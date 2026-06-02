# FirstAid Copilot Agent Core MVP

This is the local Node.js implementation of the v0.1 FirstAid Copilot agent chain.
The next local closed-loop target uses Gemma 4 E2B LiteRT-LM for the controlled
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

The current scope is the adult suspected cardiac arrest CPR demo path. Vision,
CPR quality recognition, emergency calling, GPS, and recording integrations can
remain mocked while the local Gemma + STT/TTS loop is being brought up.

## Local Gemma Runtime

The Gemma runtime is expected to use:

- Model repo: `litert-community/gemma-4-E2B-it-litert-lm`
- Local model directory: `models/gemma/gemma-4-E2B-it-litert-lm/`
- Default backend: `cpu`
- Override backend: `GEMMA_BACKEND=gpu`
- Default timeout: `GEMMA_TIMEOUT_MS=120000`

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

If Hugging Face is blocked in the current shell, download the LiteRT-LM artifact
elsewhere and import it locally:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setupGemma.ps1 -ModelSource <path-to-litertlm-or-zip-or-dir> -SkipLiteRtVerify
```

If `litert-lm` is already installed on PATH, the setup script verifies it
directly. Otherwise it falls back to `uvx --from litert-lm litert-lm --help`.
You can pass `-LiteRtCommand <path>` or `-SkipLiteRtVerify` for constrained
offline setups.

Do not commit downloaded model files. The entire `models/` tree is local runtime
state and should stay out of source control.

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

For early development, the browser, STT transcript, perception events, and TTS
audio may be mocked independently as long as the Agent/Gemma/validator contract
stays the same.

Run `npm run setup:speech -- -DryRun` to preview speech setup. A real sherpa-onnx
install can pass local paths or URLs:

```powershell
npm run setup:speech -- -SherpaOnnxSource <path-or-url> -SttModelSource <path-or-url> -TtsModelSource <path-or-url>
```

Without real speech assets, `npm run voice:serve` uses mock STT/TTS so the local
browser loop still exercises STT text, GemmaRuntime fallback/patch handling,
ActionValidator, and audio playback.

The speech adapters can be switched independently with environment variables:

- `VOICE_STT_PROVIDER=mock|sherpa-onnx|auto`
- `VOICE_TTS_PROVIDER=mock|sherpa-onnx|auto`
- `SHERPA_ONNX_STT_COMMAND` and `SHERPA_ONNX_STT_ARGS`
- `SHERPA_ONNX_TTS_COMMAND` and `SHERPA_ONNX_TTS_ARGS`

`SHERPA_ONNX_STT_ARGS` supports `{audio}`, `{out}`, `{model_dir}`, and
`{language}` placeholders. `SHERPA_ONNX_TTS_ARGS` supports `{text}`, `{out}`,
and `{model_dir}` placeholders because sherpa-onnx model packages vary in their
required flags.

## Commands

```powershell
npm run setup:gemma
npm run setup:speech
npm run verify:local
npm run voice:serve
npm test
node --test
node src/cli/runDemo.js
```

`npm run verify:local` audits model files, Gemma/LiteRT command availability,
speech command configuration, and a local voice-loop smoke test. Add
`-- --require-real-gemma --require-real-speech` when you want missing local model
or sherpa assets to fail the readiness check instead of warning.

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
