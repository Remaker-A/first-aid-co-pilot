param(
  [string]$InstallRoot = "D:\android-dev"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$env:JAVA_HOME = Join-Path $InstallRoot "jdk"
$env:ANDROID_HOME = Join-Path $InstallRoot "android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

$pathParts = @(
  (Join-Path $env:JAVA_HOME "bin"),
  (Join-Path $env:ANDROID_HOME "cmdline-tools\latest\bin"),
  (Join-Path $env:ANDROID_HOME "platform-tools"),
  (Join-Path $InstallRoot "gradle\gradle-8.13\bin")
)

$env:PATH = (($pathParts + @($env:PATH)) -join ";")

Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "ANDROID_HOME=$env:ANDROID_HOME"
Write-Host "ANDROID_SDK_ROOT=$env:ANDROID_SDK_ROOT"
Write-Host "Gradle=$(Join-Path $InstallRoot 'gradle\gradle-8.13\bin\gradle.bat')"
