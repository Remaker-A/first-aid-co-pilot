import { createDefaultSinks } from "./sinks/index.js";

// 平台无关的 GuidanceAction 分发器。
//
// 它消费「已通过 src/engine/actionValidator.js 校验的动作」，按 intent / priority / tts / ui /
// haptic / tool 路由到各通道 sink。它本身不假设任何平台，Android / Web / CLI 都可以注入自己的 sink。
//
// ── Sink 接口约定（详见 ./sinks/*.js）─────────────────────────────────────────
//   name: string                          通道名（"ui" | "tts" | "haptic" | "tool" | ...）
//   supports(action): boolean             纯判断、无副作用：该通道是否要处理此动作
//   deliver(action, context): Delivery    执行（mock）副作用并返回结构化记录
//
//   Delivery = {
//     channel: string,
//     status: "delivered" | "blocked" | "skipped" | "error",
//     summary?: string,                   一行人类可读描述（demo 控制台用）
//     payload?: object,                   通道特定结构化数据（真实设备将收到的东西）
//     warnings?: string[],
//   }
//
// ── DispatchResult ───────────────────────────────────────────────────────────
//   {
//     action_id, intent, priority, stage,
//     channels: string[],        本次成功投递（status==="delivered"）的通道名
//     deliveries: Delivery[],    每个被命中的通道的完整记录
//     warnings: string[],
//     fallback: boolean,         是否注入了 UI 兜底提示
//     unknownIntent: boolean,    intent 是否不在已知白名单内
//   }

export const FALLBACK_CHANNEL = "ui";

// 故意保持「静默」的动作：产生 0 个通道也属正常，不需要兜底（例如被校验器降级的让位动作）。
export const DELIBERATELY_SILENT_INTENTS = new Set(["defer_to_critical_action", "noop"]);

export class GuidanceDispatcher {
  constructor(options = {}) {
    this.sinks = options.sinks ?? createDefaultSinks();
    this.logger = options.logger ?? null;
    // 可选的已知 intent 白名单；不传则关闭基于 intent 名的未知检测（仅靠结构化内容兜底）。
    this.knownIntents = options.knownIntents ? new Set(options.knownIntents) : null;
    // 严格模式：critical 动作若一个通道都没命中则直接抛错（默认只上报 warning）。
    this.strictCritical = options.strictCritical === true;
    this.fallbackChannel = options.fallbackChannel ?? FALLBACK_CHANNEL;
  }

  dispatch(action, context = {}) {
    if (!action || typeof action !== "object") {
      throw new TypeError("GuidanceDispatcher.dispatch 需要一个 GuidanceAction 对象");
    }

    const intent = action.intent ?? "unknown";
    const priority = action.priority ?? "normal";
    const knownIntents = context.knownIntents
      ? new Set(context.knownIntents)
      : this.knownIntents;
    const unknownIntent = knownIntents != null && !knownIntents.has(intent);

    const deliveries = [];
    const warnings = [];

    for (const sink of this.sinks) {
      let supported = false;
      try {
        supported = sink.supports(action) === true;
      } catch {
        warnings.push(`sink_supports_error:${sink.name}`);
        continue;
      }
      if (!supported) {
        continue;
      }

      try {
        const delivery = sink.deliver(action, context);
        deliveries.push(delivery);
        if (Array.isArray(delivery?.warnings)) {
          warnings.push(...delivery.warnings);
        }
      } catch (error) {
        deliveries.push({
          channel: sink.name,
          status: "error",
          error: String(error?.message ?? error),
        });
        warnings.push(`sink_deliver_error:${sink.name}`);
      }
    }

    // 「自然通道」= 不依赖兜底、由动作内容本身命中的通道。
    const naturalChannels = deliveries
      .filter((delivery) => delivery.status === "delivered")
      .map((delivery) => delivery.channel);

    if (unknownIntent) {
      warnings.push(`unknown_intent:${intent}`);
    }

    // 兜底：没有任何自然通道命中且不是「故意静默」的动作 => 注入 UI 提示，绝不让用户面对空屏。
    let fallback = false;
    const deliberatelySilent =
      DELIBERATELY_SILENT_INTENTS.has(intent) || priority === "silent";
    if (naturalChannels.length === 0 && !deliberatelySilent) {
      const reason = unknownIntent ? `unknown_intent:${intent}` : "no_channel_delivered";
      fallback = this.#injectFallback(action, context, deliveries, reason);
      if (!fallback) {
        warnings.push("no_fallback_channel");
      }
    }

    // critical 不可吞掉：critical 动作若一个自然通道都没命中，必须显眼上报（严格模式下抛错）。
    if (priority === "critical" && naturalChannels.length === 0) {
      warnings.push(`critical_no_channel:${intent}`);
      if (this.strictCritical) {
        throw new Error(`critical GuidanceAction 未能分发到任何通道: ${intent}`);
      }
    }

    const channels = deliveries
      .filter((delivery) => delivery.status === "delivered")
      .map((delivery) => delivery.channel);

    const result = {
      action_id: action.action_id ?? null,
      intent,
      priority,
      stage: action.stage ?? null,
      channels,
      deliveries,
      warnings,
      fallback,
      unknownIntent,
    };

    this.#log(result);
    return result;
  }

  dispatchAll(actions = [], context = {}) {
    const list = Array.isArray(actions) ? actions : [];
    return list.map((action) => this.dispatch(action, context));
  }

  #injectFallback(action, context, deliveries, reason) {
    const uiSink = this.sinks.find((sink) => sink.name === this.fallbackChannel);
    if (!uiSink) {
      return false;
    }
    const delivery = uiSink.deliver(action, { ...context, fallbackReason: reason });
    const existingIndex = deliveries.findIndex(
      (item) => item.channel === this.fallbackChannel
    );
    if (existingIndex >= 0) {
      deliveries[existingIndex] = delivery;
    } else {
      deliveries.push(delivery);
    }
    return true;
  }

  #log(result) {
    if (!this.logger) {
      return;
    }
    const log = typeof this.logger === "function" ? this.logger : this.logger.log;
    if (typeof log === "function") {
      log.call(this.logger, result);
    }
    if (result.warnings.length > 0 && typeof this.logger.warn === "function") {
      this.logger.warn.call(this.logger, result.warnings, result);
    }
  }
}

export function createGuidanceDispatcher(options = {}) {
  return new GuidanceDispatcher(options);
}

export default GuidanceDispatcher;
