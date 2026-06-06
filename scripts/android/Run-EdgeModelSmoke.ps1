param(
  [string]$PackageName = "com.firstaid.copilot.debug",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Adb = "D:\android-dev\android-sdk\platform-tools\adb.exe",
  [string]$Apk = "",
  [int]$TimeoutSec = 180,
  [int]$InstallTimeoutSec = 180,
  [ValidateSet("all", "gemma", "tts", "asr")]
  [string]$Mode = "all",
  [int]$Runs = 1,
  [int]$Threads = 2,
  [string]$TtsText = "",
  [string]$AsrSample = "",
  [int]$AsrMaxMs = 0,
  [string]$GemmaPrompt = "",
  [ValidateSet("auto", "gpu", "gpu-only", "cpu", "cpu-only")]
  [string]$GemmaBackend = "cpu-only",
  [ValidateSet("on", "off")]
  [string]$GemmaSpeculative = "on",
  [int]$GemmaCpuThreads = 0,
  [int]$GemmaMaxNumTokens = 0,
  [ValidateSet("default", "deterministic", "greedy", "stable", "top1")]
  [string]$GemmaSampler = "default",
  [int]$GemmaGateMs = 0,
  [int]$GemmaBudgetMs = 0,
  [int]$GemmaTimeoutMs = 0,
  [switch]$AllowSmokeFailure,
  [switch]$InstallApk
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host "[edge-smoke] $Message"
}

function Resolve-Adb() {
  if (Test-Path -LiteralPath $script:Adb) { return }
  $found = Get-Command adb -ErrorAction SilentlyContinue
  if (!$found) { throw "adb not found. Pass -Adb or install Android platform-tools." }
  $script:Adb = $found.Source
}

function Quote-ProcessArg([string]$Arg) {
  if ($Arg -notmatch '[\s"]') { return $Arg }
  '"' + ($Arg -replace '"', '\"') + '"'
}

function Invoke-AdbProcess([string[]]$AdbArgs, [int]$TimeoutSeconds, [switch]$AllowFailure) {
  Resolve-Adb
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $script:Adb
  $startInfo.Arguments = ($AdbArgs | ForEach-Object { Quote-ProcessArg $_ }) -join " "
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.UseShellExecute = $false
  # adb emits UTF-8; decode as UTF-8 so Chinese prompts/answers survive instead
  # of being mangled by the console's legacy (GBK) code page.
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  $process = [System.Diagnostics.Process]::Start($startInfo)
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    try {
      $process.Kill($true)
    } catch [System.Management.Automation.MethodException] {
      $process.Kill()
    }
    throw "adb timed out after ${TimeoutSeconds}s: $($AdbArgs -join ' '). If a vivo install verification prompt is visible, complete it on the phone, then rerun with -InstallApk omitted."
  }
  $text = (($process.StandardOutput.ReadToEnd(), $process.StandardError.ReadToEnd()) -join "`n").Trim()
  if ($process.ExitCode -ne 0 -and !$AllowFailure) {
    throw "adb failed ($($process.ExitCode)): $($AdbArgs -join ' ')`n$text"
  }
  [pscustomobject]@{ ExitCode = $process.ExitCode; Text = $text }
}

function Invoke-AdbText([string[]]$AdbArgs, [switch]$AllowFailure) {
  Invoke-AdbProcess -AdbArgs $AdbArgs -TimeoutSeconds 120 -AllowFailure:$AllowFailure
}

function Invoke-AdbWithTimeout([string[]]$AdbArgs, [int]$TimeoutSeconds) {
  (Invoke-AdbProcess -AdbArgs $AdbArgs -TimeoutSeconds $TimeoutSeconds).Text
}

if ([string]::IsNullOrWhiteSpace($Apk)) {
  $Apk = Join-Path $RepoRoot "android\app\build\outputs\apk\debug\app-debug.apk"
}

(Invoke-AdbText -AdbArgs @("devices")).Text | Out-Host

if ($InstallApk) {
  if (!(Test-Path -LiteralPath $Apk)) { throw "APK not found: $Apk" }
  Write-Step "installing $Apk"
  Invoke-AdbWithTimeout -AdbArgs @("install", "-r", "-g", "-t", $Apk) -TimeoutSeconds $InstallTimeoutSec | Out-Host
}

$component = "$PackageName/com.firstaid.copilot.live.edge.EdgeModelSmokeActivity"
$remoteJson = "/sdcard/Android/media/$PackageName/smoke/edge-model-smoke.json"
$remoteTrace = "/sdcard/Android/media/$PackageName/smoke/sherpa-debug.txt"

Write-Step "stopping $PackageName"
Invoke-AdbText -AdbArgs @("shell", "am", "force-stop", $PackageName) | Out-Null

Write-Step "clearing previous smoke output"
Invoke-AdbText -AdbArgs @("shell", "rm", "-f", $remoteJson, $remoteTrace) | Out-Null
Invoke-AdbText -AdbArgs @("logcat", "-c") | Out-Null

Write-Step "launching $component mode=$Mode"
$startArgs = @(
  "shell", "am", "start", "-n", $component,
  "--es", "mode", $Mode,
  "--ei", "runs", "$Runs",
  "--ei", "threads", "$Threads"
)
if (![string]::IsNullOrWhiteSpace($TtsText)) {
  $startArgs += @("--es", "ttsText", $TtsText)
}
if (![string]::IsNullOrWhiteSpace($AsrSample)) {
  $startArgs += @("--es", "asrSample", $AsrSample)
}
if ($AsrMaxMs -gt 0) {
  $startArgs += @("--ei", "asrMaxMs", "$AsrMaxMs")
}
if (![string]::IsNullOrWhiteSpace($GemmaPrompt)) {
  $startArgs += @("--es", "gemmaPrompt", $GemmaPrompt)
}
if ($GemmaBackend -ne "auto") {
  $startArgs += @("--es", "gemmaBackend", $GemmaBackend)
}
if ($GemmaSpeculative -ne "on") {
  $startArgs += @("--es", "gemmaSpeculative", $GemmaSpeculative)
}
if ($GemmaCpuThreads -gt 0) {
  $startArgs += @("--ei", "gemmaCpuThreads", "$GemmaCpuThreads")
}
if ($GemmaMaxNumTokens -gt 0) {
  $startArgs += @("--ei", "gemmaMaxNumTokens", "$GemmaMaxNumTokens")
}
if ($GemmaSampler -ne "default") {
  $startArgs += @("--es", "gemmaSampler", $GemmaSampler)
}
if ($GemmaGateMs -gt 0) {
  $startArgs += @("--ei", "gemmaGateMs", "$GemmaGateMs")
}
if ($GemmaBudgetMs -gt 0) {
  $startArgs += @("--ei", "gemmaBudgetMs", "$GemmaBudgetMs")
}
if ($GemmaTimeoutMs -gt 0) {
  $startArgs += @("--ei", "gemmaTimeoutMs", "$GemmaTimeoutMs")
}
$start = Invoke-AdbText -AdbArgs $startArgs -AllowFailure
if ($start.ExitCode -ne 0 -or $start.Text -match "Error type|Exception|not found|does not exist") {
  Write-Host "[edge-smoke] ERROR: could not launch smoke activity. Install the latest debug APK first."
  $start.Text | Out-Host
  exit 2
}
$start.Text | Out-Host

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Seconds 5
  # exec-out is binary-safe (no PTY/CRLF translation), so multi-byte UTF-8 in the
  # JSON (e.g. Chinese Gemma prompts/answers) is not corrupted on the way back.
  $json = Invoke-AdbText -AdbArgs @("exec-out", "cat", $remoteJson) -AllowFailure
  if ($json.ExitCode -eq 0 -and $json.Text.TrimStart().StartsWith("{")) {
    $result = $null
    try {
      $result = $json.Text | ConvertFrom-Json
    } catch {
      # A checkpoint may be read mid-write; treat as not-ready and poll again.
      Write-Step "waiting for a complete $remoteJson"
      continue
    }
    if ($result.phase -ne "finished") {
      Write-Step "checkpoint phase=$($result.phase)"
      continue
    }
    $json.Text | Out-Host
    if ($result.ok -eq $true) {
      Write-Step "smoke passed"
      exit 0
    }
    if ($AllowSmokeFailure) {
      Write-Step "smoke completed with ok=false"
      exit 0
    }
    throw "smoke completed but reported failure"
  }
  Write-Step "waiting for $remoteJson"
}

Write-Step "timed out; recent model logs follow"
$last = Invoke-AdbText -AdbArgs @("exec-out", "cat", $remoteJson) -AllowFailure
if ($last.ExitCode -eq 0 -and $last.Text.TrimStart().StartsWith("{")) {
  Write-Step "last checkpoint"
  $last.Text | Out-Host
}
Write-Step "last sherpa trace"
Invoke-AdbText -AdbArgs @("exec-out", "cat", $remoteTrace) -AllowFailure |
  ForEach-Object { $_.Text } |
  Out-Host
Invoke-AdbText -AdbArgs @("logcat", "-d", "-t", "300", "EdgeModelSmoke:I", "SherpaSpeechEngine:I", "EdgeTextToSpeech:I", "AndroidRuntime:E", "libc:E", "DEBUG:E", "*:S") -AllowFailure |
  ForEach-Object { $_.Text } |
  Out-Host
throw "edge model smoke timed out after ${TimeoutSec}s"
