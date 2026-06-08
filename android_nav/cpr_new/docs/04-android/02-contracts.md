# 02 · 对接契约（与第 2 / 3 部分）

> 这是协作最重要的文档。第 2、3 部分只要实现下面的接口、产出下面的数据模型，
> 即可无缝接入 Android 终端。**Android 端不关心你们内部怎么实现。**

所有契约位于 `core/contract/`。

---

## A. 第 3 部分（感知）→ 第 4 部分

### 数据模型：`PerceptionEvent`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
> 已对齐《CPR 感知模块接口与交接说明 v1》。

| 字段 | 类型 | v1 对应 | 含义 |
| --- | --- | --- | --- |
| `eventId` | `String` | event_id | 事件唯一 id，供 GuidanceAction 回溯 |
| `sessionId` | `String` | session_id | 会话 id，由 Android 经 `start()` 下发，需回填 |
| `timestampMs` | `Long` | timestamp_ms | 事件时间戳（单调时钟 ms） |
| `phase` | `CprPhase` | phase | 阶段，MVP 为 COMPRESSION（其 CPR_ACTIVE） |
| `cameraView` | `CameraView` | camera_view | 机位，默认 SIDE_FRONT |
| `compressionRateBpm` | `Float?` | compression_rate_bpm | 按压频率（次/分），无法判定填 null |
| `interruptionMs` | `Long` | interruption_ms | 距上次有效按压间隔；≥1500ms 视为中断 |
| `handPosition` | `HandPosition` | hand_position | 手位：CENTER/LEFT/RIGHT/HIGH/LOW/UNKNOWN |
| `armStraight` | `Boolean` | arm_straight | 手臂是否伸直 |
| `qualityScore` | `Int` | quality_score | **第 3 部分算好的** 0~100 综合分，Android 直接展示 |
| `confidence` | `Float` | confidence | 整体置信度 0~1 |
| `rawSignals` | `Map<String,Float>` | — | 可扩展原始信号（关键点 / 各子项分等） |

> - 低于 `MIN_RELIABLE_CONFIDENCE`（默认 0.5）的事件，Android 端会做 UI 兜底，且不喂给 Agent。
> - 质量评分是第 3 部分职责；Android 的 `QualityScorer` 仅在 `qualityScore<=0` 时兜底估算。
> - 中断阈值 `PAUSE_THRESHOLD_MS`、频率区间 `TARGET_RATE_MIN/MAX` 见 `PerceptionEvent` 伴生对象。

### 接口：`CprPerceptionSource`

```kotlin
interface CprPerceptionSource {
    val events: Flow<PerceptionEvent>   // 冷流，订阅后开始产出
    fun start(sessionId: String)        // 幂等；sessionId 需回填到每条事件
    fun stop()
    val isReady: Boolean                // 模型是否加载完成
}
```

> 摄像头输入规格（格式/分辨率/帧率/rotation/timestamp）见 [07-接口对接约定.md](07-接口对接约定.md)。

### 可选：`FrameSink`（由 Android 统一管摄像头时）

若希望由第 4 部分用 CameraX 取流再喂给算法，实现 `FrameSink.onFrame(frame, meta)`，
帧格式通过 `FrameMeta.format` 约定（如 `NV21`）。否则感知源可自管采集。

---

## B. 第 2 部分（Agent）→ 第 4 部分

### 数据模型：`GuidanceAction`

> 已对齐 v1。字段名与 v1 一一对应。

| 字段 | 类型 | v1 对应 | 含义 |
| --- | --- | --- | --- |
| `actionId` | `String` | action_id | 动作唯一标识 |
| `sessionId` | `String` | session_id | 会话 id |
| `timestampMs` | `Long` | timestamp_ms | 动作时间戳 |
| `actionType` | `ActionType` | action_type | VOICE_TEXT/VISUAL_HINT/HAPTIC/COMPOSITE |
| `priority` | `GuidancePriority` | priority | LOW/MEDIUM/HIGH/CRITICAL（CRITICAL 打断 TTS） |
| `messageCode` | `MessageCode` | message_code | 稳定消息码，便于去抖/本地化（见下） |
| `messageText` | `String` | message_text | 屏幕大字 |
| `ttsText` | `String` | tts_text | TTS 文本（空=不播报） |
| `hapticPattern` | `HapticPattern?` | haptic_pattern | 震动模式 |
| `sourceEventId` | `String` | source_event_id | 触发本动作的感知事件 id |
| `phase` / `targetRate` / `metadata` | — | — | Android 扩展：驱动 UI 阶段 / 节拍器 / 透传 |

> `MessageCode`：GOOD_CONTINUE / MOVE_LEFT / MOVE_RIGHT / MOVE_UP / MOVE_DOWN /
> STRAIGHTEN_ARMS / SPEED_UP / SLOW_DOWN / RESUME_COMPRESSIONS / TRACKING_LOST。

### 接口：`GuidanceAgent`

```kotlin
interface GuidanceAgent {
    suspend fun onSessionStart(sessionId: String): GuidanceAction
    fun guidance(perception: Flow<PerceptionEvent>): Flow<GuidanceAction>
    suspend fun buildHandover(log: SessionLog): HandoverReport
    val isReady: Boolean
}
```

- `guidance()` 入参是感知流、出参是动作流，天然支持流式与取消。
- 建议在实现内部做**去抖**（相同提示不重复），避免 TTS 拥塞（Mock 已示范）。

---

## C. 会话日志与交接报告

- 第 4 部分在会话中累积 `SessionLogEntry`，结束时打包成不可变 `SessionLog`（含聚合 `metrics`）。
- 调用 `agent.buildHandover(log)` 得到 `HandoverReport` 并展示。
- `HandoverReport.location` 用轻量 `GeoSnapshot`，避免算法端依赖 Android `Location`。

---

## D. 接入步骤（第 2/3 部分照做）

1. 新建实现类，分别实现 `CprPerceptionSource` / `GuidanceAgent`。
2. 在 App 启动处（或 `MainActivity`）替换工厂：

```kotlin
ServiceLocator.perceptionFactory = { ctx -> RealPerceptionSource(ctx) }
ServiceLocator.agentFactory      = { ctx -> GemmaGuidanceAgent(ctx) }
```

3. 完成。UI 与编排代码无需任何改动。

> 调试建议：可先只替换其中一个（如先接真实 Agent，感知仍用 Mock），逐步联调。
