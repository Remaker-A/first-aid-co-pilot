# Android 开发预准备清单

版本：v0.1 prep  
日期：2026-06-03  
适用范围：FirstAid Copilot Android 真机执行层、UI/TTS/震动/工具适配、Demo 联调。

## 1. 开发边界

当前统一口径保持不变：

```text
Medical flow is rule-driven.
Interaction is Gemma-driven.
Execution is Android-driven.
```

Android 端不要重新判断医疗流程，不直接解析 Gemma 自然语言，也不要自己生成状态迁移。Android 端只负责：

- 把设备、感知、语音输入整理为 `PerceptionEvent`。
- 消费 Agent 输出的 `GuidanceAction`。
- 将 `GuidanceAction` 分发到屏幕、TTS、震动、视觉叠层、系统工具和本地日志。
- 对真实系统动作做权限、确认、失败上报和 Demo 安全保护。

Agent Core 当前链路：

```text
PerceptionEvent
-> SessionReducer
-> Guideline State Machine
-> RuleFeedbackEngine / Gemma Model Driver
-> ActionValidator
-> GuidanceAction
-> Dispatcher
```

Android 要接的是 `GuidanceAction` 之后的执行层；如果后续要把 Agent Core 移到 Android，本清单仍然适用于 Kotlin adapter 的边界拆分。

## 2. Android 端最小模块

建议先按 6 个 adapter 建工程，不急着把真实摄像头、真实拨号全部做满。

| 模块 | 职责 | 当前 Node 参考 |
| --- | --- | --- |
| `GuidanceActionBridge` | 接收/解析 `GuidanceAction`，做 schema/version 检查 | `src/domain/actionFactories.js` |
| `UiActionRenderer` | 渲染主指令、副指令、状态标签、质量分、按钮、视觉叠层 | `src/dispatch/sinks/uiSink.js` |
| `AndroidTtsSink` | 播放 `tts.text`，按 priority/interrupt policy 控制打断和排队 | `src/dispatch/sinks/ttsSink.js` |
| `AndroidHapticSink` | 用震动模拟 CPR 节拍器，支持 start/update/stop | `src/dispatch/sinks/hapticSink.js` |
| `AndroidToolExecutor` | 执行拨号、GPS、录制、报告生成、分享/删除等系统动作 | `src/dispatch/sinks/toolSink.js` |
| `AndroidSessionLogStore` | 记录 action、delivery、tool result，供交接报告和复盘使用 | `src/report/sessionLog.js` |

第一版验收只要求 mock/permitted tools 能跑通，不要求所有硬件能力一次完成。

## 3. 输入协议：PerceptionEvent

Android 或感知模块向 Agent 输入统一事件。字段以现有 v0.1 为准：

```json
{
  "schema_version": "perception_event.v0.1",
  "event_id": "evt_...",
  "session_id": "sess_...",
  "timestamp": "2026-06-03T20:30:00+08:00",
  "mode": "real_perception",
  "source": "vision_cpr",
  "event_type": "cpr_quality_update",
  "stage_hint": "S7_CPR_LOOP",
  "sequence_id": 42,
  "ttl_ms": 5000,
  "user_input": null,
  "patient_state": null,
  "cpr_quality": {
    "compression_started": true,
    "hand_position": "left_offset",
    "compression_rate": 92,
    "interruption_seconds": 0,
    "arm_straight": false,
    "quality_score": 68,
    "confidence": 0.81
  },
  "rescuer_state": null,
  "device_state": {
    "camera_available": true,
    "mic_available": true,
    "gps_available": true,
    "recording": true,
    "emergency_call_started": false,
    "network": "offline"
  },
  "metadata": {}
}
```

输入约束：

- `null` 表示未知，不等于 `false`。
- 感知只输出事实和置信度，不输出 `should_start_cpr`、`tts_text`、`tool_action` 或医疗结论。
- 高频 CPR 事件可以持续发送，但 Android UI/TTS 端必须遵守 `throttle_key` 和 `min_interval_ms`。
- Demo 模式可以从脚本注入 `PerceptionEvent`，真实感知不稳定时也可以保留兜底注入口。

## 4. 输出协议：GuidanceAction

Android 端消费的主协议：

```json
{
  "schema_version": "guidance_action.v0.1",
  "action_id": "act_...",
  "session_id": "sess_...",
  "timestamp": "2026-06-03T20:30:01+08:00",
  "stage": "S7_CPR_LOOP",
  "intent": "continue_cpr_loop",
  "priority": "high",
  "source": "rule_feedback",
  "reason_codes": ["compression_rate_low"],
  "ttl_ms": 5000,
  "throttle_key": "cpr.rate_feedback",
  "min_interval_ms": 3000,
  "tts": {
    "text": "跟着震动按，稍微加快一点。",
    "tone": "calm_firm",
    "speed": "normal",
    "interrupt_policy": "do_not_interrupt_critical"
  },
  "ui": {
    "main_text": "稍微加快",
    "secondary_text": "跟着震动节奏按压",
    "status_tags": ["CPR进行中", "频率偏慢"],
    "quality_score": 68,
    "primary_button": null
  },
  "haptic": {
    "enabled": true,
    "pattern": "metronome",
    "bpm": 110
  },
  "visual_overlay": {
    "mode": "cpr_quality_feedback",
    "highlight_target": "chest_center"
  },
  "tool_actions": [
    {
      "type": "update_haptic_metronome",
      "bpm": 110,
      "requires_user_confirmation": false
    }
  ],
  "log_event": {
    "type": "cpr_feedback",
    "detail": "compression_rate_low"
  }
}
```

Android 消费规则：

- `priority=critical` 的动作不能被静默吞掉；即使权限失败，也必须显示 UI fallback 并记录错误。
- `tts.text` 为空时不播放语音，但仍可能更新 UI、震动或工具。
- `ui` 中任何可渲染字段存在时，都应更新屏幕；无可渲染字段但动作非 silent 时，应显示兜底提示。
- `haptic.enabled=true` 或 `tool_actions` 中出现 haptic 工具时，交给 `AndroidHapticSink` 独占处理。
- 分享、外发、删除类工具必须先弹用户确认；未确认时只能 block 并上报，不能执行。

## 5. 工具动作映射

| tool type | Android 实现建议 | Demo 安全策略 |
| --- | --- | --- |
| `emergency_call` / `mock_emergency_call` | Demo 先用 `ACTION_DIAL` 或 mock 状态；真实版再评估 `ACTION_CALL` / `TelecomManager.placeCall` | 不自动拨真实 120，除非人工明确进入真机急救测试 |
| `attach_gps_location` | `FusedLocationProviderClient.getCurrentLocation`，失败时记录 `gps_failed` | 可用 mock 坐标 |
| `start_local_recording` | CameraX VideoCapture 或 MediaRecorder，本地保存 | 可只标记 recording 状态 |
| `generate_handover_report` | 从本地 log/state 生成报告并落盘 | 允许 mock 报告 |
| `request_share_report` / `request_share_video` | 弹确认对话框，不做外发 | 必须可见确认 |
| `share_report` / `share_video` / `send_report` / `send_video` | 确认后系统 ShareSheet 或指定上传 | 未确认一律 block |
| `delete_video` | 确认后删除本地文件 | 未确认一律 block |
| `start_haptic_metronome` / `update_haptic_metronome` / `stop_haptic_metronome` | `VibratorManager` / `Vibrator` + 周期波形 | 可用 mock 状态或真震动 |

## 6. UI 首版要求

比赛/Demo 第一屏不要做成介绍页，直接进入可操作急救界面。最小信息结构：

- 顶部：当前 stage、120 状态、录制状态、GPS 状态、网络/离线状态。
- 中央：`ui.main_text` 大字主指令。
- 中央下方：`ui.secondary_text` 和 `status_tags`。
- CPR 区域：质量分、按压频率、手位/手臂/中断反馈。
- 视觉叠层：根据 `visual_overlay.mode` 标出胸口中央、手位偏移或继续按压提示。
- 底部操作：确认类按钮、报告/视频分享按钮、Demo 注入控制入口。

屏幕设计以“现场嘈杂时只看屏幕也能执行”为验收标准。不要把指南说明、快捷键、功能解释放在主界面上。

## 7. TTS 与震动策略

TTS：

- `priority=critical` 或 `interrupt_policy=interrupt_lower_priority`：打断低优先级播报。
- `interrupt_policy=replace_same_intent`：同一 intent 替换上一条未播完内容。
- `interrupt_policy=do_not_interrupt_critical`：排到 critical 后面。
- `tone` 可先映射到语速/音量/音色配置，不需要一开始做复杂情绪合成。

Haptic：

- CPR 节拍默认 110 bpm。
- 收到 start/update 时保持单一节拍器实例，避免多路震动重叠。
- 收到 stop 或进入交接/结束阶段时必须 `cancel()`。
- 震动与 TTS 要共享生命周期：Activity/Service 停止、权限丢失、用户退出时统一清理。

## 8. 建议 Kotlin 数据骨架

```kotlin
data class GuidanceAction(
    val schema_version: String,
    val action_id: String,
    val session_id: String?,
    val timestamp: String,
    val stage: String,
    val intent: String,
    val priority: String,
    val source: String,
    val reason_codes: List<String> = emptyList(),
    val ttl_ms: Long = 5000,
    val throttle_key: String? = null,
    val min_interval_ms: Long = 0,
    val tts: TtsPayload = TtsPayload(),
    val ui: UiPayload = UiPayload(),
    val haptic: HapticPayload = HapticPayload(),
    val visual_overlay: Map<String, Any?>? = null,
    val tool_actions: List<Map<String, Any?>> = emptyList(),
    val log_event: Map<String, Any?>? = null
)

data class TtsPayload(
    val text: String = "",
    val tone: String = "calm_firm",
    val speed: String = "normal",
    val interrupt_policy: String = "do_not_interrupt_critical"
)

data class UiPayload(
    val main_text: String = "",
    val secondary_text: String = "",
    val status_tags: List<String> = emptyList(),
    val quality_score: Int? = null,
    val primary_button: Map<String, Any?>? = null
)

data class HapticPayload(
    val enabled: Boolean = false,
    val pattern: String? = null,
    val bpm: Int? = null
)
```

后续如果字段稳定，可以把 `tool_actions` 和 `visual_overlay` 从 `Map` 收紧为 sealed classes。

## 9. 联调顺序

### Day 0：协议和 mock

- Android 工程创建 Compose 主界面。
- 能载入一条本地 mock `GuidanceAction` JSON。
- UI/TTS/Haptic/Tool 四个 adapter 都返回结构化 `Delivery` 日志。

### Day 1：Dispatcher 行为

- 按 Node demo 的 6 类 action 做 Android 回放：
  - UI + TTS。
  - CPR 震动 start/update/stop。
  - emergency call mock。
  - share video 未确认 block。
  - share video 已确认 execute。
  - unknown/no-channel fallback。

参考命令：

```powershell
npm run demo:dispatcher
node --test test/dispatcher.test.js
```

### Day 2：闭环接入

- Android 产生 `PerceptionEvent` mock。
- Agent 返回 `GuidanceAction` 后驱动 Android adapters。
- 记录每次 `GuidanceAction -> Delivery`，用于交接报告。

参考命令：

```powershell
npm run scenario
npm run verify:local
```

严格真实资产门槛：

```powershell
npm run verify:local:strict
```

如果真实 Gemma / speech / Android 硬件资产未准备好，不能把 mock 通过当作严格就绪。

## 10. Android 验收门槛

第一版通过标准：

- 一条 `GuidanceAction` 能同步触发 UI、TTS、Haptic、Tool mock、Log。
- `priority=critical` 不会静默丢失，失败时有屏幕兜底和日志。
- 分享/外发/删除未确认时不会执行。
- CPR loop 中节拍震动可 start/update/stop，且不会叠加多个震动实例。
- Demo 主线可展示：无反应 -> 无正常呼吸 -> 呼叫 120 mock -> CPR -> 纠错 -> 交接报告。
- 用户只看屏幕文本也能理解下一步，不依赖控制台。

## 11. 先不要做的事

- 不要让 Android 自己改 `current_stage` 或绕过 Agent reducer。
- 不要让 Gemma 或 Android 直接发起未经 `ActionValidator` 审核的工具调用。
- 不要自动拨打真实 120 作为 Demo 默认行为。
- 不要把分享、上传、删除做成无需确认的一键外发。
- 不要把 mock 资产通过当作真实本地就绪。

## 12. 待确认问题

- Android app 使用纯 Kotlin/Compose，还是需要接入现有 Node Core 作为本地服务进行比赛 Demo？
- Gemma LiteRT 最终是否在 Android 端直接运行，还是 Demo 阶段由本机 Node Runtime 驱动？
- 真实拨号策略使用 `ACTION_DIAL`、`ACTION_CALL`，还是只保留可审计 mock？
- 视觉 CPR 质量识别优先接 CameraX 预览叠层，还是先由外部感知模块推 `PerceptionEvent`？
- 交接报告和视频分享的目标是系统 ShareSheet、局域网传输，还是仅本地展示？
