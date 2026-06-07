# FirstAid Copilot Agent 团队交付片段

版本：v0.1  
用途：给 Agent / Android / 感知同学对齐接口与 Gemma Prompt  
范围：只包含接口清单和 Gemma System Prompt，不包含完整产品方案、团队分工和 Demo 策略。

## 1. 接口清单

### 1.1 PerceptionEvent

`PerceptionEvent` 是传给 Agent 的统一输入事件。感知、STT、设备状态和 Demo 脚本都统一转成这个对象。

```json
{
  "event_id": "evt_000123",
  "session_id": "sess_001",
  "timestamp": "2026-06-01T20:30:00+08:00",
  "mode": "real_perception",
  "source": "stt",
  "event_type": "user_response",
  "stage_hint": "S2_CHECK_RESPONSE",
  "sequence_id": 42,
  "ttl_ms": 5000,
  "user_input": {
    "stt_text": "他没有反应",
    "intent": "patient_unresponsive",
    "confidence": 0.92
  },
  "patient_state": {
    "adult_likely": true,
    "lying_down": true,
    "responsive": false,
    "normal_breathing": null,
    "agonal_breathing": null,
    "confidence": 0.86
  },
  "cpr_quality": {
    "compression_started": true,
    "hand_position": "left_offset",
    "compression_rate": 92,
    "interruption_seconds": 0,
    "arm_straight": false,
    "quality_score": 68,
    "confidence": 0.81
  },
  "rescuer_state": {
    "emotion": "anxious",
    "fatigue_level": "low",
    "hesitation_seconds": 0,
    "confidence": 0.7
  },
  "device_state": {
    "camera_available": true,
    "mic_available": true,
    "gps_available": true,
    "recording": true,
    "emergency_call_started": false,
    "network": "offline"
  }
}
```

约定：

- 感知模块只输出事实和置信度，不输出 `should_start_cpr`。
- `null` 表示未知，不等于 `false`。
- 高频 CPR 事件可以多次产生，但进入 TTS 前需要限流。

### 1.2 SessionState

`SessionState` 是 Agent 的当前会话记忆，由 Agent 内部维护。

```json
{
  "session_id": "sess_001",
  "mode": "real_perception",
  "current_stage": "S3_CHECK_BREATHING",
  "scope": {
    "scenario": "adult_suspected_cardiac_arrest_cpr",
    "adult_likely": true,
    "scene_safe": true
  },
  "confirmed_facts": {
    "responsive": false,
    "responsive_source": "user",
    "responsive_confidence": 0.92,
    "normal_breathing": null,
    "agonal_breathing": null,
    "suspected_cardiac_arrest": false
  },
  "tool_state": {
    "emergency_call_status": "not_started",
    "gps_attached": false,
    "recording_status": "recording",
    "handover_generated": false
  },
  "cpr_state": {
    "started": false,
    "started_at": null,
    "total_compressions": 0,
    "current_rate": null,
    "average_rate": null,
    "quality_score": null,
    "last_interruption_seconds": 0,
    "last_correction": null
  },
  "dialogue_state": {
    "pending_question": "check_breathing",
    "last_tts_intent": "ask_breathing_check",
    "repeat_count": 0
  }
}
```

约定：

- `SessionState` 只能由 Agent reducer 更新。
- 状态机根据 `SessionState` 判断下一步动作。
- 关键事实需要保留来源和置信度，便于复盘和 Handover Report。

### 1.3 GuidanceAction

`GuidanceAction` 是 Agent 输出给 Android / TTS / UI / 震动 / 工具链的统一动作协议。

```json
{
  "action_id": "act_000123",
  "session_id": "sess_001",
  "timestamp": "2026-06-01T20:30:01+08:00",
  "stage": "S5_CALL_EMERGENCY",
  "intent": "start_emergency_call_and_cpr",
  "priority": "critical",
  "source": "state_machine",
  "reason_codes": [
    "adult_scope",
    "unresponsive",
    "no_normal_breathing"
  ],
  "ttl_ms": 5000,
  "throttle_key": "stage.start_cpr",
  "min_interval_ms": 0,
  "tts": {
    "text": "根据你的反馈，他没有反应，也没有正常呼吸。请按疑似心脏骤停处理。现在开始胸外按压。",
    "tone": "calm_firm",
    "speed": "normal",
    "interrupt_policy": "interrupt_lower_priority"
  },
  "ui": {
    "main_text": "疑似心脏骤停",
    "secondary_text": "准备胸外按压",
    "status_tags": ["无反应", "无正常呼吸", "CPR准备"],
    "quality_score": null
  },
  "haptic": {
    "enabled": false
  },
  "visual_overlay": {
    "mode": "prepare_cpr_position",
    "highlight_target": "chest_center"
  },
  "tool_actions": [
    {
      "type": "emergency_call",
      "target": "120",
      "mode": "auto_with_cancel_window",
      "cancel_window_seconds": 3,
      "requires_user_confirmation": false
    }
  ],
  "log_event": {
    "type": "suspected_cardiac_arrest",
    "detail": "unresponsive_and_no_normal_breathing"
  }
}
```

约定：

- Android 只消费 `GuidanceAction`，不直接解析 Gemma 自然语言。
- `priority` 分为 `critical`、`high`、`normal`、`low`。
- `source` 可为 `state_machine`、`rule_feedback`、`gemma_agent`、`demo_script`。
- 分享报告和视频必须 `requires_user_confirmation: true`。

### 1.4 Gemma 输入输出

Gemma 不直接输出最终 `GuidanceAction`，而是输出候选补丁 `GuidanceActionPatch`，再交给 `ActionValidator` 审查。

输入给 Gemma 的 `DecisionFrame`：

```json
{
  "stage": "S6_CPR_READY",
  "allowed_intents": [
    "guide_cpr_position",
    "answer_position_question",
    "encourage_rescuer"
  ],
  "facts": {
    "adult_likely": true,
    "responsive": false,
    "normal_breathing": false,
    "emergency_call_status": "started"
  },
  "safety_phrases": [
    "请按疑似心脏骤停处理。",
    "双手掌根放在胸口中央。",
    "现在开始胸外按压。"
  ],
  "user_input": "我应该按哪里？",
  "language": "zh-CN"
}
```

Gemma 输出：

```json
{
  "intent": "guide_cpr_position",
  "tts": {
    "text": "双手掌根放在胸口中央，现在开始按压。",
    "tone": "calm_firm"
  },
  "ui": {
    "main_text": "胸口中央",
    "secondary_text": "双手掌根按压"
  },
  "reason": "user_asked_position"
}
```

## 2. Gemma System Prompt

```text
你是 FirstAid Copilot 的急救引导话术层，运行在成人疑似心脏骤停 CPR 场景中。

你的职责：
1. 根据当前状态、已确认事实、允许意图和安全话术，生成简短、明确、冷静的急救引导话术。
2. 将用户口语化反馈理解为当前状态允许的意图。
3. 在 CPR 过程中优先帮助用户继续胸外按压。
4. 必要时安抚施救者，但不能分散其动作注意力。

你的限制：
1. 你不能诊断疾病。
2. 你不能改变状态机的医疗流程决策。
3. 你不能新增未经审核的医疗步骤。
4. 你不能直接发起工具调用。
5. 你不能承诺结果。
6. 你不能恐吓、责备或让用户承担复杂医学判断。

你必须遵守：
1. 只能在 allowed_intents 范围内输出。
2. 每次最多给一个主要动作。
3. 输出必须短句优先，适合 TTS 播报。
4. 不要输出长篇解释。
5. 对不确定呼吸，应按“无法确认正常呼吸”表达，不要说成确定诊断。
6. 对疑似心脏骤停，应说“按疑似心脏骤停处理”，不要说“他已经心脏骤停了”。
7. CPR 循环中，优先提醒“继续按压”。

禁止说法：
- 他已经心脏骤停了。
- 这是心梗。
- 这样一定能救活。
- 如果你不按他会死。
- 你自己决定要不要按压。
- 不用担心，没事的。

推荐表达：
- 请按疑似心脏骤停处理。
- 现在开始胸外按压。
- 双手掌根放在胸口中央。
- 跟着震动按，快速有力。
- 不要停，继续按压。
- 你做得很好，继续跟着节奏。

输出格式：
你只能输出 JSON，不要输出 Markdown，不要输出解释性段落。

JSON Schema:
{
  "intent": "string",
  "tts": {
    "text": "string",
    "tone": "calm_firm | calm_soft | urgent"
  },
  "ui": {
    "main_text": "string",
    "secondary_text": "string"
  },
  "reason": "string"
}
```

## 3. 当前统一口径

```text
Medical flow is rule-driven.
Interaction is Gemma-driven.
Execution is Android-driven.
```

中文口径：

```text
医疗流程由状态机决定。
交互表达由 Gemma 驱动。
系统动作由 Android 执行。
```
