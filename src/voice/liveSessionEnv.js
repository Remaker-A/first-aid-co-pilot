/**
 * 把进程环境变量解析成可注入 LiveSession 的安全特性开关。
 *
 * 设计原则：**全部默认 OFF**。未设置任何变量时 resolve 返回 `{}`，所以
 * `npm run voice:serve` 的默认事件契约与延迟特性字节不变；要在真机/真实链路
 * 启用某项，只需在 `.env` 显式打开（server.js 入口已 loadEnv 到 process.env）。
 *
 * 支持的开关：
 * | 环境变量 | 作用 | LiveSession 选项 |
 * | --- | --- | --- |
 * | `STT_FINAL_REVIEW` | 对命中呼吸/否定关键词的流式 final 触发一次异构离线 STT 复核（zipformer→SenseVoice 纠偏） | `finalReview: true` |
 * | `VOICE_BARGE_IN_ENERGY_GATE` | 服务端能量门控，作为客户端 VAD 的 barge-in 兜底（外放/嘈杂环境双保险） | `bargeIn.energyGate: true` |
 * | `VOICE_BARGE_IN_RMS` | 能量门控的 RMS 阈值（0~1），真机调参用 | `bargeIn.rmsThreshold` |
 * | `VOICE_BARGE_IN_MIN_SPEECH_MS` | 触发兜底所需的持续语音毫秒数 | `bargeIn.minSpeechMs` |
 */

const TRUTHY = new Set(["1", "on", "true", "yes", "enable", "enabled"]);
const FALSY = new Set(["0", "off", "false", "no", "disable", "disabled"]);

/** 解析布尔型环境变量；无法识别（含未设置）返回 undefined，便于上层区分“未配置”。 */
export function parseEnvFlag(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.has(normalized)) {
    return true;
  }
  if (FALSY.has(normalized)) {
    return false;
  }
  return undefined;
}

/** 解析正数型环境变量；非有限正数（含未设置）返回 undefined。 */
export function parsePositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

/**
 * 从环境变量构造 LiveSession 安全特性选项。只产出被显式开启的字段，未配置项
 * 一律省略，保证默认 OFF。
 */
export function resolveLiveSessionEnvOptions(env = process.env) {
  const options = {};

  if (parseEnvFlag(env.STT_FINAL_REVIEW) === true) {
    options.finalReview = true;
  }

  const bargeIn = {};
  if (parseEnvFlag(env.VOICE_BARGE_IN_ENERGY_GATE) === true) {
    bargeIn.energyGate = true;
  }
  const rmsThreshold = parsePositiveNumber(env.VOICE_BARGE_IN_RMS);
  if (rmsThreshold !== undefined) {
    bargeIn.rmsThreshold = rmsThreshold;
  }
  const minSpeechMs = parsePositiveNumber(env.VOICE_BARGE_IN_MIN_SPEECH_MS);
  if (minSpeechMs !== undefined) {
    bargeIn.minSpeechMs = minSpeechMs;
  }
  if (Object.keys(bargeIn).length > 0) {
    options.bargeIn = bargeIn;
  }

  return options;
}

/**
 * 合并“显式注入选项”与“环境变量解析结果”，显式注入始终优先，确保测试与编程式
 * 调用方能覆盖 env。`bargeIn` 做浅合并，使得（例如）env 开门控、显式调阈值能共存。
 */
export function mergeLiveSessionEnvOptions(explicit = {}, env = process.env) {
  const fromEnv = resolveLiveSessionEnvOptions(env);
  const merged = { ...fromEnv, ...explicit };
  if (fromEnv.bargeIn || explicit.bargeIn) {
    merged.bargeIn = { ...(fromEnv.bargeIn || {}), ...(explicit.bargeIn || {}) };
  }
  return merged;
}
