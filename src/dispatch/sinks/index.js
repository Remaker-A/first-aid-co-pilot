export { UiSink, createUiSink, hasRenderableUi } from "./uiSink.js";
export { TtsSink, createTtsSink, hasSpeech } from "./ttsSink.js";
export { HapticSink, createHapticSink } from "./hapticSink.js";
export { ToolSink, createToolSink } from "./toolSink.js";
export * from "./emergencyCallDemoTool.js";
export * from "./toolPolicy.js";

import { createUiSink } from "./uiSink.js";
import { createTtsSink } from "./ttsSink.js";
import { createHapticSink } from "./hapticSink.js";
import { createToolSink } from "./toolSink.js";

// 默认通道集合。数组顺序即分发记录的展示顺序；
// dispatcher 会按 name 找到 ui 通道作为兜底，与顺序无关。
export function createDefaultSinks() {
  return [createUiSink(), createTtsSink(), createHapticSink(), createToolSink()];
}
