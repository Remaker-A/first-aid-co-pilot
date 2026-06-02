// 工具动作（tool_actions）的分类与防御策略。
//
// 这里集中定义「哪类工具属于哪个通道」以及「哪类工具必须用户确认 / 不可被吞掉」，
// 让 toolSink 与 hapticSink 共享同一套口径，并与 src/engine/actionValidator.js 的约束保持一致。
//
// Dispatcher 消费的是「已通过 ActionValidator 的动作」，但分发层仍做一次防御：
// 即便上游漏判，也不能把拨打急救电话这类关键工具静默吞掉，或在未确认时直接分享外发。

// 震动节拍器相关工具：由 hapticSink 拥有（真实端 = 控制马达 / VibratorManager）。
export const HAPTIC_TOOL_TYPES = new Set([
  "start_haptic_metronome",
  "update_haptic_metronome",
  "stop_haptic_metronome",
]);

// 真正会「外发 / 分享 / 删除」的工具：执行前必须拿到用户确认（与 actionValidator 的 SHARE_TOOL_TYPES 对齐）。
export const SHARE_TOOL_TYPES = new Set([
  "share_report",
  "share_video",
  "send_report",
  "send_video",
  "delete_video",
]);

// 「请求确认」类工具：本身就是弹一个确认框，requires_user_confirmation 不应为 false。
export const CONFIRMATION_REQUEST_TOOL_TYPES = new Set([
  "request_share_report",
  "request_share_video",
]);

// 关键、不可吞掉的工具：拨打急救电话。dispatcher 永不因确认 / 权限把它拦下。
export const CRITICAL_TOOL_TYPES = new Set(["emergency_call", "mock_emergency_call"]);

export function getToolType(tool) {
  if (!tool || typeof tool !== "object") {
    return "";
  }
  return tool.type || tool.tool || tool.name || "";
}

export function isHapticTool(tool) {
  return HAPTIC_TOOL_TYPES.has(getToolType(tool));
}

export function isShareTool(tool) {
  return SHARE_TOOL_TYPES.has(getToolType(tool));
}

export function isConfirmationRequestTool(tool) {
  return CONFIRMATION_REQUEST_TOOL_TYPES.has(getToolType(tool));
}

export function isCriticalTool(tool) {
  return CRITICAL_TOOL_TYPES.has(getToolType(tool));
}

// 系统工具 = 一切非震动类工具（拨号 / GPS / 录制 / 分享 / 生成报告 / 未知工具），由 toolSink 拥有。
// 注意：连类型缺失的畸形工具也归到这里，确保它们被显式上报为 unknown_tool 而不是被悄悄丢弃。
export function isSystemTool(tool) {
  if (!tool || typeof tool !== "object") {
    return false;
  }
  return !HAPTIC_TOOL_TYPES.has(getToolType(tool));
}

export function listTools(action) {
  const tools = action?.tool_actions ?? action?.tool_action ?? [];
  const list = Array.isArray(tools) ? tools : [tools];
  return list.filter((tool) => tool && typeof tool === "object");
}

export function listSystemTools(action) {
  return listTools(action).filter(isSystemTool);
}

export function listHapticTools(action) {
  return listTools(action).filter(isHapticTool);
}

// 是否已获得用户确认。两条来源任一满足即视为已确认：
//   1) 工具自带确认字段（与 actionValidator.hasUserConfirmation 一致）；
//   2) 运行时 context.confirmations 授予（模拟用户在 UI 上点了「确认」）。
export function isToolConfirmed(tool, context = {}) {
  if (
    tool?.requires_user_confirmation === true &&
    (tool.user_confirmed === true ||
      tool.confirmed_by_user === true ||
      tool.confirmation?.confirmed === true)
  ) {
    return true;
  }

  const confirmations = context.confirmations;
  if (!confirmations) {
    return false;
  }

  const type = getToolType(tool);
  const id = tool?.id ?? tool?.tool_id ?? null;

  if (confirmations instanceof Set) {
    return confirmations.has(type) || (id != null && confirmations.has(id));
  }
  if (Array.isArray(confirmations)) {
    return confirmations.includes(type) || (id != null && confirmations.includes(id));
  }
  if (typeof confirmations === "object") {
    return confirmations[type] === true || (id != null && confirmations[id] === true);
  }
  return false;
}
