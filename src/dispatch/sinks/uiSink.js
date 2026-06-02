// UiSink —— 屏幕渲染通道（always-on，同时充当分发器的「最后兜底」通道）。
//
// 真实端（Android）替换点：把下面返回的 payload 映射到 Compose / View 层的
//   主文案、副文案、状态标签、质量分仪表、视觉叠层(visual_overlay)、主按钮。
// 本 mock 不做真正渲染，只返回结构化 payload，便于交接时核对字段。

const FALLBACK_MAIN_TEXT = "请继续按当前提示操作";
const FALLBACK_SECONDARY_TEXT = "保持冷静，跟随上一条指令，我会尽快给出下一步。";

// priority -> UI 横幅样式提示，真实端可据此决定配色 / 强调级别。
const PRIORITY_BANNER = Object.freeze({
  critical: "alert",
  high: "warning",
  normal: "info",
  low: "muted",
  silent: "muted",
});

export class UiSink {
  constructor() {
    this.name = "ui";
  }

  supports(action) {
    return hasRenderableUi(action);
  }

  deliver(action, context = {}) {
    const ui = action?.ui ?? {};
    const priority = action?.priority ?? "normal";
    const fallbackReason = context.fallbackReason ?? null;
    // 仅当原动作没有可渲染内容、且分发器要求兜底时，才渲染兜底文案。
    const isFallback = Boolean(fallbackReason) && !hasRenderableUi(action);

    const mainText = isFallback ? FALLBACK_MAIN_TEXT : ui.main_text ?? "";
    const secondaryText = isFallback ? FALLBACK_SECONDARY_TEXT : ui.secondary_text ?? "";
    const banner = PRIORITY_BANNER[priority] ?? "info";

    return {
      channel: this.name,
      status: "delivered",
      intent: action?.intent ?? null,
      summary: `[UI/${banner}] ${mainText || "(无主文案)"}`,
      payload: {
        banner,
        main_text: mainText,
        secondary_text: secondaryText,
        status_tags: Array.isArray(ui.status_tags) ? [...ui.status_tags] : [],
        quality_score: ui.quality_score ?? null,
        primary_button: ui.primary_button ?? ui.primary_action ?? null,
        visual_overlay: action?.visual_overlay ?? null,
        fallback: isFallback,
        fallback_reason: isFallback ? fallbackReason : null,
      },
    };
  }
}

// 判断动作是否带有任何可渲染的 UI 内容；分发器据此决定是否需要兜底。
export function hasRenderableUi(action) {
  const ui = action?.ui ?? {};
  if (typeof ui.main_text === "string" && ui.main_text.trim().length > 0) {
    return true;
  }
  if (typeof ui.secondary_text === "string" && ui.secondary_text.trim().length > 0) {
    return true;
  }
  if (Array.isArray(ui.status_tags) && ui.status_tags.length > 0) {
    return true;
  }
  if (ui.quality_score != null) {
    return true;
  }
  if (action?.visual_overlay != null) {
    return true;
  }
  if (ui.primary_button || ui.primary_action) {
    return true;
  }
  return false;
}

export function createUiSink() {
  return new UiSink();
}
