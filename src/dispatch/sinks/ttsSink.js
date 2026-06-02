// TtsSink —— 语音播报通道。
//
// 真实端（Android）替换点：用系统 TextToSpeech / sherpa-onnx / 流式 TTS 引擎合成并播放，
//   依据 tone / speed 调整音色与语速；依据 interrupt_policy + priority 做打断 / 排队 / 音频 duck。
// 本 mock 不发声，只返回「将要播报的内容与播报策略」，并记录历史供 demo 观察。

export class TtsSink {
  constructor() {
    this.name = "tts";
    this.history = [];
  }

  supports(action) {
    return hasSpeech(action);
  }

  deliver(action) {
    const tts = action?.tts ?? {};
    const priority = action?.priority ?? "normal";
    const interruptPolicy = tts.interrupt_policy ?? "queue";
    const mode = resolvePlaybackMode(priority, interruptPolicy);

    const utterance = {
      text: tts.text ?? "",
      tone: tts.tone ?? "calm_firm",
      speed: tts.speed ?? "normal",
      interrupt_policy: interruptPolicy,
      mode,
      priority,
    };
    this.history.push(utterance);

    return {
      channel: this.name,
      status: "delivered",
      intent: action?.intent ?? null,
      summary: `[TTS/${mode}] ${utterance.text}`,
      payload: utterance,
    };
  }

  reset() {
    this.history = [];
  }
}

export function hasSpeech(action) {
  const text = action?.tts?.text;
  return typeof text === "string" && text.trim().length > 0;
}

// 播报策略：critical 或 interrupt_lower_priority => 打断当前；never => 强制排队；其余按策略排队。
function resolvePlaybackMode(priority, interruptPolicy) {
  if (interruptPolicy === "never") {
    return "queue";
  }
  if (priority === "critical" || interruptPolicy === "interrupt_lower_priority") {
    return "interrupt";
  }
  if (interruptPolicy === "replace_same_intent") {
    return "replace_same_intent";
  }
  if (interruptPolicy === "do_not_interrupt_critical") {
    return "queue_behind_critical";
  }
  return "queue";
}

export function createTtsSink() {
  return new TtsSink();
}
