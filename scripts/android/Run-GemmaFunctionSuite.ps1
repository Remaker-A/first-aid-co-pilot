param(
  [string]$PackageName = "com.firstaid.copilot.debug",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Adb = "D:\android-dev\android-sdk\platform-tools\adb.exe",
  [string]$Apk = "",
  [int]$TimeoutSec = 300,
  [int]$InstallTimeoutSec = 180,
  # Polling cadence for reading the device-side checkpoint JSON. The suite pins
  # the CPU while Gemma generates (~47s/generate on this device), which starves
  # a foreground `adb exec-out cat`. Poll less aggressively and give each read a
  # generous deadline so a single slow read is retried instead of aborting.
  [int]$PollIntervalSec = 25,
  [int]$PollReadTimeoutSec = 300,
  [int]$Runs = 3,
  [int]$Threads = 0,
  [ValidateSet("auto", "gpu", "gpu-only", "cpu", "cpu-only")]
  [string]$GemmaBackend = "cpu-only",
  [ValidateSet("on", "off")]
  [string]$GemmaSpeculative = "on",
  [int]$GemmaCpuThreads = 0,
  [int]$GemmaMaxNumTokens = 0,
  [ValidateSet("default", "deterministic", "greedy", "stable", "top1")]
  [string]$GemmaSampler = "default",
  [int]$GemmaTimeoutMs = 0,
  [int]$GemmaGateMs = 0,
  [int]$GemmaBudgetMs = 0,
  [switch]$InstallApk,
  [switch]$AllowSuiteFailure
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host "[gemma-suite] $Message"
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
    $timeoutMsg = "adb timed out after ${TimeoutSeconds}s: $($AdbArgs -join ' '). If a vivo install verification prompt is visible, complete it on the phone, then rerun with -InstallApk omitted."
    # A timed-out best-effort read (e.g. a checkpoint poll while the CPU is pinned
    # by Gemma) must not abort the whole run: surface it as a non-zero result so
    # the caller can retry until the overall -TimeoutSec budget is exhausted.
    if ($AllowFailure) {
      return [pscustomobject]@{ ExitCode = -1; Text = $timeoutMsg }
    }
    throw $timeoutMsg
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

function Format-Rate($Value) {
  if ($null -eq $Value) { return "n/a" }
  return ("{0:0.0}%" -f ([double]$Value * 100))
}

function Format-Ms($Value) {
  if ($null -eq $Value) { return "n/a" }
  return ("{0} ms" -f [int][math]::Round([double]$Value))
}

function Format-Recommendation($Recommendation) {
  switch ($Recommendation) {
    "near_realtime_ok" { return "near_realtime_ok (近实时可用)" }
    "ack_then_async" { return "ack_then_async (先应答后异步)" }
    default {
      if ([string]::IsNullOrWhiteSpace($Recommendation)) { return "n/a" }
      return $Recommendation
    }
  }
}

function Test-FunctionPass($Function) {
  if ($null -eq $Function.parseOkRate -or [double]$Function.parseOkRate -lt 1.0) { return $false }
  if ($null -eq $Function.assertPassRate -or [double]$Function.assertPassRate -lt 1.0) { return $false }
  if ($null -ne $Function.bannedHits -and [int]$Function.bannedHits -gt 0) { return $false }
  return $true
}

function Save-Report([string]$JsonText) {
  $artifactsDir = Join-Path $RepoRoot "artifacts"
  if (!(Test-Path -LiteralPath $artifactsDir)) {
    New-Item -ItemType Directory -Path $artifactsDir -Force | Out-Null
  }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $path = Join-Path $artifactsDir ("gemma-suite-{0}.json" -f $stamp)
  # Land the report as UTF-8 without BOM so downstream JSON parsers stay happy.
  [System.IO.File]::WriteAllText($path, $JsonText, (New-Object System.Text.UTF8Encoding($false)))
  return $path
}

function Show-Summary($Report) {
  Write-Host ""
  Write-Step "===== 每功能中文 PASS/FAIL 摘要 ====="
  $functions = $Report.functions
  if ($null -eq $functions) {
    Write-Step "报告缺少 functions 字段，无法生成每功能摘要。"
  } else {
    $preferredOrder = @("patch", "nlu", "open_question", "handover")
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($name in $preferredOrder) {
      if ($functions.PSObject.Properties.Name -contains $name) { [void]$names.Add($name) }
    }
    foreach ($prop in $functions.PSObject.Properties) {
      if ($preferredOrder -notcontains $prop.Name) { [void]$names.Add($prop.Name) }
    }

    foreach ($fname in $names) {
      $fn = $functions.PSObject.Properties[$fname].Value
      $label = if ([string]::IsNullOrWhiteSpace($fn.label)) { $fname } else { $fn.label }
      $status = if (Test-FunctionPass $fn) { "PASS" } else { "FAIL" }
      $banned = if ($null -eq $fn.bannedHits) { 0 } else { [int]$fn.bannedHits }
      Write-Host ""
      Write-Host ("[{0}] {1} ({2})" -f $status, $label, $fname)
      Write-Host ("    解析成功率 parseOkRate = {0}" -f (Format-Rate $fn.parseOkRate))
      Write-Host ("    断言通过率 assertPassRate = {0}" -f (Format-Rate $fn.assertPassRate))
      Write-Host ("    违禁命中 bannedHits = {0}" -f $banned)
      $cases = @($fn.cases)
      if ($cases.Count -eq 0) {
        Write-Host "    (该功能没有 case 明细)"
      } else {
        foreach ($case in $cases) {
          $caseLabel = if ([string]::IsNullOrWhiteSpace($case.label)) { $case.caseId } else { $case.label }
          $okRuns = if ($null -eq $case.okRuns) { "?" } else { $case.okRuns }
          $runs = if ($null -eq $case.runs) { "?" } else { $case.runs }
          $caseBanned = if ($null -eq $case.bannedHits) { 0 } else { [int]$case.bannedHits }
          $p50 = if ($null -ne $case.latency) { $case.latency.p50Ms } else { $null }
          $p95 = if ($null -ne $case.latency) { $case.latency.p95Ms } else { $null }
          $recommendation = if ($null -ne $case.gate) { $case.gate.recommendation } else { $null }
          Write-Host ("      - {0} [{1}]: {2}/{3} 通过, 解析 {4}, 断言 {5}, 违禁 {6}, p50={7} p95={8}, 闸门={9}" -f `
            $caseLabel, $case.caseId, $okRuns, $runs, `
            (Format-Rate $case.parseOkRate), (Format-Rate $case.assertPassRate), $caseBanned, `
            (Format-Ms $p50), (Format-Ms $p95), (Format-Recommendation $recommendation))
        }
      }
    }
  }

  Write-Host ""
  if ($Report.ok -eq $true) {
    Write-Step "总体结果 OVERALL = PASS (顶层 ok=true)"
  } else {
    Write-Step "总体结果 OVERALL = FAIL (顶层 ok=$($Report.ok))"
  }
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
$remoteJson = "/sdcard/Android/media/$PackageName/smoke/gemma-suite.json"

Write-Step "stopping $PackageName"
Invoke-AdbText -AdbArgs @("shell", "am", "force-stop", $PackageName) | Out-Null

Write-Step "clearing previous suite output"
Invoke-AdbText -AdbArgs @("shell", "rm", "-f", $remoteJson) | Out-Null
Invoke-AdbText -AdbArgs @("logcat", "-c") | Out-Null

Write-Step "launching $component mode=gemma-suite runs=$Runs"
$startArgs = @(
  "shell", "am", "start", "-n", $component,
  "--es", "mode", "gemma-suite",
  "--ei", "runs", "$Runs"
)
if ($Threads -gt 0) {
  $startArgs += @("--ei", "threads", "$Threads")
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
if ($GemmaTimeoutMs -gt 0) {
  $startArgs += @("--ei", "gemmaTimeoutMs", "$GemmaTimeoutMs")
}
if ($GemmaGateMs -gt 0) {
  $startArgs += @("--ei", "gemmaGateMs", "$GemmaGateMs")
}
if ($GemmaBudgetMs -gt 0) {
  $startArgs += @("--ei", "gemmaBudgetMs", "$GemmaBudgetMs")
}
$start = Invoke-AdbText -AdbArgs $startArgs -AllowFailure
if ($start.ExitCode -ne 0 -or $start.Text -match "Error type|Exception|not found|does not exist") {
  Write-Host "[gemma-suite] ERROR: could not launch suite activity. Install the latest debug APK first."
  $start.Text | Out-Host
  exit 2
}
$start.Text | Out-Host

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Seconds $PollIntervalSec
  # exec-out is binary-safe (no PTY/CRLF translation), so multi-byte UTF-8 in the
  # JSON (e.g. Chinese Gemma prompts/answers) is not corrupted on the way back.
  # A long per-read deadline + -AllowFailure means a read starved by Gemma's CPU
  # usage returns a non-zero result and is retried on the next poll instead of
  # throwing and killing the whole suite mid-run.
  $json = Invoke-AdbProcess -AdbArgs @("exec-out", "cat", $remoteJson) -TimeoutSeconds $PollReadTimeoutSec -AllowFailure
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
    $reportPath = Save-Report $json.Text
    Write-Step "report saved to $reportPath"
    Show-Summary $result
    if ($result.ok -eq $true) {
      Write-Step "gemma function suite passed"
      exit 0
    }
    if ($AllowSuiteFailure) {
      Write-Step "gemma function suite ok=false (allowed by -AllowSuiteFailure)"
      exit 0
    }
    exit 1
  }
  if ($json.ExitCode -ne 0) {
    Write-Step "checkpoint read slow/unavailable (exit=$($json.ExitCode)); retrying"
  } else {
    Write-Step "waiting for $remoteJson"
  }
}

Write-Step "timed out; recent suite logs follow"
$last = Invoke-AdbText -AdbArgs @("exec-out", "cat", $remoteJson) -AllowFailure
if ($last.ExitCode -eq 0 -and $last.Text.TrimStart().StartsWith("{")) {
  Write-Step "last checkpoint"
  $last.Text | Out-Host
}
Invoke-AdbText -AdbArgs @("logcat", "-d", "-t", "300", "EdgeModelSmoke:I", "AndroidRuntime:E", "libc:E", "DEBUG:E", "*:S") -AllowFailure |
  ForEach-Object { $_.Text } |
  Out-Host
throw "gemma function suite timed out after ${TimeoutSec}s"
