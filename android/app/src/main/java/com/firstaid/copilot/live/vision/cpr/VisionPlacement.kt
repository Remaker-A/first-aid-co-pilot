package com.firstaid.copilot.live.vision.cpr

enum class VisionCameraFacing(val eventValue: String) {
    Front("front"),
    Back("back"),
}

enum class VisionCameraMount(val eventValue: String, val canAttemptLiveRecognition: Boolean) {
    SideFixed("side_fixed", true),
    BystanderHandheld("bystander_handheld", true),
    Handheld("handheld", false),
    Unusable("unusable", false),
    Unknown("unknown", false),
}

enum class PhonePlacement {
    SideFixed,
    BystanderHandheld,
    RescuerHandheld,
    FlatOnGround,
    Unknown,
}

data class VisionReadiness(
    val ready: Boolean,
    val reason: String?,
)

fun cameraMountForPlacement(placement: PhonePlacement): VisionCameraMount =
    when (placement) {
        PhonePlacement.SideFixed -> VisionCameraMount.SideFixed
        PhonePlacement.BystanderHandheld -> VisionCameraMount.BystanderHandheld
        PhonePlacement.RescuerHandheld -> VisionCameraMount.Handheld
        PhonePlacement.FlatOnGround -> VisionCameraMount.Unusable
        PhonePlacement.Unknown -> VisionCameraMount.Unknown
    }

fun evaluateVisionReadiness(
    confidence: Double?,
    visionReady: Boolean?,
    cameraMount: String?,
    poseCoverage: Double?,
    frameStability: Double?,
): VisionReadiness {
    val safeConfidence = confidence ?: return VisionReadiness(false, "missing_confidence")
    if (safeConfidence < LIVE_CONFIDENCE_THRESHOLD) {
        return VisionReadiness(false, "low_confidence")
    }

    val mount = VisionCameraMount.entries.firstOrNull { it.eventValue == cameraMount }
        ?: VisionCameraMount.Unknown
    if (!mount.canAttemptLiveRecognition) {
        return VisionReadiness(false, "camera_mount_${mount.eventValue}")
    }

    if ((poseCoverage ?: 0.0) < LIVE_POSE_COVERAGE_THRESHOLD) {
        return VisionReadiness(false, "low_pose_coverage")
    }
    if ((frameStability ?: 0.0) < LIVE_FRAME_STABILITY_THRESHOLD) {
        return VisionReadiness(false, "unstable_frame")
    }
    if (visionReady != true) {
        return VisionReadiness(false, "not_ready")
    }

    return VisionReadiness(true, null)
}

const val LIVE_CONFIDENCE_THRESHOLD = 0.75
const val LIVE_POSE_COVERAGE_THRESHOLD = 0.75
const val LIVE_FRAME_STABILITY_THRESHOLD = 0.75
