# 第 4 部分 · Android 终端 / 交互实现

> 负责人视角：搭建 Android 工程、硬件适配、急救 UI、流程集成与异常兜底。
> **边界**：本部分负责“集成模型与算法 + 把交互做稳”，**不设计医疗决策规则，也不维护算法本身**。
> 医学决策属于第 2 部分（Gemma Agent），感知/质量评估算法属于第 3 部分。

---

## 1. 一句话说明

第 4 部分是整个产品的**外壳与总线**：把第 3 部分的「感知结果」喂给第 2 部分的「决策 Agent」，
再把 Agent 的「指导动作」通过 TTS / 大字 / 震动 / 节拍器呈现给施救者，并完成 120 拨号、
定位、录音留证与交接报告。

最关键的设计：**用接口契约把第 2/3 部分解耦**，并提供 Mock 实现，
做到**断网、无模型也能端到端跑通 Demo**，真实实现就绪后只需替换实现类。

---

## 2. 数据流总览

```
 第3部分(感知)            第4部分(本模块)                第2部分(Agent)
┌───────────┐   events   ┌──────────────────────┐  perception  ┌────────────┐
│Perception │──────────▶ │ CprSessionViewModel   │────────────▶ │GuidanceAgent│
│  Source   │            │  (编排/总线)           │              │            │
└───────────┘            │                        │◀──────────── └────────────┘
                         │   guidance 动作         │  GuidanceAction
                         ▼                        ▼
                    更新 UI 状态           TTS / 震动 / 节拍 / 阶段
                         │
                         ├─▶ 120 拨号 (EmergencyDialer)
                         ├─▶ 定位     (LocationProvider)
                         ├─▶ 录音     (AudioRecorderController)
                         └─▶ 结束时打包 SessionLog ─▶ Agent ─▶ HandoverReport ─▶ UI
```

---

## 3. 目录结构

```
app/src/main/java/com/example/cpr_new/
├── MainActivity.kt                 # 入口，装配依赖 + 注入 ViewModel
├── core/
│   ├── contract/                   # ★ 与第2/3部分对接的接口契约（解耦核心）
│   │   ├── PerceptionEvent.kt      #   第3部分 -> 本模块
│   │   ├── GuidanceAction.kt       #   第2部分 -> 本模块
│   │   ├── SessionModels.kt        #   SessionLog / HandoverReport / GeoSnapshot
│   │   ├── CprPerceptionSource.kt  #   感知源接口（第3部分实现）
│   │   └── GuidanceAgent.kt        #   Agent 接口（第2部分实现）
│   └── di/
│       ├── CprDependencies.kt      # 依赖集合
│       └── ServiceLocator.kt       # ★ 一处替换 Mock / 真实实现
├── hardware/                       # 硬件适配层（纯 framework API，零额外依赖）
│   ├── audio/TtsController.kt
│   ├── audio/AudioRecorderController.kt
│   ├── haptics/HapticController.kt
│   ├── location/LocationProvider.kt
│   └── permission/RuntimePermissions.kt
├── feature/
│   ├── session/                    # 会话编排
│   │   ├── CprSessionViewModel.kt  # ★ 总线
│   │   ├── CprSessionState.kt      # UI 状态（单一数据源）
│   │   ├── Metronome.kt            # 节拍器
│   │   └── QualityScorer.kt        # 质量分聚合（仅展示用）
│   └── emergency/EmergencyDialer.kt
├── ui/                             # 急救 UI（Compose）
│   ├── EmergencyPalette.kt         # 高对比配色
│   ├── component/CprComponents.kt  # 无状态组件
│   └── screen/CprGuidanceScreen.kt # 主屏
└── mock/                           # 演示桩（真实实现就绪后可删）
    ├── MockCprPerceptionSource.kt
    └── MockGuidanceAgent.kt
```

---

## 4. 分模块文档

| 文档 | 内容 |
| --- | --- |
| [01-architecture.md](01-architecture.md) | 整体架构、分层、依赖注入、扩展点 |
| [02-contracts.md](02-contracts.md) | **与第 2/3 部分的对接契约**（最重要） |
| [03-hardware.md](03-hardware.md) | 硬件适配层（TTS/震动/定位/录音/权限） |
| [04-session-orchestration.md](04-session-orchestration.md) | 会话编排状态机、节拍器、质量分 |
| [05-ui.md](05-ui.md) | 急救 UI 设计与组件 |
| [06-exception-handling.md](06-exception-handling.md) | 异常兜底清单（演示高风险点） |
| [07-接口对接约定.md](07-接口对接约定.md) | 摄像头输入规格 + 联调传输方式（对外确认稿） |

---

## 5. 如何运行（Demo）

1. 用 Android Studio 打开工程，直接运行 `app`。
2. 默认走 **Mock 感知 + Mock Agent**，无需模型、无需联网即可体验完整流程。
3. 点击「开始急救」→ 授权（可拒绝，会降级）→ 观察大字指导、质量仪表盘、节拍器与语音播报 → 点「结束」查看交接报告。

---

## 6. 第 2 / 3 部分如何接入（关键）

只改 `ServiceLocator.kt` 两行，业务/UI 代码零改动：

```kotlin
ServiceLocator.perceptionFactory = { ctx -> RealPerceptionSource(ctx) } // 第3部分
ServiceLocator.agentFactory      = { ctx -> GemmaGuidanceAgent(ctx) }   // 第2部分
```

详见 [02-contracts.md](02-contracts.md)。
