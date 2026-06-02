param(
  [switch]$DryRun,
  [switch]$Force,
  [string]$SpeechDir = "models/speech",
  [string]$SherpaOnnxSource = "",
  [string]$SttModelSource = "",
  [string]$TtsModelSource = "",
  [switch]$SkipEnvExample
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

if ([System.IO.Path]::IsPathRooted($SpeechDir)) {
  $ResolvedSpeechDir = $SpeechDir
} else {
  $ResolvedSpeechDir = Join-Path $RepoRoot $SpeechDir
}

$BinDir = Join-Path $ResolvedSpeechDir "bin"
$SttDir = Join-Path $ResolvedSpeechDir "stt"
$TtsDir = Join-Path $ResolvedSpeechDir "tts"
$EnvExamplePath = Join-Path $RepoRoot ".env.speech.example"

function Write-Step {
  param([string]$Message)
  Write-Host "[setup:speech] $Message"
}

function Join-CommandForDisplay {
  param([string[]]$Parts)

  return ($Parts | ForEach-Object {
    if ($_ -match '[\s"`$&|<>;]') {
      '"' + ($_ -replace '"', '\"') + '"'
    } else {
      $_
    }
  }) -join " "
}

function Test-HttpSource {
  param([string]$Source)
  return $Source -match '^https?://'
}

function Resolve-LocalPath {
  param([string]$PathValue)

  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return $PathValue
  }

  return Join-Path $RepoRoot $PathValue
}

function Ensure-Directory {
  param([string]$PathValue)

  if ($DryRun) {
    Write-Step "Would create directory: $PathValue"
    return
  }

  New-Item -ItemType Directory -Path $PathValue -Force | Out-Null
}

function Get-FileNameFromSource {
  param(
    [string]$Source,
    [string]$FallbackName
  )

  if (Test-HttpSource -Source $Source) {
    $uri = [System.Uri]$Source
    $name = [System.IO.Path]::GetFileName($uri.AbsolutePath)
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      return $name
    }
    return $FallbackName
  }

  return [System.IO.Path]::GetFileName((Resolve-LocalPath -PathValue $Source))
}

function Expand-Or-CopyArtifact {
  param(
    [string]$SourcePath,
    [string]$DestinationDir,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $SourcePath)) {
    if ($DryRun) {
      Write-Warning "$Label source was not found for dry run preview: $SourcePath"
      return
    }

    throw "$Label source was not found: $SourcePath"
  }

  $item = Get-Item -LiteralPath $SourcePath
  if ($item.PSIsContainer) {
    if ($DryRun) {
      Write-Step "Would copy $Label directory '$SourcePath' to '$DestinationDir'."
      return
    }

    Get-ChildItem -LiteralPath $SourcePath -Force |
      Copy-Item -Destination $DestinationDir -Recurse -Force
    return
  }

  if ($item.Extension -ieq ".zip") {
    if ($DryRun) {
      Write-Step "Would expand $Label archive '$SourcePath' to '$DestinationDir'."
      return
    }

    Expand-Archive -LiteralPath $SourcePath -DestinationPath $DestinationDir -Force
    return
  }

  if ($DryRun) {
    Write-Step "Would copy $Label file '$SourcePath' to '$DestinationDir'."
    return
  }

  Copy-Item -LiteralPath $SourcePath -Destination $DestinationDir -Force
}

function Install-Source {
  param(
    [string]$Source,
    [string]$DestinationDir,
    [string]$Label,
    [string]$DownloadFileName
  )

  if ([string]::IsNullOrWhiteSpace($Source)) {
    Write-Warning "$Label source was not provided. Supply a local path or URL to install real offline $Label assets."
    return $false
  }

  Ensure-Directory -PathValue $DestinationDir

  if (Test-HttpSource -Source $Source) {
    $fileName = Get-FileNameFromSource -Source $Source -FallbackName $DownloadFileName
    $downloadPath = Join-Path $DestinationDir $fileName

    if ($DryRun) {
      Write-Step "Would download $Label from $Source to $downloadPath."
      if ($fileName -match '\.zip$') {
        Write-Step "Would expand $Label archive into $DestinationDir."
      }
      return $true
    }

    try {
      Write-Step "Downloading $Label from $Source"
      Invoke-WebRequest -Uri $Source -OutFile $downloadPath
    } catch {
      throw "Failed to download $Label from $Source. Check network access or pass a local path instead. $($_.Exception.Message)"
    }

    if ($downloadPath -match '\.zip$') {
      Expand-Archive -LiteralPath $downloadPath -DestinationPath $DestinationDir -Force
    }

    return $true
  }

  $localPath = Resolve-LocalPath -PathValue $Source
  Expand-Or-CopyArtifact -SourcePath $localPath -DestinationDir $DestinationDir -Label $Label
  return $true
}

function Find-SherpaExecutable {
  param([string]$SearchDir)

  $fromPath = Get-Command "sherpa-onnx-offline" -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }

  $fromPathExe = Get-Command "sherpa-onnx-offline.exe" -ErrorAction SilentlyContinue
  if ($fromPathExe) {
    return $fromPathExe.Source
  }

  if (-not (Test-Path -LiteralPath $SearchDir)) {
    return $null
  }

  $patterns = @(
    "sherpa-onnx-offline.exe",
    "sherpa-onnx-offline",
    "sherpa-onnx*.exe"
  )

  foreach ($pattern in $patterns) {
    $match = Get-ChildItem -LiteralPath $SearchDir -Filter $pattern -File -Recurse |
      Sort-Object FullName |
      Select-Object -First 1
    if ($match) {
      return $match.FullName
    }
  }

  return $null
}

function Find-ModelFiles {
  param([string]$SearchDir)

  if (-not (Test-Path -LiteralPath $SearchDir)) {
    return @()
  }

  return @(Get-ChildItem -LiteralPath $SearchDir -File -Recurse |
    Where-Object { $_.Extension -in @(".onnx", ".tokens", ".txt", ".bin", ".json", ".yaml", ".yml") } |
    Sort-Object FullName)
}

function Write-EnvExample {
  $content = @'
# Copy values from this file into your local .env if the voice server supports it.
# This file contains no secrets.

# Use mock first to validate the Node demo loop without real audio assets.
# Set SPEECH_MODE=sherpa-onnx after real command paths and model args are ready.
SPEECH_MODE=mock
VOICE_STT_PROVIDER=mock
VOICE_TTS_PROVIDER=mock

# Switch to sherpa-onnx after setupSpeech.ps1 reports executable and model files found.
# SPEECH_MODE=sherpa-onnx
SHERPA_ONNX_STT_COMMAND=models/speech/bin/sherpa-onnx-offline.exe
SHERPA_ONNX_TTS_COMMAND=models/speech/bin/sherpa-onnx-offline-tts.exe
SPEECH_STT_MODEL_DIR=models/speech/stt
SPEECH_TTS_MODEL_DIR=models/speech/tts

# Args are model-specific. Use placeholders:
# {audio}, {out}, {model_dir}, {language} for STT.
# {text}, {out}, {model_dir} for TTS.
# SHERPA_ONNX_STT_ARGS=--wave-filename "{audio}"
# SHERPA_ONNX_TTS_ARGS=--text "{text}" --output "{out}"

# Optional runtime tuning for the voice server or adapters.
SPEECH_SAMPLE_RATE=16000
SPEECH_LANGUAGE=zh
VOICE_STT_TIMEOUT_MS=15000
VOICE_TTS_TIMEOUT_MS=15000
'@

  if ($DryRun) {
    Write-Step "Would write example speech environment file: $EnvExamplePath"
    return
  }

  Set-Content -LiteralPath $EnvExamplePath -Value $content -Encoding UTF8
}

Write-Step "Speech asset directory: $ResolvedSpeechDir"
Write-Step "sherpa-onnx source: $(if ([string]::IsNullOrWhiteSpace($SherpaOnnxSource)) { '<not provided>' } else { $SherpaOnnxSource })"
Write-Step "STT model source: $(if ([string]::IsNullOrWhiteSpace($SttModelSource)) { '<not provided>' } else { $SttModelSource })"
Write-Step "TTS model source: $(if ([string]::IsNullOrWhiteSpace($TtsModelSource)) { '<not provided>' } else { $TtsModelSource })"

if ($DryRun) {
  Write-Step "Dry run only; no files will be downloaded, copied, deleted, or written."
}

if ((Test-Path -LiteralPath $ResolvedSpeechDir) -and $Force) {
  if ($DryRun) {
    Write-Step "Would remove existing speech directory because -Force was supplied: $ResolvedSpeechDir"
  } else {
    Write-Step "Removing existing speech directory because -Force was supplied."
    Remove-Item -LiteralPath $ResolvedSpeechDir -Recurse -Force
  }
}

Ensure-Directory -PathValue $ResolvedSpeechDir
Ensure-Directory -PathValue $BinDir
Ensure-Directory -PathValue $SttDir
Ensure-Directory -PathValue $TtsDir

$installedSherpa = Install-Source `
  -Source $SherpaOnnxSource `
  -DestinationDir $BinDir `
  -Label "sherpa-onnx runtime" `
  -DownloadFileName "sherpa-onnx-windows.zip"

$installedStt = Install-Source `
  -Source $SttModelSource `
  -DestinationDir $SttDir `
  -Label "STT model" `
  -DownloadFileName "sherpa-onnx-stt-model.zip"

$installedTts = Install-Source `
  -Source $TtsModelSource `
  -DestinationDir $TtsDir `
  -Label "TTS model" `
  -DownloadFileName "sherpa-onnx-tts-model.zip"

if (-not $SkipEnvExample) {
  Write-EnvExample
}

$sherpaExecutable = Find-SherpaExecutable -SearchDir $BinDir
$sttFiles = @(Find-ModelFiles -SearchDir $SttDir)
$ttsFiles = @(Find-ModelFiles -SearchDir $TtsDir)

if ($sherpaExecutable) {
  Write-Step "Found sherpa-onnx executable: $sherpaExecutable"
} else {
  Write-Warning "sherpa-onnx executable was not found. Install it on PATH or rerun with -SherpaOnnxSource <local path or URL>."
}

if ($sttFiles.Count -gt 0) {
  Write-Step "Found STT asset files: $($sttFiles.Count)"
} else {
  Write-Warning "No STT model files were found under $SttDir. Rerun with -SttModelSource <local path or URL> for real STT."
}

if ($ttsFiles.Count -gt 0) {
  Write-Step "Found TTS asset files: $($ttsFiles.Count)"
} else {
  Write-Warning "No TTS model files were found under $TtsDir. Rerun with -TtsModelSource <local path or URL> for real TTS."
}

if ($sherpaExecutable -and $sttFiles.Count -gt 0 -and $ttsFiles.Count -gt 0) {
  Write-Step "Real sherpa-onnx speech setup looks ready."
} else {
  Write-Step "Mock speech mode is ready to use. Use .env.speech.example as the non-secret template while real assets are missing."
  Write-Step "Example real setup: $(Join-CommandForDisplay @('powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', './scripts/setupSpeech.ps1', '-SherpaOnnxSource', '<path-or-url>', '-SttModelSource', '<path-or-url>', '-TtsModelSource', '<path-or-url>'))"
}

if ($DryRun) {
  Write-Step "Dry run complete."
  exit 0
}

if ($installedSherpa -or $installedStt -or $installedTts) {
  Write-Step "Speech setup complete."
} else {
  Write-Step "Speech setup completed without real asset sources."
}
