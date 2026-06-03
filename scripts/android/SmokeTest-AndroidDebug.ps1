param(
  [switch]$SkipBuild,
  [switch]$KeepTemp,
  [string]$PackageName = "com.firstaid.copilot.debug",
  [string]$DeviceSerial = "",
  [string]$InstallRoot = "D:\android-dev",
  [string]$ApkPath = "",
  [string]$VivoInstallPassword = "",
  [int]$InstallTimeoutSeconds = 240
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$AndroidSource = Join-Path $RepoRoot "android"
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$AndroidSdk = Join-Path $InstallRoot "android-sdk"
$GradleBat = Join-Path $InstallRoot "gradle\gradle-8.13\bin\gradle.bat"
$JavaHome = Join-Path $InstallRoot "jdk"
$Adb = Join-Path $AndroidSdk "platform-tools\adb.exe"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$TempAndroidRoot = Join-Path $InstallRoot "firstaid-android-build-$Timestamp"
$UiDumpLocalPath = Join-Path $InstallRoot "firstaid-android-ui-$Timestamp.xml"
$InstallerDumpLocalPath = Join-Path $InstallRoot "firstaid-android-installer-$Timestamp.xml"
$InstallStdoutPath = Join-Path $InstallRoot "firstaid-android-install-$Timestamp.stdout.txt"
$InstallStderrPath = Join-Path $InstallRoot "firstaid-android-install-$Timestamp.stderr.txt"
$TempCreated = $false

function Write-Step {
  param([string]$Message)
  Write-Host "[android:smoke] $Message"
}

function Assert-PathExists {
  param(
    [string]$PathValue,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $PathValue)) {
    throw "$Label not found: $PathValue"
  }
}

function Add-PathEntry {
  param([string]$PathValue)

  if (-not (Test-Path -LiteralPath $PathValue)) {
    return
  }

  $parts = @()
  if (-not [string]::IsNullOrWhiteSpace($env:PATH)) {
    $parts = $env:PATH -split [System.IO.Path]::PathSeparator
  }

  foreach ($part in $parts) {
    if ($part -ieq $PathValue) {
      return
    }
  }

  $env:PATH = $PathValue + [System.IO.Path]::PathSeparator + $env:PATH
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory = ""
  )

  Write-Step ("Running: {0} {1}" -f $FilePath, ($Arguments -join " "))
  if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    & $FilePath @Arguments
  } else {
    Push-Location -LiteralPath $WorkingDirectory
    try {
      & $FilePath @Arguments
    } finally {
      Pop-Location
    }
  }

  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Command failed with exit code ${exitCode}: $FilePath $($Arguments -join ' ')"
  }
}

function Invoke-Capture {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )

  Write-Step ("Running: {0} {1}" -f $FilePath, ($Arguments -join " "))
  $output = & $FilePath @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    $text = ($output | Out-String).Trim()
    throw "Command failed with exit code ${exitCode}: $FilePath $($Arguments -join ' ')`n$text"
  }

  return $output
}

function Join-ProcessArguments {
  param([string[]]$Arguments)

  return ($Arguments | ForEach-Object {
    if ($_ -match '[\s"]') {
      '"' + ($_ -replace '"', '\"') + '"'
    } else {
      $_
    }
  }) -join " "
}

function Invoke-Adb {
  param([string[]]$Arguments)

  $adbArgs = @()
  if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
    $adbArgs += @("-s", $DeviceSerial)
  }

  $adbArgs += $Arguments
  Invoke-Checked -FilePath $Adb -Arguments $adbArgs
}

function Invoke-AdbCapture {
  param([string[]]$Arguments)

  $adbArgs = @()
  if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
    $adbArgs += @("-s", $DeviceSerial)
  }

  $adbArgs += $Arguments
  Invoke-Capture -FilePath $Adb -Arguments $adbArgs
}

function Get-AdbText {
  param([string[]]$Arguments)

  $output = Invoke-AdbCapture -Arguments $Arguments
  return ($output | Out-String)
}

function Get-UiDumpText {
  Invoke-Adb -Arguments @("shell", "uiautomator", "dump", "/sdcard/firstaid-smoke-current.xml")
  $uiDump = Get-AdbText -Arguments @("exec-out", "cat", "/sdcard/firstaid-smoke-current.xml")
  Set-Content -LiteralPath $InstallerDumpLocalPath -Encoding UTF8 -Value $uiDump
  return $uiDump
}

function Get-NodeCenterFromBounds {
  param(
    [string]$UiDump,
    [string[]]$AttributeMatches
  )

  $xml = $null
  try {
    $xml = [xml]$UiDump
  } catch {
    return $null
  }

  foreach ($attributeMatch in $AttributeMatches) {
    $node = $xml.SelectNodes("//node") |
      Where-Object {
        ($_.text -like "*$attributeMatch*") -or
        ($_.'content-desc' -like "*$attributeMatch*") -or
        ($_.'resource-id' -like "*$attributeMatch*")
      } |
      Select-Object -First 1

    if ($null -ne $node -and $node.bounds -match "\[(\d+),(\d+)\]\[(\d+),(\d+)\]") {
      return @{
        X = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
        Y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
      }
    }
  }

  return $null
}

function Tap-UiTextIfPresent {
  param(
    [string]$UiDump,
    [string[]]$AttributeMatches
  )

  $center = Get-NodeCenterFromBounds -UiDump $UiDump -AttributeMatches $AttributeMatches
  if ($null -eq $center) {
    return $false
  }

  Invoke-Adb -Arguments @("shell", "input", "tap", "$($center.X)", "$($center.Y)")
  Start-Sleep -Seconds 1
  return $true
}

function Send-AdbText {
  param([string]$Text)

  $escaped = $Text.Replace(" ", "%s")
  Invoke-Adb -Arguments @("shell", "input", "text", $escaped)
}

function Test-PackageInstalled {
  param([string]$TargetPackage)

  $adbArgs = @()
  if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
    $adbArgs += @("-s", $DeviceSerial)
  }

  $adbArgs += @("shell", "pm", "path", $TargetPackage)
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $Adb @adbArgs 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($exitCode -ne 0) {
    return $false
  }

  $pathOutput = ($output | Out-String)
  return $pathOutput -match "package:"
}

function Resolve-InstallerPrompt {
  param(
    [string]$TargetPackage,
    [switch]$AllowPending
  )

  $uiDump = Get-UiDumpText

  if ($uiDump -match "com.bbk.account:id/custom_edit_Text" -or $uiDump -match "com.bbk.account") {
    if ([string]::IsNullOrWhiteSpace($VivoInstallPassword)) {
      $message = "Device-side install is blocked by vivo account verification. Please finish the password verification on the phone, pass -VivoInstallPassword, or disable the third-party install verification from the installer Settings button, then rerun this script. Installer UI dump: $InstallerDumpLocalPath"
      throw $message
    }

    $clickedPassword = Tap-UiTextIfPresent -UiDump $uiDump -AttributeMatches @("com.bbk.account:id/custom_edit_Text")
    if ($clickedPassword -and ($uiDump -notmatch [char]0x2022)) {
      Send-AdbText -Text $VivoInstallPassword
      Start-Sleep -Seconds 1
    }
    Tap-UiTextIfPresent -UiDump (Get-UiDumpText) -AttributeMatches @("android:id/button1") | Out-Null
    Start-Sleep -Seconds 4
    return
  }

  $clickedRisk = Tap-UiTextIfPresent -UiDump $uiDump -AttributeMatches @("com.android.packageinstaller:id/deleted_file_state_cb")
  if ($clickedRisk) {
    $uiDump = Get-UiDumpText
  }

  $clickedInstall = Tap-UiTextIfPresent -UiDump $uiDump -AttributeMatches @("android:id/button1")
  if ($clickedInstall) {
    Start-Sleep -Seconds 4
  }

  $uiDump = Get-UiDumpText
  if ($uiDump -match "com.bbk.account:id/custom_edit_Text" -or $uiDump -match "com.bbk.account") {
    if ([string]::IsNullOrWhiteSpace($VivoInstallPassword)) {
      $message = "Device-side install reached vivo account verification. Please finish the password verification on the phone, pass -VivoInstallPassword, or disable the third-party install verification from the installer Settings button, then rerun this script. Installer UI dump: $InstallerDumpLocalPath"
      throw $message
    }

    $clickedPassword = Tap-UiTextIfPresent -UiDump $uiDump -AttributeMatches @("com.bbk.account:id/custom_edit_Text")
    if ($clickedPassword -and ($uiDump -notmatch [char]0x2022)) {
      Send-AdbText -Text $VivoInstallPassword
      Start-Sleep -Seconds 1
    }
    Tap-UiTextIfPresent -UiDump (Get-UiDumpText) -AttributeMatches @("android:id/button1") | Out-Null
    Start-Sleep -Seconds 4
  }

  if (-not (Test-PackageInstalled -TargetPackage $TargetPackage)) {
    if ($AllowPending) {
      return
    }
    throw "Install did not complete after handling device installer prompt. Installer UI dump: $InstallerDumpLocalPath"
  }
}

function Install-Apk {
  param(
    [string]$ApkPath,
    [string]$TargetPackage
  )

  $adbArgs = @()
  if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
    $adbArgs += @("-s", $DeviceSerial)
  }

  $adbArgs += @("install", "-r", "-d", "-t", $ApkPath)
  Write-Step ("Running: {0} {1}" -f $Adb, ($adbArgs -join " "))

  Remove-Item -LiteralPath $InstallStdoutPath, $InstallStderrPath -Force -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $Adb `
    -ArgumentList (Join-ProcessArguments -Arguments $adbArgs) `
    -RedirectStandardOutput $InstallStdoutPath `
    -RedirectStandardError $InstallStderrPath `
    -WindowStyle Hidden `
    -PassThru

  $deadline = (Get-Date).AddSeconds($InstallTimeoutSeconds)
  while (-not $process.HasExited) {
    if ((Get-Date) -gt $deadline) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "Timed out waiting for adb install after ${InstallTimeoutSeconds}s. stdout: $InstallStdoutPath stderr: $InstallStderrPath installer UI: $InstallerDumpLocalPath"
    }

    try {
      Resolve-InstallerPrompt -TargetPackage $TargetPackage -AllowPending
    } catch {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw
    }

    Start-Sleep -Seconds 2
  }

  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $stdout = if (Test-Path -LiteralPath $InstallStdoutPath) { Get-Content -LiteralPath $InstallStdoutPath -Raw -ErrorAction SilentlyContinue } else { "" }
  $stderr = if (Test-Path -LiteralPath $InstallStderrPath) { Get-Content -LiteralPath $InstallStderrPath -Raw -ErrorAction SilentlyContinue } else { "" }
  $text = (($stdout, $stderr) -join [Environment]::NewLine).Trim()
  if (-not [string]::IsNullOrWhiteSpace($text)) {
    Write-Host $text
  }

  if ($exitCode -eq 0 -or $text -match "(?m)^\s*Success\s*$") {
    return
  }

  if ($text -match "INSTALL_FAILED_ABORTED" -or $text -match "User rejected permissions") {
    Write-Step "Device installer prompt interrupted adb install; inspecting on-device installer UI."
    Resolve-InstallerPrompt -TargetPackage $TargetPackage
    return
  }

  throw "Command failed with exit code ${exitCode}: $Adb $($adbArgs -join ' ')`n$text"
}

function Copy-AndroidProject {
  Assert-PathExists -PathValue $AndroidSource -Label "Android source directory"
  New-Item -ItemType Directory -Path $TempAndroidRoot -Force | Out-Null

  $robocopyArgs = @(
    $AndroidSource,
    $TempAndroidRoot,
    "/E",
    "/XD",
    ".gradle",
    ".kotlin",
    "build",
    "/XF",
    "local.properties",
    "/NFL",
    "/NDL",
    "/NP"
  )

  Write-Step "Copying android/ to $TempAndroidRoot"
  & robocopy @robocopyArgs | Out-Host
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "robocopy failed with exit code $exitCode"
  }

  $script:TempCreated = $true
}

function Write-TempLocalProperties {
  $sdkDir = $AndroidSdk -replace "\\", "/"
  $localPropertiesPath = Join-Path $TempAndroidRoot "local.properties"
  Set-Content -LiteralPath $localPropertiesPath -Encoding UTF8 -Value @(
    "# Generated by scripts/android/SmokeTest-AndroidDebug.ps1.",
    "# Temporary build copy only.",
    "sdk.dir=$sdkDir"
  )
}

function Find-LatestBuiltApk {
  if (-not [string]::IsNullOrWhiteSpace($ApkPath)) {
    return [System.IO.Path]::GetFullPath($ApkPath)
  }

  $apkName = "app\build\outputs\apk\debug\app-debug.apk"
  $latestTempApk = Get-ChildItem -LiteralPath $InstallRoot -Directory -Filter "firstaid-android-*" -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName $apkName } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending |
    Select-Object -First 1

  if ($latestTempApk) {
    return $latestTempApk
  }

  return Join-Path $AndroidSource $apkName
}

function Select-AdbDevice {
  Invoke-Checked -FilePath $Adb -Arguments @("start-server")

  if (-not [string]::IsNullOrWhiteSpace($DeviceSerial)) {
    Write-Step "Using device serial: $DeviceSerial"
    Invoke-Adb -Arguments @("wait-for-device")
    return
  }

  $devicesOutput = Invoke-Capture -FilePath $Adb -Arguments @("devices")
  $devices = @()
  foreach ($line in $devicesOutput) {
    if ($line -match "^(\S+)\s+device$") {
      $devices += $Matches[1]
    }
  }

  if ($devices.Count -eq 0) {
    throw "No adb device is online. Connect a device or start an emulator, then rerun the script."
  }

  if ($devices.Count -gt 1) {
    throw "Multiple adb devices are online: $($devices -join ', '). Rerun with -DeviceSerial."
  }

  Write-Step "Using adb device: $($devices[0])"
}

function Remove-TempBuildIfNeeded {
  if ($KeepTemp -or (-not $TempCreated)) {
    return
  }

  $resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
  $resolvedTempRoot = [System.IO.Path]::GetFullPath($TempAndroidRoot).TrimEnd("\")
  $tempName = Split-Path -Leaf $resolvedTempRoot
  if ((-not $resolvedTempRoot.StartsWith($resolvedInstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) -or
      ($tempName -notlike "firstaid-android-build-*")) {
    throw "Refusing to remove unexpected temp directory: $resolvedTempRoot"
  }

  Write-Step "Removing temporary build copy: $TempAndroidRoot"
  Remove-Item -LiteralPath $TempAndroidRoot -Recurse -Force
}

try {
  Assert-PathExists -PathValue $AndroidSource -Label "Android source directory"
  Assert-PathExists -PathValue $AndroidSdk -Label "Android SDK"
  Assert-PathExists -PathValue $GradleBat -Label "Gradle"
  Assert-PathExists -PathValue $Adb -Label "adb"

  if (Test-Path -LiteralPath $JavaHome) {
    $env:JAVA_HOME = $JavaHome
    Add-PathEntry -PathValue (Join-Path $JavaHome "bin")
  }

  $env:ANDROID_HOME = $AndroidSdk
  $env:ANDROID_SDK_ROOT = $AndroidSdk
  Add-PathEntry -PathValue (Join-Path $AndroidSdk "cmdline-tools\latest\bin")
  Add-PathEntry -PathValue (Join-Path $AndroidSdk "platform-tools")
  Add-PathEntry -PathValue (Split-Path -Parent $GradleBat)

  Select-AdbDevice

  if ($SkipBuild) {
    $apkPath = Find-LatestBuiltApk
    Write-Step "Skipping build; using APK: $apkPath"
  } else {
    Copy-AndroidProject
    Write-TempLocalProperties
    Invoke-Checked -FilePath $GradleBat -Arguments @(":app:assembleDebug", "--no-daemon") -WorkingDirectory $TempAndroidRoot
    $apkPath = Join-Path $TempAndroidRoot "app\build\outputs\apk\debug\app-debug.apk"
  }

  Assert-PathExists -PathValue $apkPath -Label "Debug APK"
  Install-Apk -ApkPath $apkPath -TargetPackage $PackageName

  $componentName = "$PackageName/com.firstaid.copilot.MainActivity"
  Invoke-Adb -Arguments @("shell", "am", "force-stop", $PackageName)
  Invoke-Adb -Arguments @("shell", "am", "start", "-W", "-n", $componentName)
  Start-Sleep -Seconds 2

  Invoke-Adb -Arguments @("shell", "uiautomator", "dump", "/sdcard/firstaid-smoke-ui.xml")
  $uiDump = Invoke-AdbCapture -Arguments @("exec-out", "cat", "/sdcard/firstaid-smoke-ui.xml")
  Set-Content -LiteralPath $UiDumpLocalPath -Encoding UTF8 -Value $uiDump

  Write-Host ""
  Write-Step "Smoke test completed."
  Write-Step "Installed APK: $apkPath"
  Write-Step "Launched: $componentName"
  Write-Step "UI dump: $UiDumpLocalPath"
  if ($KeepTemp -and $TempCreated) {
    Write-Step "Temporary build copy kept: $TempAndroidRoot"
  }
} finally {
  Remove-TempBuildIfNeeded
}
