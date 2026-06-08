# 03 · 硬件适配层

位于 `hardware/`。全部基于 Android framework 原生 API，**零额外依赖、可离线**，
不感知业务，可独立复用与替换。所有控制器都做了**能力检测 + 容错降级**，无对应硬件时静默，不崩溃。

---

## TtsController（语音播报）

- 把 `GuidanceAction.spokenText` 念出来。
- 中文优先、英文兜底；引擎未就绪时丢弃播报由大字兜底。
- `speak(text, interrupt)`：CRITICAL 用 `QUEUE_FLUSH` 打断，其余 `QUEUE_ADD` 排队。
- 宿主销毁须调 `release()`（ViewModel `onCleared` 已处理）。

## HapticController（触觉反馈）

- 把抽象 `HapticPattern` 映射为震动波形：TICK（节拍）/ DOUBLE（切换）/ STRONG（告警）。
- Android 12+ 用 `VibratorManager`，以下用过时 API；无马达静默。

## LocationProvider（定位）

- 为 120 与交接报告提供 `GeoSnapshot`。
- 仅依赖 `LocationManager`（GPS 不需要网络）。
- 策略：先回 `lastKnown()` 秒级兜底，再 `requestSingleFix()` 实时定位（带超时）。
- 无权限直接降级返回 null。

## AudioRecorderController（录音留证）

- `MediaRecorder` 录到 App 私有目录（`filesDir/recordings`，无需存储权限）。
- 无麦克风权限 / 设备不支持时 `start()` 返回 null，流程继续。

## RuntimePermissions（运行时权限）

- `CprPermissions` 集中声明权限常量与推荐集合。
- `rememberPermissionState(permissions)`：Compose 一行接入“请求 + 状态回读”。
- **120 拨号用 `ACTION_DIAL`，不需要 CALL_PHONE 权限**，更安全也避免 Demo 误拨。

---

## 权限清单（AndroidManifest）

| 权限 | 用途 | 缺失时 |
| --- | --- | --- |
| CAMERA | 感知取流（第 3 部分） | 降级为无视觉感知 |
| RECORD_AUDIO | 录音留证 / 节奏辅助 | 不录音 |
| ACCESS_FINE/COARSE_LOCATION | 现场坐标 | 报告无定位 |
| VIBRATE | 节拍/告警触觉 | 无震动 |

硬件 `uses-feature` 全部 `required=false`，保证无摄像头/麦克风设备也能安装，运行时再检测。

---

## CameraPreview（摄像头 · 已实现）

位于 `hardware/camera/CameraPreview.kt`，基于 **CameraX**（`camera-core/camera2/lifecycle/view`）。

按职责，摄像头“接入与取流”属于第 4 部分，**画面理解算法属于第 3 部分**。本组件只做三件事：

1. **打开摄像头 + 实时预览**（`Preview` 用例 + `PreviewView`）——这是真实相机画面，不再是占位。
2. **可选帧分析**（`ImageAnalysis`）：仅当感知源实现了 `FrameSink` 时，才把每帧（YUV→NV21）
   连同 `FrameMeta`（含 sessionId / rotation / timestamp）推给第 3 部分。
3. **自管生命周期**：绑定到 `LocalLifecycleOwner`，离开界面自动解绑释放；`enabled`（相机权限）
   翻转后自动重新绑定。

设计要点：
- Mock 模式下 `frameSink` 为 null，**只预览不分析**，省去无谓的像素拷贝。
- 无权限 / 相机不可用时显示占位文案，不崩溃、不黑屏。
- 帧率/分辨率/格式的推荐值见 `CameraInputSpec`；NV21 为朴素打包，正式联调按 stride 精化。

接线：`MainActivity` 传入 `cameraGranted` 与 `viewModel.frameSink` → `CprGuidanceScreen`
→ 进行态 `ActiveContent` 顶部渲染 `CameraPreview`。
