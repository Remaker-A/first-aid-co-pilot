export function isActionableCprQualityEvent(event) {
  if (!event?.cpr_quality || typeof event.cpr_quality !== "object") {
    return false;
  }

  if (!isVisionCprEvent(event)) {
    return true;
  }

  return !isExplicitRecordingOnlyVisionEvent(event);
}

export function isExplicitRecordingOnlyVisionEvent(event) {
  const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const quality = event?.cpr_quality && typeof event.cpr_quality === "object" ? event.cpr_quality : {};

  return (
    metadata.perception_mode === "recording_only" ||
    metadata.vision_ready === false ||
    quality.vision_ready === false ||
    metadata.camera_mount === "unusable"
  );
}

function isVisionCprEvent(event) {
  return event?.source === "vision_cpr" || event?.event_type === "cpr_quality_update";
}
