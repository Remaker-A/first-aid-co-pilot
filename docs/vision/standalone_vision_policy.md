# Standalone Vision Placement and Recording Policy

This document defines the placement, recording, readiness, and event metadata contract for the standalone CPR vision module.

The vision module only emits factual perception data. It does not emit `GuidanceAction`, medical decisions, TTS text, haptics, or tool actions. Downstream CPR flow remains rule-driven and consumes vision output through the existing `vision_cpr` / `cpr_quality_update` perception path.

## Default Placement

Default setup:

- Use the front camera.
- Mount the phone in a side-fixed position near the patient's chest.
- Treat front-camera input as mirrored; normalize landmarks before deriving left/right hand placement.
- Keep the phone fixed before attempting live recognition. The rescuer should not hold the phone while doing compressions.
- Frame the patient's chest, both hands/wrists, both elbows, and upper torso. The module needs the CPR contact area and arm posture visible.

Accepted `camera_mount` values:

| Phone placement | `camera_mount` | Live recognition policy |
| --- | --- | --- |
| Side-fixed default mount | `side_fixed` | May attempt live recognition if all readiness gates pass |
| Bystander-held but stable side view | `bystander_handheld` | May attempt live recognition if all readiness gates pass |
| Rescuer handheld | `handheld` | Recording-only |
| Flat on ground, blocked, or unusable view | `unusable` | Recording-only |
| Unknown placement | `unknown` | Recording-only |

`side_fixed` is the default and preferred placement for demos, local tests, and live readiness claims. `bystander_handheld` is a secondary allowance only when the bystander can keep the side view stable and hands-free for the rescuer.

## Recording Policy

Camera activation must start as recording/capture first. Recording is the safe fallback and must remain available even when live recognition is unavailable.

The visible camera/capture state should be stable while the stream is open. A short-lived readiness drop must not make the UI look like the camera is starting and stopping. Show capture as continuous, and treat live recognition as a secondary analysis state that can be pending, active, or temporarily not ready.

Use `RecordingOnly` or equivalent UI copy when any of these are true:

- The pose model asset is missing, fails to initialize, or fails during analysis.
- Camera preview works but live pose analysis is disabled.
- The phone mount is `handheld`, `unusable`, or `unknown`.
- Confidence, pose coverage, frame stability, or derived `vision_ready` fail the gates below.
- Metadata needed to audit the recognition claim is missing.

Only show or label `LiveRecognition` when the current turn was produced by real on-device perception and every live-recognition gate passes. Demo presets and scripted injection remain demo data, not live recognition. Real microphone/camera capture without a passing vision gate remains recording-only.

## Live-Recognition Readiness Gates

The standalone module may emit live CPR metrics only after the following gates pass for the current snapshot:

| Gate | Required value | Failure reason |
| --- | --- | --- |
| `confidence` | `>= 0.75` | `missing_confidence` or `low_confidence` |
| `camera_mount` | `side_fixed` or `bystander_handheld` | `camera_mount_handheld`, `camera_mount_unusable`, or `camera_mount_unknown` |
| `pose_coverage` | `>= 0.75` | `low_pose_coverage` |
| `frame_stability` | `>= 0.70` | `unstable_frame` |
| `vision_ready` | `true` | `not_ready` |

`observed_window_ms` is required metadata for auditability. It should reflect the usable temporal window behind the current metrics. The current readiness decision is driven by confidence, mount, coverage, stability, and `vision_ready`; rate and interruption claims should still be treated as provisional when `observed_window_ms` is too short to support them.

For CPR video, stability is based on horizontal anchor jitter and shoulder-width scale jitter, not vertical torso movement. Normal up/down compression motion must not make a side-fixed camera look unstable. Web video testing also treats only obvious timeline jumps as seek/loop resets; slow MediaPipe inference during continuous playback should not reset the CPR metric window.

When any gate fails, the module should:

- Keep recording/capture active if permitted.
- Avoid injecting `real_perception` live CPR metrics into the agent turn.
- Surface the degraded state as recording-only.
- Preserve diagnostic metadata so testers can tell whether the failure was mount, coverage, stability, confidence, or model readiness.

## Event Contract

Live-ready CPR metrics should be sent as a `PerceptionEvent` compatible payload:

```json
{
  "source": "real_perception",
  "event_type": "cpr_quality_update",
  "cpr_quality": {
    "compressions_started": true,
    "compression_rate": 108.5,
    "current_rate": 108.5,
    "average_rate": 106.8,
    "interruption_seconds": 0,
    "hand_position": "center",
    "hand_position_basis": "calibrated_target",
    "arm_straight": true,
    "arm_posture": "straight",
    "quality_score": 92,
    "total_compressions": 30,
    "confidence": 0.9,
    "observed_window_ms": 3200,
    "timestamp_ms": 123456
  },
  "metadata": {
    "camera_facing": "front",
    "camera_mount": "side_fixed",
    "mirrored": true,
    "vision_ready": true,
    "pose_coverage": 0.88,
    "frame_stability": 0.91,
    "observed_window_ms": 3200
  }
}
```

Required metadata:

| Field | Type | Meaning |
| --- | --- | --- |
| `camera_facing` | string | `front` by default; `back` only if a future mode explicitly supports it |
| `camera_mount` | string | Placement/mount classification used by the readiness gate |
| `mirrored` | boolean | Whether x coordinates were mirrored before deriving hand position |
| `vision_ready` | boolean | Output of the metrics deriver's internal readiness check |
| `pose_coverage` | number from `0` to `1` | Coverage of the shoulders, elbows, wrists, and hips needed for CPR metrics |
| `frame_stability` | number from `0` to `1` | Stability of the torso center over the readiness window |
| `observed_window_ms` | integer milliseconds | Time span of the samples backing the current metrics |

If the module is recording-only, it may still expose these fields as diagnostics, but it must not present them as accepted live CPR guidance.

For Web v1, hand placement defaults to a calibrated target after the first stable press window. Until calibration locks, `hand_position_basis` may be `rescuer_torso_proxy`; after calibration it should become `calibrated_target`. This avoids false left/right or high/low corrections when the patient/manikin landmarks are partially unavailable.

## Acceptance Checklist

- [ ] Documentation or UI setup names `side_fixed` front-camera placement as the default.
- [ ] The front camera is selected by default and `mirrored=true` is included for front-camera metrics.
- [ ] The tester can place the phone side-fixed with chest, hands/wrists, elbows, and upper torso visible.
- [ ] `handheld`, `unusable`, and `unknown` mounts remain recording-only.
- [ ] `bystander_handheld` can attempt live recognition only when the bystander view is stable and all gates pass.
- [ ] Missing pose model, analysis failure, or disabled analysis keeps the camera in recording/capture fallback without claiming live recognition.
- [ ] Live recognition requires `confidence >= 0.75`.
- [ ] Live recognition requires `pose_coverage >= 0.75`.
- [ ] Live recognition requires `frame_stability >= 0.70`.
- [ ] Live recognition requires `vision_ready=true`.
- [ ] Every emitted live CPR event includes `camera_facing`, `camera_mount`, `mirrored`, `vision_ready`, `pose_coverage`, `frame_stability`, and `observed_window_ms`.
- [ ] Failed readiness preserves a reason such as `low_confidence`, `low_pose_coverage`, `unstable_frame`, `not_ready`, or `camera_mount_*`.
- [ ] Passing live metrics use the factual `real_perception` / `cpr_quality_update` path and do not emit medical guidance directly.
- [ ] Demo/scripted events are labeled separately from recording-only capture and live recognition.
- [ ] Android and Web outputs have a golden-parity test before Android claims strict SSOT equivalence.
- [ ] A doc-only change under `docs/vision/` does not modify Android or Node source files.
