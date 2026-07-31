package com.firstaid.copilot.perception

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

data class CameraDeviceState(
    val available: Boolean,
    val permission: String,
    val previewActive: Boolean,
    val facing: String = "back",
    val streamStatus: String = if (previewActive) "previewing" else "idle",
) {
    fun toDeviceStateMap(): Map<String, Any?> = mapOf(
        "camera_available" to available,
        "camera_permission" to permission,
        "camera_facing" to facing,
        "camera_preview_active" to previewActive,
        "camera_stream_status" to streamStatus,
    )
}

data class CameraFrameSignal(
    val frameId: String,
    val width: Int,
    val height: Int,
    val rotationDegrees: Int,
    val brightness: Double,
    val brightnessLabel: String,
    val motionScore: Double,
    val motionLabel: String,
    val cameraFacing: String = "back",
    val recognitionStatus: String = "frame_signal_only",
) {
    fun toPayloadMap(): Map<String, Any?> = mapOf(
        "frame_id" to frameId,
        "width" to width,
        "height" to height,
        "rotation_degrees" to rotationDegrees,
        "brightness" to brightness,
        "brightness_label" to brightnessLabel,
        "motion_score" to motionScore,
        "motion_label" to motionLabel,
        "camera_facing" to cameraFacing,
        "recognition_status" to recognitionStatus,
    )
}

data class CameraPerceptionEvent(
    val eventId: String,
    val sessionId: String,
    val timestamp: String,
    val source: String,
    val eventType: String,
    val deviceState: Map<String, Any?>,
    val metadata: Map<String, Any?> = emptyMap(),
) {
    fun toPayloadMap(): Map<String, Any?> = mapOf(
        "schema_version" to "perception_event.v0.1",
        "event_id" to eventId,
        "session_id" to sessionId,
        "timestamp" to timestamp,
        "mode" to "real_perception",
        "source" to source,
        "event_type" to eventType,
        "ttl_ms" to 1500,
        "user_input" to null,
        "patient_state" to null,
        "cpr_quality" to null,
        "rescuer_state" to null,
        "device_state" to deviceState,
        "metadata" to metadata,
    )

    fun toJsonString(): String = toJsonValue(toPayloadMap()).toString()

    fun toLogLine(): String =
        "$source:$eventType event=$eventId camera=${deviceState["camera_stream_status"]}"
}

class CameraPerceptionBridge(
    private val sessionId: String,
    private val now: () -> String = { Instant.now().toString() },
    private val idFactory: () -> String = { "evt_android_camera_${UUID.randomUUID()}" },
) {
    fun deviceStateEvent(state: CameraDeviceState): CameraPerceptionEvent =
        CameraPerceptionEvent(
            eventId = idFactory(),
            sessionId = sessionId,
            timestamp = now(),
            source = "device",
            eventType = "device_state_update",
            deviceState = state.toDeviceStateMap(),
        )

    fun frameSignalEvent(signal: CameraFrameSignal): CameraPerceptionEvent =
        CameraPerceptionEvent(
            eventId = idFactory(),
            sessionId = sessionId,
            timestamp = now(),
            source = "device",
            eventType = "device_state_update",
            deviceState = CameraDeviceState(
                available = true,
                permission = "granted",
                previewActive = true,
                facing = signal.cameraFacing,
                streamStatus = "analyzing",
            ).toDeviceStateMap(),
            metadata = mapOf(
                "camera_frame_signal" to signal.toPayloadMap(),
                "perception_boundary" to
                    "Frame signal only; no patient_state, cpr_quality, or rescuer_state recognition emitted.",
            ),
        )
}

private fun toJsonValue(value: Any?): Any? =
    when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { json ->
            value.forEach { (key, childValue) ->
                json.put(key.toString(), toJsonValue(childValue))
            }
        }
        is Iterable<*> -> JSONArray().also { array ->
            value.forEach { array.put(toJsonValue(it)) }
        }
        else -> value
    }
