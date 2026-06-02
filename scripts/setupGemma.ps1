param(
  [switch]$DryRun,
  [switch]$Force,
  [switch]$TokenPrompt,
  [switch]$SkipLiteRtVerify,
  [string]$Repo = "litert-community/gemma-4-E2B-it-litert-lm",
  [string]$ModelDir = "models/gemma/gemma-4-E2B-it-litert-lm",
  [string]$ModelSource = "",
  [string]$LiteRtCommand = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ModelPattern = "gemma-4-E2B-it*.litertlm"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$WorkspaceUvCacheDir = Join-Path $RepoRoot ".cache\uv"
$WorkspaceUvToolDir = Join-Path $RepoRoot ".cache\uv\tools"
$WorkspaceHfHomeDir = Join-Path $RepoRoot ".cache\huggingface"
$WorkspaceHfHubCacheDir = Join-Path $WorkspaceHfHomeDir "hub"

if ([string]::IsNullOrWhiteSpace($env:UV_CACHE_DIR)) {
  $env:UV_CACHE_DIR = $WorkspaceUvCacheDir
}
if ([string]::IsNullOrWhiteSpace($env:UV_TOOL_DIR)) {
  $env:UV_TOOL_DIR = $WorkspaceUvToolDir
}
if ([string]::IsNullOrWhiteSpace($env:HF_HOME)) {
  $env:HF_HOME = $WorkspaceHfHomeDir
}
if ([string]::IsNullOrWhiteSpace($env:HF_HUB_CACHE)) {
  $env:HF_HUB_CACHE = $WorkspaceHfHubCacheDir
}

if ([System.IO.Path]::IsPathRooted($ModelDir)) {
  $ResolvedModelDir = $ModelDir
} else {
  $ResolvedModelDir = Join-Path $RepoRoot $ModelDir
}

function Write-Step {
  param([string]$Message)
  Write-Host "[setup:gemma] $Message"
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

function Get-UvLauncher {
  $uvx = Get-Command "uvx" -ErrorAction SilentlyContinue
  if ($uvx) {
    return @{
      Command = $uvx.Source
      Prefix = @()
      Name = "uvx"
    }
  }

  $uv = Get-Command "uv" -ErrorAction SilentlyContinue
  if ($uv) {
    return @{
      Command = $uv.Source
      Prefix = @("tool", "run")
      Name = "uv tool run"
    }
  }

  return $null
}

function Get-HuggingFaceCliLauncher {
  $hf = Get-Command "hf" -ErrorAction SilentlyContinue
  if ($hf) {
    return @{
      Command = $hf.Source
      Name = "hf"
    }
  }

  $legacyHfCli = Get-Command "huggingface-cli" -ErrorAction SilentlyContinue
  if ($legacyHfCli) {
    return @{
      Command = $legacyHfCli.Source
      Name = "huggingface-cli"
    }
  }

  return $null
}

function New-UvToolCommand {
  param(
    [hashtable]$Launcher,
    [string[]]$ToolArgs
  )

  if ($null -eq $Launcher) {
    return @("uvx") + $ToolArgs
  }

  return @($Launcher.Command) + [string[]]$Launcher.Prefix + $ToolArgs
}

function Get-LiteRtLmCommand {
  param([string]$ExplicitCommand)

  if (-not [string]::IsNullOrWhiteSpace($ExplicitCommand)) {
    return @{
      Command = $ExplicitCommand
      Name = "explicit litert-lm"
    }
  }

  $fromPath = Get-Command "litert-lm" -ErrorAction SilentlyContinue
  if ($fromPath) {
    return @{
      Command = $fromPath.Source
      Name = "litert-lm"
    }
  }

  return $null
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

function Install-ModelSource {
  param(
    [string]$Source,
    [string]$DestinationDir
  )

  if ([string]::IsNullOrWhiteSpace($Source)) {
    return $false
  }

  New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null

  if (Test-HttpSource -Source $Source) {
    $fileName = Get-FileNameFromSource -Source $Source -FallbackName "gemma-4-E2B-it-litert-lm.zip"
    $downloadPath = Join-Path $DestinationDir $fileName
    Write-Step "Downloading Gemma model source from $Source"
    Invoke-WebRequest -Uri $Source -OutFile $downloadPath
    if ($downloadPath -match '\.zip$') {
      Write-Step "Expanding Gemma model archive into $DestinationDir"
      Expand-Archive -LiteralPath $downloadPath -DestinationPath $DestinationDir -Force
    }
    return $true
  }

  $localPath = Resolve-LocalPath -PathValue $Source
  if (-not (Test-Path -LiteralPath $localPath)) {
    throw "Gemma model source was not found: $localPath"
  }

  $item = Get-Item -LiteralPath $localPath
  if ($item.PSIsContainer) {
    Write-Step "Copying Gemma model directory from $localPath"
    Get-ChildItem -LiteralPath $localPath -Force |
      Copy-Item -Destination $DestinationDir -Recurse -Force
    return $true
  }

  if ($item.Extension -ieq ".zip") {
    Write-Step "Expanding Gemma model archive from $localPath"
    Expand-Archive -LiteralPath $localPath -DestinationPath $DestinationDir -Force
    return $true
  }

  Write-Step "Copying Gemma model file from $localPath"
  Copy-Item -LiteralPath $localPath -Destination $DestinationDir -Force
  return $true
}

function Invoke-NativeCommand {
  param([string[]]$CommandParts)

  $exe = $CommandParts[0]
  $args = @($CommandParts | Select-Object -Skip 1)
  & $exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $(Join-CommandForDisplay $CommandParts)"
  }
}

function Find-GemmaModelFile {
  param([string]$SearchDir)

  if (-not (Test-Path -LiteralPath $SearchDir)) {
    return $null
  }

  return Get-ChildItem -LiteralPath $SearchDir -Filter $ModelPattern -File -Recurse |
    Sort-Object FullName |
    Select-Object -First 1
}

function Read-TokenFromPrompt {
  $secureToken = Read-Host "Enter Hugging Face token" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if ($TokenPrompt -and [string]::IsNullOrWhiteSpace($env:HF_TOKEN) -and [string]::IsNullOrWhiteSpace($env:HUGGINGFACE_HUB_TOKEN)) {
  $promptToken = Read-TokenFromPrompt
  if (-not [string]::IsNullOrWhiteSpace($promptToken)) {
    $env:HF_TOKEN = $promptToken
  }
}

$tokenSource = $null
if (-not [string]::IsNullOrWhiteSpace($env:HF_TOKEN)) {
  $tokenSource = "HF_TOKEN"
} elseif (-not [string]::IsNullOrWhiteSpace($env:HUGGINGFACE_HUB_TOKEN)) {
  $tokenSource = "HUGGINGFACE_HUB_TOKEN"
}

$uvLauncher = Get-UvLauncher
$huggingFaceCli = Get-HuggingFaceCliLauncher
if ($huggingFaceCli) {
  if ($huggingFaceCli.Name -eq "hf") {
    $downloadCommand = @(
      $huggingFaceCli.Command, "download", $Repo,
      "--local-dir", $ResolvedModelDir
    )
  } else {
    $downloadCommand = @(
      $huggingFaceCli.Command, "download", $Repo,
      "--local-dir", $ResolvedModelDir,
      "--local-dir-use-symlinks", "False"
    )
  }
} else {
  $downloadArgs = @(
    "--from", "huggingface_hub[cli]",
    "huggingface-cli", "download", $Repo,
    "--local-dir", $ResolvedModelDir,
    "--local-dir-use-symlinks", "False"
  )
  $downloadCommand = New-UvToolCommand -Launcher $uvLauncher -ToolArgs $downloadArgs
}

$liteRtLm = Get-LiteRtLmCommand -ExplicitCommand $LiteRtCommand
if ($liteRtLm) {
  $litertVerifyCommand = @($liteRtLm.Command, "--help")
} else {
  $litertVerifyArgs = @(
    "--from", "litert-lm",
    "litert-lm", "--help"
  )
  $litertVerifyCommand = New-UvToolCommand -Launcher $uvLauncher -ToolArgs $litertVerifyArgs
}

Write-Step "Gemma model repo: $Repo"
Write-Step "Gemma model directory: $ResolvedModelDir"
Write-Step "Gemma model source: $(if ([string]::IsNullOrWhiteSpace($ModelSource)) { '<huggingface download>' } else { $ModelSource })"
Write-Step "Gemma model file pattern: $ModelPattern"
Write-Step "uv cache directory: $env:UV_CACHE_DIR"
Write-Step "uv tool directory: $env:UV_TOOL_DIR"
Write-Step "Hugging Face cache directory: $env:HF_HUB_CACHE"

if ($DryRun) {
  Write-Step "Dry run only; no files will be downloaded or deleted."
  if (-not [string]::IsNullOrWhiteSpace($ModelSource)) {
    Write-Step "Would install Gemma model from source: $ModelSource"
  } elseif ($tokenSource) {
    Write-Step "Hugging Face token source: $tokenSource"
  } else {
    Write-Warning "HF_TOKEN or HUGGINGFACE_HUB_TOKEN is not set. A real run will fail until one is set."
  }

  if ($uvLauncher) {
    Write-Step "uv launcher: $($uvLauncher.Name) at $($uvLauncher.Command)"
  } else {
    Write-Warning "uv/uvx was not found. Install uv before a real run: https://docs.astral.sh/uv/"
  }
  if ($huggingFaceCli) {
    Write-Step "Hugging Face CLI: $($huggingFaceCli.Name) at $($huggingFaceCli.Command)"
  } else {
    Write-Step "Hugging Face CLI was not found; would use uvx to run huggingface_hub[cli]."
  }
  if ($liteRtLm) {
    Write-Step "LiteRT-LM CLI: $($liteRtLm.Name) at $($liteRtLm.Command)"
  } elseif ($SkipLiteRtVerify) {
    Write-Step "Would skip LiteRT-LM CLI verification because -SkipLiteRtVerify was supplied."
  } else {
    Write-Step "LiteRT-LM CLI was not found; would use uvx to run litert-lm --help."
  }

  if ($Force) {
    Write-Step "Would remove the existing model directory before download because -Force was supplied."
  }

  if ([string]::IsNullOrWhiteSpace($ModelSource)) {
    Write-Step "Would download with: $(Join-CommandForDisplay $downloadCommand)"
  }
  if (-not $SkipLiteRtVerify) {
    Write-Step "Would verify LiteRT-LM CLI with: $(Join-CommandForDisplay $litertVerifyCommand)"
  }
  Write-Step "Would scan for: $ModelPattern"
  exit 0
}

if (-not $tokenSource -and [string]::IsNullOrWhiteSpace($ModelSource)) {
  throw "HF_TOKEN or HUGGINGFACE_HUB_TOKEN is required. Set one after accepting the Gemma model terms on Hugging Face, then rerun npm run setup:gemma."
}

if (-not $uvLauncher -and -not $huggingFaceCli -and [string]::IsNullOrWhiteSpace($ModelSource)) {
  throw "uv or uvx was not found. Install uv first, then rerun npm run setup:gemma. See https://docs.astral.sh/uv/"
}
if (-not $SkipLiteRtVerify -and -not $liteRtLm -and -not $uvLauncher) {
  throw "litert-lm was not found and uv/uvx is unavailable for verification. Install litert-lm, pass -LiteRtCommand <path>, or rerun with -SkipLiteRtVerify."
}

if ([string]::IsNullOrWhiteSpace($env:HF_TOKEN) -and -not [string]::IsNullOrWhiteSpace($env:HUGGINGFACE_HUB_TOKEN)) {
  $env:HF_TOKEN = $env:HUGGINGFACE_HUB_TOKEN
}
if ([string]::IsNullOrWhiteSpace($env:HUGGINGFACE_HUB_TOKEN) -and -not [string]::IsNullOrWhiteSpace($env:HF_TOKEN)) {
  $env:HUGGINGFACE_HUB_TOKEN = $env:HF_TOKEN
}

$existingModel = Find-GemmaModelFile -SearchDir $ResolvedModelDir
if ($existingModel -and -not $Force) {
  Write-Step "Found existing model file; skipping download: $($existingModel.FullName)"
} else {
  if ((Test-Path -LiteralPath $ResolvedModelDir) -and $Force) {
    Write-Step "Removing existing model directory because -Force was supplied."
    Remove-Item -LiteralPath $ResolvedModelDir -Recurse -Force
  }

  New-Item -ItemType Directory -Path $ResolvedModelDir -Force | Out-Null
  if (-not [string]::IsNullOrWhiteSpace($ModelSource)) {
    Install-ModelSource -Source $ModelSource -DestinationDir $ResolvedModelDir | Out-Null
  } else {
    Write-Step "Downloading Gemma 4 E2B LiteRT-LM with: $(Join-CommandForDisplay $downloadCommand)"
    Invoke-NativeCommand -CommandParts $downloadCommand
  }
}

$modelFile = Find-GemmaModelFile -SearchDir $ResolvedModelDir
if (-not $modelFile) {
  throw "No $ModelPattern file was found under $ResolvedModelDir. Check that repo '$Repo' contains the LiteRT-LM artifact and that the download completed successfully."
}

Write-Step "Verified model file: $($modelFile.FullName)"
if ($SkipLiteRtVerify) {
  Write-Step "Skipping LiteRT-LM CLI verification because -SkipLiteRtVerify was supplied."
} else {
  Write-Step "Verifying LiteRT-LM CLI with: $(Join-CommandForDisplay $litertVerifyCommand)"
  Invoke-NativeCommand -CommandParts $litertVerifyCommand
}
Write-Step "Gemma setup complete."
