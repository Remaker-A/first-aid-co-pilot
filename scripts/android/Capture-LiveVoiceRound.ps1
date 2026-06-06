param(
  [string]$PackageName = "com.firstaid.copilot.debug",
  [string]$Adb = "D:\android-dev\android-sdk\platform-tools\adb.exe",
  [string]$ArtifactsRoot = "",
  [int]$DurationSeconds = 180,
  [switch]$TapOneKey,
  [switch]$NoLaunch,
  [switch]$SkipHealth
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($ArtifactsRoot)) {
  $ArtifactsRoot = Join-Path $RepoRoot "artifacts"
}
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ArtifactDir = Join-Path $ArtifactsRoot "vivo-live-$Timestamp"
$LogPath = Join-Path $ArtifactDir "logcat-live.txt"
$SummaryPath = Join-Path $ArtifactDir "summary.json"
$PackagePath = Join-Path $ArtifactDir "package.txt"

function Write-Step([string]$Message) {
  Write-Host "[vivo-live] $Message"
}

function Invoke-Adb([string[]]$Arguments, [switch]$AllowFailure) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $Adb @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0 -and !$AllowFailure) {
    $text = ($output | Out-String).Trim()
    throw "adb failed ($exitCode): $($Arguments -join ' ')`n$text"
  }
  return ($output | Out-String)
}

function Save-DeviceSnapshot([string]$Name) {
  $remoteXml = "/sdcard/firstaid-$Name.xml"
  $remotePng = "/sdcard/firstaid-$Name.png"
  Invoke-Adb @("shell", "uiautomator", "dump", $remoteXml) -AllowFailure | Out-Null
  Invoke-Adb @("exec-out", "cat", $remoteXml) -AllowFailure |
    Set-Content -LiteralPath (Join-Path $ArtifactDir "$Name.xml") -Encoding UTF8
  Invoke-Adb @("shell", "screencap", "-p", $remotePng) -AllowFailure | Out-Null
  Invoke-Adb @("pull", $remotePng, (Join-Path $ArtifactDir "$Name.png")) -AllowFailure | Out-Null
}

function Percentile([double[]]$Values, [double]$P) {
  if ($Values.Count -eq 0) { return $null }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Ceiling($sorted.Count * $P) - 1
  if ($index -lt 0) { $index = 0 }
  if ($index -ge $sorted.Count) { $index = $sorted.Count - 1 }
  return [int][Math]::Round($sorted[$index])
}

function LatencySummary([object[]]$Values) {
  $numbers = @($Values | Where-Object { $null -ne $_ -and $_ -ge 0 } | ForEach-Object { [double]$_ })
  if ($numbers.Count -eq 0) {
    return [ordered]@{ count = 0; p50 = $null; p95 = $null; max = $null }
  }
  return [ordered]@{
    count = $numbers.Count
    p50 = Percentile $numbers 0.50
    p95 = Percentile $numbers 0.95
    max = [int][Math]::Round(($numbers | Measure-Object -Maximum).Maximum)
  }
}

function FloatPercentile([double[]]$Values, [double]$P) {
  if ($Values.Count -eq 0) { return $null }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Ceiling($sorted.Count * $P) - 1
  if ($index -lt 0) { $index = 0 }
  if ($index -ge $sorted.Count) { $index = $sorted.Count - 1 }
  return [Math]::Round($sorted[$index], 4)
}

function FloatSummary([object[]]$Values) {
  $numbers = @($Values | Where-Object { $null -ne $_ -and $_ -ge 0 } | ForEach-Object { [double]$_ })
  if ($numbers.Count -eq 0) {
    return [ordered]@{ count = 0; p50 = $null; p95 = $null; max = $null }
  }
  return [ordered]@{
    count = $numbers.Count
    p50 = FloatPercentile $numbers 0.50
    p95 = FloatPercentile $numbers 0.95
    max = [Math]::Round(($numbers | Measure-Object -Maximum).Maximum, 4)
  }
}

function LogTimeMs([string]$Line) {
  if ($Line -match "^\s*(?<seconds>\d+(?:\.\d+)?)\s") {
    return [double]$Matches.seconds * 1000.0
  }
  return $null
}

function ValuesAfter([object[]]$StartTimes, [object[]]$EndTimes) {
  $latencies = @()
  $cursor = 0
  foreach ($start in @($StartTimes | Where-Object { $null -ne $_ })) {
    while ($cursor -lt $EndTimes.Count -and $EndTimes[$cursor] -lt $start) {
      $cursor += 1
    }
    if ($cursor -lt $EndTimes.Count) {
      $latencies += ([double]$EndTimes[$cursor] - [double]$start)
      $cursor += 1
    }
  }
  return $latencies
}

function FirstValuesAfter([object[]]$StartTimes, [object[]]$EndTimes) {
  $latencies = @()
  foreach ($start in @($StartTimes | Where-Object { $null -ne $_ })) {
    $end = @($EndTimes | Where-Object { $_ -ge $start } | Select-Object -First 1)
    if ($end.Count -gt 0) {
      $latencies += ([double]$end[0] - [double]$start)
    }
  }
  return $latencies
}

function Parse-MetricsLine([string]$Line) {
  if ($Line -notmatch "Live metrics turn=(?<turn>-?\d+) stage=(?<stage>\S*) source=(?<source>\S*) intent=(?<intent>\S*) intentSource=(?<intentSource>\S*) total=(?<total>-?\d+)ms tts=(?<tts>-?\d+)ms audio=(?<audio>-?\d+)ms openSegment=(?<openSegment>\S*) openWait=(?<openWait>-?\d+)ms openFallback=(?<openFallback>true|false)") {
    return $null
  }
  return [ordered]@{
    turn = [int]$Matches.turn
    stage = $Matches.stage
    source = $Matches.source
    intent = $Matches.intent
    intentSource = $Matches.intentSource
    totalMs = [int]$Matches.total
    ttsMs = [int]$Matches.tts
    audioMs = [int]$Matches.audio
    openSegment = $Matches.openSegment
    openWaitMs = [int]$Matches.openWait
    openFallback = $Matches.openFallback -eq "true"
  }
}

function Analyze-Log([string]$Path) {
  $metrics = @()
  $asrPartials = @()
  $asrFinals = @()
  $asrPartialTimes = @()
  $asrFinalTimes = @()
  $ttsStarts = @()
  $ttsStartTimes = @()
  $liveAudioStarts = @()
  $serverAudioBegins = 0
  $serverAudioChunks = 0
  $serverAudioEnds = 0
  $errors = @()
  $utteranceCommits = 0
  $utteranceCommitTimes = @()
  $wsOpened = $false
  $captureRmsPeaks = @()
  $captureVoiceActiveEvents = 0
  $voiceActiveTimes = @()
  $guidanceTimes = @()
  $audioBeginTimes = @()
  $captureStarted = $false

  if (Test-Path -LiteralPath $Path) {
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
      $timeMs = LogTimeMs $line
      if ($line -match "Live WebSocket opened") { $wsOpened = $true }
      $metric = Parse-MetricsLine $line
      if ($null -ne $metric) { $metrics += $metric }
      if ($line -match "ASR partial='(?<text>[^']*)'") {
        $asrPartials += $Matches.text
        if ($null -ne $timeMs) { $asrPartialTimes += $timeMs }
      }
      if ($line -match "ASR final='(?<text>[^']*)' intent=(?<intent>\S*) confidence=(?<confidence>\S+)") {
        $asrFinals += [ordered]@{
          text = $Matches.text
          intent = $Matches.intent
          confidence = $Matches.confidence
        }
        if ($null -ne $timeMs) { $asrFinalTimes += $timeMs }
      }
      if ($line -match "Received live text .*`"type`":`"guidance`"") { if ($null -ne $timeMs) { $guidanceTimes += $timeMs } }
      if ($line -match "Received live text .*`"type`":`"audio_begin`"") { if ($null -ne $timeMs) { $audioBeginTimes += $timeMs } }
      if ($line -match "Audio capture started threshold=") { $captureStarted = $true }
      if ($line -match "Capture rmsPeak=(?<peak>[0-9.]+(?:[Ee][+-]?\d+)?)") {
        $captureRmsPeaks += [double]$Matches.peak
      }
      if ($line -match "Voice active voicedMs=") {
        $captureVoiceActiveEvents += 1
        if ($null -ne $timeMs) { $voiceActiveTimes += $timeMs }
      }
      if ($line -match "Local utterance committed bytes=") {
        $utteranceCommits += 1
        if ($null -ne $timeMs) { $utteranceCommitTimes += $timeMs }
      }
      if ($line -match "Android TTS onStart latency=(?<ms>\d+)ms") {
        $ttsStarts += [int]$Matches.ms
        if ($null -ne $timeMs) { $ttsStartTimes += $timeMs }
      }
      if ($line -match "Live audio start latency=(?<ms>\d+)ms") { $liveAudioStarts += [int]$Matches.ms }
      if ($line -match '"type":"audio_begin"') { $serverAudioBegins += 1 }
      if ($line -match "Received live audio bytes=") { $serverAudioChunks += 1 }
      if ($line -match '"type":"audio_end"') { $serverAudioEnds += 1 }
      if ($line -match "(Exception|Error|Failed|failed|timeout|timed out)" -and $line -notmatch "openFallback=false") {
        $errors += $line
      }
    }
  }

  $openAnswerMetrics = @($metrics | Where-Object { $_.openSegment -eq "answer" })
  $voiceToPartial = FirstValuesAfter $voiceActiveTimes $asrPartialTimes
  $speechEndToFinal = ValuesAfter $utteranceCommitTimes $asrFinalTimes
  $finalToGuidance = ValuesAfter $asrFinalTimes $guidanceTimes
  $guidanceToTts = ValuesAfter $guidanceTimes $ttsStartTimes
  $finalToTts = FirstValuesAfter $asrFinalTimes $ttsStartTimes
  $speechEndToTts = FirstValuesAfter $utteranceCommitTimes $ttsStartTimes
  return [ordered]@{
    ok = $wsOpened -and ($metrics.Count -gt 0 -or $asrFinals.Count -gt 0)
    artifactDir = $ArtifactDir
    log = $LogPath
    counts = [ordered]@{
      metrics = $metrics.Count
      asrPartials = $asrPartials.Count
      asrFinals = $asrFinals.Count
      utteranceCommits = $utteranceCommits
      ttsStarts = $ttsStarts.Count
      liveAudioStarts = $liveAudioStarts.Count
      serverAudioBegins = $serverAudioBegins
      serverAudioChunks = $serverAudioChunks
      serverAudioEnds = $serverAudioEnds
      errors = $errors.Count
    }
    websocketOpened = $wsOpened
    capture = [ordered]@{
      started = $captureStarted
      rmsPeak = FloatSummary $captureRmsPeaks
      voiceActiveEvents = $captureVoiceActiveEvents
    }
    voicePathLatencyMs = [ordered]@{
      voiceActiveToFirstPartial = LatencySummary $voiceToPartial
      speechEndToFinal = LatencySummary $speechEndToFinal
      finalToGuidance = LatencySummary $finalToGuidance
      guidanceToAndroidTtsStart = LatencySummary $guidanceToTts
      finalToAndroidTtsStart = LatencySummary $finalToTts
      speechEndToAndroidTtsStart = LatencySummary $speechEndToTts
    }
    latencyMs = [ordered]@{
      turnTotal = LatencySummary @($metrics | ForEach-Object { $_.totalMs })
      tts = LatencySummary @($metrics | ForEach-Object { $_.ttsMs })
      serverAudioFirstChunk = LatencySummary @($metrics | ForEach-Object { $_.audioMs })
      androidTtsOnStart = LatencySummary $ttsStarts
      liveAudioStart = LatencySummary $liveAudioStarts
      openQuestionWait = LatencySummary @($openAnswerMetrics | ForEach-Object { $_.openWaitMs })
    }
    intents = @($metrics | ForEach-Object { $_.intent } | Where-Object { $_ } | Sort-Object -Unique)
    stages = @($metrics | ForEach-Object { $_.stage } | Where-Object { $_ } | Sort-Object -Unique)
    asrFinals = $asrFinals
    asrPartials = @($asrPartials | Select-Object -First 12)
    metrics = $metrics
    errors = @($errors | Select-Object -First 30)
    notes = @(
      "voicePathLatencyMs pairs Android logcat epoch timestamps when human speech creates voice-active, ASR final, guidance, and TTS events.",
      "For final acceptance, run 2-3 human spoken rounds and inspect ASR partial/final plus Live metrics counts."
    )
  }
}

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Step "artifact dir: $ArtifactDir"

if (!(Test-Path -LiteralPath $Adb)) {
  throw "adb not found: $Adb"
}

Invoke-Adb @("devices", "-l") | Tee-Object -FilePath (Join-Path $ArtifactDir "adb-devices.txt") | Out-Host
Invoke-Adb @("reverse", "tcp:8787", "tcp:8787") | Out-Null

if (!$SkipHealth) {
  $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:8787/api/health"
  Set-Content -LiteralPath (Join-Path $ArtifactDir "health.json") -Encoding UTF8 -Value $health.Content
  Write-Step "server health: $($health.Content.Trim())"
}

Invoke-Adb @("shell", "dumpsys", "package", $PackageName) -AllowFailure |
  Set-Content -LiteralPath $PackagePath -Encoding UTF8
Invoke-Adb @("logcat", "-c") | Out-Null

$logcatArgs = @(
  "logcat", "-v", "epoch",
  "WebSocketAgentChannel:I",
  "LiveSessionViewModel:I",
  "LiveCprCoachScreen:I",
  "LiveAudioCapture:I",
  "LiveAudioPlayer:I",
  "AndroidTextToSpeech:I",
  "EdgeTextToSpeech:I",
  "SherpaSpeechEngine:I",
  "AudioRecord:D",
  "AndroidRuntime:E",
  "*:S"
)
$logProcess = Start-Process -FilePath $Adb `
  -ArgumentList $logcatArgs `
  -RedirectStandardOutput $LogPath `
  -WindowStyle Hidden `
  -PassThru

try {
  if (!$NoLaunch) {
    Invoke-Adb @("shell", "am", "force-stop", $PackageName) | Out-Null
    Invoke-Adb @("shell", "am", "start", "-W", "-n", "$PackageName/com.firstaid.copilot.MainActivity") |
      Tee-Object -FilePath (Join-Path $ArtifactDir "launch.txt") |
      Out-Host
    Start-Sleep -Seconds 3
  }

  Save-DeviceSnapshot "before"

  if ($TapOneKey) {
    Write-Step "tapping one-key first aid button"
    Invoke-Adb @("shell", "input", "tap", "360", "920") | Out-Null
    Start-Sleep -Seconds 2
  }

  Write-Step "capture window ${DurationSeconds}s. Speak to the vivo now if running a human round."
  Start-Sleep -Seconds $DurationSeconds

  Save-DeviceSnapshot "after"
} finally {
  if ($logProcess -and !$logProcess.HasExited) {
    Stop-Process -Id $logProcess.Id -Force -ErrorAction SilentlyContinue
    $logProcess.WaitForExit()
  }
}

$summary = Analyze-Log $LogPath
$summary | ConvertTo-Json -Depth 10 |
  Set-Content -LiteralPath $SummaryPath -Encoding UTF8

Write-Step "summary: $SummaryPath"
Write-Host ($summary | ConvertTo-Json -Depth 5)
