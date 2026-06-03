# FirstAid Copilot Agent 开发拆任务与接口冻结清单

版本：v0.1 baseline  
日期：2026-06-01  
依据文档：`FirstAid_Copilot_Agent_Technical_Design.md`

当前实现状态（2026-06-03）：

```text
Agent Core 主链路已实现。
本地 Gemma 4 E2B LiteRT-LM runner 已接入。
Sherpa-ONNX STT/TTS 真实语音链路已通过严格验证。
仍待 Android 真机层替换的边界：摄像头视觉、拨号、GPS、录制、震动实际执行。
```

## 1. 当前定案

本项目 MVP 按以下设计执行：

```text
成人疑似心脏骤停 CPR 场景
状态机负责医疗流程决策
Gemma Model Driver 负责交互与动作候选生成
Android Tool Layer 负责执行
感知模块负责输出结构化事实
Demo 工程负责脚本回放和现场兜底
```

核心架构口径：

```text
Medical flow is rule-driven
Interaction is Gemma-driven
Execution is Android-driven
```

## 2. 第一优先级：冻结接口

以下三个协议先冻结为 v0.1，除非出现阻塞实现的问题，否则不再频繁改字段。

### 2.1 PerceptionEvent

负责从 STT、视觉、设备、Demo 脚本向 Agent 输入结构化事实。

必须支持：

- `event_id`
- `session_id`
- `timestamp`
- `mode`
- `source`
- `event_type`
- `stage_hint`
- `sequence_id`
- `ttl_ms`
- `user_input`
- `patient_state`
- `cpr_quality`
- `rescuer_state`
- `device_state`

负责人建议：感知同学 + Agent 同学共同确认。

### 2.2 SessionState

负责记录 Agent 当前相信的事实、流程阶段、工具状态、CPR 状态和交接时间线。

必须支持：

- `current_stage`
- `scope`
- `confirmed_facts`
- `tool_state`
- `cpr_state`
- `dialogue_state`
- `action_control`
- `handover_timeline`
- `demo_state`

负责人建议：Agent 同学。

### 2.3 GuidanceAction

负责 Agent 向 Android、TTS、UI、震动、工具链下发统一动作。

必须支持：

- `action_id`
- `session_id`
- `stage`
- `intent`
- `priority`
- `source`
- `reason_codes`
- `tts`
- `ui`
- `haptic`
- `visual_overlay`
- `tool_actions`
- `log_event`
- `throttle_key`
- `min_interval_ms`

负责人建议：Agent 同学 + Android 同学共同确认。

## 3. Agent / Gemma 任务

### A1. 状态机

实现：

- `S0_INIT`
- `S1_SCENE_SAFE`
- `S2_CHECK_RESPONSE`
- `S3_CHECK_BREATHING`
- `S4_SUSPECTED_ARREST`
- `S5_CALL_EMERGENCY`
- `S6_CPR_READY`
- `S7_CPR_LOOP`
- `S8_ASSISTANCE`
- `S9_HANDOVER`

验收：

```text
mock 输入能跑通：
无反应 → 确认无正常呼吸/濒死喘息 → 呼叫120 → CPR → 纠错 → 交接报告
```

### A2. CPRStartRule

实现规则：

```text
adult_likely == true
AND responsive == false
AND (normal_breathing == false OR agonal_breathing == true)
→ START_CPR
```

验收：

- 无反应 + 无正常呼吸：启动 CPR。
- 无反应 + 喘息样呼吸：启动 CPR。
- 无反应 + 不确定呼吸：不直接启动 CPR，继续引导 5-10 秒呼吸检查并准备呼叫 120。
- 有反应：不启动 CPR。
- 明确正常呼吸：不启动 CPR。

### A3. Gemma Model Driver

实现组件：

- `GemmaRuntime`
- `DecisionFrame`
- `GemmaPromptBuilder`
- `GemmaResponseParser`
- `GuidanceActionPatch`
- `GemmaFallbackPolicy`

验收：

- Gemma 可以根据 `DecisionFrame` 输出合法 `GuidanceActionPatch`。
- 输出必须是 JSON。
- Gemma 超时或输出非法时，系统回退到固定模板。
- Gemma 不能改变状态机结论。

### A4. Action Validator

实现校验：

- intent 是否在当前状态允许范围内。
- 是否包含禁止诊断或结果承诺。
- TTS 是否过长。
- 是否试图新增未授权工具调用。
- 优先级是否允许打断当前动作。

验收：

- “他已经心脏骤停了”应被拦截。
- “这样一定能救活”应被拦截。
- low priority 不能打断 critical。

## 4. Android 任务

### B1. GuidanceAction Dispatcher

消费 `GuidanceAction` 并分发到：

- TTS
- UI
- Haptic
- Visual Overlay
- ToolAction
- SessionLog

验收：

```text
一个 GuidanceAction 能同步触发屏幕文字、语音、震动和日志记录。
```

### B2. 工具调用

优先实现：

- 模拟拨打 120。
- GPS 状态读取或模拟。
- 本地录制状态。
- 分享报告前用户确认。

Demo 中 `emergency_call` 先使用模拟拨号，不触发真实 120。

### B3. CPR UI

必须展示：

- 当前阶段。
- 主指令大字。
- 次级说明。
- 质量分。
- 频率状态。
- 120 / 录制 / GPS 状态。

验收：

```text
现场嘈杂时，评委只看屏幕也能理解流程。
```

## 5. 感知任务

### C1. Mock 字段先行

先按接口输出 mock 字段：

- `responsive`
- `normal_breathing`
- `agonal_breathing`
- `hand_position`
- `compression_rate`
- `interruption_seconds`
- `arm_straight`
- `quality_score`
- `confidence`

验收：

```text
Agent 不依赖真实视觉，也能通过 mock PerceptionEvent 跑完整链路。
```

### C2. 真实感知逐步替换

优先替换：

1. CPR 按压频率。
2. 中断时长。
3. 手位偏移。
4. 手臂是否伸直。
5. 质量分。

不稳定字段可以继续由 Demo 脚本兜底。

## 6. Demo 工程任务

### D1. DemoEventScript

实现脚本：

```text
00:00 启动
00:10 无反应
00:20 无正常呼吸/喘息
00:25 呼叫120
00:45 CPR开始，质量分32
00:55 手位偏左，频率92
01:10 手臂弯曲，质量分55
01:25 质量分78
01:45 中断3秒
02:00 质量分91
02:15 疲劳提醒
02:35 AED事件
03:30 急救员到达
04:00 展示报告
```

### D2. 三种模式

必须支持：

- `real_perception`
- `demo_assisted`
- `demo_replay`

比赛现场默认使用 `demo_assisted`，必要时切换 `demo_replay`。

### D3. 兜底入口

需要准备隐藏控制：

- 注入“他没有反应”。
- 注入“没有正常呼吸/偶尔喘一下”。
- 注入 CPR 质量分曲线。
- 注入“急救员到达”。
- 一键生成 HandoverReport。

## 7. Handover Report 任务

### E1. 基础报告

必须包含：

- 患者 ID：匿名。
- 初判时间。
- 症状判断。
- CPR 开始时间。
- 累计按压次数。
- 平均频率。
- 平均质量评分。
- 中断事件。
- 纠错事件。
- AED 状态。
- 视频记录状态。

### E2. Demo 报告

Demo 中可使用脚本数据生成：

```text
症状：无反应，无正常呼吸，疑似心脏骤停
CPR 开始：00:45
平均频率：112/min
平均质量评分：78/100
纠错事件：手位偏左、频率偏慢、手臂弯曲
视频记录：已本地保存，等待用户同意分享
```

## 8. 最小可运行版本

第一版不要等真实感知和真机模型全部完成。最小可运行链路是：

```text
DemoEventScript
→ PerceptionEvent
→ SessionReducer
→ StateMachine
→ Gemma Model Driver 或模板兜底
→ ActionValidator
→ GuidanceAction
→ UI/TTS mock
→ SessionLog
→ HandoverReport
```

验收标准：

```text
在不接真实摄像头的情况下，完整跑完 4 分钟 CPR Demo。
```

## 9. 每日验收建议

### Day 1

- 三个接口 JSON 定稿。
- 状态机空跑。

### Day 2

- DemoEventScript 能注入事件。
- CPRStartRule 单测通过。

### Day 3

- GuidanceAction 能驱动 UI/TTS mock。
- SessionLog 能记录时间线。

### Day 4

- Gemma Driver 接入或模板兜底接入。
- ActionValidator 生效。

### Day 5

- HandoverReport 生成。
- 第一版完整 Demo 跑通。

## 10. 当前结论

现在不再继续扩架构，直接进入实现。

优先级：

```text
先跑通 mock 主链路
再接 Gemma 和真实语音
再接 Android 真机感知与工具执行
最后打磨 Demo 与交接材料
```

这能最大程度保证比赛交付稳定。
