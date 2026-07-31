# FirstAid Copilot 动作识别设计

## 1. 识别目标

动作识别只负责把摄像头、姿态模型或测试夹具的观测转换成事实型 `PerceptionEvent`，不直接输出医疗结论、TTS 文案或工具调用。Agent 继续沿用现有链路：

```text
ActionRecognitionFrame
-> CPRActionRecognizer
-> PerceptionEvent(source=vision_cpr)
-> SessionReducer
-> StateMachine / RuleFeedbackEngine
-> ActionValidator
-> GuidanceAction
```

第一版覆盖 CPR 视觉辅助阶段需要的信号：

| 信号 | 识别方式 | 输出字段 |
| --- | --- | --- |
| 按压位置 | 掌根/双腕中心相对胸口中央的归一化偏移 | `cpr_quality.hand_position` |
| 按压频率 | 最近按压时间戳或手部/胸部位移峰值间隔 | `cpr_quality.compression_rate_bpm`，兼容旧字段 `compression_rate` / `current_rate` |
| 按压中断 | 当前时间与最近一次按压峰值的间隔 | `cpr_quality.interruption_ms`，兼容旧字段 `interruption_seconds` |
| 手臂姿势 | 肩-肘-腕夹角，阈值默认 155 度 | `cpr_quality.arm_straight`, `arm_posture` |
| CPR 质量分 | 位置、频率、连续性、手臂姿势加权评分 | `cpr_quality.quality_score` |
| 施救者状态 | 可选疲劳/犹豫/情绪分数映射 | `rescuer_state.fatigue_level`, `emotion` |

## 2. 具体怎么识别

输入可以是三类数据，按可靠性从高到低融合：

1. 语义观测：端上模型已经给出的 `hand_center`、`chest_center`、`compression_timestamps_ms`、`fatigue_score` 等。
2. 姿态点：MediaPipe/MoveNet 风格的肩、肘、腕、髋等 landmark。
3. 位移采样：`compression_samples` 中的 `depth_mm`、`hand_y`、`wrist_y` 等时间序列。

识别规则：

- 胸口中央优先用显式 `chest_center`；缺省时用双肩和双髋估计。
- 手部按压点优先用显式 `hand_center`；缺省时用双腕中心估计。
- 手位偏移用 torso/chest 宽度归一化，输出 `center`、`left_offset`、`right_offset`、`too_high`、`too_low`、`off_center` 或 `unknown`。
- 按压频率优先用 `compression_timestamps_ms`，没有时从位移峰值估算。
- 手臂是否伸直用左右肘角平均判断，低于阈值输出 `arm_straight=false`。
- 置信度是输入模型置信度、关键点可见度、手/胸定位完整度和节奏观测完整度的保守融合。

## 3. Agent 联动

动作识别输出仍然是标准 `PerceptionEvent`。Agent 不感知识别算法细节，只读取 `cpr_quality` 和 `rescuer_state`：

- `SessionReducer` 写入 `state.cpr_state`。
- `RuleFeedbackEngine` 在 `S7_CPR_LOOP` 高频处理纠错，优先级为：中断、手位、频率、手臂、疲劳/AED。
- Gemma 只做非关键话术补充，关键 CPR 纠错仍由规则层快速输出并经 `ActionValidator` 校验。
- Android/语音服务可以直接传 `action_recognition_frame`；服务会转成 `cpr_quality_update` 事件进入现有 Agent 管线。

## 4. Input 定义

```json
{
  "schema_version": "action_recognition_frame.v0.1",
  "session_id": "sess_001",
  "timestamp": "2026-06-04T12:00:00+08:00",
  "timestamp_ms": 2200,
  "sequence_id": 42,
  "stage_hint": "S7_CPR_LOOP",
  "camera": {
    "facing": "rear",
    "width": 1280,
    "height": 720,
    "fps": 30
  },
  "chest_center": { "x": 0.5, "y": 0.52 },
  "hand_center": { "x": 0.39, "y": 0.54 },
  "torso_width": 0.38,
  "pose": {
    "confidence": 0.88,
    "landmarks": {
      "left_shoulder": { "x": 0.42, "y": 0.32, "visibility": 0.9 },
      "left_elbow": { "x": 0.42, "y": 0.43, "visibility": 0.9 },
      "left_wrist": { "x": 0.39, "y": 0.54, "visibility": 0.9 }
    }
  },
  "compression_timestamps_ms": [0, 652, 1304, 1956],
  "rescuer": {
    "fatigue_score": 0.82,
    "hesitation_seconds": 0
  }
}
```

## 5. Output 定义

识别器的直接结果：

```json
{
  "schema_version": "action_recognition_result.v0.1",
  "source": "vision_cpr",
  "event_type": "cpr_quality_update",
  "stage_hint": "S7_CPR_LOOP",
  "cpr_quality": {
    "compressions_started": true,
    "compression_started": true,
    "compression_rate_bpm": 92,
    "compression_rate": 92,
    "current_rate": 92,
    "hand_position": "left_offset",
    "arm_straight": false,
    "arm_posture": "bent",
    "interruption_ms": 240,
    "interruption_seconds": 0.24,
    "quality_score": 45,
    "confidence": 0.78
  },
  "rescuer_state": {
    "fatigue_level": "high",
    "hesitation_seconds": 0,
    "confidence": 0.82
  }
}
```

进入 Agent 的事件：

```json
{
  "schema_version": "perception_event.v0.1",
  "source": "vision_cpr",
  "event_type": "cpr_quality_update",
  "stage_hint": "S7_CPR_LOOP",
  "ttl_ms": 1500,
  "cpr_quality": {
    "hand_position": "left_offset",
    "compression_rate_bpm": 92,
    "compression_rate": 92,
    "interruption_ms": 240,
    "interruption_seconds": 0.24,
    "arm_straight": false,
    "quality_score": 45,
    "confidence": 0.78
  },
  "metadata": {
    "recognizer": "cpr_action_heuristic_v0.1"
  }
}
```
