param(
  [int]$Rounds = 2,
  [int]$DurationSeconds = 180,
  [switch]$NoTapOneKey,
  [switch]$NoLaunch,
  [switch]$SkipHealth,
  [string]$PackageName = "com.firstaid.copilot.debug",
  [string]$Adb = "D:\android-dev\android-sdk\platform-tools\adb.exe",
  [string]$ArtifactsRoot = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($ArtifactsRoot)) {
  $ArtifactsRoot = Join-Path $RepoRoot "artifacts"
}

function Write-Step([string]$Message) {
  Write-Host "[vivo-acceptance] $Message"
}

function Get-LatestVivoSummary([string]$Root) {
  Get-ChildItem -LiteralPath $Root -Directory -Filter "vivo-live-*" |
    ForEach-Object {
      $summary = Join-Path $_.FullName "summary.json"
      if (Test-Path -LiteralPath $summary) {
        [pscustomobject]@{
          Directory = $_.FullName
          Summary = $summary
          LastWriteTime = (Get-Item -LiteralPath $summary).LastWriteTime
        }
      }
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Invoke-OneCaptureRound([int]$RoundIndex, [int]$RoundCount, [object]$Before) {
  Write-Step "Round $RoundIndex/$RoundCount suggested spoken flow: scene safe -> unresponsive -> only gasping -> start -> one open question -> AED arrived -> 120 arrived."
  Write-Step "Round $RoundIndex/${RoundCount}: starting ${DurationSeconds}s vivo capture window. Speak to the phone naturally."

  $captureArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $captureScript,
    "-DurationSeconds", [string]$DurationSeconds,
    "-PackageName", $PackageName,
    "-Adb", $Adb,
    "-ArtifactsRoot", $ArtifactsRoot
  )
  if (!$NoTapOneKey) { $captureArgs += "-TapOneKey" }
  if ($NoLaunch) { $captureArgs += "-NoLaunch" }
  if ($SkipHealth) { $captureArgs += "-SkipHealth" }

  & powershell @captureArgs
  $captureExit = $LASTEXITCODE
  if ($captureExit -ne 0) {
    throw "capture round $RoundIndex failed with exit code $captureExit"
  }

  $after = Get-LatestVivoSummary $ArtifactsRoot
  if ($null -eq $after) {
    throw "no vivo live summary found under $ArtifactsRoot"
  }
  if ($Before -and $after.Summary -eq $Before.Summary) {
    throw "capture round $RoundIndex did not create a new summary; latest remains $($after.Summary)"
  }

  Write-Step ("Round " + $RoundIndex + "/" + $RoundCount + " capture complete: " + [string]$after.Directory)
  return $after
}

$captureScript = Join-Path $PSScriptRoot "Capture-LiveVoiceRound.ps1"
$auditScript = Join-Path $RepoRoot "scripts\analyzeVivoLiveVoiceRound.mjs"

if (!(Test-Path -LiteralPath $captureScript)) {
  throw "capture script not found: $captureScript"
}
if (!(Test-Path -LiteralPath $auditScript)) {
  throw "audit script not found: $auditScript"
}

if ($Rounds -lt 1) {
  throw "Rounds must be >= 1"
}

$roundsCompleted = [System.Collections.Generic.List[object]]::new()
$before = Get-LatestVivoSummary $ArtifactsRoot
for ($round = 1; $round -le $Rounds; $round += 1) {
  $after = Invoke-OneCaptureRound $round $Rounds $before
  [void]$roundsCompleted.Add($after)
  $before = $after
}

$artifactDir = [string]$roundsCompleted[$roundsCompleted.Count - 1].Directory
$auditPath = Join-Path $artifactDir "acceptance-audit.json"
$summaryPaths = [System.Collections.Generic.List[string]]::new()
foreach ($roundResult in $roundsCompleted) {
  [void]$summaryPaths.Add([string]$roundResult.Summary)
}

Write-Step ("Auditing " + $summaryPaths.Count + " round summaries.")
foreach ($summaryPath in $summaryPaths) {
  Write-Step ("Audit input: " + $summaryPath)
}

& node $auditScript @($summaryPaths.ToArray()) --min-rounds $Rounds --output-json $auditPath
$auditExit = $LASTEXITCODE
Write-Step ("Audit JSON: " + $auditPath)

exit $auditExit
