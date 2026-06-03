# FirstAid Copilot Android Bring-up

This folder contains Android-side development material for consuming validated `GuidanceAction` payloads from the Agent. The boundary stays fixed:

```text
Medical flow is rule-driven.
Interaction is Gemma-driven.
Execution is Android-driven.
```

Android adapters consume `GuidanceAction` and execute UI, TTS, haptic, tool, and log delivery. They must not infer medical stages, rewrite the medical flow, or bypass Agent validation.

## Local Toolchain

Current local install root:

```powershell
$InstallRoot = "D:\android-dev"
```

This keeps Android development tools on the D drive without putting large SDK/JDK files under the repo path. If D drive space is tight, use the setup script with an explicit E drive root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setupAndroidDevEnv.ps1 -InstallRoot "E:\android-dev"
```

The setup script prepares the missing local Android tools, JDK, SDK command-line tools, platform packages, build tools, and local Gradle when needed. Validate the result with equivalent commands:

```powershell
$env:JAVA_HOME = "$InstallRoot\jdk"
$env:ANDROID_HOME = "$InstallRoot\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$InstallRoot\gradle\gradle-8.13\bin;$env:PATH"

java -version
sdkmanager --list_installed
adb version
gradle -v
```

For the current PowerShell session, point Android and Java tools at the local install before building:

```powershell
powershell -ExecutionPolicy Bypass -File ..\scripts\useAndroidDevEnv.ps1
```

Build from the Android folder:

```powershell
cd android
..\scripts\useAndroidDevEnv.ps1
D:\android-dev\gradle\gradle-8.13\bin\gradle.bat :app:assembleDebug
```

The debug APK is generated at `android/app/build/outputs/apk/debug/app-debug.apk`.

Local setup success does not change safety behavior: Demo builds must not automatically dial real 120, sharing or deletion still requires explicit user confirmation, and mock-only passes are not strict real readiness.

## Fixtures

GuidanceAction fixtures live in:

```text
android/app/src/main/assets/fixtures/
```

Use `manifest.json` to enumerate them in a deterministic order. Each JSON file is a single validated-style `GuidanceAction` object.

| Fixture | Coverage | Expected adapter behavior |
| --- | --- | --- |
| `01_ui_tts_response_check.json` | Normal UI + TTS | Render main/secondary text, status tags, primary button, and speak `tts.text`. |
| `02_cpr_haptic_start.json` | CPR haptic start | Start one 110 bpm metronome instance, render CPR guidance, and speak the critical prompt. |
| `03_cpr_haptic_update.json` | CPR haptic update | Keep the same metronome instance and update/refresh 110 bpm feedback without stacking vibrations. |
| `04_cpr_haptic_stop.json` | CPR haptic stop | Stop/cancel the metronome and render handover text. |
| `05_critical_emergency_call_mock.json` | Critical emergency call mock | Treat as critical and always surface UI/TTS/tool delivery, but keep Demo behavior mock-only. |
| `06_share_video_unconfirmed.json` | Share video without confirmation | Show the confirmation UI and block the share tool. No external send should happen. |
| `07_share_video_confirmed.json` | Share video with confirmation | Execute the share adapter only because the tool carries explicit confirmation. |
| `08_unknown_intent_fallback.json` | Unknown intent fallback | Show a safe UI fallback and log the unknown intent instead of silently dropping it. |

## Adapter Checks

Recommended Android adapter pass:

1. Load all files listed in `fixtures/manifest.json` from assets.
2. Parse each file into the Kotlin `GuidanceAction` model.
3. Send the action through `GuidanceActionBridge`.
4. Dispatch to `UiActionRenderer`, `AndroidTtsSink`, `AndroidHapticSink`, `AndroidToolExecutor`, and `AndroidSessionLogStore`.
5. Record one structured delivery log per adapter result.

Minimum assertions:

- UI updates when `ui.main_text`, `ui.secondary_text`, `status_tags`, `quality_score`, or `primary_button` is present.
- TTS only speaks when `tts.text` is non-empty and respects `priority` plus `interrupt_policy`.
- Haptic tools are owned by `AndroidHapticSink`; `start_haptic_metronome`, `update_haptic_metronome`, and `stop_haptic_metronome` must not be routed as generic system tools.
- CPR metronome lifecycle is single-instance: start, update, then stop/cancel.
- `priority=critical` is never swallowed. If a permission or mock tool fails, show UI fallback and log the failure.
- `share_video`, `share_report`, `send_video`, `send_report`, and `delete_video` execute only after explicit user confirmation.
- Unknown intents with no renderable content still produce a safe UI fallback and log entry.

## Node Reference Commands

Run these from the repository root to compare Android adapter behavior with the Node dispatcher:

```powershell
npm run demo:dispatcher
node --test test/dispatcher.test.js
npm run scenario
```

`npm run demo:dispatcher` prints representative validated actions and the channels that receive them. `node --test test/dispatcher.test.js` verifies dispatcher guardrails. `npm run scenario` runs the scripted CPR loop through Agent output and dispatcher delivery.

## Safety Rules

Demo default must not automatically dial real 120. Use `mock_emergency_call`, mock state, or a visible dial-only flow unless a real emergency test has explicit manual approval and a separate real-device safety plan.

Sharing, external sending, uploading, and deletion must require visible user confirmation. A fixture or mock dispatcher passing is not permission to send data externally.

Mock success is not strict real readiness. Passing these fixtures, the dispatcher demo, or mock tools only proves adapter wiring. Strict readiness still requires real Gemma, speech, Android hardware permissions, and real-device validation.
