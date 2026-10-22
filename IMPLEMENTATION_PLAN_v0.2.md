# FirstAid Copilot v0.2 实施计划

> 状态：部分实施；Android 触控训练与独立 Web 原型已实现，其余项目仍为后续计划，详见下方实施状态。
> 原则：Rule Engine 负责医疗流程决策；Gemma 只负责理解、表达与交互增强；任何 LLM 输出都不得直接控制急救流程。

## 当前实施状态（2026-08-06）

第一阶段已开始，以 `android/` 为主客户端，并采用独立 Practice 启动入口：

- 已新增 `TrainingActivity`，不初始化或复用 Emergency session。
- 已新增成人倒地 CPR 训练状态、封闭动作协议与确定性 `TrainingRuleEngine`。
- 已完成现场安全、反应、呼吸、呼救、CPR 准备五步触控演练闭环。
- 训练观察协议已预留 `TOUCH / VOICE / VISION` 来源与置信度门控。
- 已新增完整正确序列、危险动作、越序动作、低置信度和重置测试。
- 已新增独立手机 Web 原型，用于在接入 Android 前确认多模态教学 UI 与完整训练闭环。
- 语音输入、视觉动作训练与 Gemma 受控解释尚未接入，属于下一迭代。

验证状态：Node Emergency 回归测试 393/393 通过；Android Debug JVM 测试 290/290 通过（含 5 个 TrainingRuleEngine 测试）；`assembleDebug` 成功并生成 Debug APK。

## 1. 实施范围

v0.2 先完成三个可独立验收的工作包：

1. **Safety & Contract Baseline**：统一协议和规则一致性，解决多套 Android/Node 逻辑漂移。
2. **Emergency Copilot Interaction**：增强陪伴、确认、状态解释和情境适配，不扩大医疗范围。
3. **Training Copilot Slice**：在安全隔离的训练域中完成一个互动 CPR 案例。

Multimodal 的下一步聚焦可靠性和规则融合，不在 v0.2 首批增加新传感器种类。

## 2. 修改文件

### 2.1 Node Agent Core

| 文件 | 计划变更 |
| --- | --- |
| `src/domain/types.js` | 增加 `SessionMode`、`interaction_context`、策略决策与审计字段；保持 schema 版本兼容 |
| `src/engine/sessionReducer.js` | 归约情绪、疲劳、犹豫、重复询问、感知可用性；只保存观察事实 |
| `src/engine/stateMachine.js` | 不增加 LLM 分支；暴露当前阶段允许的 interaction envelope |
| `src/engine/actionValidator.js` | 校验 mode、interaction intent、工具权限和 Gemma 字段白名单 |
| `src/engine/guidanceArbitration.js` | 增加 `interaction_policy` 来源及冲突优先级，低于所有关键流程与纠错 |
| `src/agent/runPipeline.js` | 在状态机之后调用 interaction policy，再决定是否允许 Gemma 润色 |
| `src/gemma/decisionFrame.js` | 增加受控 interaction context，不暴露模型不需要的状态 |
| `src/gemma/promptBuilder.js` | 为陪伴/解释使用封闭意图与单动作短话术契约 |
| `src/voice/service.js` | 复用相同 policy 与仲裁；维持 `ack_then_async` |
| `src/report/sessionLog.js` | 记录 policy reason、chosen source、fallback、interrupt/defer 结果 |
| `src/report/handoverReportGenerator.js` | 只消费确定性事实；不把情绪推断写成医学事实 |

### 2.2 Knowledge / Prompt

| 文件 | 计划变更 |
| --- | --- |
| `knowledge/allowed_intents.json` | 增加/整理 `reassure_rescuer`、`confirm_understanding`、`explain_current_step`、`simplify_instruction` 等受控意图 |
| `knowledge/safety_phrases.json` | 增加审核过的安抚、确认、视觉丢失、听不清与重复解释模板 |
| `knowledge/nlu_slots.json` | 如需新增，只允许描述用户表达/交互状态的 slot，不允许模型写医疗结论 |
| `prompts/gemma_system_prompt_v1.1.txt` | 升级版本，强调 interaction envelope 和禁止改变行动语义 |
| `prompts/gemma_open_question_system_prompt_v1.txt` | 按阶段限定回答范围，强制先保持当前关键动作 |

### 2.3 Android 主应用

| 文件 | 计划变更 |
| --- | --- |
| `android/.../live/LocalAgentTransport.kt` | 收敛重复状态机；改为 canonical contract 的适配/执行实现 |
| `android/.../live/LiveSessionViewModel.kt` | 消费结构化 policy metadata，避免自行决定医疗流程 |
| `android/.../live/ProactiveCoach.kt` | 与共享 policy fixtures 对齐，仅负责本地低延迟调度与安全模板回退 |
| `android/.../live/LiveUiState.kt` | 增加用户可见的当前任务/确认状态，不展示模型推测 |
| `android/.../edge/EdgeGemmaPromptBuilder.kt` | 输入 canonical interaction envelope |
| `android/.../edge/EdgeGuidanceGuard.kt` | 与 Node validator 共享对抗 fixtures 与 reason codes |
| `android/.../ui/LiveCprCoachScreen.kt` | 明确“现在做什么 / 为什么 / 是否已识别”三类信息层级 |

### 2.4 `android_nav/cpr_new`

| 文件 | 计划变更 |
| --- | --- |
| `agent/copilot/RemoteGuidanceAgent.kt` | 减少本地文本到医疗事实的重复映射，统一走事件契约与置信度 |
| `agent/copilot/CopilotModels.kt` | 对齐版本化 `GuidanceAction`/policy metadata |
| `core/contract/*` | 使用生成或共享 fixtures 验证 schema，不再独立演化 |
| `mock/MockGuidanceAgent.kt` | 仅 debug/test 可用，明确其不代表医疗决策实现 |
| `feature/session/CprSessionViewModel.kt` | 只执行/展示已验证动作，不创建医疗流程结论 |

## 3. 新增文件

### 3.1 Emergency Copilot

- `src/engine/copilotInteractionPolicy.js`
  - 输入：`SessionState`、当前规则动作、最近交互摘要。
  - 输出：`InteractionDecision`，包含受控 intent、reason code、优先级上限、是否可由 Gemma 润色。
- `src/domain/interactionTypes.js`
  - 定义 `InteractionContext`、`InteractionDecision` 与 schema version。
- `knowledge/interaction_policy_v1.json`
  - 存放阶段适用范围、节流、模板键与冲突约束；不存放医疗流程迁移。
- `test/copilot-interaction-policy.test.js`
- `test/copilot-interaction-safety.test.js`
- `test/contract-golden-scenarios.test.js`
- `test/fixtures/contracts/*.json`

### 3.2 Training Copilot（第二工作包完成后再创建）

- `src/training/domain/trainingTypes.js`
- `src/training/engine/trainingReducer.js`
- `src/training/engine/trainingRuleEvaluator.js`
- `src/training/engine/trainingActionValidator.js`
- `knowledge/training/adult_collapse_cpr_v1.json`
- `prompts/training_feedback_system_v1.txt`
- `test/training-isolation.test.js`
- `test/training-rule-evaluator.test.js`

Training 文件不得依赖 Emergency 工具执行器；共享内容仅限只读医学规则标识、协议基础类型和安全词表。

## 4. 数据结构变化

### 4.1 `SessionState`

建议从 `session_state.v0.1` 演进到兼容的 `v0.2`：

```json
{
  "mode": "emergency | training | demo",
  "interaction_context": {
    "last_user_ack": "understood | confused | no_response | unknown",
    "consecutive_clarifications": 0,
    "observed_emotion": "calm | anxious | panic | unknown",
    "cognitive_load": "normal | high | unknown",
    "last_support_intent": null,
    "last_support_at": null
  }
}
```

约束：

- `observed_emotion` 是观察/交互信号，不是诊断。
- `cognitive_load` 必须由确定性规则从交互迹象推导，并允许 unknown。
- 这些字段不得参与 CPR start decision 或改变医疗 stage。

### 4.2 `InteractionDecision`

```json
{
  "schema_version": "interaction_decision.v0.2",
  "intent": "reassure_rescuer",
  "reason_codes": ["rescuer_anxious", "no_recent_critical_correction"],
  "semantic_anchor": "保持当前动作并确认用户正在正确执行",
  "max_priority": "normal",
  "gemma_reword_allowed": true,
  "expires_in_ms": 5000
}
```

Gemma 只能改写 `semantic_anchor` 的表达，不能修改 intent、priority、stage 或 tools。

### 4.3 Training 数据

```json
{
  "scenario_id": "adult_collapse_cpr_v1",
  "current_node": "check_response",
  "observed_user_action": "call_for_help",
  "rule_evaluation": {
    "result": "correct | incomplete | unsafe | unrelated",
    "rule_ids": ["CPR-SEQ-002"],
    "next_allowed_nodes": ["check_breathing"]
  }
}
```

模型只负责把自由回答映射为候选 `observed_user_action` 和解释既有 `rule_evaluation`。

## 5. API 变化

### 5.1 `/api/turn` 与 WebSocket guidance

保持现有事件输入兼容，响应可选增加：

```json
{
  "policy": {
    "decision_id": "...",
    "reason_codes": [],
    "chosen_source": "interaction_policy | gemma_agent | state_machine",
    "gemma_fallback_reason": null
  }
}
```

客户端不得依据 `policy` 自行跳 stage；它仅用于 UI、遥测与审计。

### 5.2 协议版本

- 所有请求/响应显式携带 `schema_version`。
- v0.2 reader 在过渡期接受 v0.1；v0.1 reader 忽略新增可选字段。
- 工具动作继续只由规则侧生成，Gemma patch schema 不增加 tools、priority 或 stage。
- 新增 `/api/training/turn` 或本地等价入口，禁止复用 Emergency `/api/turn` 的工具执行权限。

## 6. 测试方案

### 6.1 安全回归（必须门禁）

- Gemma 尝试改 stage、CPR decision、priority、事实或工具动作时必须拒绝。
- 安抚/解释与关键纠错同时出现时，关键纠错胜出。
- 模型超时、崩溃、空输出、越权和乱码均回退确定性动作。
- 视觉/STT 冲突、低置信度和过期事件不得触发不可逆流程推进。
- Emergency 与 Training 的工具权限完全隔离。

### 6.2 跨端 contract tests

使用同一组 JSON golden scenarios 同时验证：

- Node reference core。
- Android `LocalAgentTransport` 或其替代实现。
- `android_nav/cpr_new` 映射层。

每个事件序列至少比较：`current_stage`、restricted `intent`、priority ceiling、tool policy、reason code。

### 6.3 产品体验测试

场景：

- 用户恐慌并重复问“我做得对吗”。
- 用户长时间沉默或连续未确认。
- CPR 质量纠错与用户提问同时发生。
- 摄像头丢失但节拍仍需继续。
- STT 误听 AED/停止/呼吸等高风险词。
- Gemma 完全不可用。

指标：

- 首个确定性响应 p95。
- 高频纠错端到端 p95。
- 关键动作被非关键语音打断次数（目标 0）。
- 正确 stage 完成率与误推进率。
- 重复指令率、用户确认成功率、交接字段完整率。
- 有/无 interaction policy 的受控可用性测试与主观压力评分。

### 6.4 Training 测试

- 同义自由回答映射到同一封闭动作。
- 错误步骤由规则判分，Gemma 不得改变结果。
- 提示注入不能获得真实工具权限。
- 同一 scenario/rule version 下评分确定且可复现。
- 训练解释不得伪造未在 rule evaluation 中出现的医疗结论。

### 6.5 验证环境

- Node：`npm test` 与 strict local verification。
- Android：JVM unit tests、instrumented contract fixtures、真机 Gemma/STT/TTS/vision acceptance。
- CI 应补齐可复现 Gradle wrapper，并区分无需模型的门禁与真实模型/真机验收。

## 7. 发布与回滚

- 所有新策略使用 feature flag，默认先保持 v0.1 确定性行为。
- 先 shadow 记录 policy decision，不播报；验证冲突与节流后再小范围启用。
- 任意延迟或安全指标退化时，可单独关闭 Gemma 润色或 interaction policy，状态机/规则反馈保持工作。
- Training 以独立入口发布，不与 Emergency 主按钮混合。

## 8. 开发前确认点

开始编码前需确认：

1. `android/` 与 `android_nav/cpr_new/` 哪一个是 v0.2 的主产品客户端。
2. 跨平台规则核心采用“共享运行时”“生成代码/表”还是“reference core + golden conformance”路线。
3. v0.2 首个用户成功指标与验收设备列表。
4. Training Copilot 是否进入 v0.2 发布范围，还是仅完成技术垂直切片。
