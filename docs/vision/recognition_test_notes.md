# Vision Recognition Test Notes

Date: 2026-06-05

## v1 Goal

- Keep CPR vision as an independent, replaceable module.
- Emit factual `vision_cpr` / `cpr_quality_update` data only.
- Never emit medical decisions, TTS copy, haptics, or tool actions from the vision module.
- Prefer front camera, side-fixed phone placement, and a view that includes the chest contact area, both hands/wrists, elbows, and upper torso.
- Fall back to recording/capture when camera placement, pose coverage, confidence, frame stability, or readiness gates are not good enough.

## Local Web Demo

- Start: `npm run demo:voice`
- Local URL: `http://127.0.0.1:8902/`
- Selected CPR test URL: `http://127.0.0.1:8902/?vision_video=/vision-test-assets/pexels-cpr-practice-3981773-loop39s.mp4`
- Main trace harness: `npx --yes --package @playwright/cli playwright-cli -s=firstaid-vision run-code --filename artifacts\vision-tests\playwright-cpr-trace.js`
- Continuous page harness: `artifacts/vision-tests/playwright-continuous-cpr-run.js`

## Test Assets

- Selected positive sample: `artifacts/vision-tests/pexels-cpr-practice-3981773-loop39s.mp4`
- Source: Pexels video `3981773`, downloaded from `https://videos.pexels.com/video-files/3981773/3981773-hd_1920_1080_30fps.mp4`
- Earlier exploratory samples: Fairfax County Hands-Only CPR PSA, ProCPR/Balmoral public clips, blank no-person and moving no-person negative clips.

## Current Results

- Direct MediaPipe trace on the selected Pexels CPR sample:
  - `detected=260/260`
  - `ready=163/260`
  - `started=254/260`
  - `totalMax=42`
  - hand position: `center` for all sampled frames
  - arm posture: `straight` for all sampled frames
  - rate values are mostly low, commonly around 60-90 bpm, with brief in-range segments.
- In-app browser continuous page run after the latest fixes:
  - `realRows=27/27`
  - `readyRows=27/27`
  - `pausedRows=0/27`
  - intents: `continue_cpr_loop=13`, `correct_compression_rate=14`
  - hand position: `center=27`
  - hand basis: `calibrated_target=17`, after the initial proxy window
  - arm posture: `straight=27`
  - interruption seconds stayed below the correction threshold; no false `correct_compression_interruption` was observed.
- Interpretation for this sample: the system recognizes the key CPR posture as valid hand placement and straight arms, then corrects slow compression rhythm instead of issuing false hand-position or interruption corrections.

## Fixes Captured By This Run

- Readiness stability now tolerates normal vertical CPR body motion by using horizontal anchor jitter and shoulder-width scale jitter.
- Front/video test mode uses calibrated hand-position reference after a stable initial press window.
- Video test timeline reset no longer treats slow MediaPipe inference during continuous playback as a seek.
- Interruption detection uses a wider motion window so sparse but visible CPR movement does not become a false stop.
- Rule feedback does not prioritize interruption when the current event has a fresh compression rate.

## Known Limits

- The selected Pexels sample is useful for posture and rhythm debugging, but it is still not a true phone-at-chest-side capture. It should not be treated as clinical validation.
- Browser performance affects live page sampling. The direct trace is the better algorithm check; the continuous page run is the better integration check.
- Android currently implements a near-compatible but not identical CPR metrics algorithm. Before Android claims strict SSOT parity, add golden tests that replay the same landmark sequence through Web JS and Android Kotlin and compare key outputs.

## Follow-Up Checklist

- [x] Positive CPR sample produces `vision_cpr` real-perception events.
- [x] Hand position remains centered on the selected CPR sample.
- [x] Arm posture remains straight on the selected CPR sample.
- [x] Slow rhythm triggers `correct_compression_rate`.
- [x] Sparse live sampling no longer triggers false interruption correction.
- [x] Front-camera mirror normalization is covered by unit tests.
- [x] Recording-only or not-ready vision does not trigger hand-position correction.
- [ ] Camera permission denial and unavailable-device fallback still need a manual browser/device pass.
- [ ] Android/Web golden-parity landmark replay still needs to be added.
