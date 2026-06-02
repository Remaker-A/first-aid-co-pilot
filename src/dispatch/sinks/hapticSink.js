import { getToolType, listHapticTools } from "./toolPolicy.js";

// HapticSink —— 震动 / 节拍器通道（独占「马达」这一硬件资源）。
//
// 输入有两种表达，本 sink 统一消费：
//   1) action.haptic = { enabled, pattern, bpm }  声明式：当前是否需要节拍震动；
//   2) tool_actions 里的 start/update/stop_haptic_metronome  命令式：显式控制。
//
// 真实端（Android）替换点：用 VibratorManager / Vibrator + VibrationEffect.createWaveform
//   按 bpm 生成周期性波形；收到 stop 时调用 cancel()。注意与音频 / TTS 的资源协调。
// 本 mock 仅维护一个内存里的「马达状态」，并返回将要执行的指令。

const DEFAULT_BPM = 110;

export class HapticSink {
  constructor() {
    this.name = "haptic";
    this.running = false;
    this.bpm = null;
    this.pattern = null;
  }

  supports(action) {
    if (action?.haptic?.enabled === true) {
      return true;
    }
    return listHapticTools(action).length > 0;
  }

  deliver(action) {
    const hapticTools = listHapticTools(action);
    const stopRequested = hapticTools.some(
      (tool) => getToolType(tool) === "stop_haptic_metronome"
    );

    if (stopRequested) {
      const wasRunning = this.running;
      const stoppedBpm = this.bpm;
      this.running = false;
      this.bpm = null;
      this.pattern = null;
      return this.#delivery("stop", {
        pattern: null,
        bpm: stoppedBpm,
        running: false,
        was_running: wasRunning,
      });
    }

    // start / update：合并声明式 haptic 与命令式 tool 的参数。
    const declared = action?.haptic ?? {};
    const toolWithBpm = hapticTools.find((tool) => typeof tool.bpm === "number");
    const bpm = firstNumber(declared.bpm, toolWithBpm?.bpm) ?? DEFAULT_BPM;
    const pattern = declared.pattern ?? toolWithBpm?.pattern ?? "metronome";
    const command = this.running ? "update" : "start";
    const changed = !this.running || this.bpm !== bpm || this.pattern !== pattern;

    this.running = true;
    this.bpm = bpm;
    this.pattern = pattern;

    return this.#delivery(command, { pattern, bpm, running: true, changed });
  }

  #delivery(command, payload) {
    return {
      channel: this.name,
      status: "delivered",
      command,
      summary: `[HAPTIC/${command}] pattern=${payload.pattern ?? "-"} bpm=${payload.bpm ?? "-"}`,
      payload: { command, ...payload },
    };
  }

  reset() {
    this.running = false;
    this.bpm = null;
    this.pattern = null;
  }

  getState() {
    return { running: this.running, bpm: this.bpm, pattern: this.pattern };
  }
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

export function createHapticSink() {
  return new HapticSink();
}
