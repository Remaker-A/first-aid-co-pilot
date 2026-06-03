param(
  [switch]$DryRun,
  [switch]$Force,
  [switch]$TokenPrompt,
  [switch]$SkipLiteRtVerify,
  [string]$Repo = "litert-community/gemma-4-E2B-it-litert-lm",
  [string]$ModelDir = "models/gemma/gemma-4-E2B-it-litert-lm",
  [string]$ModelSource = "",
  [string]$LiteRtCommand = "",
  [string]$LiteRtPackageSource = "",
  [string]$UvPython = "",
  [string[]]$LiteRtPackages = @("litert-lm-nightly", "litert-lm")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ModelPattern = "gemma-4-E2B-it*.litertlm"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$WorkspaceUvCacheDir = Join-Path $RepoRoot ".cache\uv"
$WorkspaceUvToolDir = Join-Path $RepoRoot ".cache\uv\tools"
$WorkspaceUvPythonInstallDir = Join-Path $RepoRoot ".cache\uv\python"
$WorkspaceHfHomeDir = Join-Path $RepoRoot ".cache\huggingface"
$WorkspaceHfHubCacheDir = Join-Path $WorkspaceHfHomeDir "hub"

if ([string]::IsNullOrWhiteSpace($env:UV_CACHE_DIR)) {
  $env:UV_CACHE_DIR = $WorkspaceUvCacheDir
}
if ([string]::IsNullOrWhiteSpace($env:UV_TOOL_DIR)) {
  $env:UV_TOOL_DIR = $WorkspaceUvToolDir
}
if ([string]::IsNullOrWhiteSpace($env:UV_PYTHON_INSTALL_DIR)) {
  $env:UV_PYTHON_INSTALL_DIR = $WorkspaceUvPythonInstallDir
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
  $uv = Get-Command "uv" -ErrorAction SilentlyContinue
  if ($uv) {
    return @{
      Command = $uv.Source
      Prefix = @("tool", "run")
      Name = "uv tool run"
    }
  }

  $uvx = Get-Command "uvx" -ErrorAction SilentlyContinue
  if ($uvx) {
    return @{
      Command = $uvx.Source
      Prefix = @()
      Name = "uvx"
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
    [string]$Python,
    [string[]]$ToolArgs
  )

  $pythonArgs = @()
  if (-not [string]::IsNullOrWhiteSpace($Python)) {
    $pythonArgs = @("--python", $Python)
  }

  if ($null -eq $Launcher) {
    return @("uvx") + $pythonArgs + $ToolArgs
  }

  return @($Launcher.Command) + [string[]]$Launcher.Prefix + $pythonArgs + $ToolArgs
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
    try {
      & $fromPath.Source --help 1>$null 2>$null
      if ($LASTEXITCODE -eq 0) {
        return @{
          Command = $fromPath.Source
          Name = "litert-lm"
        }
      }
    } catch {
      # Fall through to uv package candidates below.
    }

    Write-Warning "Found litert-lm at $($fromPath.Source), but it is not callable. Will try uv package candidates instead."
  }

  return $null
}

function New-LiteRtVerifyCommands {
  param(
    [hashtable]$LiteRtLm,
    [hashtable]$UvLauncher,
    [string]$Python,
    [string]$PackageSource,
    [string[]]$Packages
  )

  $commands = New-Object System.Collections.Generic.List[object]
  if ($LiteRtLm) {
    $commands.Add([pscustomobject]@{
      Parts = [string[]]@($LiteRtLm.Command, "--help")
    }) | Out-Null
    return $commands
  }

  $candidateSources = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($PackageSource)) {
    $candidateSources.Add((Resolve-LocalPath -PathValue $PackageSource)) | Out-Null
  }
  foreach ($package in $Packages) {
    if ([string]::IsNullOrWhiteSpace($package)) {
      continue
    }

    $candidateSources.Add($package) | Out-Null
  }

  foreach ($source in $candidateSources) {
    $toolArgs = @(
      "--from", $source,
      "litert-lm", "--help"
    )
    $commands.Add([pscustomobject]@{
      Parts = [string[]](New-UvToolCommand -Launcher $UvLauncher -Python $Python -ToolArgs $toolArgs)
    }) | Out-Null
  }

  return $commands
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

function Invoke-FirstSuccessfulCommand {
  param($CommandCandidates)

  $failures = @()
  foreach ($candidate in $CommandCandidates) {
    $commandParts = [string[]]$candidate.Parts
    try {
      Invoke-NativeCommand -CommandParts $commandParts
      return
    } catch {
      $failures += $_.Exception.Message
      Write-Warning $_.Exception.Message
    }
  }

  throw "All LiteRT-LM verification commands failed.`n$($failures -join "`n")"
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
  $downloadCommand = New-UvToolCommand -Launcher $uvLauncher -Python $UvPython -ToolArgs $downloadArgs
}

$liteRtLm = Get-LiteRtLmCommand -ExplicitCommand $LiteRtCommand
$litertVerifyCommands = New-LiteRtVerifyCommands -LiteRtLm $liteRtLm -UvLauncher $uvLauncher -Python $UvPython -PackageSource $LiteRtPackageSource -Packages $LiteRtPackages

Write-Step "Gemma model repo: $Repo"
Write-Step "Gemma model directory: $ResolvedModelDir"
Write-Step "Gemma model source: $(if ([string]::IsNullOrWhiteSpace($ModelSource)) { '<huggingface download>' } else { $ModelSource })"
Write-Step "Gemma model file pattern: $ModelPattern"
Write-Step "uv cache directory: $env:UV_CACHE_DIR"
Write-Step "uv tool directory: $env:UV_TOOL_DIR"
Write-Step "uv Python install directory: $env:UV_PYTHON_INSTALL_DIR"
if (-not [string]::IsNullOrWhiteSpace($UvPython)) {
  Write-Step "uv tool Python override: $UvPython"
}
if (-not [string]::IsNullOrWhiteSpace($LiteRtPackageSource)) {
  Write-Step "LiteRT-LM local package source: $(Resolve-LocalPath -PathValue $LiteRtPackageSource)"
}
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
  } elseif (-not [string]::IsNullOrWhiteSpace($LiteRtPackageSource)) {
    Write-Step "LiteRT-LM CLI was not found or not callable; would try local package source first, then uv package candidates: $($LiteRtPackages -join ', ')."
  } else {
    Write-Step "LiteRT-LM CLI was not found or not callable; would use uv package candidates: $($LiteRtPackages -join ', ')."
  }

  if ($Force) {
    Write-Step "Would remove the existing model directory before download because -Force was supplied."
  }

  if ([string]::IsNullOrWhiteSpace($ModelSource)) {
    Write-Step "Would download with: $(Join-CommandForDisplay $downloadCommand)"
  }
  if (-not $SkipLiteRtVerify) {
    foreach ($candidate in $litertVerifyCommands) {
      Write-Step "Would verify LiteRT-LM CLI with: $(Join-CommandForDisplay ([string[]]$candidate.Parts))"
    }
  }
  Write-Step "Would scan for: $ModelPattern"
  exit 0
}

$existingModel = Find-GemmaModelFile -SearchDir $ResolvedModelDir
if (-not $existingModel -and -not $tokenSource -and [string]::IsNullOrWhiteSpace($ModelSource)) {
  throw "HF_TOKEN or HUGGINGFACE_HUB_TOKEN is required to download the Gemma model. Set one after accepting the Gemma model terms on Hugging Face, pass -ModelSource <path>, or keep the existing model file in place."
}

if (-not $uvLauncher -and -not $huggingFaceCli -and [string]::IsNullOrWhiteSpace($ModelSource)) {
  throw "uv or uvx was not found. Install uv first, then rerun npm run setup:gemma. See https://docs.astral.sh/uv/"
}
if (-not $SkipLiteRtVerify -and -not $liteRtLm -and (-not $uvLauncher -or $litertVerifyCommands.Count -eq 0)) {
  throw "litert-lm was not found and uv/uvx is unavailable for verification. Install litert-lm, pass -LiteRtCommand <path>, set GEMMA_COMMAND/GEMMA_COMMAND_PREFIX_ARGS for a module runner, or rerun with -SkipLiteRtVerify."
}

if ([string]::IsNullOrWhiteSpace($env:HF_TOKEN) -and -not [string]::IsNullOrWhiteSpace($env:HUGGINGFACE_HUB_TOKEN)) {
  $env:HF_TOKEN = $env:HUGGINGFACE_HUB_TOKEN
}
if ([string]::IsNullOrWhiteSpace($env:HUGGINGFACE_HUB_TOKEN) -and -not [string]::IsNullOrWhiteSpace($env:HF_TOKEN)) {
  $env:HUGGINGFACE_HUB_TOKEN = $env:HF_TOKEN
}

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
  foreach ($candidate in $litertVerifyCommands) {
    Write-Step "LiteRT-LM verification candidate: $(Join-CommandForDisplay ([string[]]$candidate.Parts))"
  }
  Invoke-FirstSuccessfulCommand -CommandCandidates $litertVerifyCommands
}
Write-Step "Gemma setup complete."
