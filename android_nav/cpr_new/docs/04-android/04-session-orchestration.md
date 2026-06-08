# 04 · 会话编排

位于 `feature/session/`。这是第 4 部分的“总线”，把感知、Agent、硬件、UI 串成一条数据流。

---

## CprSessionViewModel（编排核心）

### 职责

1. **拉起数据流**：`startSession()` 启动感知、Agent、节拍器、录音、定位。
2. **感知 → UI / Agent**：收到 `PerceptionEvent` 时算质量分、更新 UI，并（仅可靠事件）转交 Agent。
3. **Agent → 输出**：收到 `GuidanceAction` 时做 TTS 播报、触觉、节拍变速、阶段切换。
4. **流程动作**：120 拨号、定位采集、录音留证。
5. **异常兜底**：任一环节异常都转成用户可见 `incidentBanner`，不崩溃、不中断主流程。
6. **生成交接**：`stopSession()` 打包 `SessionLog` 交给 Agent 生成 `HandoverReport`。

### 关键设计

- 感知事件经 `perceptionRelay`（`MutableSharedFlow`）中转：本地订阅更新 UI，同时喂给 Agent，二者解耦。
- 所有协程跑在 `viewModelScope`，每个 `collect` 用 `runCatching{}.onFailure{ raiseIncident() }` 包裹。
- 依赖通过构造器注入（`CprDependencies`），可在单测中传入假实现。
- `onCleared()` 兜底释放所有硬件资源。

### 状态：CprSessionState

UI 的唯一数据源（Single Source of Truth），全字段带默认值，保证任何时刻可安全渲染。
派生属性 `rateInRange` / `handPositionOk` 供 UI 决定配色。

---

## Metronome（节拍器）

- 协程 + `delay` 实现，挂在传入 scope 上。
- `ticks`（`SharedFlow`）每拍发一次，UI 做脉冲、硬件做轻触，互不阻塞。
- `setBpm()` 运行中热更新：Agent 下发 `targetRate` 即时变速，无需重启。
- 频率自动夹到标准区间 `100~120`，默认 110。

---

## QualityScorer（质量分）

> ⚠️ 仅用于 UI 展示的轻量加权，**不是医学评分标准**（医学评估属第 3 部分）。

- 纯函数：`score(event): Int`（0~100），便于单测与调权重。
- 权重：频率 40% + 深度 35% + 手位 25%；中断打 0.6 折；再乘置信度。

---

## 一次会话的时序

```
开始急救
 ├─ startPerception()   订阅感知流
 ├─ startGuidance()     订阅 Agent 动作流
 ├─ startMetronome()    节拍器开始 + 每拍触觉
 ├─ startRecording()    录音（无权限则跳过）
 ├─ captureLocation()   异步取定位
 └─ emitFirstGuidance() Agent 首条指导

运行中（循环）
 感知帧 → 质量分/UI → (可靠则)喂 Agent → 动作 → TTS/触觉/变速/阶段

结束
 └─ stopSession() → 停止各流 → 打包 SessionLog → Agent.buildHandover → 展示报告
```
