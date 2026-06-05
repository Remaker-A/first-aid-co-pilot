param(
  [string]$PackageName = "com.firstaid.copilot.debug",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Adb = "D:\android-dev\android-sdk\platform-tools\adb.exe",
  [string]$DeviceRoot = "",
  [switch]$SkipAar,
  [switch]$SkipPush,
  [switch]$SkipGemma,
  [switch]$SkipAsr,
  [switch]$SkipTts,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host "[edge-models] $Message"
}

function Ensure-Directory([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Copy-IfNeeded([string]$Source, [string]$Destination) {
  if (!(Test-Path -LiteralPath $Source)) {
    throw "Missing source: $Source"
  }
  if ((Test-Path -LiteralPath $Destination) -and !$Force) {
    Write-Step "already present: $Destination"
    return
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Invoke-Adb([string[]]$AdbArgs) {
  if (!(Test-Path -LiteralPath $Adb)) {
    $found = Get-Command adb -ErrorAction SilentlyContinue
    if (!$found) { throw "adb not found. Pass -Adb or install Android platform-tools." }
    $script:Adb = $found.Source
  }
  & $Adb @AdbArgs
  if ($LASTEXITCODE -ne 0) {
    throw "adb failed: $($AdbArgs -join ' ')"
  }
}

$androidApp = Join-Path $RepoRoot "android\app"
$libs = Join-Path $androidApp "libs"
$cache = Join-Path $RepoRoot ".cache\android-deps"
$sherpaAar = Join-Path $libs "sherpa-onnx-1.13.2.aar"

if (!$SkipAar) {
  Ensure-Directory $libs
  Ensure-Directory $cache
  $cachedSherpa = Join-Path $cache "sherpa-onnx-1.13.2.aar"
  if (!(Test-Path -LiteralPath $cachedSherpa) -or $Force) {
    Write-Step "downloading sherpa-onnx Android AAR"
    Invoke-WebRequest `
      -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-1.13.2.aar" `
      -OutFile $cachedSherpa
  }
  Copy-IfNeeded $cachedSherpa $sherpaAar
}

if ($SkipPush) {
  Write-Step "skipping device model push"
  exit 0
}

$gemma = Join-Path $RepoRoot "models\gemma\gemma-4-E2B-it-litert-lm\gemma-4-E2B-it.litertlm"
$asr = Join-Path $RepoRoot "models\speech\stt-stream\sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
$tts = Join-Path $RepoRoot "models\speech\tts"

if (!$SkipGemma -and !(Test-Path -LiteralPath $gemma)) { throw "Missing Gemma model: $gemma" }
if (!$SkipAsr -and !(Test-Path -LiteralPath $asr)) { throw "Missing ASR model dir: $asr" }
if (!$SkipTts -and !(Test-Path -LiteralPath $tts)) { throw "Missing TTS model dir: $tts" }

Invoke-Adb @("devices")
if ([string]::IsNullOrWhiteSpace($DeviceRoot)) {
  $DeviceRoot = "/sdcard/Android/media/$PackageName/models"
}
$deviceRoot = $DeviceRoot
Write-Step "creating $deviceRoot"
Invoke-Adb @("shell", "mkdir", "-p", "$deviceRoot/gemma", "$deviceRoot/speech/stt-stream", "$deviceRoot/speech/tts")

if (!$SkipGemma) {
  Write-Step "pushing Gemma LiteRT-LM model"
  Invoke-Adb @("push", $gemma, "$deviceRoot/gemma/gemma-4-E2B-it.litertlm")
}

if (!$SkipAsr) {
  Write-Step "pushing streaming ASR model directory"
  $asrRemote = "$deviceRoot/speech/stt-stream/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
  Invoke-Adb @("shell", "mkdir", "-p", $asrRemote)
  Invoke-Adb @("push", (Join-Path $asr "."), $asrRemote)
}

if (!$SkipTts) {
  Write-Step "pushing TTS model directory"
  $ttsRemote = "$deviceRoot/speech/tts"
  Invoke-Adb @("shell", "mkdir", "-p", $ttsRemote)
  Invoke-Adb @("push", (Join-Path $tts "."), $ttsRemote)
}

Write-Step "device model inventory"
Invoke-Adb @("shell", "ls", "-lh", "$deviceRoot")
if (!$SkipGemma) {
  Invoke-Adb @("shell", "ls", "-lh", "$deviceRoot/gemma")
}
if (!$SkipTts) {
  Invoke-Adb @("shell", "ls", "-lh", "$deviceRoot/speech/tts/model.onnx")
}

Write-Step "done"
