import { runAgentPipeline } from "../agent/runPipeline.js";
import { createDecisionFrame, SPECIAL_GEMMA_INTENTS } from "../gemma/decisionFrame.js";
import { GemmaRuntime } from "../gemma/runtime.js";
import { OPEN_QUESTION_GEMMA_SYSTEM_PROMPT_FILE } from "../gemma/promptBuilder.js";
import { createNluGovernor } from "../gemma/nluCache.js";
import { createId } from "../domain/types.js";
import { validateAction } from "../engine/actionValidator.js";
import {
  guidanceSourceRank,
  recordGuidanceArbitration,
  resolveGemmaAuthority
} from "../engine/guidanceArbitration.js";
import { AgentStage } from "../domain/stages.js";
import { getNluSlotsConfig } from "../knowledge/knowledgeBase.js";
import { transcribeInput } from "./stt.js";
import { synthesizeSpeech } from "./tts.js";
import { resolveUserIntent } from "./intentResolver.js";
import {
  LiveResponseType,
  OPEN_QUESTION_CPR_FALLBACK_PHRASE,
  createLiveAgentInput,
  createLiveDriverProposal,
  createOpenQuestionAckProposal,
  detectOpenQuestion,
  isOpenQuestionStage,
  liveProposalToGuidanceAction,
  openQuestionAnswerIntents,
} from "./liveDriver.js";

const DEFAULT_VOICE_EVENT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_GEMMA_LIVE_TIMEOUT_MS = 1200;
const DEFAULT_GEMMA_TURN_TIMEOUT_MS = 1000;
const DEFAULT_GEMMA_OPEN_QUESTION_LIVE_TIMEOUT_MS = 800;
const DEFAULT_GEMMA_OPEN_QUESTION_TURN_TIMEOUT_MS = 800;
const DEFAULT_GEMMA_OPEN_QUESTION_TEXT_TIMEOUT_MS = 800;
const DEFAULT_GEMMA_OPEN_QUESTION_TEXT_MAX_TOKENS = 32;
const DEFAULT_GEMMA_OPEN_QUESTION_TEXT_STREAM = true;
const DEFAULT_GEMMA_OPEN_QUESTION_TEXT_STREAM_MAX_CHARS = 24;
const DEFAULT_OPEN_QUESTION_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_OPEN_QUESTION_CACHE_MAX_ENTRIES = 64;
const CPR_READINESS_FAST_PATH = "s6_readiness_continue_cpr";
const S5_CALL_TO_CPR_FAST_PATH = "s5_call_done_continue_cpr";

// At the S6 confirm gate, readiness/start phrases ("开始"/"可以了"/"没有呼吸"/
// "准备好了"…) all mean "start compressions now". They sometimes classify as a
// non-continue_cpr intent (e.g. "可以了"->step_done, "没有呼吸"->no_normal_breathing);
// those are advance-compatible and get folded into the continue_cpr start signal.
// Divergent intents (responsive / normal breathing / paramedics / scene unsafe /
// signs of life) are NOT in this set, so they are kept and the flow branches.
const READINESS_FAST_PATH_OVERRIDABLE_INTENTS = new Set([
  "continue_cpr",
  "no_normal_breathing",
  "breathing_absent",
  "agonal_breathing",
  "compressions_reported",
  "step_done",
]);

const CLIENT_INTENT_ALIASES = Object.freeze({
  mark_scene_safe: "scene_safe",
  mark_scene_unsafe: "scene_unsafe",
  mark_unresponsive: "patient_unresponsive",
  mark_responsive: "patient_responsive",
  mark_no_normal_breathing: "no_normal_breathing",
  mark_normal_breathing: "normal_breathing",
  mark_emergency_called: "emergency_called",
  mark_cpr_ready: "continue_cpr",
  mark_aed_available: "aed_available",
  mark_paramedics_arrived: "paramedics_arrived",
});

export function createVoiceDemoService(options = {}) {
  const sessions = new Map();
  const runtime = options.runtime || new GemmaRuntime(options.gemma || {});
  const now = options.now || (() => new Date().toISOString());
  const env = options.env || process.env;
  let startupPrewarm = null;
  if (shouldPrewarmGemmaOnStart(options, env) && runtime && typeof runtime.prewarm === "function") {
    startupPrewarm = runtime.prewarm({
      timeoutMs: options.gemmaPrewarmTimeoutMs ?? options.gemma_prewarm_timeout_ms,
    }).catch((error) => ({ ok: true, warmed: false, reason: "startup_prewarm_failed", error }));
  }
  // Per-service NLU governance: an LRU result cache + per-session call budget so
  // repeated/fuzzy utterances skip the slow local model and one session cannot
  // hammer the CPU. Instance-scoped on purpose — no cross-session or cross-test
  // state bleed. Config layering: options > env > nlu_slots.json baseline.
  const { cache: nluCache, budget: nluBudget } = createNluGovernor({
    ...options,
    baseline: resolveNluRuntimeBaseline(),
    env: options.env || process.env,
  });
  const coreOptions = { ...options, nluCache, nluBudget };

  return {
    sessions,
    async handleTurn(input = {}) {
      const totalStart = Date.now();
      const timings = {};
      const sessionId = input.sessionId || input.session_id || createId("voice_sess");
      const session = getOrCreateSession(sessions, sessionId, now);
      const stt = await timed(timings, "stt_ms", () => transcribeInput(input, options.stt || {}));
      const guidance = await runVoiceGuidanceCore({
        sessionId,
        session,
        stt,
        input,
        runtime,
        options: coreOptions,
        now,
        timings,
      });
      const guidanceAction = guidance.guidanceAction;
      const spokenText = guidanceAction?.tts?.text || guidance.stateAction?.tts?.text || "";
      const tts = await timed(timings, "tts_ms", () => synthesizeSpeech(spokenText, options.tts || {}));
      // Low-latency path: `/api/turn` returns the immediate ack/flow guidance and
      // does not wait for the controlled Gemma Q&A answer. Live sessions keep the
      // promise channel and stream the answer later; probes can opt back into the
      // bounded wait when they explicitly need the resolved answer.
      const shouldWaitForOpenQuestionAnswer =
        input.waitForOpenQuestionAnswer === true ||
        input.awaitOpenQuestionAnswer === true ||
        options.waitForOpenQuestionAnswer === true ||
        options.awaitOpenQuestionAnswer === true;
      const openQuestionAnswer = guidance.openQuestionAnswer
        ? shouldWaitForOpenQuestionAnswer
          ? summarizeOpenQuestionAnswer(await guidance.openQuestionAnswer.promise.catch(() => null))
          : summarizeOpenQuestionChannel(guidance.openQuestionAnswer)
        : null;
      timings.total_ms = Date.now() - totalStart;
      const response = {
        ok: true,
        session_id: sessionId,
        transcript: stt.transcript,
        stt,
        intent_resolution: guidance.intentResolution,
        event: guidance.event,
        state: guidance.pipeline.state,
        state_action: guidance.stateAction,
        decision_frame: guidance.frame,
        action_patch: guidance.patch,
        gemma_validation: guidance.gemmaValidation,
        live_agent_input: guidance.liveInput,
        live_driver_proposal: guidance.liveProposal,
        guidance_action: guidanceAction,
        guidance_source: guidance.guidanceDecision.source,
        response_type: guidance.guidanceDecision.responseType,
        live_driver_source: guidance.guidanceDecision.liveDriverSource,
        tts_arbitration_reason: guidance.guidanceDecision.reason,
        decision_scope: guidance.guidanceDecision.decision_scope ?? null,
        gemma: guidance.gemma,
        gemma_live: createGemmaLiveDebug(guidance.gemma, guidance.gemmaPlan),
        open_question: guidance.openQuestion === true,
        open_question_answer: openQuestionAnswer,
        tts,
        timings,
        report: guidance.pipeline.report,
      };

      session.lastResponse = response;
      return response;
    },
    async createGuidance(input = {}, stt, timings = {}) {
      const sessionId = input.sessionId || input.session_id || createId("voice_sess");
      const session = getOrCreateSession(sessions, sessionId, now);
      const resolvedStt = stt || await timed(timings, "stt_ms", () => transcribeInput(input, options.stt || {}));
      const guidance = await runVoiceGuidanceCore({
        sessionId,
        session,
        stt: resolvedStt,
        input,
        runtime,
        options: coreOptions,
        now,
        timings,
      });
      session.lastResponse = createGuidanceResponseSnapshot(guidance);
      return guidance;
    },
    reset(sessionId) {
      if (sessionId) {
        sessions.delete(sessionId);
      } else {
        sessions.clear();
      }
      return { ok: true, session_id: sessionId || null };
    },
    getSession(sessionId) {
      return sessions.get(sessionId) || null;
    },
    // Best-effort: pay the resident-daemon model-load cost up front so the first
    // real NLU turn is fast. No-op in one-shot (non-daemon) mode. Never throws.
    async prewarm(prewarmOptions = {}) {
      if (startupPrewarm && prewarmOptions.reuseStartup !== false) {
        return startupPrewarm;
      }
      if (runtime && typeof runtime.prewarm === "function") {
        return runtime.prewarm(prewarmOptions);
      }
      return { ok: true, warmed: false, reason: "runtime_prewarm_unsupported" };
    },
  };
}

export async function runVoiceGuidanceCore({
  sessionId,
  session,
  stt,
  input = {},
  runtime,
  options = {},
  now = () => new Date().toISOString(),
  timings = {},
  } = {}) {
  const priorState = getPriorSessionState(session, input);
  const resolverStage = resolveIntentStage(priorState, input, session);
  const rawIntentResolution = await timed(timings, "intent_resolution_ms", () => resolveUserIntent({
    transcript: stt.transcript,
    stage: resolverStage,
    runtime,
    options: {
      ...options,
      sessionId,
      facts: priorState?.confirmed_facts || {},
      perceptionSummary: input.perceptionSummary || input.perception_summary,
      recentTts: priorState?.dialogue_state?.recent_tts,
    },
  }));
  const hintedIntentResolution = applyClientIntentHint(rawIntentResolution, {
    input,
    stage: resolverStage,
  });
  const intentResolution = applyCprFlowFastPaths(hintedIntentResolution, {
    stt,
    stage: resolverStage,
  });
  const event = createVoiceEvent({ sessionId, stt, input, now, intentResolution, stage: resolverStage });

  session.events.push(event);

  // The voice service runs its own Gemma supplement below (runtime +
  // ActionValidator), so it needs the pipeline's deterministic,
  // synchronous state-machine actions. Now that runAgentPipeline defaults
  // Gemma ON, opt out explicitly to keep the synchronous contract.
  const pipeline = await timed(timings, "agent_pipeline_ms", () => runAgentPipeline({
    events: session.events,
    mode: "demo_assisted",
    sessionId,
    now,
    useGemma: false,
  }));
  const stateAction = pipeline.actions[pipeline.actions.length - 1] || null;
  const frame = createDecisionFrame({
    state: pipeline.state,
    event,
    userInput: {
      stt_text: stt.transcript,
      intent_hint: event.user_input?.intent,
      confidence: event.user_input?.confidence,
    },
    perceptionSummary: input.perceptionSummary || input.perception_summary,
  });
  const liveInput = createLiveAgentInput({
    sessionState: pipeline.state,
    latestEvent: event,
    latestUserUtterance: frame.user_input,
    pendingFlowAction: stateAction,
    pendingRuleFeedback: stateAction?.source === "rule_feedback" ? stateAction : null,
    recentTts: frame.recent_tts,
    allowedIntents: frame.allowed_intents,
  });
  const liveProposal = createLiveDriverProposal(liveInput);
  const gemmaPlan = planGemmaSupplement(stateAction, stt, {
    state: pipeline.state,
    event,
    liveProposal,
    options,
  });

  // WB open question: the synchronous turn plays an immediate stabilizing ack
  // (WA-cache eligible, CPR-live only) while the controlled Q&A Gemma answer is
  // generated asynchronously and streamed afterwards. We never block the ack on
  // the model, and the deterministic flow / critical corrections (handled earlier
  // in planGemmaSupplement) always win, so the metronome and corrections are never
  // interrupted.
  let openQuestionAnswer = null;
  let openQuestionAck = null;
  let gemma;
  if (gemmaPlan.openQuestion) {
    const stage = pipeline.state.current_stage;
    openQuestionAck = buildOpenQuestionAck(stage, pipeline.state, sessionId);
    openQuestionAnswer = startOpenQuestionAnswer({
      runtime,
      frame,
      plan: gemmaPlan,
      state: pipeline.state,
      sessionId,
      cache: session.openQuestionCache,
      options,
    });
    gemma = createSkippedGemma("open_question_async");
  } else {
    gemma = gemmaPlan.run
      ? await timed(timings, "gemma_ms", () => generateGemmaPatch(runtime, frame, gemmaPlan))
      : createSkippedGemma(gemmaPlan.reason);
  }
  const patch = gemma.patch || null;
  const gemmaValidation = patch
    ? validateAction(toGuidanceCandidate(patch, pipeline.state, sessionId), pipeline.state)
    : null;
  const guidanceDecision = arbitrateGuidanceAction({
    stateAction,
    gemmaValidation,
    liveProposal,
    state: pipeline.state,
    sessionId,
    // allowIntentChange 不再写死：由 gemma_decision_scope 在 arbitrateGuidanceAction
    // 内按 restricted/autonomy 裁决（关键/工具流早已在 planGemmaSupplement 阶段拦截）。
    userIntent: event.user_input?.intent ?? null,
    event,
    openQuestionAck,
  });

  return {
    sessionId,
    stt,
    intentResolution,
    event,
    pipeline,
    stateAction,
    frame,
    liveInput,
    liveProposal,
    gemmaPlan,
    gemma,
    patch,
    gemmaValidation,
    guidanceDecision,
    guidanceAction: guidanceDecision.action,
    openQuestion: gemmaPlan.openQuestion === true,
    openQuestionAnswer,
  };
}

// Medical flow stays state-machine-driven. Gemma may only supplement wording on
// non-critical turns. If the state action is critical or carries tool actions
// (call 120, start CPR, generate report, etc.), the state action is dispatched
// as-is and Gemma never replaces it.
export function resolveGuidanceAction(stateAction, gemmaValidation, options = {}) {
  if (stateAction && isCriticalFlowAction(stateAction)) {
    return { action: stateAction, source: "state_machine_critical" };
  }

  if (gemmaValidation?.ok === false && gemmaValidation.action) {
    return { action: gemmaValidation.action, source: "gemma_fallback" };
  }

  if (
    stateAction &&
    options.allowIntentChange === false &&
    gemmaValidation?.action &&
    gemmaValidation.action.intent !== stateAction.intent
  ) {
    return { action: stateAction, source: "state_machine" };
  }

  if (gemmaValidation?.action) {
    if (!gemmaValidation.ok) {
      return { action: gemmaValidation.action, source: "gemma_fallback" };
    }
    // 同 intent -> 润色 (gemma_agent)；不同 intent 且授权放开 -> Gemma autonomy 自选。
    const changedIntent =
      Boolean(stateAction) && gemmaValidation.action.intent !== stateAction.intent;
    return {
      action: gemmaValidation.action,
      source: changedIntent ? "gemma_autonomy" : "gemma_agent",
    };
  }

  return { action: stateAction, source: "state_machine" };
}

export function arbitrateGuidanceAction({
  stateAction,
  gemmaValidation,
  liveProposal,
  state = {},
  sessionId = null,
  // 默认 undefined：交由 gemma_decision_scope 裁决换义授权。显式传 false 时退化为
  // 强制"仅润色"的硬上限（不再写死，但保留可由调用方收紧的能力）。
  allowIntentChange = undefined,
  userIntent = null,
  event = null,
  openQuestionAck = null,
} = {}) {
  if (isCriticalRuleCorrection(stateAction)) {
    return {
      action: stateAction,
      source: "rule_feedback_critical",
      responseType: LiveResponseType.CRITICAL_CORRECTION,
      liveDriverSource: null,
      reason: "critical_rule_feedback",
    };
  }

  if (isCprReadinessFlowFastPath(stateAction, state, userIntent, event)) {
    return {
      action: stateAction,
      source: "rule_flow_fast_path",
      responseType: LiveResponseType.FLOW_INSTRUCTION,
      liveDriverSource: "rule_flow_fast_path",
      reason: "s6_readiness_continue_cpr",
    };
  }

  // WB open-question ack: an immediate stabilizing line that supersedes the
  // (non-critical) deterministic CPR-loop guidance for this turn while the async
  // answer is prepared. Placed after the critical-correction / readiness gates so
  // those always win (corrections are never interrupted).
  if (openQuestionAck) {
    return {
      action: openQuestionAck,
      source: "open_question_ack",
      responseType: LiveResponseType.OPEN_QUESTION_ACK,
      liveDriverSource: "open_question_ack",
      reason: "open_question_ack",
    };
  }

  // "你说我做" CPR coach has been retired: the autonomous loop now drives the
  // CPR phase (silence-by-default + rule corrections), so step_done /
  // compressions_reported no longer voice scripted per-step commands. The
  // continue_cpr readiness fast path above still starts/keeps the loop, and
  // compressions_reported keeps its cpr_state.started link (see inferCprQuality).
  const liveValidation = validateLiveProposal(liveProposal, state, sessionId);
  if (
    liveValidation?.ok &&
    (liveProposal.responseType === LiveResponseType.QUESTION_ANSWER || !isCriticalFlowAction(stateAction))
  ) {
    return {
      action: liveValidation.action,
      source: liveProposal.source || "rule_fast_path",
      responseType: liveProposal.responseType || LiveResponseType.QUESTION_ANSWER,
      liveDriverSource: liveProposal.source || "rule_fast_path",
      reason: "explicit_live_question",
    };
  }

  // Tier-2 授权信封：按 gemma_decision_scope 决定 Gemma 能否在该轮换义。
  //  - 状态机 intent 是 restricted -> 仅润色（换义丢弃）。
  //  - 状态机 intent 是 autonomy 且 Gemma 选的也是 autonomy 子集 -> 允许自选。
  // 显式 allowIntentChange===false 作为硬上限可强制只润色。
  const gemmaAction = gemmaValidation?.action || null;
  const authority = resolveGemmaAuthority({
    stage: state.current_stage,
    stateIntent: stateAction?.intent ?? null,
    gemmaIntent: gemmaAction?.intent ?? null,
  });
  const effectiveAllowIntentChange =
    allowIntentChange === false ? false : authority.allowIntentChange;
  const gemmaDecision = resolveGuidanceAction(stateAction, gemmaValidation, {
    allowIntentChange: effectiveAllowIntentChange,
  });
  const decisionScope = {
    state_intent: stateAction?.intent ?? null,
    gemma_intent: gemmaAction?.intent ?? null,
    state_scope: authority.stateScope,
    gemma_scope: authority.gemmaScope,
    allow_intent_change: effectiveAllowIntentChange,
    priority_rank: guidanceSourceRank(gemmaDecision.source),
  };
  // 可审计：每次仲裁（自选/被拦截/润色）都留结构化记录（intent + scope + source）。
  recordGuidanceArbitration({
    session_id: sessionId,
    stage: state.current_stage ?? null,
    state_intent: decisionScope.state_intent,
    gemma_intent: decisionScope.gemma_intent,
    state_scope: authority.stateScope,
    gemma_scope: authority.gemmaScope,
    allow_intent_change: effectiveAllowIntentChange,
    chosen_source: gemmaDecision.source,
  });
  return {
    ...gemmaDecision,
    responseType: responseTypeForAction(gemmaDecision.action, stateAction),
    liveDriverSource:
      gemmaDecision.source === "gemma_agent" || gemmaDecision.source === "gemma_autonomy"
        ? "gemma_live_driver"
        : null,
    reason: gemmaDecision.source,
    decision_scope: decisionScope,
  };
}

function isCprReadinessFlowFastPath(stateAction, state = {}, userIntent = null, event = null) {
  return (
    userIntent === "continue_cpr" &&
    event?.metadata?.rule_flow_fast_path === CPR_READINESS_FAST_PATH &&
    state?.current_stage === AgentStage.S7_CPR_LOOP &&
    stateAction?.stage === AgentStage.S7_CPR_LOOP &&
    stateAction?.intent === "start_cpr_loop"
  );
}

export function isCriticalFlowAction(action) {
  if (action.priority === "critical") {
    return true;
  }

  if (action.source === "state_machine" && action.priority === "high") {
    return true;
  }

  const tools = Array.isArray(action.tool_actions)
    ? action.tool_actions
    : action.tool_action
      ? [action.tool_action]
      : [];
  return tools.length > 0;
}

function planGemmaSupplement(stateAction, stt, context = {}) {
  const cprLive = isCprLiveContext(context.state, context.event);

  if (!stateAction) {
    return cprLive && stt.transcript
      ? { run: true, reason: null, live: true, timeoutMs: resolveGemmaLiveTimeoutMs(context.options) }
      : { run: false, reason: "no_state_action" };
  }

  if (isCriticalRuleCorrection(stateAction)) {
    return { run: false, reason: "critical_rule_feedback_fast_path", live: cprLive };
  }

  if (stateAction.priority === "critical") {
    return { run: false, reason: "critical_or_tool_state_action", live: cprLive };
  }

  if (context.liveProposal) {
    return { run: false, reason: "live_fast_path_selected", live: cprLive };
  }

  if (isCriticalFlowAction(stateAction) && !cprLive) {
    return { run: false, reason: "critical_or_tool_state_action" };
  }

  if (!stt.transcript) {
    return { run: false, reason: "no_user_input" };
  }

  // WB 开放问答例外：闭集外的提问（detectOpenQuestion）路由给受控问答 Gemma —
  // 即便在非 CPR-live 轮（否则会被下面的 diagnostic_fast_path 跳过）。答案异步生成，
  // 不阻塞当轮（CPR-live 先即时 ack），并被收紧到该 stage 的 autonomy 答句 intent。
  if (isOpenQuestionRoutable(stateAction, stt, context)) {
    return {
      run: true,
      reason: null,
      live: cprLive,
      openQuestion: true,
      timeoutMs: cprLive
        ? resolveGemmaOpenQuestionTimeoutMs(context.options, { live: true })
        : resolveGemmaOpenQuestionTimeoutMs(context.options, { live: false }),
      textTimeoutMs: resolveGemmaOpenQuestionTextTimeoutMs(context.options),
      textMaxTokens: resolveGemmaOpenQuestionTextMaxTokens(context.options),
      textStream: resolveGemmaOpenQuestionTextStream(context.options),
      textStreamMaxChars: resolveGemmaOpenQuestionTextStreamMaxChars(context.options),
      timeoutReason: "gemma_open_question_timeout",
    };
  }

  // 方案①（诊断轮即时）：非 CPR-live 的流程引导轮（S1/S2 等标准话术）不为
  // Gemma 润色阻塞，直接用确定性状态机话术即时响应，降低判断阶段延迟。
  // 这些话术是固定的标准流程句，Gemma 润色收益低；Gemma 仍服务于 CPR-live
  // 轮（S7/S8）的自然语言润色与安抚，那里语言价值更高。
  if (!cprLive) {
    return { run: false, reason: "diagnostic_fast_path" };
  }

  return {
    run: true,
    reason: null,
    live: true,
    timeoutMs: resolveGemmaLiveTimeoutMs(context.options),
  };
}

// True when the current user turn is an open question this stage can safely answer.
function isOpenQuestionRoutable(stateAction, stt, context = {}) {
  const stage = context.state?.current_stage;
  if (!isOpenQuestionStage(stage)) {
    return false;
  }
  return detectOpenQuestion({
    transcript: stt.transcript,
    intent: context.event?.user_input?.intent ?? null,
  });
}

function createSkippedGemma(reason) {
  return {
    ok: true,
    skipped: true,
    skipReason: reason,
    patch: null,
  };
}

function createGemmaLiveDebug(gemma, plan = {}) {
  return {
    skipped: gemma?.skipped === true,
    skipReason: gemma?.skipReason || null,
    timeout_ms: plan.timeoutMs || gemma?.timeout_ms || null,
    stale: gemma?.stale === true,
    live: plan.live === true,
    patch: Boolean(gemma?.patch),
  };
}

function summarizeOpenQuestionAnswer(answer) {
  if (!answer) {
    return null;
  }
  const metrics = answer.openQuestionMetrics || {};
  return {
    ok: answer.ok === true,
    fallback: answer.fallback === true,
    source: answer.source || null,
    response_type: answer.responseType || null,
    reason: answer.reason || null,
    cache_hit: metrics.cache_hit === true || answer.cacheHit === true,
    wait_ms: numberOrNull(metrics.wait_ms),
    timeout_ms: numberOrNull(metrics.timeout_ms),
    action: answer.action || null,
  };
}

function summarizeOpenQuestionChannel(channel) {
  if (!channel) {
    return null;
  }
  return {
    pending: typeof channel.promise?.then === "function",
    cache_hit: channel.cacheHit === true,
    cache_key: channel.cacheKey || null,
    timeout_ms: numberOrNull(channel.timeoutMs),
    started_at_ms: numberOrNull(channel.startedAt),
  };
}

function createGuidanceResponseSnapshot(guidance = {}) {
  return {
    ok: true,
    session_id: guidance.sessionId,
    transcript: guidance.stt?.transcript,
    stt: guidance.stt,
    intent_resolution: guidance.intentResolution,
    event: guidance.event,
    state: guidance.pipeline?.state,
    state_action: guidance.stateAction,
    guidance_action: guidance.guidanceAction,
    guidance_source: guidance.guidanceDecision?.source,
    response_type: guidance.guidanceDecision?.responseType,
    report: guidance.pipeline?.report,
  };
}

async function generateGemmaPatch(runtime, frame, plan = {}) {
  const invoke = () => runtime.generatePatch(frame, {
    ...(plan.promptOptions ? { promptOptions: plan.promptOptions } : {}),
    ...(plan.timeoutMs ? { timeoutMs: plan.timeoutMs } : {}),
  });

  if (!plan.timeoutMs) {
    return invoke();
  }

  const timeoutReason = plan.timeoutReason || (plan.live ? "gemma_live_timeout" : "gemma_turn_timeout");
  return withTimeout(Promise.resolve().then(invoke), plan.timeoutMs, timeoutReason);
}

// WB: build the immediate stabilizing ack (CPR-live only). Routed through the live
// proposal path so it keeps the running metronome (haptic) and a
// do_not_interrupt_critical policy, then validated like any other live answer.
function buildOpenQuestionAck(stage, state, sessionId) {
  const ackProposal = createOpenQuestionAckProposal(stage);
  if (!ackProposal) {
    return null;
  }
  const candidate = liveProposalToGuidanceAction(ackProposal, state, sessionId);
  const validation = validateAction(candidate, state);
  return validation.ok ? validation.action : null;
}

// WB: kick off (but do NOT await) the controlled Q&A answer. Returns a channel
// whose `promise` always resolves to a safe { action, source, responseType } —
// timeouts and illegal/forbidden answers resolve to a deterministic safety
// fallback, never a rejection, so the streaming layer can speak it after the ack.
function startOpenQuestionAnswer({ runtime, frame, plan, state, sessionId, cache = null, options = {} }) {
  const stage = state.current_stage;
  const answerIntents = openQuestionAnswerIntents(stage);
  const answerFrame = buildOpenQuestionFrame(frame, answerIntents);
  const cacheOptions = resolveOpenQuestionCacheOptions(options);
  const cacheKey = buildOpenQuestionCacheKey(answerFrame);
  const cached = readOpenQuestionCache(cache, cacheKey, cacheOptions);
  if (cached) {
    const answer = attachOpenQuestionMetrics(
      {
        ...cached.answer,
        source: "gemma_open_question_cache",
        reason: cached.answer.reason || "open_question_cache_hit",
        cacheHit: true,
      },
      {
        cacheHit: true,
        cacheKey,
        timeoutMs: plan.timeoutMs,
        waitMs: 0,
      }
    );
    return {
      promise: Promise.resolve(answer),
      intents: answerIntents,
      cacheKey,
      cacheHit: true,
      timeoutMs: plan.timeoutMs,
    };
  }

  const templateAnswer = buildOpenQuestionTemplateAnswer({
    stage,
    frame: answerFrame,
    state,
    sessionId,
  });
  if (templateAnswer) {
    const answer = attachOpenQuestionMetrics(templateAnswer, {
      cacheHit: false,
      cacheKey,
      timeoutMs: plan.timeoutMs,
      waitMs: 0,
    });
    return {
      promise: Promise.resolve(answer),
      intents: answerIntents,
      cacheKey,
      cacheHit: false,
      timeoutMs: plan.timeoutMs,
      template: true,
    };
  }

  const startedAt = Date.now();
  const promise = resolveOpenQuestionAnswer({
    runtime,
    frame: answerFrame,
    plan: {
      timeoutMs: plan.timeoutMs,
      live: plan.live,
      textTimeoutMs: plan.textTimeoutMs,
      textMaxTokens: plan.textMaxTokens,
      textStream: plan.textStream,
      textStreamMaxChars: plan.textStreamMaxChars,
      timeoutReason: plan.timeoutReason || "gemma_open_question_timeout",
      promptOptions: { systemPromptFile: OPEN_QUESTION_GEMMA_SYSTEM_PROMPT_FILE },
    },
    state,
    sessionId,
    stage,
    answerIntents,
  })
    .then((answer) => {
      const enriched = attachOpenQuestionMetrics(answer, {
        cacheHit: false,
        cacheKey,
        timeoutMs: plan.timeoutMs,
        waitMs: Date.now() - startedAt,
      });
      if (shouldCacheOpenQuestionAnswer(enriched)) {
        writeOpenQuestionCache(cache, cacheKey, enriched, cacheOptions);
      }
      return enriched;
    })
    .catch((error) => attachOpenQuestionMetrics(
      openQuestionFallback(stage, state, sessionId, "open_question_error", { error }),
      {
        cacheHit: false,
        cacheKey,
        timeoutMs: plan.timeoutMs,
        waitMs: Date.now() - startedAt,
      }
    ));

  return {
    promise,
    intents: answerIntents,
    cacheKey,
    cacheHit: false,
    timeoutMs: plan.timeoutMs,
    startedAt,
  };
}

async function resolveOpenQuestionAnswer({ runtime, frame, plan, state, sessionId, stage, answerIntents }) {
  const validatorIntents = [...answerIntents, ...SPECIAL_GEMMA_INTENTS];
  const textAnswer = await resolveOpenQuestionTextAnswer({
    runtime,
    frame,
    plan,
    state,
    sessionId,
    stage,
    validatorIntents,
  });
  if (textAnswer?.ok) {
    return textAnswer;
  }
  if (textAnswer?.attempted) {
    return openQuestionFallback(stage, state, sessionId, textAnswer.reason || "gemma_text_unavailable");
  }

  const gemma = await generateGemmaPatch(runtime, frame, plan);
  const patch = gemma?.patch || null;

  if (!patch) {
    return openQuestionFallback(stage, state, sessionId, gemma?.skipReason || gemma?.reason || "open_question_no_answer");
  }

  const candidate = toGuidanceCandidate(patch, state, sessionId);
  const validation = validateAction(candidate, state, { allowedIntents: validatorIntents });
  if (!validation.ok || !validation.action?.tts?.text) {
    // Illegal / forbidden / empty answer -> deterministic safety fallback.
    return openQuestionFallback(stage, state, sessionId, "open_question_blocked", { validation });
  }

  // In the CPR loop the answer must never preempt a critical correction or pause
  // the metronome, so force a non-interrupting policy regardless of the patch.
  if (stage === AgentStage.S7_CPR_LOOP || stage === AgentStage.S8_ASSISTANCE) {
    validation.action.tts.interrupt_policy = "do_not_interrupt_critical";
  }

  return {
    ok: true,
    action: validation.action,
    source: "gemma_open_question",
    responseType: LiveResponseType.OPEN_QUESTION_ANSWER,
    reason: "open_question_answered",
  };
}

async function resolveOpenQuestionTextAnswer({ runtime, frame, plan, state, sessionId, stage, validatorIntents }) {
  if (typeof runtime?.generateText !== "function") {
    return { attempted: false, reason: "gemma_text_unavailable" };
  }

  const invokeText = () => runtime.generateText(
    buildOpenQuestionTextMessages(frame, stage),
    {
      timeoutMs: plan.textTimeoutMs || plan.timeoutMs,
      maxTokens: plan.textMaxTokens,
      stream: plan.textStream,
      streamMaxChars: plan.textStreamMaxChars,
      streamStopPattern: "(继续按压|别停|保持按压)",
    }
  );
  const result = plan.textTimeoutMs
    ? await withTimeout(Promise.resolve().then(invokeText), plan.textTimeoutMs, plan.timeoutReason || "gemma_open_question_text_timeout")
    : await invokeText();
  if (!result?.ok || !result.text) {
    return {
      attempted: result?.reason !== "gemma_text_daemon_disabled",
      reason: result?.reason || result?.skipReason || "gemma_text_unavailable",
    };
  }

  const text = normalizeOpenQuestionTextAnswer(result.text);
  if (!text) {
    return { attempted: true, reason: "gemma_text_empty" };
  }

  const candidate = {
    intent: answerIntentsForStage(stage)[0] || "fallback_template",
    tts: { text, tone: "calm_firm", speed: "normal" },
    ui: {
      main_text: "继续按压",
      secondary_text: text,
    },
    reason: "gemma_open_question_text",
    confidence: 0.7,
  };
  const validation = validateAction(
    toGuidanceCandidate(candidate, state, sessionId),
    state,
    { allowedIntents: validatorIntents }
  );
  if (!validation.ok || !validation.action?.tts?.text) {
    return { attempted: true, reason: "gemma_text_blocked", validation };
  }
  if (stage === AgentStage.S7_CPR_LOOP || stage === AgentStage.S8_ASSISTANCE) {
    validation.action.tts.interrupt_policy = "do_not_interrupt_critical";
  }

  return {
    ok: true,
    action: validation.action,
    source: result.streamed ? "gemma_open_question_text_stream" : "gemma_open_question_text",
    responseType: LiveResponseType.OPEN_QUESTION_ANSWER,
    reason: result.streamed ? "open_question_text_stream_answered" : "open_question_text_answered",
  };
}

function answerIntentsForStage(stage) {
  return openQuestionAnswerIntents(stage);
}

// Restrict the answer frame to the stage's controlled-answer intents so both the
// prompt and the validator agree on what Gemma may say.
function buildOpenQuestionFrame(frame, answerIntents) {
  const facts = frame?.facts || {};
  const userInput = frame?.user_input || {};
  const recentTts = Array.isArray(frame?.recent_tts) ? frame.recent_tts.slice(-2) : [];
  const safetyPhrases = Array.isArray(frame?.safety_phrases) ? frame.safety_phrases.slice(0, 3) : [];
  return pruneNullish({
    session_id: frame?.session_id,
    current_stage: frame?.current_stage,
    allowed_intents: [...answerIntents, ...SPECIAL_GEMMA_INTENTS],
    facts: pruneNullish({
      adult_likely: facts.adult_likely,
      scene_safe: facts.scene_safe,
      responsive: facts.responsive,
      normal_breathing: facts.normal_breathing,
      agonal_breathing: facts.agonal_breathing,
      suspected_cardiac_arrest: facts.suspected_cardiac_arrest,
      emergency_call_status: facts.emergency_call_status,
      cpr_started: facts.cpr_started,
      total_compressions: facts.total_compressions,
      current_rate: facts.current_rate,
      average_rate: facts.average_rate,
      quality_score: facts.quality_score,
      last_interruption_seconds: facts.last_interruption_seconds,
      fatigue_level: facts.fatigue_level,
    }),
    user_input: pruneNullish({
      stt_text: typeof userInput.stt_text === "string" ? userInput.stt_text : "",
      intent_hint: userInput.intent_hint,
      confidence: userInput.confidence,
    }),
    perception_summary: compactOpenQuestionPerception(frame?.perception_summary),
    recent_tts: recentTts.map((item) => pruneNullish({
      intent: item?.intent,
      text: typeof item?.text === "string" ? item.text : "",
      seconds_ago: item?.seconds_ago,
    })),
    safety_phrases: safetyPhrases,
    output_schema: frame?.output_schema,
    language: frame?.language || "zh-CN",
  });
}

function buildOpenQuestionTextMessages(frame = {}, stage = AgentStage.S7_CPR_LOOP) {
  const question = frame.user_input?.stt_text || "";
  const stageText = stage === AgentStage.S8_ASSISTANCE
    ? "正在CPR和AED协助"
    : "正在CPR";
  const context = `只用简体中文，必须以“继续按压”开头。成人疑似心脏骤停，${stageText}。施救者问：${question}。只答一句，不超25字；不诊断、不承诺、不新增步骤。`;

  return [{ role: "user", content: context }];
}

function normalizeOpenQuestionTextAnswer(value) {
  let text = String(value || "").trim();
  if (!text) {
    return "";
  }

  text = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.text === "string") {
      text = parsed.text;
    }
  } catch {
    // Plain text is the preferred fast-path output.
  }

  text = text
    .replace(/\*\*/g, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || "";
  text = text
    .replace(/^["'“”]+/u, "")
    .replace(/["'“”]+$/u, "")
    .trim();
  text = pickOpenQuestionSafetySentence(text) || text;

  if (!/(继续按压|别停|保持按压)/u.test(text)) {
    return "";
  }
  if (/(停止按压|可以停|不用按|不要按|一定|保证|心梗|脑卒中|会死)/u.test(text)) {
    return "";
  }
  return text;
}

function pickOpenQuestionSafetySentence(text) {
  const sentences = String(text || "").match(/[^。！？!?.]+[。！？!?.]?/gu) || [];
  return sentences
    .map((sentence) => sentence.trim())
    .find((sentence) => /(继续按压|别停|保持按压)/u.test(sentence)) || "";
}

function compactOpenQuestionPerception(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return undefined;
  }
  const cpr = summary.cpr_quality || summary.cprQuality || {};
  return pruneNullish({
    cpr_quality: cpr && typeof cpr === "object" && !Array.isArray(cpr)
      ? pruneNullish({
          compression_rate_bpm: cpr.compression_rate_bpm ?? cpr.current_rate ?? cpr.compressionRate,
          hand_position: cpr.hand_position ?? cpr.handPosition,
          arm_posture: cpr.arm_posture ?? cpr.armPosture,
          interruption_seconds: cpr.interruption_seconds ?? cpr.interruptionSeconds,
          quality_score: cpr.quality_score ?? cpr.qualityScore,
        })
      : undefined,
  });
}

function buildOpenQuestionCacheKey(frame = {}) {
  const facts = frame.facts || {};
  const factKey = [
    facts.normal_breathing,
    facts.agonal_breathing,
    facts.suspected_cardiac_arrest,
    facts.emergency_call_status,
    facts.cpr_started,
  ].map((item) => item === undefined ? "" : String(item)).join(",");
  return [
    frame.current_stage || "",
    normalizeOpenQuestionBucket(frame.user_input?.stt_text || ""),
    factKey,
  ].join("|");
}

function normalizeOpenQuestionBucket(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:"“”'‘’\s]/g, "")
    .slice(0, 80);
}

function readOpenQuestionCache(cache, key, options = {}) {
  if (!cache || !key) {
    return null;
  }
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.createdAt > options.ttlMs) {
    cache.delete(key);
    return null;
  }
  return cloneJson(entry);
}

function writeOpenQuestionCache(cache, key, answer, options = {}) {
  if (!cache || !key || !answer?.action) {
    return;
  }
  cache.set(key, {
    createdAt: Date.now(),
    answer: cloneOpenQuestionAnswerForCache(answer),
  });
  while (cache.size > options.maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function shouldCacheOpenQuestionAnswer(answer) {
  return answer?.ok === true && answer?.fallback !== true && Boolean(answer.action?.tts?.text);
}

function cloneOpenQuestionAnswerForCache(answer) {
  return cloneJson({
    ok: answer.ok === true,
    action: answer.action,
    source: answer.source || "gemma_open_question",
    responseType: answer.responseType || LiveResponseType.OPEN_QUESTION_ANSWER,
    reason: answer.reason || "open_question_answered",
  });
}

function attachOpenQuestionMetrics(answer, { cacheHit, cacheKey, timeoutMs, waitMs } = {}) {
  if (!answer) {
    return answer;
  }
  return {
    ...answer,
    cacheHit: cacheHit === true,
    openQuestionMetrics: {
      ...(answer.openQuestionMetrics || {}),
      cache_hit: cacheHit === true,
      cache_key: cacheKey || null,
      timeout_ms: numberOrNull(timeoutMs),
      wait_ms: numberOrNull(waitMs),
      fallback: answer.fallback === true,
      reason: answer.reason || null,
    },
  };
}

function resolveOpenQuestionCacheOptions(options = {}) {
  const env = options.env || process.env;
  const ttlMs = firstPositiveNumber(
    options.openQuestionCacheTtlMs,
    options.open_question_cache_ttl_ms,
    env.OPEN_QUESTION_CACHE_TTL_MS,
    DEFAULT_OPEN_QUESTION_CACHE_TTL_MS
  );
  const maxEntries = firstPositiveNumber(
    options.openQuestionCacheMaxEntries,
    options.open_question_cache_max_entries,
    env.OPEN_QUESTION_CACHE_MAX_ENTRIES,
    DEFAULT_OPEN_QUESTION_CACHE_MAX_ENTRIES
  );
  return {
    ttlMs,
    maxEntries,
  };
}

function pruneNullish(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined)
  );
}

// Deterministic safety fallback for a timed-out / illegal open-question answer. In
// CPR-live a short "keep pressing" reassurance is spoken after the ack; elsewhere
// the ack/flow line already covered the turn so no extra answer is spoken.
function openQuestionFallback(stage, state, sessionId, reason, extra = {}) {
  const action = buildOpenQuestionFallbackAction(stage, state, sessionId, reason);
  return {
    ok: false,
    fallback: true,
    action,
    source: "open_question_fallback",
    responseType: LiveResponseType.REASSURANCE,
    reason,
    violations: extra.validation?.violations || [],
  };
}

// Stage-safe fallback spoken lines for a timed-out / blocked open-question answer
// OUTSIDE the CPR loop. Each acknowledges the uncertainty and redirects to that
// stage's deterministic next step WITHOUT inventing any medical fact, so a Gemma
// failure no longer leaves a non-CPR open question answered only by the flow line.
const NON_CPR_OPEN_QUESTION_FALLBACK_TEXT = Object.freeze({
  [AgentStage.S0_INIT]: "这个我先说不准，别紧张，我一直在，我们一步一步来。",
  [AgentStage.S1_SCENE_SAFE]: "这个我先说不准，别紧张，先确认周围安全，再靠近他，我一直在。",
  [AgentStage.S2_CHECK_RESPONSE]: "这个我先说不准，别紧张，先拍他双肩、大声叫他，看他有没有反应，我一直在。",
  [AgentStage.S5_CALL_EMERGENCY]: "这个我先说不准，别紧张，先保持手机免提，准备开始按压，我一直在。",
  [AgentStage.S6_CPR_READY]: "这个我先说不准，别紧张，先把双手放回他胸口中央，准备好就开始按压。",
});

function buildOpenQuestionFallbackAction(stage, state, sessionId, reason) {
  const spec = openQuestionFallbackSpec(stage);
  if (!spec) {
    return null;
  }
  const candidate = {
    intent: spec.intent,
    session_id: sessionId,
    stage,
    source: "open_question_fallback",
    priority: "normal",
    reason_codes: ["open_question_fallback", reason],
    tts: {
      text: spec.text,
      tone: "calm_firm",
      speed: "normal",
      interrupt_policy: "do_not_interrupt_critical",
    },
    ui: { main_text: spec.uiMain, secondary_text: spec.uiSecondary },
    log_event: { type: "open_question_fallback", detail: reason },
  };
  const validation = validateAction(candidate, state);
  return validation.ok ? validation.action : null;
}

// Resolve the deterministic fallback line + a stage-legal intent. CPR-live keeps the
// "继续按压不要停" reassurance; the non-CPR open-question stages draw their intent from
// the stage's own controlled-answer set (so the line still passes ActionValidator) and
// speak a stage-safe redirect instead of staying silent (P2-8).
function openQuestionFallbackSpec(stage) {
  if (stage === AgentStage.S7_CPR_LOOP || stage === AgentStage.S8_ASSISTANCE) {
    return {
      intent: "encourage_rescuer",
      text: OPEN_QUESTION_CPR_FALLBACK_PHRASE,
      uiMain: "继续按压",
      uiSecondary: "跟着节拍，不要停",
    };
  }

  const text = NON_CPR_OPEN_QUESTION_FALLBACK_TEXT[stage];
  const intent = openQuestionAnswerIntents(stage)[0] || null;
  if (!text || !intent) {
    return null;
  }
  return {
    intent,
    text,
    uiMain: "别紧张，我在",
    uiSecondary: "先跟着当前步骤",
  };
}

function buildOpenQuestionTemplateAnswer({ stage, frame, state, sessionId }) {
  const spec = openQuestionTemplateSpec(stage, frame?.user_input?.stt_text || "");
  if (!spec) {
    return null;
  }
  const candidate = {
    intent: spec.intent,
    session_id: sessionId,
    stage,
    source: "open_question_template",
    priority: "normal",
    reason_codes: ["open_question_template", spec.reason],
    tts: {
      text: spec.text,
      tone: "calm_firm",
      speed: "normal",
      interrupt_policy: "do_not_interrupt_critical",
    },
    ui: { main_text: spec.uiMain, secondary_text: spec.uiSecondary },
    log_event: { type: "open_question_template", detail: spec.reason },
  };
  const validation = validateAction(candidate, state);
  if (!validation.ok || !validation.action?.tts?.text) {
    return null;
  }
  return {
    ok: true,
    action: validation.action,
    source: "open_question_template",
    responseType: LiveResponseType.OPEN_QUESTION_ANSWER,
    reason: spec.reason,
  };
}

function openQuestionTemplateSpec(stage, transcript = "") {
  if (stage !== AgentStage.S7_CPR_LOOP && stage !== AgentStage.S8_ASSISTANCE) {
    return null;
  }
  const text = normalizeOpenQuestionBucket(transcript);
  const base = {
    intent: "answer_current_cpr_question",
    uiMain: "继续按压",
    uiSecondary: "别停，等急救员接手",
  };
  if (/(有用|有帮助|管用|值得|意义)/.test(text)) {
    return {
      ...base,
      text: "有帮助，持续按压能帮他维持血流，继续别停。",
      reason: "template_cpr_helps",
    };
  }
  if (/((按压|心肺|cpr|胸口|胸).*(原理|为什么|为何|背后|作用)|(原理|为什么|为何|背后|作用).*(按压|心肺|cpr|胸口|胸))/.test(text)) {
    return {
      ...base,
      text: "按压是在替心脏把血送到大脑和重要器官。现在继续按压，别停。",
      reason: "template_cpr_principle",
    };
  }
  if (/(节奏|频率|快慢|每分钟|为什么.*按|为何.*按)/.test(text)) {
    return {
      ...base,
      text: "这个节奏能维持血流，继续按压别停。",
      reason: "template_cpr_rhythm",
    };
  }
  if (/(下一分钟|接下来|怎么安排|安排什么|之后做什么|后面做什么)/.test(text)) {
    return {
      ...base,
      text: "下一分钟继续按压，有人在旁边就准备换手。",
      reason: "template_next_minute",
    };
  }
  if (/(人工呼吸|口对口|吹气|渡气)/.test(text)) {
    return {
      ...base,
      text: "现在先不要停下来做人工呼吸，继续按压，等AED或急救员。",
      reason: "template_hands_only_cpr",
    };
  }
  if (/(别的办法|其他办法|换.*办法|为什么不能|为何不能|流程.*依据|依据|指南|标准)/.test(text)) {
    return {
      ...base,
      text: "这是急救指南的做法，现在最重要是继续按压。",
      reason: "template_guideline_basis",
    };
  }
  if (/(没力气|没劲|手酸|手臂酸|太累|坚持不住|没人帮|没有人帮)/.test(text)) {
    return {
      ...base,
      text: "能坚持就继续按压，有人靠近时立刻换手。",
      reason: "template_rescuer_fatigue_plan",
    };
  }
  if (/(吐了|呕吐|吐东西|口鼻.*堵|嘴.*堵|气道.*堵)/.test(text)) {
    return {
      ...base,
      text: "先继续按压；口鼻若被堵住，只快速清开口边再继续按压。",
      reason: "template_vomit_airway",
    };
  }
  if (/(地上有水|有水|水里|漏电|触电|电线|电源)/.test(text)) {
    return {
      ...base,
      text: "注意用电安全，能安全就继续按压；用AED前让电极处干燥。",
      reason: "template_environment_safety",
    };
  }
  if (/(我一个人|只有我|没人|没有人|旁边没人)/.test(text)) {
    return {
      ...base,
      text: "你一个人也先继续按压，手机保持免提，有人靠近就让他帮忙。",
      reason: "template_solo_rescuer",
    };
  }
  if (/(搬动|移动|挪动|翻身|扶起来|坐起来|抬起来)/.test(text)) {
    return {
      ...base,
      text: "不要为了处理他而搬动，继续按压；除非现场不安全必须避险。",
      reason: "template_do_not_move_patient",
    };
  }
  if (/(喂水|喝水|喂吃|吃东西|喂药|吃药|找药|拿药|药在哪里|药呢)/.test(text)) {
    return {
      ...base,
      text: "不要喂水喂药，也不要停下来找药；继续按压，等急救员。",
      reason: "template_no_water_or_medicine",
    };
  }
  if (/(掐人中|按人中|拍脸|扇脸|泼水|刺激他)/.test(text)) {
    return {
      ...base,
      text: "不要掐人中或刺激他，现在最重要是继续按压，别停。",
      reason: "template_no_stimulation",
    };
  }
  if (/(摸脉搏|测脉搏|看脉搏|有没有脉搏|还有脉搏|量血压|测血压)/.test(text)) {
    return {
      ...base,
      text: "不要花时间反复测脉搏，继续按压，等AED或急救员接手。",
      reason: "template_no_pulse_check",
    };
  }
  if (/(肋骨|骨折|按坏|压坏|弄断|受伤)/.test(text)) {
    return {
      ...base,
      text: "可能会受伤，但现在继续按压更重要。",
      reason: "template_possible_rib_injury",
    };
  }
  if (/(脸色|脸.*白|发白|发青|发紫|嘴唇.*紫|嘴唇.*青)/.test(text)) {
    return {
      ...base,
      text: "继续按压，脸色变化说明情况紧急，现在按压最重要。",
      reason: "template_pale_or_blue",
    };
  }
  if (/(救回来|救活|活过来|还有希望|能不能活|会不会死)/.test(text)) {
    return {
      ...base,
      text: "现在不能保证结果，继续按压是在为他争取时间。",
      reason: "template_no_outcome_promise",
    };
  }
  if (/(害怕|紧张|慌|我怕|很怕|怎么办)/.test(text)) {
    return {
      ...base,
      text: "害怕很正常，盯着节拍继续按，我陪着你。",
      reason: "template_rescuer_fear",
    };
  }
  return null;
}

async function withTimeout(promise, timeoutMs, reason) {
  let timeout = null;
  const pending = Promise.resolve(promise);
  pending.catch(() => {});

  try {
    return await Promise.race([
      pending,
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          resolve({
            ok: true,
            skipped: true,
            skipReason: reason,
            stale: true,
            timeout_ms: timeoutMs,
            patch: null,
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function timed(timings, key, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timings[key] = Date.now() - start;
  }
}

function validateLiveProposal(liveProposal, state, sessionId) {
  if (!liveProposal) {
    return null;
  }

  const candidate = liveProposalToGuidanceAction(liveProposal, state, sessionId);
  return validateAction(candidate, state);
}

function responseTypeForAction(action, stateAction) {
  if (isCriticalRuleCorrection(action)) {
    return LiveResponseType.CRITICAL_CORRECTION;
  }

  if (action?.source === "gemma_agent") {
    return LiveResponseType.PROACTIVE_COACHING;
  }

  if (stateAction?.intent === action?.intent) {
    return LiveResponseType.FLOW_INSTRUCTION;
  }

  return LiveResponseType.REASSURANCE;
}

function isCriticalRuleCorrection(action) {
  return (
    action?.source === "rule_feedback" &&
    (action.priority === "critical" || action.priority === "high")
  );
}

function isCprLiveContext(state = {}, event = null) {
  return (
    state.current_stage === AgentStage.S7_CPR_LOOP ||
    state.current_stage === AgentStage.S8_ASSISTANCE ||
    event?.stage_hint === AgentStage.S7_CPR_LOOP ||
    event?.stage_hint === AgentStage.S8_ASSISTANCE ||
    isCprVisionEvent(event)
  );
}

function isCprVisionEvent(event = null) {
  return event?.source === "vision_cpr" || event?.event_type === "cpr_quality_update" || Boolean(event?.cpr_quality);
}

function resolveGemmaLiveTimeoutMs(options = {}) {
  return firstPositiveNumber(
    options.gemmaLiveTimeoutMs,
    options.gemma_live_timeout_ms,
    (options.env || process.env).GEMMA_LIVE_TIMEOUT_MS,
    DEFAULT_GEMMA_LIVE_TIMEOUT_MS
  );
}

function resolveGemmaOpenQuestionTimeoutMs(options = {}, { live = false } = {}) {
  const env = options.env || process.env;
  if (live) {
    return firstPositiveNumber(
      options.gemmaOpenQuestionLiveTimeoutMs,
      options.gemma_open_question_live_timeout_ms,
      env.GEMMA_OPEN_QUESTION_LIVE_TIMEOUT_MS,
      options.gemmaOpenQuestionTimeoutMs,
      options.gemma_open_question_timeout_ms,
      env.GEMMA_OPEN_QUESTION_TIMEOUT_MS,
      options.gemmaLiveTimeoutMs,
      options.gemma_live_timeout_ms,
      env.GEMMA_LIVE_TIMEOUT_MS,
      DEFAULT_GEMMA_OPEN_QUESTION_LIVE_TIMEOUT_MS
    );
  }
  return firstPositiveNumber(
    options.gemmaOpenQuestionTurnTimeoutMs,
    options.gemma_open_question_turn_timeout_ms,
    env.GEMMA_OPEN_QUESTION_TURN_TIMEOUT_MS,
    options.gemmaOpenQuestionTimeoutMs,
    options.gemma_open_question_timeout_ms,
    env.GEMMA_OPEN_QUESTION_TIMEOUT_MS,
    options.gemmaTurnTimeoutMs,
    options.gemma_turn_timeout_ms,
    env.GEMMA_TURN_TIMEOUT_MS,
    DEFAULT_GEMMA_OPEN_QUESTION_TURN_TIMEOUT_MS
  );
}

function resolveGemmaOpenQuestionTextTimeoutMs(options = {}) {
  const env = options.env || process.env;
  return firstPositiveNumber(
    options.gemmaOpenQuestionTextTimeoutMs,
    options.gemma_open_question_text_timeout_ms,
    env.GEMMA_OPEN_QUESTION_TEXT_TIMEOUT_MS,
    DEFAULT_GEMMA_OPEN_QUESTION_TEXT_TIMEOUT_MS
  );
}

function resolveGemmaOpenQuestionTextMaxTokens(options = {}) {
  const env = options.env || process.env;
  return firstPositiveNumber(
    options.gemmaOpenQuestionTextMaxTokens,
    options.gemma_open_question_text_max_tokens,
    env.GEMMA_OPEN_QUESTION_TEXT_MAX_TOKENS,
    DEFAULT_GEMMA_OPEN_QUESTION_TEXT_MAX_TOKENS
  );
}

function resolveGemmaOpenQuestionTextStream(options = {}) {
  const env = options.env || process.env;
  const value =
    options.gemmaOpenQuestionTextStream ??
    options.gemma_open_question_text_stream ??
    env.GEMMA_OPEN_QUESTION_TEXT_STREAM;
  if (value === undefined || value === null || value === "") {
    return DEFAULT_GEMMA_OPEN_QUESTION_TEXT_STREAM;
  }
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function resolveGemmaOpenQuestionTextStreamMaxChars(options = {}) {
  const env = options.env || process.env;
  return firstPositiveNumber(
    options.gemmaOpenQuestionTextStreamMaxChars,
    options.gemma_open_question_text_stream_max_chars,
    env.GEMMA_OPEN_QUESTION_TEXT_STREAM_MAX_CHARS,
    DEFAULT_GEMMA_OPEN_QUESTION_TEXT_STREAM_MAX_CHARS
  );
}

export function resolveGemmaTurnTimeoutMs(options = {}) {
  return firstPositiveNumber(
    options.gemmaTurnTimeoutMs,
    options.gemma_turn_timeout_ms,
    (options.env || process.env).GEMMA_TURN_TIMEOUT_MS,
    DEFAULT_GEMMA_TURN_TIMEOUT_MS
  );
}

function toGuidanceCandidate(patch, state, sessionId) {
  return {
    ...patch,
    session_id: sessionId,
    stage: state.current_stage,
    source: "gemma_agent",
    priority: "normal",
    reason_codes: patch.reason ? [patch.reason] : [],
    log_event: {
      type: patch.log_suggestion?.type || patch.intent || "gemma_patch",
      detail: patch.log_suggestion?.detail || patch.reason || patch.intent || "gemma_patch",
    },
  };
}

function getOrCreateSession(sessions, sessionId, now) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      createdAt: now(),
      events: [createSessionStartedEvent(sessionId, now)],
      lastResponse: null,
      openQuestionCache: new Map(),
    };
    sessions.set(sessionId, session);
  }

  return session;
}

function createSessionStartedEvent(sessionId, now) {
  return {
    schema_version: "perception_event.v0.1",
    event_id: createId("evt"),
    session_id: sessionId,
    timestamp: now(),
    mode: "demo_assisted",
    source: "voice_server",
    event_type: "session_started",
    ttl_ms: getVoiceEventTtlMs(),
    metadata: {
      adult_likely: true,
      recording: true,
    },
  };
}

function createVoiceEvent({ sessionId, stt, input, now, intentResolution = null, stage = null }) {
  const resolvedIntent = intentResolution?.intent ?? stt.intent;
  const resolvedConfidence = numberOrNull(intentResolution?.confidence) ?? stt.confidence;
  const resolvedSource = intentResolution?.source || "stt";
  const inferredDeviceState = inferDeviceState(resolvedIntent, stage, intentResolution);
  const inferredCprQuality = inferCprQuality(resolvedIntent, stage);
  const rawSource = input.eventSource || input.event_source || inferEventSource(input);
  const eventType =
    input.eventType ||
    input.event_type ||
    inferEventType(input, resolvedIntent, stage);
  const source = canonicalizeVoiceEventSource(rawSource, eventType, input);
  const sourceMetadata = createCanonicalSourceMetadata(rawSource, source, input.metadata);
  const patientState = mergeResolvedPatientState(
    input.patientState || input.patient_state || null,
    intentResolution,
  );
  const intentMetadata = inferIntentMetadata(resolvedIntent, stt.transcript, intentResolution);

  return {
    schema_version: "perception_event.v0.1",
    event_id: createId("evt"),
    session_id: sessionId,
    timestamp: now(),
    mode: "demo_assisted",
    source,
    event_type: eventType,
    ttl_ms: input.ttlMs || input.ttl_ms || getVoiceEventTtlMs(),
    user_input: {
      stt_text: stt.transcript,
      intent: resolvedIntent,
      confidence: resolvedConfidence,
      source: resolvedSource,
    },
    patient_state: patientState,
    cpr_quality: input.cprQuality || input.cpr_quality || inferredCprQuality,
    rescuer_state: input.rescuerState || input.rescuer_state || null,
    device_state: input.deviceState || input.device_state || inferredDeviceState,
    tool_result: input.toolResult || input.tool_result || null,
    metadata: {
      ...(input.metadata || {}),
      ...sourceMetadata,
      ...intentMetadata,
      ...(intentResolution?.fastPath ? { rule_flow_fast_path: intentResolution.fastPath } : {}),
      audio: stt.audio,
      intent_resolution: createIntentResolutionDebug(intentResolution),
    },
  };
}

function applyClientIntentHint(intentResolution, { input = {}, stage = null } = {}) {
  const hint = resolveClientIntentHint(input);
  if (!hint || !isClientIntentHintAllowed(hint, stage)) {
    return intentResolution;
  }

  return {
    ...(intentResolution || {}),
    ok: true,
    intent: hint,
    slots: intentResolution?.intent === hint ? intentResolution?.slots || {} : {},
    confidence: Math.max(numberOrNull(intentResolution?.confidence) ?? 0, 0.98),
    source: "client_intent_hint",
    needsClarification: false,
    needs_clarification: false,
    escalated: intentResolution?.escalated === true,
    clientIntentHint: true,
  };
}

function applyCprFlowFastPaths(intentResolution, { stt = {}, stage = null } = {}) {
  const withCallBridge = applyS5EmergencyCallBridgeFastPath(intentResolution, { stt, stage });
  return applyCprReadinessFastPath(withCallBridge, { stt, stage });
}

function applyS5EmergencyCallBridgeFastPath(intentResolution, { stt = {}, stage = null } = {}) {
  if (stage !== AgentStage.S5_CALL_EMERGENCY) {
    return intentResolution;
  }

  const existingIntent = intentResolution?.intent ?? stt.intent ?? null;
  if (existingIntent !== "continue_cpr" && !isCprReadinessUtterance(stt.transcript)) {
    return intentResolution;
  }

  return {
    ...(intentResolution || {}),
    ok: true,
    intent: "continue_cpr",
    slots: intentResolution?.slots || {},
    confidence: Math.max(
      numberOrNull(intentResolution?.confidence) ?? 0,
      numberOrNull(stt.confidence) ?? 0,
      0.9,
    ),
    source: intentResolution?.source === "client_intent_hint" ? "client_intent_hint" : "rule_flow_fast_path",
    needsClarification: false,
    needs_clarification: false,
    escalated: intentResolution?.escalated === true,
    fastPath: S5_CALL_TO_CPR_FAST_PATH,
  };
}

function applyCprReadinessFastPath(intentResolution, { stt = {}, stage = null } = {}) {
  if (stage !== AgentStage.S6_CPR_READY) {
    return intentResolution;
  }

  const existingIntent = intentResolution?.intent ?? stt.intent ?? null;
  // At the S6 confirm gate both the readiness phrases the regex enumerates AND any
  // utterance already classified as continue_cpr ("开始按压"/"继续按"/"开始 CPR"/"开始
  // 按压吧"…) mean "start compressions now". The latter previously skipped the fast
  // path (the readiness regex doesn't list every continue_cpr phrasing), so the S6→S7
  // start lost its rule_flow_fast_path tag and its guidance source drifted to
  // state_machine_critical even though the behaviour/wording were correct. Treat an
  // already-continue_cpr intent as a readiness signal so the fastPath flag — and the
  // downstream attribution — stay consistent for every "就绪即开始" utterance.
  if (!isCprReadinessUtterance(stt.transcript) && existingIntent !== "continue_cpr") {
    return intentResolution;
  }

  if (existingIntent && !READINESS_FAST_PATH_OVERRIDABLE_INTENTS.has(existingIntent)) {
    return intentResolution;
  }

  return {
    ...(intentResolution || {}),
    ok: true,
    intent: "continue_cpr",
    slots: intentResolution?.slots || {},
    confidence: Math.max(
      numberOrNull(intentResolution?.confidence) ?? 0,
      numberOrNull(stt.confidence) ?? 0,
      0.92,
    ),
    source: "rule_flow_fast_path",
    needsClarification: false,
    needs_clarification: false,
    escalated: intentResolution?.escalated === true,
    fastPath: CPR_READINESS_FAST_PATH,
  };
}

function isCprReadinessUtterance(transcript = "") {
  const text = normalizeReadinessText(transcript);
  return (
    /^(?:我|我们)?(?:已|已经)?准备好(?:了|啦)?$/.test(text) ||
    /^(?:我|我们)?准备就绪$/.test(text) ||
    /^(?:我|我们)?(?:已|已经)?(?:好|好了|准备好了|准备就绪)(?:可以)?(?:开始|按压|开按)?(?:吧|了)?$/.test(text) ||
    /^(?:好|好的|好啊|好了|行|行了|可以)$/.test(text) ||
    // "开始" / "现在开始" / "这就开始" / "开始吧" / "开始按压" / "开始CPR" …
    /^(?:我|我们)?(?:这就|现在|马上)?开始(?:吧|啊|了|按|按压|胸外按压|心肺复苏|cpr)?$/i.test(text) ||
    /^(?:我|我们)?(?:可以|能)(?:开始|按|按压|压)(?:了|吧)?$/i.test(text) ||
    /^(?:来吧|开始压吧|开始压|开按吧|现在压|马上压|这就压)$/i.test(text) ||
    /^(?:我|我们)?(?:继续|接着)(?:吧|啊|了|按|按压|胸外按压|心肺复苏|cpr)?$/i.test(text) ||
    /^(?:现在)?(?:怎么|如何)(?:开始)?按压$/.test(text) ||
    /^按压(?:怎么做|怎么开始)$/.test(text) ||
    // "可以" / "可以了" / "可以开始" / "可以按了"
    /^可以(?:了|的|开始了?|按了?|按压了?)?$/.test(text) ||
    // Re-confirming arrest at the gate also means "start now".
    /^(?:他)?(?:没有|没|无)(?:正常)?呼吸了?$/.test(text) ||
    /^(?:他)?(?:不|没在|没有在)呼吸了?$/.test(text)
  );
}

function normalizeReadinessText(value) {
  return typeof value === "string"
    ? value.trim().replace(/[。！？!,.，、\s]+$/g, "")
    : "";
}

function resolveClientIntentHint(input = {}) {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const raw =
    input.intent ??
    input.intentHint ??
    input.intent_hint ??
    input.userIntent ??
    input.user_intent ??
    metadata.intent_hint ??
    metadata.intent ??
    null;
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  return normalizeClientIntent(raw.trim());
}

function normalizeClientIntent(intent) {
  return CLIENT_INTENT_ALIASES[intent] || intent;
}

function isClientIntentHintAllowed(intent, stage) {
  if (!intent) {
    return false;
  }
  if (intent === "continue_cpr" || intent === "compressions_reported") {
    return isCprControlStage(stage);
  }
  if (intent === "emergency_called") {
    return isEmergencyCallStage(stage);
  }
  return true;
}

function isCprControlStage(stage) {
  return [
    AgentStage.S5_CALL_EMERGENCY,
    AgentStage.S6_CPR_READY,
    AgentStage.S7_CPR_LOOP,
    AgentStage.S8_ASSISTANCE,
    AgentStage.MONITOR_RESPONSE,
    AgentStage.MONITOR_BREATHING,
  ].includes(stage);
}

function isEmergencyCallStage(stage) {
  return [
    AgentStage.S5_CALL_EMERGENCY,
    AgentStage.S6_CPR_READY,
    AgentStage.S7_CPR_LOOP,
    AgentStage.S8_ASSISTANCE,
  ].includes(stage);
}

function canonicalizeVoiceEventSource(rawSource, eventType, input = {}) {
  if (
    rawSource === "real_perception" &&
    eventType === "cpr_quality_update" &&
    (input.cprQuality || input.cpr_quality)
  ) {
    return "vision_cpr";
  }
  return rawSource;
}

function createCanonicalSourceMetadata(rawSource, source, inputMetadata = {}) {
  if (!rawSource || rawSource === source) {
    return {};
  }
  return {
    raw_event_source: inputMetadata.raw_event_source || rawSource,
    perception_mode: inputMetadata.perception_mode || rawSource,
  };
}

function mergeResolvedPatientState(inputPatientState, intentResolution) {
  const slots = intentResolution?.slots;
  if (!slots || typeof slots !== "object") {
    return inputPatientState || null;
  }

  const patient = inputPatientState && typeof inputPatientState === "object"
    ? { ...inputPatientState }
    : {};
  let changed = false;

  for (const [slot, rawSlot] of Object.entries(slots)) {
    const normalized = normalizeResolvedSlot(rawSlot, intentResolution.nlu?.slots?.[slot]);
    if (!normalized || Object.prototype.hasOwnProperty.call(patient, slot)) {
      continue;
    }

    patient[slot] = normalized.value;
    patient[`${slot}_confidence`] = normalized.confidence;
    patient[`${slot}_source`] = intentResolution.source || "stt";
    changed = true;
  }

  return changed || inputPatientState ? patient : null;
}

function normalizeResolvedSlot(slot, originalSlot) {
  if (slot === null) {
    return { value: null, confidence: numberOrNull(originalSlot?.confidence) };
  }
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(slot, "value")) {
    return null;
  }
  return {
    value: slot.value,
    confidence: numberOrNull(slot.confidence),
  };
}

function createIntentResolutionDebug(intentResolution) {
  if (!intentResolution) {
    return null;
  }

  return {
    intent: intentResolution.intent || null,
    confidence: numberOrNull(intentResolution.confidence),
    source: intentResolution.source || null,
    needs_clarification: intentResolution.needs_clarification === true,
    escalated: intentResolution.escalated === true,
    escalation_reason: intentResolution.escalationReason || null,
    fallback_reason: intentResolution.fallbackReason || null,
    cache_hit: intentResolution.cacheHit === true,
  };
}

function getPriorSessionState(session, input = {}) {
  return input.sessionState || input.session_state || session?.lastResponse?.state || null;
}

function resolveIntentStage(priorState, input = {}, session = null) {
  const explicitStage = input.stage || input.stage_hint || input.currentStage || input.current_stage;
  if (explicitStage) {
    return explicitStage;
  }
  if (priorState?.current_stage) {
    return priorState.current_stage;
  }
  if (Array.isArray(session?.events) && session.events.length > 0) {
    return AgentStage.S1_SCENE_SAFE;
  }
  return AgentStage.S0_INIT;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return Math.floor(number);
    }
  }
  return null;
}

function shouldPrewarmGemmaOnStart(options = {}, env = process.env) {
  const value = options.gemmaPrewarmOnStart ?? options.gemma_prewarm_on_start ?? env.GEMMA_PREWARM_ON_START;
  return value === true || value === "true" || value === "1";
}

function cloneJson(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function resolveNluRuntimeBaseline() {
  try {
    const config = getNluSlotsConfig();
    return config && typeof config.nlu_runtime === "object" && config.nlu_runtime
      ? config.nlu_runtime
      : {};
  } catch {
    return {};
  }
}

function getVoiceEventTtlMs() {
  const fromEnv = Number(process.env.VOICE_EVENT_TTL_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? Math.floor(fromEnv)
    : DEFAULT_VOICE_EVENT_TTL_MS;
}

function inferDeviceState(intent, stage = null, intentResolution = null) {
  const callStarted =
    intent === "emergency_called" ||
    (stage === AgentStage.S5_CALL_EMERGENCY &&
      intent === "continue_cpr" &&
      intentResolution?.fastPath === S5_CALL_TO_CPR_FAST_PATH);
  if (!callStarted) {
    return null;
  }

  return {
    emergency_call_started: true,
    emergency_call_status: "started",
    gps_attached: true,
    recording: true,
  };
}

function inferIntentMetadata(intent, transcript = "", intentResolution = null) {
  if (intent === "aed_available") {
    const softAlias = isSoftAedAlias(transcript);
    return {
      aed_available: true,
      aed_status: "available",
      ...(softAlias
        ? {
            aed_soft_alias: true,
            aed_alias: "pacemaker",
          }
        : {}),
      ...(intentResolution?.source === "phonetic_fuzzy" ? { aed_source: "phonetic_fuzzy" } : {}),
    };
  }

  if (intent === "paramedics_arrived" || intent === "emergency_team_arrived") {
    return { ems_arrived: true };
  }

  return {};
}

function isSoftAedAlias(transcript = "") {
  return /起搏器|心脏起搏/.test(String(transcript || ""));
}

function inferCprQuality(intent, stage = null) {
  // compressions_reported ("按了30次"/"在按了") reuses the same continue_cpr ->
  // cpr_state.started link so the "你说我做" press_30 step can drive S6 -> S7.
  if (intent !== "continue_cpr" && intent !== "compressions_reported") {
    return null;
  }
  if (!isCprStartStage(stage)) {
    return null;
  }

  return {
    started: true,
    compression_rate: 110,
    quality_score: 0.72,
  };
}

function isCprStartStage(stage) {
  return [
    AgentStage.S6_CPR_READY,
    AgentStage.S7_CPR_LOOP,
    AgentStage.S8_ASSISTANCE,
    AgentStage.MONITOR_RESPONSE,
    AgentStage.MONITOR_BREATHING,
  ].includes(stage);
}

function inferEventSource(input = {}) {
  if (input.cprQuality || input.cpr_quality) {
    return "vision_cpr";
  }
  if (input.rescuerState || input.rescuer_state) {
    return "vision_rescuer";
  }
  if (input.deviceState || input.device_state || input.toolResult || input.tool_result) {
    return "device";
  }
  if (input.patientState || input.patient_state || input.perceptionSummary || input.perception_summary) {
    return "vision_patient";
  }
  return "stt";
}

function inferEventType(input = {}, intent, stage = null) {
  if (input.toolResult || input.tool_result) {
    return "tool_result";
  }
  if (input.cprQuality || input.cpr_quality) {
    return "cpr_quality_update";
  }
  if (input.rescuerState || input.rescuer_state) {
    return "rescuer_state_update";
  }
  if (input.deviceState || input.device_state) {
    return "device_state_update";
  }
  if (input.patientState || input.patient_state) {
    const patient = input.patientState || input.patient_state;
    if (
      Object.prototype.hasOwnProperty.call(patient, "normal_breathing") ||
      Object.prototype.hasOwnProperty.call(patient, "agonal_breathing")
    ) {
      return "breathing_update";
    }
    return "patient_state_update";
  }

  if (intent === "paramedics_arrived") {
    return "handover_requested";
  }
  if (intent === "normal_breathing" || intent === "no_normal_breathing") {
    return "breathing_update";
  }
  if (intent === "continue_cpr" && stage === AgentStage.S5_CALL_EMERGENCY) {
    return "device_state_update";
  }
  if (intent === "continue_cpr" || intent === "compressions_reported") {
    return "cpr_quality_update";
  }
  if (intent === "emergency_called") {
    return "device_state_update";
  }
  return "user_response";
}
