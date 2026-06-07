# 功能 E：端侧呼吸观察 NLU 模型 Runbook

## 当前生产接线

当 `edgeGemmaEnabled=true` 且 `edgeGemmaNlu=true` 时，Live 屏幕会创建：

```kotlin
EdgeBreathingNluResolvers.tfliteOrRuleBased(context.applicationContext)
```

该 resolver 会按 Android 侧 `defaultEdgeModelRoots()` 搜索
`nlu/breathing_zh_text_embedder.tflite`。模型存在且 MediaPipe `TextEmbedder`
初始化成功时走 TFLite；模型缺失、过小、metadata 不兼容或初始化失败时自动回退规则版。

## 本机转换卡点

本机检查结果：

- `python` 是 3.13.12，`py -3.10` 是 3.10.11。
- Python 3.13 环境有 `mediapipe 0.10.35`、`transformers 5.8.0`，但没有 `tensorflow`。
- Python 3.13 的 MediaPipe metadata writer import 会缺 `mediapipe.tasks.cc`。
- Python 3.10 环境有 MediaPipe metadata writer，但没有 `tensorflow` / `transformers`。

因此本次未生成 `.tflite`，唯一剩余手动步骤是按下面命令安装转换依赖并运行脚本。

## 生成模型

建议用 Python 3.10 虚拟环境，避免 Python 3.13 与 TensorFlow/MediaPipe metadata
工具链不兼容：

```powershell
py -3.10 -m venv .venv-nlu
.\.venv-nlu\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install `
  tensorflow==2.10.1 keras==2.10.0 numpy==1.23.5 `
  torch transformers==4.38.2 sentencepiece mediapipe==0.10.29
```

导出默认中文模型：

```powershell
python scripts/export_breathing_nlu_text_embedder.py `
  --model-id BAAI/bge-small-zh-v1.5 `
  --output artifacts/models/nlu/breathing_zh_text_embedder.tflite
```

脚本会完成：

- 下载 HuggingFace tokenizer/model。
- 构建 BERT 三输入 `ids` / `mask` / `segment_ids` 的 TFLite embedder。
- 对 token embedding 做 mask mean pooling + L2 normalize。
- 写入 MediaPipe TextEmbedder 必需 metadata。
- 尝试用 Python MediaPipe TextEmbedder embed 一句中文 smoke。

如果 metadata 写入或 smoke 失败，不要把 raw TFLite 当生产模型使用。

## 推送到设备

Debug 包名是 `com.firstaid.copilot.debug`。Android 侧会搜索多个模型根目录，推荐推送到外部
files 目录：

```powershell
$adb = "D:\android-dev\android-sdk\platform-tools\adb.exe"
& $adb -s 10KDCF04SH00000 shell "mkdir -p /sdcard/Android/data/com.firstaid.copilot.debug/files/models/nlu"
& $adb -s 10KDCF04SH00000 push `
  artifacts/models/nlu/breathing_zh_text_embedder.tflite `
  /sdcard/Android/data/com.firstaid.copilot.debug/files/models/nlu/breathing_zh_text_embedder.tflite
```

## 设备验证

安装 debug APK 后启动 Live 页面并打开 E：

```powershell
$adb = "D:\android-dev\android-sdk\platform-tools\adb.exe"
& $adb -s 10KDCF04SH00000 shell am start -S `
  -n com.firstaid.copilot.debug/com.firstaid.copilot.MainActivity `
  --ez edgeGemmaEnabled true `
  --ez edgeGemmaNlu true
```

过滤实时 NLU 遥测：

```powershell
& $adb -s 10KDCF04SH00000 logcat -c
& $adb -s 10KDCF04SH00000 logcat LiveSessionViewModel:I TfliteBreathingNlu:W *:S
```

在 Live 流程进入呼吸观察阶段后提交中文语料，例如：

- `他没有正常呼吸`
- `胸口没有起伏`
- `像是偶尔喘一下`
- `我不确定有没有呼吸`

期望日志：

```text
On-device NLU resolved resolver=EdgeTinyNluResolver/TfliteBreathingNluClassifier intent=... needsClarification=... latencyMs=...
```

若模型缺失或不可用，期望看到：

```text
On-device NLU resolved resolver=EdgeTinyNluResolver/RuleBasedBreathingNluClassifier intent=... needsClarification=... latencyMs=...
```

