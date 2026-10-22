# FirstAid Copilot 产品评审 v0.2

> 评审日期：2026-08-06
> 评审范围：仓库 `main`（`145c7bf`）与《FirstAid Copilot 产品方向调整说明 v0.2》
> 本文仅做产品与架构评审，不代表已完成对应实现。

## 0. 结论摘要

当前 MVP 与 v0.2 的产品定位高度一致：它已经不是知识问答 App，而是以确定性规则掌握医疗流程、以端侧 Gemma 增强理解与表达、以语音/视觉/节拍帮助用户完成任务的 Emergency Copilot。

下一阶段不应先扩充病种或堆叠功能。最高优先级是把现有能力收敛成一个可信的产品闭环：

1. 建立跨 Node、主 Android 与 `android_nav/cpr_new` 的单一规则与协议来源，消除流程分叉风险。
2. 把“陪伴感”设计成受规则触发、可度量、可降级的交互策略，而不是扩大 LLM 自由度。
3. 以 Emergency Copilot 的完成率、首响时间、关键动作不中断和压力降低作为 v0.2 成功标准。
4. Training Copilot 复用同一规则核心，但使用独立 session mode、状态与动作命名空间；它不能进入真实急救执行通道。

产品定位匹配度（基于代码与测试证据）：**约 8/10**。技术安全底座成熟度明显高于一般 MVP；主要缺口是多套客户端逻辑漂移、产品体验指标不完整，以及训练域尚未建模。

## 1. 当前架构分析

### 1.1 已验证的主链路

```text
PerceptionEvent
  -> SessionReducer（事实归约与冲突处理）
  -> StateMachine + CprStartRule（医疗流程决定）
  -> RuleFeedbackEngine（CPR 高频规则反馈）
  -> 可选 Gemma GuidanceActionPatch（理解/表达增强）
  -> ActionValidator（硬安全校验）
  -> Guidance Arbitration（权限与优先级仲裁）
  -> GuidanceAction Dispatcher（UI/TTS/Haptic/Tool/Log）
  -> SessionLog -> Handover Report
```

关键证据：

- `src/engine/cprStartRule.js` 单独决定是否启动 CPR，并处理事实冲突重检。
- `src/engine/stateMachine.js` 掌握 S0–S9 与监测分支的流程迁移。
- `src/engine/ruleFeedbackEngine.js` 在 S7 对中断、手位、频率、手臂、疲劳、AED 和鼓励做确定性反馈。
- `src/engine/actionValidator.js` 阻止 Gemma 改 stage、创建工具动作、使用禁止意图/话术或输出过长话术。
- `src/engine/guidanceArbitration.js` 明确定义“关键规则纠错 > 状态机关键动作 > 规则快路径 > Gemma autonomy > Gemma 润色 > 确定性兜底”。
- `src/agent/runPipeline.js` 对关键或含工具的动作绕过 Gemma，模型失败时回退状态机动作。
- `android/app/.../edge/EdgeGuidanceGuard.kt` 为端侧增强提供第二套输出守卫。

### 1.2 快慢双循环

- 快循环：视觉指标、按压中断、节拍和姿势纠错不等待 LLM。
- 慢循环：阶段说明、开放问题、安抚、话术润色与交接叙述可调用 Gemma，失败可回退。
- `ack_then_async` 已形成正确的交互基础：确定性响应先行，模型只补充非关键内容。

这与 v0.2 “实时反馈不能等待 LLM”完全一致，应保留为架构红线。

### 1.3 Android 现状

仓库存在两个 Android 方向：

- `android/`：当前功能较完整，含 `LocalAgentTransport`、端侧 Gemma、语音、视觉、主动陪伴和大量 JVM 测试。
- `android_nav/cpr_new/`：新原生 CPR 界面/模块，主要通过 `RemoteGuidanceAgent` 连接 Node，同时保留 `MockGuidanceAgent`。

风险在于主 Android 的 `LocalAgentTransport.kt` 内再次实现了阶段推进与规则话术，而 Node 已有另一套状态机；`cpr_new` 又有自己的协议模型与 Mock 规则。这会让“哪个实现是医疗流程真相源”逐渐不清晰。

## 2. 产品定位匹配度

### 2.1 已匹配

- **Human is Pilot**：动作协议以指导、确认和反馈为主，用户仍执行急救动作。
- **AI is Copilot**：语音、视觉、节拍、情绪/疲劳状态和交接日志已经组成协作闭环。
- **不是医疗问答机器人**：开放问答被限制在阶段允许意图与安全话术内。
- **不是 AI 医生**：禁止诊断、禁止模型切换状态、禁止模型发起工具操作。
- **端侧优先**：Gemma、STT/TTS、视觉和本地传输路径已有实现证据。
- **任务导向**：核心体验围绕发现倒地者到 EMS 交接，而非内容浏览。

### 2.2 部分匹配

- **陪伴感**：已有 `ProactiveCoach`、`rescuer_state`、鼓励和安抚意图，但尚未形成完整、可审计的交互策略模型与效果指标。
- **个性化指导**：当前更多是基于阶段、质量、疲劳和 AED 状态的情境适配；不应表述为广义用户画像个性化。
- **状态解释**：能解释当前动作，但 UI/语音是否始终让用户理解“为什么现在做这一步”缺少体验验收矩阵。
- **跨平台核心**：协议思想可跨平台，实际规则核心仍以 JavaScript/Kotlin 多份实现存在，尚未达到真正共享。

### 2.3 尚未实现

- **Training Copilot**：仓库已有 demo/simulator，但它们是验证工具，不等同于面向用户的互动模拟训练产品。
- **Sensor 输入**：方向文档提出未来输入，当前未见稳定产品契约；现阶段不应为了路线图提前扩张。
- **iOS 产品层**：尚无 iOS 实现。开始 iOS 前应先稳定跨端协议和规则一致性方案。

## 3. 技术债与风险排序

### P0：规则与协议多源

`src/engine`、`android/.../LocalAgentTransport.kt`、`android_nav/cpr_new` 的模型/Mock 存在并行逻辑。医疗规则一旦只在某一端更新，可能出现不同客户端给出不同流程。

建议：明确 Node reference core 为规范来源，建立版本化 contract fixtures 与跨实现一致性测试；中期选择可跨平台编译/嵌入的 rule core，或由生成物同步，而不是人工复制规则。

### P0：`cpr_new` 的 Mock 边界表述不安全

`MockGuidanceAgent` 注释提到真实决策可由“Gemma（或规则基线）”负责，这与项目原则冲突。Mock 可以存在于 demo/test，但不得成为 production fallback，也不得暗示 Gemma 可拥有医疗流程决策权。

### P1：陪伴策略缺少统一决策层

情绪、疲劳、犹豫、近期纠错、TTS 冲突和节流分散在 reducer、规则反馈、Android `ProactiveCoach` 与 Gemma fallback 中。需要一个确定性的 `InteractionPolicy`/`CopilotPolicy`，只决定“何时以何种受控意图交互”，Gemma只生成受限措辞。

### P1：产品指标偏技术，缺少任务指标

现有延迟、缓存、Gemma 使用率和测试较强，但 v0.2 还需要：关键步骤完成率、误推进率、纠错响应时间、按压不中断率、重复指令率、用户求助后有效响应率、交接完整率、主观压力变化。

### P1：Training 与 Emergency 隔离尚未定义

训练模式如果复用真实工具动作、真实会话日志或紧急通道，会造成产品与安全混淆。必须在 domain 层隔离模式、事件来源、动作执行权限与数据保存。

### P2：版本和文档漂移

仓库内存在多份技术报告、优化计划、两个 Android 目录与 v0.1 schema。继续扩展前需确定 canonical 文档、协议版本策略和弃用路径。

### P2：测试可运行性

Node 测试覆盖广，但部分 HTTP 测试在受限环境因无法监听 `127.0.0.1` 而失败；Android 目录没有提交 Gradle wrapper，降低可重复验证性。真实设备/真实模型验收仍需单独执行，不能由单元测试结论替代。

## 4. 推荐修改模块

### 4.1 Emergency Copilot（先做）

1. **Copilot Interaction Policy**：由规则根据阶段、用户输入、情绪、疲劳、沉默、最近纠错和优先级选择受控 `interaction_intent`。
2. **Interaction Context**：在 `SessionState` 中增加最小必要上下文，如认知负荷、最近确认、连续未理解次数；不建立敏感画像。
3. **受控话术增强**：Gemma只可在当前 `interaction_intent` 的语义包络内改写，关键动作仍使用审核模板。
4. **对话冲突控制**：任何安抚/解释不得打断 critical 或 CPR 高频纠错；利用现有仲裁与节流扩展，不另建旁路。
5. **体验遥测**：全部本地优先，记录 reason code、选择来源、回退原因和延迟，不保存非必要原始音视频。

### 4.2 Training Copilot（后做）

建立独立 `training` domain：

- `ScenarioDefinition`：案例事实、目标步骤、允许用户动作、分支与评分规则。
- `TrainingSessionState`：模拟进度与学习反馈，不复用 Emergency 的真实患者事实状态。
- `TrainingEvaluation`：规则引擎评价流程正确性；Gemma只把用户自由回答映射到封闭动作候选，并解释规则结果。
- `TrainingGuidanceAction` 或带严格 mode 的动作协议：禁止紧急拨号、定位、真实录制/分享等生产工具。

Training 不应先做课程、题库或证书；首个垂直切片只做一个成人倒地 CPR 互动案例。

### 4.3 Multimodal Guidance（随后强化）

优先提升输入可信度和融合规则：

- 感知层继续只输出观察值、置信度、时间戳与质量状态。
- 多模态冲突进入 reducer 的 evidence/conflict 机制，由规则要求复核。
- 新 sensor 必须先定义 `PerceptionEvent` 契约、时效、置信度与失效回退，再接 UI。
- 不允许 Gemma从原始图像/传感器输出直接决定 stage。

## 5. v0.2 开发计划

### Milestone 0：安全基线与单一真相源（1–2 周）

- 冻结 v0.1 安全行为，建立 architecture decision 与 contract version policy。
- 盘点并标记 Node、`android/`、`cpr_new` 各自 production/demo/test 身份。
- 建立跨端 golden scenarios：同一事件序列必须得到相同 stage、restricted intent 和 tool policy。
- 将 `cpr_new` Mock 限制为 debug/test，并纠正其职责说明。

退出条件：任何客户端都不能绕过 canonical rule contract；现有 CPR 安全回归全部通过。

### Milestone 1：Emergency Copilot 体验增强（2–3 周）

- 引入确定性 `CopilotInteractionPolicy` 与结构化 `InteractionContext`。
- 覆盖恐慌、犹豫、重复询问、疲劳、噪声误识别、视觉丢失等情境。
- 优化短话术、确认反馈、状态解释与可打断策略。
- 加入产品级任务指标和本地审计。

退出条件：关键路径延迟不退化；安抚/解释从不覆盖关键指令；场景验收显示任务完成率与重复询问改善。

### Milestone 2：Training Copilot 垂直切片（2–3 周）

- 仅实现一个成人倒地 CPR 场景。
- 规则评分用户步骤，Gemma 解析自由表达并解释评分。
- Emergency/Training 的 session、工具权限、UI 和日志清晰隔离。

退出条件：对抗输入不能触发真实急救工具；Gemma 不能修改正确步骤、分数或分支结果。

### Milestone 3：多模态可靠性与跨平台准备（2 周）

- 完善视觉/STT 冲突、过期事件和低置信度复核。
- 固化 protocol fixtures、schema migration 与跨端兼容表。
- 基于稳定核心再评估 Swift/Kotlin Multiplatform/Flutter UI 方案。

## 6. 文件级修改建议

| 文件/目录 | 建议 | 原因 |
| --- | --- | --- |
| `src/domain/types.js` | 增加版本化 interaction context 与 mode，不混入医疗结论 | 承载陪伴上下文与训练隔离 |
| `src/engine/stateMachine.js` | 保持医疗流程唯一决策权；只接收规范化事实 | 防止交互增强渗入流程判断 |
| `src/engine/cprStartRule.js` | 冻结并建立 golden contract | CPR 启动属于最高风险规则 |
| `src/engine/actionValidator.js` | 增加 interaction intent/模式/工具权限校验 | 复用现有安全闸门 |
| `src/engine/guidanceArbitration.js` | 加入 interaction policy source，优先级仍低于关键规则/流程 | 保证安抚不抢占救命指令 |
| `src/engine/ruleFeedbackEngine.js` | 保持高频规则闭环，避免引入 LLM 等待 | 实时安全红线 |
| `src/engine/` 新建 `copilotInteractionPolicy.js` | 规则决定何时安抚、确认、解释、简化 | 把陪伴感做成可审计策略 |
| `src/gemma/decisionFrame.js` | 只暴露必要交互上下文和已批准 intent | 限制模型权限与敏感信息 |
| `knowledge/allowed_intents.json` | 版本化陪伴意图语义与 restricted/autonomy 分类 | 形成封闭词表 |
| `knowledge/safety_phrases.json` | 增加经审核的情绪支持与状态解释模板 | Gemma 失败时仍有可靠体验 |
| `src/report/sessionLog.js` | 记录 policy reason/source/fallback，不保存非必要内容 | 支持体验度量和审计 |
| `src/voice/service.js` | 复用 interaction policy；保留确定性先响 | 防止语音链路另建决策旁路 |
| `android/.../LocalAgentTransport.kt` | 不再人工扩展独立医疗规则；转为共享/生成的规则适配层 | 消除跨端漂移 |
| `android/.../ProactiveCoach.kt` | 收敛为 canonical interaction policy 的端侧执行/缓存实现 | 保持陪伴策略一致 |
| `android/.../edge/EdgeGuidanceGuard.kt` | 与 Node validator 用共享 fixtures 校验 | 确保端侧模型同样受控 |
| `android_nav/cpr_new/.../RemoteGuidanceAgent.kt` | 只映射事实与执行已验证动作，不本地猜测医疗结论 | 保持客户端职责清晰 |
| `android_nav/cpr_new/.../MockGuidanceAgent.kt` | 限制 debug/test；删除“Gemma 负责真实决策”表述 | 修复安全边界歧义 |
| `test/` 与 Android tests | 新增跨端 golden、陪伴冲突、训练隔离和对抗测试 | 让产品方向可验证 |
| `docs/` | 指定 canonical 架构与弃用文档 | 降低版本漂移 |

## 7. 架构红线

以下变更不应被接受：

- Gemma 直接输出或修改 stage、CPR start decision、医疗事实、priority 或 tool action。
- 为“更自然”而让关键路径等待模型。
- 用 prompt 代替 ActionValidator、规则仲裁或执行权限校验。
- 让 Training 模式调用真实紧急工具。
- 在不同客户端手工维护未做一致性测试的医疗规则副本。
- 以新增病种数量代替 Emergency Copilot 的任务完成质量。
