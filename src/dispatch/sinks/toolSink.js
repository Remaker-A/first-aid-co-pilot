import {
  getToolType,
  isConfirmationRequestTool,
  isCriticalTool,
  isShareTool,
  isToolConfirmed,
  listSystemTools,
} from "./toolPolicy.js";
import { buildEmergencyCallDemoDetail } from "./emergencyCallDemoTool.js";

// ToolSink —— 系统工具通道（拨打120 / GPS / 本地录制 / 生成交接报告 / 分享外发等）。
//
// 真实端（Android）替换点：把每个 outcome === "executed" 的分支替换为真实系统调用：
//   emergency_call        -> Intent.ACTION_CALL / TelecomManager.placeCall；
//   attach_gps_location   -> FusedLocationProviderClient.getCurrentLocation；
//   start_local_recording -> MediaRecorder / CameraX VideoCapture；
//   generate_handover_report -> 报告生成 + 本地落盘；
//   share_* / send_*      -> 系统 ShareSheet / 网络上传（务必在用户确认之后）；
//   delete_video          -> 删除本地文件。
//
// 防御原则（即便上游已校验，分发层仍兜底）：
//   - critical 工具（拨打急救电话）绝不因确认 / 权限被吞掉，永远执行；
//   - 分享 / 外发 / 删除类工具未确认前只 block，不执行，且 block 必须被上报（不可静默）。

export class ToolSink {
  constructor() {
    this.name = "tool";
  }

  supports(action) {
    return listSystemTools(action).length > 0;
  }

  deliver(action, context = {}) {
    const tools = listSystemTools(action);
    const results = tools.map((tool) => this.#dispatchTool(tool, action, context));
    const warnings = results.flatMap((result) => result.warnings ?? []);
    const anySuccess = results.some(
      (result) => result.outcome === "executed" || result.outcome === "prompted"
    );

    return {
      channel: this.name,
      // 没有任何工具被真正执行 / 弹确认时标记为 blocked，便于分发器据此决定是否兜底。
      status: anySuccess ? "delivered" : "blocked",
      intent: action?.intent ?? null,
      summary: `[TOOL] ${results.map((result) => `${result.type}:${result.outcome}`).join(", ")}`,
      payload: { tools: results },
      warnings,
    };
  }

  #dispatchTool(tool, action, context) {
    const type = getToolType(tool) || "<missing>";
    const priority = action?.priority ?? "normal";
    const warnings = [];

    if (type === "<missing>") {
      warnings.push("unknown_tool:<missing>");
      return { type, outcome: "unknown_tool", warnings };
    }

    // 关键工具（拨打急救电话）：永不拦截。
    if (isCriticalTool(tool)) {
      const detail = buildEmergencyCallDemoDetail(tool, action, context);
      warnings.push(...detail.warnings);
      return {
        type,
        outcome: "executed",
        critical: true,
        detail,
        warnings,
      };
    }

    // 分享 / 外发 / 删除：未确认 => 阻断（但要上报，不可吞掉）。
    if (isShareTool(tool)) {
      if (isToolConfirmed(tool, context)) {
        return { type, outcome: "executed", confirmed: true, warnings };
      }
      warnings.push(`tool_blocked_requires_confirmation:${type}`);
      if (priority === "critical") {
        // 防御：critical 动作里若挂了未确认的分享工具，必须显眼上报。
        warnings.push(`critical_tool_blocked:${type}`);
      }
      return {
        type,
        outcome: "blocked_requires_confirmation",
        confirmed: false,
        reason: "需要用户确认后才能分享 / 外发",
        warnings,
      };
    }

    // 请求确认类工具：本身就是弹确认框。
    if (isConfirmationRequestTool(tool)) {
      if (tool.requires_user_confirmation === false) {
        warnings.push(`tool_confirmation_flag_missing:${type}`);
      }
      return { type, outcome: "prompted", detail: "向用户弹出确认请求", warnings };
    }

    // 其余系统工具（GPS / 录制 / 生成报告 / 检查权限 等）：mock 直接执行。
    return { type, outcome: "executed", warnings };
  }
}

export function createToolSink() {
  return new ToolSink();
}
