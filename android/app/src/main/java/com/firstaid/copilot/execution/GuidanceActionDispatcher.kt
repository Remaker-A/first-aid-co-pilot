package com.firstaid.copilot.execution

class GuidanceActionDispatcher(
    private val sinks: List<GuidanceSink> = defaultExecutionSinks(),
    private val knownIntents: Set<String>? = null,
    private val strictCritical: Boolean = false,
    private val fallbackChannel: String = ExecutionChannel.UI.value
) {
    fun dispatch(
        action: GuidanceAction,
        context: DispatchContext = DispatchContext()
    ): DispatchResult {
        val warnings = mutableListOf<String>()
        val deliveries = mutableListOf<Delivery>()
        val activeKnownIntents = context.knownIntents ?: knownIntents
        val unknownIntent = activeKnownIntents != null && action.intent !in activeKnownIntents

        sinks.forEach { sink ->
            val supported = runCatching { sink.supports(action, context) }
                .getOrElse {
                    warnings += "sink_supports_error:${sink.name}"
                    false
                }

            if (supported) {
                val delivery = runCatching { sink.deliver(action, context) }
                    .getOrElse {
                        Delivery(
                            channel = sink.name,
                            status = DeliveryStatus.ERROR,
                            error = it.message ?: it.toString(),
                            warnings = listOf("sink_deliver_error:${sink.name}")
                        )
                    }
                deliveries += delivery
                warnings += delivery.warnings
            }
        }

        val naturalChannels = deliveries
            .filter { it.status == DeliveryStatus.DELIVERED }
            .map { it.channel }

        if (unknownIntent) {
            warnings += "unknown_intent:${action.intent}"
        }

        var fallback = false
        if (naturalChannels.isEmpty() && !action.isSilent) {
            val reason = if (unknownIntent) {
                "unknown_intent:${action.intent}"
            } else {
                "no_channel_delivered"
            }
            fallback = injectUiFallback(action, context, deliveries, reason)
            if (!fallback) {
                warnings += "no_fallback_channel"
            }
        }

        if (action.isCritical && naturalChannels.isEmpty()) {
            warnings += "critical_no_channel:${action.intent}"
            if (strictCritical) {
                throw IllegalStateException(
                    "critical GuidanceAction was not delivered to any natural channel: ${action.intent}"
                )
            }
        }

        val channels = deliveries
            .filter { it.status == DeliveryStatus.DELIVERED }
            .map { it.channel }

        return DispatchResult(
            action_id = action.action_id,
            intent = action.intent,
            priority = action.priority,
            stage = action.stage,
            channels = channels,
            deliveries = deliveries,
            warnings = warnings.distinct(),
            fallback = fallback,
            unknownIntent = unknownIntent
        )
    }

    fun dispatchAll(
        actions: List<GuidanceAction>,
        context: DispatchContext = DispatchContext()
    ): List<DispatchResult> = actions.map { dispatch(it, context) }

    private fun injectUiFallback(
        action: GuidanceAction,
        context: DispatchContext,
        deliveries: MutableList<Delivery>,
        reason: String
    ): Boolean {
        val uiSink = sinks.firstOrNull { it.name == fallbackChannel } ?: return false
        val delivery = runCatching {
            uiSink.deliver(action, context.copy(fallbackReason = reason))
        }.getOrElse {
            Delivery(
                channel = uiSink.name,
                status = DeliveryStatus.ERROR,
                error = it.message ?: it.toString(),
                warnings = listOf("fallback_deliver_error:${uiSink.name}")
            )
        }

        val existingIndex = deliveries.indexOfFirst { it.channel == fallbackChannel }
        if (existingIndex >= 0) {
            deliveries[existingIndex] = delivery
        } else {
            deliveries += delivery
        }
        return delivery.status == DeliveryStatus.DELIVERED
    }
}

fun defaultExecutionSinks(): List<GuidanceSink> = listOf(
    UiActionRenderer(),
    MockAndroidTtsSink(),
    MockAndroidHapticSink(),
    AndroidToolExecutor()
)
