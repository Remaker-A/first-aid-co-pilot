// 闭环「病人/现场」模拟器（Scene Simulator）。
//
// 它是急救 agent 的对手方：维护一份「隐藏真值」（病人已倒地、无反应、濒死/无正常
// 呼吸；施救者技能与疲劳随时间与指导变化），并在每一轮根据急救 agent 上一条
// GuidanceAction（或 dispatcher 结果）调整下一条**视觉** PerceptionEvent。EMS 到达或
// 步数/时长上限即终止，并能发出 aed / ems / handover_requested 等里程碑事件。
//
// 设计约束（务必保持）：
//   - 本模块**只读**依赖 src/domain/types.js 构造标准 PerceptionEvent，不引入任何引擎。
//   - **绝不** import src/agent/runPipeline.js —— 模拟器保持独立，闭环由 CLI 负责把
//     「模拟器 → agent → dispatcher → 模拟器」接起来。
//   - **不在模块顶层** import src/gemma/runtime.js —— LLM 真实感层（llmSceneBrain）通过
//     可选注入的文本生成函数 / runtime 工作，保证无模型也能 import 与运行。
//
// ── 可插拔的脑（brain）接口 ───────────────────────────────────────────────────
//   brain.name: string
//   brain.react({ cpr, signal, scene, rng, step, cprObservation }): cpr
//       纯函数式地把「当前 CPR 隐藏真值」推进到下一拍。ruleReactionBrain 完全确定、无需
//       模型；它读取 agent 纠错意图，把 hand_position 向 center 收敛、rate 收敛到
//       100-120、消除中断/手臂弯曲，并让 quality_score 单调上升。
//   brain.narrate?({ event, signal, scene, phase, rng }): string | Promise<string>
//       可选。生成「旁观者自然语言反应 / 细节噪声」。ruleReactionBrain 不实现（保持确定）；
//       llmSceneBrain 通过注入的 LLM 实现，缺模型时回退到确定性模板。
//
// CPR「隐藏真值」（数值）字段：
//   handOffset>=0(0=正中) / handAxis / currentRate / armStraight / interruptionSeconds /
//   qualityScore / totalCompressions / averageRate

import {
  ChestMovement,
  EventSource,
  EventType,
  FatigueLevel,
  Mode,
  RescuerEmotion,
  createPerceptionEvent,
} from "../domain/types.js";

// ── CPR 反应常量 ──────────────────────────────────────────────────────────────
const RATE_TARGET = 110;
const RATE_BAND_LOW = 100;
const RATE_BAND_HIGH = 120;
const RATE_STEP = 8; // 每次「节拍/频率」指导让 current_rate 向目标靠拢的幅度
const HAND_STEP = 1; // 每次手位纠错让 handOffset 向 0 收敛的幅度
const QUALITY_STEP = 12; // 良好指导下每拍 quality_score 的爬升幅度
const QUALITY_CEILING = 96; // quality_score 上限
const QUALITY_PENALTY = 16; // 每个未解决问题对 quality 目标的压制
const INTERRUPTION_PAUSE_SECONDS = 3; // 注入一次中断时的暂停秒数

// ── 默认里程碑 / 限制 ─────────────────────────────────────────────────────────
const DEFAULT_SCHEDULE = Object.freeze({
  interruptionAtCprTick: 4, // 在第几个 CPR 控制拍注入一次「中断」
  fatigueAtCprTick: 6, // 发出施救者高疲劳（→换手）里程碑
  aedAtCprTick: 9, // 发出 AED 到达里程碑
  emsAtCprTick: 12, // 发出 EMS 到达（handover_requested）并终止
});
const DEFAULT_MAX_STEPS = 60;
const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_STEP_MS = 6000;

// 进入 CPR 闭环前的固定相位序列：每调用一次 nextEvent 推进一相，逐步「揭示」隐藏真值，
// 并满足状态机 S0→…→S6 的推进守卫（scene_safe / responsive=false /
// no_normal_breathing+agonal / emergency_call_started）。
const PRE_CPR_PHASES = Object.freeze([
  "start",
  "scene_safe",
  "check_response",
  "check_breathing",
  "suspected",
  "emergency",
]);

const DEFAULT_BASELINE_CPR = Object.freeze({
  handOffset: 2,
  handAxis: "left", // left | right | high | low
  currentRate: 88,
  armStraight: false,
  interruptionSeconds: 0,
  qualityScore: 30,
  totalCompressions: 8,
  averageRate: 88,
});

// ── 通用小工具 ────────────────────────────────────────────────────────────────
function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function stepToward(value, target, step) {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

// 确定性 RNG（mulberry32）。规则脑不需要随机；仅供 llmSceneBrain 的细节噪声使用。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return Math.floor(seed);
  const text = String(seed ?? "firstaid-scene");
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── agent 信号归一化 ──────────────────────────────────────────────────────────
// 接受 GuidanceAction、dispatcher 的 DispatchResult、二者组成的数组，或 null。
export function normalizeAgentSignal(input) {
  if (input == null) {
    return { intent: null, reasonCodes: [], haptic: null, visualOverlay: null, priority: null, raw: null };
  }

  if (Array.isArray(input)) {
    const list = input.filter(Boolean);
    if (list.length === 0) return normalizeAgentSignal(null);
    // 优先采纳最近一条「纠错类」动作；否则取最后一条。
    const correction = [...list]
      .reverse()
      .find((item) => isAnyCorrection(readIntent(item), readReasonCodes(item)));
    return normalizeAgentSignal(correction ?? list[list.length - 1]);
  }

  const intent = readIntent(input);
  const reasonCodes = readReasonCodes(input);
  let haptic = input.haptic ?? null;
  // DispatchResult 没有 haptic 字段，但可能在 deliveries 里命中 haptic 通道。
  if (!haptic && Array.isArray(input.deliveries)) {
    const hapticDelivery = input.deliveries.find(
      (delivery) => delivery?.channel === "haptic" && delivery?.status === "delivered"
    );
    if (hapticDelivery) haptic = { enabled: true };
  }

  return {
    intent,
    reasonCodes,
    haptic,
    visualOverlay: input.visual_overlay ?? input.visualOverlay ?? null,
    priority: input.priority ?? null,
    raw: input,
  };
}

function readIntent(item) {
  return item?.intent ?? null;
}

function readReasonCodes(item) {
  const codes = item?.reason_codes ?? item?.reasonCodes ?? [];
  return Array.isArray(codes) ? [...codes] : [];
}

// ── 纠错意图探测（对意图名与 reason_codes 做子串匹配，兼容多种命名）──────────────
function matches(intent, reasonCodes, pattern) {
  if (typeof intent === "string" && pattern.test(intent)) return true;
  return reasonCodes.some((code) => typeof code === "string" && pattern.test(code));
}

function isHandCorrection(intent, reasonCodes) {
  return matches(intent, reasonCodes, /hand[_-]?position/i);
}

function isRateCorrection(intent, reasonCodes) {
  return matches(intent, reasonCodes, /compression[_-]?rate|rate[_-]?(low|high)/i);
}

function isArmCorrection(intent, reasonCodes) {
  return matches(intent, reasonCodes, /arm[_-]?(posture|bent|straight)/i);
}

function isInterruptionCorrection(intent, reasonCodes) {
  return matches(intent, reasonCodes, /interrupt/i);
}

function isAnyCorrection(intent, reasonCodes) {
  return (
    isHandCorrection(intent, reasonCodes) ||
    isRateCorrection(intent, reasonCodes) ||
    isArmCorrection(intent, reasonCodes) ||
    isInterruptionCorrection(intent, reasonCodes)
  );
}

const RHYTHM_INTENTS = new Set([
  "start_cpr_loop",
  "continue_cpr_loop",
  "continue_cpr",
  "encourage_rescuer",
  "guide_compression_rhythm",
  "start_metronome",
  "update_cpr_quality",
]);

// 「节拍/韵律提示」= 让 current_rate 向目标收敛的良好指导（含触觉节拍器）。
function isRhythmGuidance(signal) {
  if (!signal) return false;
  if (signal.haptic?.enabled === true) return true;
  if (typeof signal.intent === "string" && RHYTHM_INTENTS.has(signal.intent)) return true;
  return isRateCorrection(signal.intent, signal.reasonCodes ?? []);
}

// ── CPR 真值 → 事件 cpr_quality token 映射 ────────────────────────────────────
function handPositionToken(handOffset, handAxis) {
  if (handOffset <= 0) return "center";
  if (handOffset >= 2) return "off_center";
  switch (handAxis) {
    case "right":
      return "right";
    case "high":
      return "too_high";
    case "low":
      return "too_low";
    case "left":
    default:
      return "left";
  }
}

function countUnresolved(cpr) {
  return (
    (cpr.handOffset > 0 ? 1 : 0) +
    (cpr.armStraight ? 0 : 1) +
    (cpr.currentRate < RATE_BAND_LOW || cpr.currentRate > RATE_BAND_HIGH ? 1 : 0) +
    (cpr.interruptionSeconds >= 2 ? 1 : 0)
  );
}

// quality_score 推进：永不下降（单调），在「未解决问题」决定的目标上限以内逐拍爬升。
// 问题被纠正后上限抬高，quality 继续向高分爬升 —— 满足「持续良好指导下单调上升直至高分」。
function nextQualityScore(previous, cpr, options) {
  const ceiling = options.qualityCeiling;
  const penalty = options.qualityPenalty;
  const step = options.qualityStep;
  const target = ceiling - penalty * countUnresolved(cpr);
  const climbed = previous + step;
  return clamp(climbed, previous, Math.max(previous, target));
}

// ── ruleReactionBrain：默认、完全确定、无需任何模型 ──────────────────────────────
export function createRuleReactionBrain(options = {}) {
  const config = {
    rateTarget: options.rateTarget ?? RATE_TARGET,
    rateStep: options.rateStep ?? RATE_STEP,
    handStep: options.handStep ?? HAND_STEP,
    qualityStep: options.qualityStep ?? QUALITY_STEP,
    qualityCeiling: options.qualityCeiling ?? QUALITY_CEILING,
    qualityPenalty: options.qualityPenalty ?? QUALITY_PENALTY,
  };

  return {
    name: options.name ?? "rule_reaction",
    react({ cpr, signal }) {
      const next = { ...cpr };
      const intent = signal?.intent ?? null;
      const reasons = signal?.reasonCodes ?? [];

      // 1) 中断纠错：立即恢复按压。
      if (isInterruptionCorrection(intent, reasons)) {
        next.interruptionSeconds = 0;
      }
      // 2) 手位纠错：handOffset 向 0（胸口正中）收敛。
      if (isHandCorrection(intent, reasons)) {
        next.handOffset = Math.max(0, next.handOffset - config.handStep);
      }
      // 3) 手臂纠错：伸直手臂。
      if (isArmCorrection(intent, reasons)) {
        next.armStraight = true;
      }
      // 4) 频率/节拍指导：current_rate 向 100-120 区间（目标 110）收敛。
      if (isRateCorrection(intent, reasons) || isRhythmGuidance(signal)) {
        next.currentRate = stepToward(next.currentRate, config.rateTarget, config.rateStep);
      }
      // 5) quality_score 单调上升（受未解决问题数压制的上限约束）。
      next.qualityScore = nextQualityScore(cpr.qualityScore, next, config);
      return next;
    },
  };
}

export const ruleReactionBrain = createRuleReactionBrain();

// ── llmSceneBrain：真实感层（旁观者自然语言反应 + 细节噪声）──────────────────────
// 物理/生理（CPR 真值）仍交由确定性规则脑推进 —— LLM 只负责「叙事真实感」，绝不污染
// 闭环医学信号。文本生成通过注入的 generateText(prompt) 或 runtime 完成；缺模型/异常时
// 回退到确定性模板，保证无模型也能跑。
export function createLlmSceneBrain(injection = {}) {
  const fallbackBrain = injection.fallbackBrain ?? ruleReactionBrain;
  const generate = resolveGenerate(injection.generateText, injection.runtime);
  const buildPrompt = injection.promptBuilder ?? defaultScenePrompt;

  return {
    name: injection.name ?? "llm_scene",
    // 确定性生理推进，委托给规则脑（保证 live 模式下医学信号依旧可控、可复现）。
    react(context) {
      return fallbackBrain.react(context);
    },
    // 非确定性旁观者叙事；失败时回退到确定性模板。
    async narrate(context) {
      const fallback = fallbackNarration(context);
      if (!generate) return fallback;
      try {
        const text = await generate(buildPrompt(context));
        const clean = typeof text === "string" ? text.trim() : "";
        return clean.length > 0 ? clean : fallback;
      } catch {
        return fallback;
      }
    },
  };
}

// 别名：与计划/任务中使用的名称保持一致（`llmSceneBrain(injection)` 即工厂调用）。
export const llmSceneBrain = createLlmSceneBrain;

// 把多种注入形态归一成一个 async (prompt) => string；无可用生成器时返回 null。
function resolveGenerate(generateText, runtime) {
  if (typeof generateText === "function") {
    return (prompt) => Promise.resolve(generateText(prompt));
  }
  if (runtime && typeof runtime === "object") {
    if (typeof runtime.generateText === "function") {
      return (prompt) => Promise.resolve(runtime.generateText(prompt));
    }
    if (typeof runtime.generate === "function") {
      return (prompt) => Promise.resolve(runtime.generate(prompt));
    }
    // 兼容 src/gemma/runtime.js 的 GemmaRuntime.generatePatch(frame)。
    if (typeof runtime.generatePatch === "function") {
      return async (prompt) => {
        const result = await runtime.generatePatch({ user_input: prompt, language: "zh-CN" });
        return result?.patch?.tts?.text ?? result?.text ?? "";
      };
    }
  }
  return null;
}

function defaultScenePrompt(context) {
  const { phase, scene, signal } = context;
  const lastGuidance = signal?.intent ? `急救助手刚刚的指令意图是「${signal.intent}」。` : "急救助手尚未给出指令。";
  const cpr = scene?.cpr ?? {};
  return [
    "你在扮演一位心脏骤停现场的旁观者/施救者，请用一句简短中文口语描述你此刻的反应。",
    `现场阶段：${phase}。`,
    lastGuidance,
    `当前按压：频率约 ${Math.round(cpr.currentRate ?? 0)} 次/分，质量分 ${Math.round(cpr.qualityScore ?? 0)}。`,
    "只输出一句话，不要解释。",
  ].join("\n");
}

function fallbackNarration(context) {
  const { phase, scene } = context;
  const notes = {
    start: "有人突然倒在地上，我赶紧过去看看。",
    scene_safe: "周围没有危险，我可以靠近他。",
    check_response: "我拍他、叫他，他一点反应都没有。",
    check_breathing: "他胸口几乎不动，只是偶尔抽一下气。",
    suspected: "情况很不好，我听你的指挥。",
    emergency: "电话已经拨出去了，开着免提。",
    cpr: "我在按，按照你说的做。",
    fatigue: "我手有点酸了，旁边有人可以换我。",
    aed: "有人把 AED 拿过来了！",
    ems: "救护车到了，急救员过来接手了。",
  };
  const key = phase?.startsWith("cpr") ? "cpr" : phase;
  const base = notes[key] ?? "我在现场，继续照你说的做。";
  const score = Math.round(scene?.cpr?.qualityScore ?? 0);
  return phase?.startsWith("cpr") ? `${base}（按压质量分 ${score}）` : base;
}

// ── SceneSimulator ───────────────────────────────────────────────────────────
export class SceneSimulator {
  constructor(options = {}) {
    this.brain = options.brain ?? ruleReactionBrain;
    this.sessionId = options.sessionId ?? "sess_scene_sim";
    this.mode = options.mode ?? Mode.DEMO_ASSISTED;
    this.stepMs = options.stepMs ?? DEFAULT_STEP_MS;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.ttlMs = options.ttlMs ?? 60000;
    this.schedule = { ...DEFAULT_SCHEDULE, ...(options.schedule ?? {}) };
    this.rng = mulberry32(hashSeed(options.seed));

    // 隐藏真值。
    this.cpr = { ...DEFAULT_BASELINE_CPR, ...(options.baselineCpr ?? {}) };
    this.rescuer = {
      skill: 0.3,
      fatigue: 0,
      fatigueLevel: FatigueLevel.LOW,
      emotion: RescuerEmotion.ANXIOUS,
    };
    this.patient = {
      adultLikely: true,
      lyingDown: true,
      responsive: false,
      normalBreathing: false,
      agonalBreathing: true,
      chestMovement: ChestMovement.IRREGULAR,
    };

    // 进度游标。
    this.step = 0; // 已产出的事件数
    this.preIndex = 0; // 已产出的 pre-CPR 相位数
    this.controllerTick = 0; // CPR 控制器被调用的次数
    this.cprObservation = 0; // 已产出的 cpr_quality 事件数（决定 baseline / react）
    this.elapsedMs = 0;
    this.phase = "init";
    this.finished = false;
    this.milestones = {
      interruptionInjected: false,
      fatigueEmitted: false,
      aedEmitted: false,
      emsEmitted: false,
    };
    this.lastEvent = null;
    this.lastSignal = normalizeAgentSignal(null);
  }

  isFinished() {
    return this.finished === true;
  }

  getPhase() {
    return this.phase;
  }

  getLastEvent() {
    return this.lastEvent;
  }

  // 隐藏真值 + 进度的只读快照（供 CLI 打印 / 单测断言）。
  snapshot() {
    return {
      step: this.step,
      phase: this.phase,
      finished: this.finished,
      controllerTick: this.controllerTick,
      cprObservation: this.cprObservation,
      elapsedMs: this.elapsedMs,
      brain: this.brain?.name ?? null,
      milestones: { ...this.milestones },
      patient: { ...this.patient },
      rescuer: { ...this.rescuer },
      cpr: {
        ...this.cpr,
        hand_position: handPositionToken(this.cpr.handOffset, this.cpr.handAxis),
        unresolved: countUnresolved(this.cpr),
      },
    };
  }

  // 同步推进一拍：读取 agent 上一轮动作 / dispatch，产出下一条 PerceptionEvent。
  // 结束后返回 null。该路径完全确定（规则脑下两次运行 cpr_quality 序列一致）。
  nextEvent(lastAgentInput) {
    if (this.finished) return null;
    const signal = normalizeAgentSignal(lastAgentInput);
    this.lastSignal = signal;
    const event = this.#produce(signal);
    this.lastEvent = event;
    return event;
  }

  // 异步推进一拍：在确定性事件之上叠加脑的旁观者叙事（如 llmSceneBrain 调真实 Gemma）。
  // 叙事写入 event.metadata.bystander；脑无 narrate 或失败时事件保持不变。
  async nextEventAsync(lastAgentInput) {
    const event = this.nextEvent(lastAgentInput);
    if (event && typeof this.brain?.narrate === "function") {
      try {
        const text = await this.brain.narrate(this.#narrateContext(event));
        if (typeof text === "string" && text.trim().length > 0) {
          event.metadata = { ...event.metadata, bystander: text.trim() };
        }
      } catch {
        // 叙事失败不影响确定性事件本身。
      }
    }
    return event;
  }

  #narrateContext(event) {
    return {
      event,
      phase: this.phase,
      signal: this.lastSignal,
      scene: this.snapshot(),
      rng: this.rng,
    };
  }

  #produce(signal) {
    this.step += 1;
    this.elapsedMs += this.stepMs;

    // 安全网：步数/时长上限 → 强制以 EMS 交接收尾。
    if (!this.milestones.emsEmitted && this.step >= this.maxSteps) {
      return this.#emitEms();
    }
    if (!this.milestones.emsEmitted && this.elapsedMs >= this.maxDurationMs) {
      return this.#emitEms();
    }

    if (this.preIndex < PRE_CPR_PHASES.length) {
      const phase = PRE_CPR_PHASES[this.preIndex];
      this.preIndex += 1;
      this.phase = phase;
      return this.#emitPrePhase(phase);
    }

    return this.#emitFromController(signal);
  }

  // S0→S6 之前的固定相位事件（逐步揭示隐藏真值）。
  #emitPrePhase(phase) {
    switch (phase) {
      case "start":
        return this.#event({
          source: EventSource.VISION_PATIENT,
          eventType: EventType.SESSION_STARTED,
          stageHint: "S0_INIT",
          patientState: this.#patientState({ reveal: "collapsed" }),
          deviceState: {
            camera_available: true,
            mic_available: true,
            gps_available: true,
            recording: true,
            emergency_call_started: false,
            network: "offline",
          },
          metadata: { scene_note: "有人突然倒地", reveal: "collapsed" },
        });
      case "scene_safe":
        return this.#event({
          source: EventSource.VISION_PATIENT,
          eventType: EventType.PATIENT_STATE_UPDATE,
          stageHint: "S1_SCENE_SAFE",
          patientState: this.#patientState({ reveal: "collapsed" }),
          metadata: { scene_safe: true, scene_note: "现场安全" },
        });
      case "check_response":
        return this.#event({
          source: EventSource.VISION_PATIENT,
          eventType: EventType.PATIENT_STATE_UPDATE,
          stageHint: "S2_CHECK_RESPONSE",
          patientState: this.#patientState({ reveal: "unresponsive" }),
          metadata: { scene_note: "拍打呼喊无反应" },
        });
      case "check_breathing":
        return this.#event({
          source: EventSource.VISION_PATIENT,
          eventType: EventType.BREATHING_UPDATE,
          stageHint: "S3_CHECK_BREATHING",
          patientState: this.#patientState({ reveal: "no_breathing" }),
          metadata: { scene_note: "无正常呼吸，偶有濒死喘息" },
        });
      case "suspected":
        return this.#event({
          source: EventSource.VISION_PATIENT,
          eventType: EventType.PATIENT_STATE_UPDATE,
          stageHint: "S4_SUSPECTED_ARREST",
          patientState: this.#patientState({ reveal: "no_breathing" }),
          metadata: { scene_note: "疑似心脏骤停" },
        });
      case "emergency":
      default:
        return this.#event({
          source: EventSource.VISION_PATIENT,
          eventType: EventType.DEVICE_STATE_UPDATE,
          stageHint: "S5_CALL_EMERGENCY",
          patientState: this.#patientState({ reveal: "no_breathing" }),
          deviceState: {
            camera_available: true,
            mic_available: true,
            gps_available: true,
            recording: true,
            emergency_call_started: true,
            network: "offline",
          },
          metadata: { emergency_call_started: true, scene_note: "120 已拨出，开启免提" },
        });
    }
  }

  // CPR 闭环控制器：按 controllerTick 调度里程碑，否则产出 brain 调整后的 cpr_quality。
  #emitFromController(signal) {
    const tick = this.controllerTick;
    this.controllerTick += 1;
    const { fatigueAtCprTick, aedAtCprTick, emsAtCprTick } = this.schedule;

    if (emsAtCprTick != null && tick >= emsAtCprTick) {
      return this.#emitEms();
    }
    if (fatigueAtCprTick != null && tick === fatigueAtCprTick && !this.milestones.fatigueEmitted) {
      return this.#emitFatigue();
    }
    if (aedAtCprTick != null && tick === aedAtCprTick && !this.milestones.aedEmitted) {
      return this.#emitAed();
    }
    return this.#emitCpr(signal, tick);
  }

  #emitCpr(signal, tick) {
    this.phase = this.cprObservation === 0 ? "cpr_start" : "cpr_loop";

    // 第一拍是「原始基线观测」（不经过 brain）；其后每拍由 brain 依据 agent 信号推进。
    if (this.cprObservation > 0) {
      this.cpr = this.brain.react({
        cpr: this.cpr,
        signal,
        scene: this.snapshot(),
        rng: this.rng,
        step: this.step,
        cprObservation: this.cprObservation,
      });
    }
    this.cprObservation += 1;

    // 施救者技能随质量提升、疲劳随按压时间累积（隐藏真值的时间演化）。
    this.rescuer.skill = clamp(this.cpr.qualityScore / 100, 0, 1);
    this.rescuer.fatigue = clamp(this.rescuer.fatigue + 0.12, 0, 1);
    this.rescuer.fatigueLevel = fatigueLevelFromScore(this.rescuer.fatigue);

    // 一次性「中断」注入：仅影响本条事件，内部真值随即恢复（等待 agent 纠错后规则脑确认）。
    let interruptionSeconds = this.cpr.interruptionSeconds;
    if (
      this.schedule.interruptionAtCprTick != null &&
      tick === this.schedule.interruptionAtCprTick &&
      !this.milestones.interruptionInjected
    ) {
      interruptionSeconds = INTERRUPTION_PAUSE_SECONDS;
      this.milestones.interruptionInjected = true;
      this.cpr.interruptionSeconds = 0;
    }

    const compressing = interruptionSeconds < 2;
    const perMinute = Math.round(this.cpr.currentRate);
    const added = compressing ? Math.round((perMinute * this.stepMs) / 60000) : 0;
    this.cpr.totalCompressions += added;
    this.cpr.averageRate = Math.round(0.6 * this.cpr.averageRate + 0.4 * perMinute);

    const cprQuality = {
      compressions_started: compressing,
      current_rate: compressing ? perMinute : 0,
      average_rate: this.cpr.averageRate,
      quality_score: Math.round(this.cpr.qualityScore),
      hand_position: handPositionToken(this.cpr.handOffset, this.cpr.handAxis),
      hand_offset: this.cpr.handOffset, // 自定义数值字段：便于细粒度断言/可视化（引擎只读 hand_position）
      arm_posture: this.cpr.armStraight ? "straight" : "bent",
      interruption_seconds: interruptionSeconds,
      total_compressions: this.cpr.totalCompressions,
      confidence: 0.85,
    };

    return this.#event({
      source: EventSource.VISION_CPR,
      eventType: EventType.CPR_QUALITY_UPDATE,
      stageHint: "S7_CPR_LOOP",
      ttlMs: 3000,
      cprQuality,
      metadata: {
        cpr_observation: this.cprObservation,
        unresolved: countUnresolved(this.cpr),
        scene_note: interruptionSeconds >= 2 ? "按压中断" : "持续按压中",
      },
    });
  }

  #emitFatigue() {
    this.phase = "fatigue";
    this.milestones.fatigueEmitted = true;
    this.rescuer.fatigue = Math.max(this.rescuer.fatigue, 0.85);
    this.rescuer.fatigueLevel = FatigueLevel.HIGH;
    this.rescuer.emotion = RescuerEmotion.ANXIOUS;
    return this.#event({
      source: EventSource.VISION_RESCUER,
      eventType: EventType.RESCUER_STATE_UPDATE,
      stageHint: "S8_ASSISTANCE",
      ttlMs: 5000,
      rescuerState: {
        emotion: this.rescuer.emotion,
        fatigue_level: FatigueLevel.HIGH,
        hesitation_seconds: 0,
        confidence: 0.76,
      },
      metadata: { scene_note: "施救者明显疲劳，需要换手" },
    });
  }

  #emitAed() {
    this.phase = "aed";
    this.milestones.aedEmitted = true;
    // 有人取来 AED 并协助按压 → 疲劳得到缓解（隐藏真值演化）。
    this.rescuer.fatigue = Math.min(this.rescuer.fatigue, 0.4);
    this.rescuer.fatigueLevel = fatigueLevelFromScore(this.rescuer.fatigue);
    return this.#event({
      source: EventSource.VISION_PATIENT,
      eventType: EventType.PATIENT_STATE_UPDATE,
      stageHint: "S8_ASSISTANCE",
      ttlMs: 5000,
      patientState: this.#patientState({ reveal: "no_breathing" }),
      metadata: { aed_available: true, helper_arrived: true, scene_note: "AED 已取到，旁人协助" },
    });
  }

  #emitEms() {
    this.phase = "ems";
    this.milestones.emsEmitted = true;
    this.finished = true; // EMS 到达即终止：之后 nextEvent 返回 null，isFinished() 为真。
    return this.#event({
      source: EventSource.VISION_PATIENT,
      eventType: EventType.HANDOVER_REQUESTED,
      stageHint: "S9_HANDOVER",
      ttlMs: 10000,
      metadata: { ems_arrived: true, scene_note: "急救员到达，请求交接" },
    });
  }

  // 依据「揭示等级」构造 patient_state；隐藏真值固定为成人/倒地/无反应/无正常呼吸/濒死喘息。
  #patientState({ reveal }) {
    const base = {
      adult_likely: this.patient.adultLikely,
      lying_down: this.patient.lyingDown,
      responsive: null,
      normal_breathing: null,
      agonal_breathing: null,
      chest_movement: ChestMovement.UNKNOWN,
      confidence: 0.85,
      observed_duration_ms: this.elapsedMs,
    };
    if (reveal === "unresponsive" || reveal === "no_breathing") {
      base.responsive = this.patient.responsive; // false
    }
    if (reveal === "no_breathing") {
      base.normal_breathing = this.patient.normalBreathing; // false
      base.agonal_breathing = this.patient.agonalBreathing; // true
      base.chest_movement = this.patient.chestMovement; // irregular
    }
    return base;
  }

  #event(input) {
    return createPerceptionEvent({
      sessionId: this.sessionId,
      mode: this.mode,
      ttlMs: input.ttlMs ?? this.ttlMs,
      sequenceId: this.step,
      ...input,
      metadata: {
        simulator: "scene_sim",
        brain: this.brain?.name ?? null,
        seed_step: this.step,
        sim_phase: this.phase,
        ...(input.metadata ?? {}),
      },
    });
  }
}

function fatigueLevelFromScore(score) {
  if (score >= 0.75) return FatigueLevel.HIGH;
  if (score >= 0.4) return FatigueLevel.MEDIUM;
  return FatigueLevel.LOW;
}

export function createSceneSimulator(options = {}) {
  return new SceneSimulator(options);
}

export default createSceneSimulator;
