# FirstAid Copilot Agent Core MVP

This is the local Node.js implementation of the v0.1 FirstAid Copilot agent chain.
The local closed-loop target uses Gemma 4 E2B LiteRT-LM for the controlled
language layer, with speech I/O handled by offline STT/TTS adapters.

## What Runs

```text
DemoEventScript
-> PerceptionEvent
-> SessionReducer
-> Guideline State Machine
-> RuleFeedbackEngine / Gemma 4 E2B LiteRT-LM
-> ActionValidator
-> GuidanceAction
-> SessionLog
-> HandoverReport
```

The current scope is the adult suspected cardiac arrest CPR demo path. The
local Gemma + STT/TTS loop is wired and covered by strict readiness checks.
Vision, CPR quality recognition, emergency calling, GPS, and recording
integrations remain replaceable boundary adapters until the Android device
layer is connected.

## Local Gemma Runtime

The Gemma runtime is expected to use:

- Model repo: `litert-community/gemma-4-E2B-it-litert-lm`
- Local model directory: `models/gemma/gemma-4-E2B-it-litert-lm/`
- CLI runner: `litert-lm`
- Default backend: `cpu`
- Override backend: `GEMMA_BACKEND=gpu`
- Default timeout: `GEMMA_TIMEOUT_MS=120000`
- Voice turn budget: `GEMMA_TURN_TIMEOUT_MS=1000`
- Optional daemon: `GEMMA_DAEMON=1` with `litert-lm serve`

Set `HF_TOKEN` before downloading the model. The token must come from an account
that has accepted the Gemma model terms on Hugging Face.

```powershell
$env:HF_TOKEN = "<your huggingface token>"
npm run setup:gemma

# Optional: keep the token out of shell history.
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setupGemma.ps1 -TokenPrompt
```

The setup script should download the LiteRT-LM model into `models/`, then select
the first file matching `gemma-4-E2B-it*.litertlm`. If no matching file is found,
the script should fail with a clear message to check the downloaded model repo.
It prefers the modern `hf download` CLI when present, and keeps uv/Hugging Face
cache directories under `.cache/` inside the workspace.

If Hugging Face is blocked in the current shell, download the LiteRT-LM model
artifact elsewhere and import it locally:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setupGemma.ps1 -ModelSource <path-to-litertlm-or-zip-or-dir> -SkipLiteRtVerify
```

If `litert-lm` is already installed on PATH, the setup script verifies it
directly. Otherwise it tries uv package candidates, preferring
`litert-lm-nightly` and then `litert-lm`. You can pass `-UvPython <python>`,
`-LiteRtPackageSource <wheel-or-dir>`, `-LiteRtCommand <path>`, or
`-SkipLiteRtVerify` for constrained offline setups.

Do not commit downloaded model files. The entire `models/` tree is local runtime
state and should stay out of source control.

For low-latency voice runs, Gemma is bounded per turn. `GEMMA_TURN_TIMEOUT_MS`
applies to normal voice turns and `GEMMA_LIVE_TIMEOUT_MS` applies to CPR live
turns; if Gemma exceeds the budget, the voice service speaks the deterministic
state-machine or LiveDriver guidance immediately. Medical flow control remains
rule driven; Gemma only supplements wording after `ActionValidator`.

`GEMMA_DAEMON=1` makes `GemmaRuntime` try a local `litert-lm serve` process
before the existing one-shot `litert-lm run` path. The daemon uses
`GEMMA_SERVE_HOST`, `GEMMA_SERVE_PORT`, `GEMMA_SERVE_API`, optional
`GEMMA_SERVE_MODEL_ID`, and `GEMMA_SERVE_EXTRA_ARGS`. Current `litert-lm serve`
loads models from the local `litert-lm import` registry rather than from a model
file argument; `GEMMA_BACKEND=gpu` remains a one-shot `litert-lm run` fallback
setting. The default is off, and any daemon startup, HTTP, timeout, or crash
failure falls back to the old one-shot runner.

## Speech Runtime

STT and TTS are configured separately from Gemma. The intended local loop is:

```text
browser microphone WAV
-> offline STT
-> PerceptionEvent.user_input
-> Agent + GemmaRuntime
-> ActionValidator
-> offline TTS WAV
-> browser playback
```

Mocks remain supported for browser, STT transcript, perception events, and TTS
audio as long as the Agent/Gemma/validator contract stays the same. Production
readiness should use the strict real-asset verifier.

Run `npm run setup:speech -- -DryRun` to preview speech setup. A real sherpa-onnx
install can pass local paths or URLs:

```powershell
npm run setup:speech -- -SherpaOnnxSource <path-or-url> -SttModelSource <path-or-url> -TtsModelSource <path-or-url>
```

Without real speech assets, `npm run voice:serve` uses mock STT/TTS so the local
browser loop still exercises STT text, GemmaRuntime fallback/patch handling,
ActionValidator, and audio playback.

Live voice mode is intended to keep the browser in a half-duplex loop: capture
microphone audio, endpoint a phrase with VAD, POST the 16 kHz WAV to
`/api/turn`, play the returned TTS audio, then resume listening after playback.
The HTTP contract stays the same as the manual voice demo so text input,
uploaded audio, and mock speech remain available as fallbacks.

The speech adapters can be switched independently with environment variables:

- `VOICE_STT_PROVIDER=mock|sherpa-onnx|auto`
- `VOICE_TTS_PROVIDER=mock|sherpa-onnx|auto`
- `SPEECH_DAEMON=0|1`
- `SHERPA_ONNX_STT_COMMAND` and `SHERPA_ONNX_STT_ARGS`
- `SHERPA_ONNX_TTS_COMMAND` and `SHERPA_ONNX_TTS_ARGS`

`SHERPA_ONNX_STT_ARGS` supports `{audio}`, `{out}`, `{model_dir}`, and
`{language}` placeholders. `SHERPA_ONNX_TTS_ARGS` supports `{text}`, `{out}`,
and `{model_dir}` placeholders because sherpa-onnx model packages vary in their
required flags.

Set `SPEECH_DAEMON=1` only for real sherpa-onnx mode when using the bundled
Python wrappers. The Node adapter keeps one STT and one TTS process alive,
sends one JSON request per line, and falls back to the previous one-shot spawn
path if the daemon crashes, times out, or cannot start. Leave it at `0` for the
most conservative rollback path; mock STT/TTS ignores the switch.

For the fast local voice loop, copy `.env.speech.example` to `.env`, switch to
real sherpa providers, then enable:

```powershell
SPEECH_DAEMON=1
GEMMA_DAEMON=1
GEMMA_BACKEND=gpu
GEMMA_TURN_TIMEOUT_MS=1000
```

Mock mode stays compatible with these variables because mock STT/TTS ignores
`SPEECH_DAEMON`, and Gemma daemon mode remains behind `GEMMA_DAEMON`.

## Commands

```powershell
npm run setup:gemma
npm run setup:speech
npm run verify:local
npm run verify:local:strict
npm run voice:serve
npm test
node --test
node src/cli/runDemo.js
```

`npm run verify:local` audits model files, Gemma/LiteRT command availability,
speech command configuration, and a local voice-loop smoke test. Add
`-- --require-real-gemma --require-real-speech` when you want missing local model
or sherpa assets to fail the readiness check instead of warning, or run
`npm run verify:local:strict`.

The core tests remain pure ESM `node:test` and do not require npm runtime
dependencies. Local model setup may install or call external CLI tools.

## Key Paths

- `src/domain/`: shared protocol constants and factories.
- `src/engine/`: CPR start rule, reducer, state machine, high-frequency CPR feedback, action validation.
- `src/gemma/`: DecisionFrame, prompt builder, response parser, Gemma runtime, local fallback policy.
- `src/voice/`: local HTTP voice demo, mock STT, mock/sherpa TTS, closed-loop orchestration.
- `src/demo/`: demo event player.
- `src/report/`: session log and handover report generator.
- `knowledge/`: safety phrases, allowed intents, CPR demo script.
- `test/`: Node test coverage for CPR rules, demo replay, Gemma runtime contracts, and safety validation.
