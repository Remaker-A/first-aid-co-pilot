import {
  EventSource,
  EventType,
  Mode,
  createPerceptionEvent,
} from "../domain/types.js";

const BRIGHTNESS_DARK_MAX = 45;
const BRIGHTNESS_BRIGHT_MIN = 190;
const MOTION_LOW_MAX = 4;
const MOTION_HIGH_MIN = 18;

export function normalizeCameraFrameSignal(input = {}) {
  const brightness = numberOrNull(input.brightness ?? input.luma ?? input.mean_luma);
  const motionScore = numberOrNull(input.motionScore ?? input.motion_score);

  return definedValues({
    frame_id: input.frameId ?? input.frame_id ?? null,
    captured_at: input.capturedAt ?? input.captured_at ?? input.timestamp ?? null,
    width: integerOrNull(input.width),
    height: integerOrNull(input.height),
    rotation_degrees: integerOrNull(input.rotationDegrees ?? input.rotation_degrees),
    brightness,
    brightness_label: input.brightnessLabel ?? input.brightness_label ?? labelBrightness(brightness),
    motion_score: motionScore,
    motion_label: input.motionLabel ?? input.motion_label ?? labelMotion(motionScore),
    camera_facing: input.cameraFacing ?? input.camera_facing ?? "back",
    recognition_status: input.recognitionStatus ?? input.recognition_status ?? "frame_signal_only",
  });
}

export function cameraFrameSignalToPerceptionEvent(input = {}) {
  const signal = normalizeCameraFrameSignal(
    input.cameraFrameSignal ?? input.camera_frame_signal ?? input,
  );

  return createPerceptionEvent({
    sessionId: input.sessionId ?? input.session_id ?? null,
    timestamp: input.timestamp,
    mode: input.mode ?? Mode.REAL_PERCEPTION,
    source: EventSource.DEVICE,
    eventType: EventType.DEVICE_STATE_UPDATE,
    ttlMs: input.ttlMs ?? input.ttl_ms ?? 1500,
    deviceState: {
      camera_available: true,
      camera_permission: input.cameraPermission ?? input.camera_permission ?? "granted",
      camera_facing: signal.camera_facing,
      camera_preview_active: true,
      camera_stream_status: "analyzing",
    },
    metadata: {
      camera_frame_signal: signal,
      perception_boundary:
        "Frame signal only; no patient_state, cpr_quality, or rescuer_state recognition emitted.",
    },
  });
}

function labelBrightness(value) {
  if (value == null) {
    return "unknown";
  }
  if (value < BRIGHTNESS_DARK_MAX) {
    return "too_dark";
  }
  if (value > BRIGHTNESS_BRIGHT_MIN) {
    return "too_bright";
  }
  return "usable";
}

function labelMotion(value) {
  if (value == null) {
    return "unknown";
  }
  if (value < MOTION_LOW_MAX) {
    return "stable";
  }
  if (value >= MOTION_HIGH_MIN) {
    return "high_motion";
  }
  return "motion";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number == null ? null : Math.round(number);
}

function definedValues(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}
