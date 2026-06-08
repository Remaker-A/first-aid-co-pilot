# FirstAid Copilot — 技术报告

**赛道：** C - Edge AI  
**团队：** 妙手回春  
**核心模型：** Gemma 4 E2B（LiteRT-LM 端侧部署，Gemma-4 移动端混合量化：2/4/8-bit 混合权重）  
**平台：** Android（compileSdk 35, minSdk 26），纯离线运行

---

## 1. 问题定义与真实影响力

中国每年约 54.4 万人发生心源性猝死，院前急救成功率不到 1%，目击者 CPR 实施率不足 5%。核心矛盾不是"没人在场"，而是在场的普通人不会做、不敢做。心脏骤停的黄金抢救窗口仅 4 分钟，而 120 平均到场需要 12 分钟——中间 8 分钟的空白期决定了患者的生死。

FirstAid Copilot 的目标是：让一个从未接受过急救培训的普通人，在这 8 分钟内，靠一部手机就能完成规范的 CPR。

我们选择完全离线部署的原因：

- **场景刚需**：心脏骤停常发生在电梯、地下车库、偏远地区，网络不可靠
- **延迟敏感**：CPR 纠错需要亚秒级响应，云端往返不可接受
- **隐私合规**：摄像头持续录制施救画面，数据不应离开设备

---

## 2. 产品定位与能力边界


| 它是                            | 它不是               |
| ----------------------------- | ----------------- |
| 端侧离线运行的急救陪跑 Agent             | 不是急救百科 / 静态教程     |
| 成人疑似心脏骤停 CPR 的第一响应助手          | 不是自由聊天的医疗问答机器人    |
| 用"规则把关 + AI 说话 + 结构化工具"的可审核系统 | 不是让大模型自由决定急救流程的系统 |
| 实时纠错 + 交接报告的"急救陪跑系统"          | 不是医疗诊断系统 / 医生替代品  |


一句话理解架构分工：

```
Medical flow is rule-driven    —— 医疗流程由「可审核的规则状态机」决策
Interaction  is Gemma-driven   —— 自然语言理解与话术由端侧 Gemma 负责
Execution    is Android-driven —— UI / 语音 / 节拍 / 工具调用由 Android 执行
```

关键医疗判断永远掌握在确定性的规则状态机手里；Gemma 只负责"把话说清楚、听懂用户"，且所有输出都要经过安全校验器（ActionValidator）这道刹车。

当前 MVP 范围：仅覆盖成人疑似心脏骤停 CPR。暂不支持儿童/婴儿 CPR、海姆立克、止血、中风、溺水、触电等其他场景。未来将逐步扩展。

---

## 3. 系统架构

### 3.1 三层职责边界

```
┌─────────────────────────────────────────────────────────────────┐
│  Perception 感知层  ── 只输出事实与置信度，不做医疗决策             │
│  麦克风/STT · 摄像头/视觉 · 设备状态 · Demo 脚本                   │
└───────────────┬─────────────────────────────────────────────────┘
                │ PerceptionEvent
┌───────────────▼─────────────────────────────────────────────────┐
│  Agent Core 决策层（拥有医疗流程决策权）                          │
│  SessionReducer → StateMachine + CprStartRule → RuleFeedbackEngine│
│           → (可选) Gemma Driver → ActionValidator → Arbitration   │
└───────────────┬─────────────────────────────────────────────────┘
                │ GuidanceAction（唯一动作协议，已校验）
┌───────────────▼─────────────────────────────────────────────────┐
│  Execution 执行层（Android）                                      │
│  UI 大字 · TTS 语音 · 节拍音 · 工具调用(120/GPS/录制) · 日志       │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 双循环：慢循环负责思考，快循环负责救命


| 维度      | 慢循环（Slow loop）                    | 快循环（Fast loop）               |
| ------- | --------------------------------- | ---------------------------- |
| 负责      | 阶段切换、用户提问、安抚、报告生成                 | 节拍、按压中断、频率、手位、手臂姿势           |
| 驱动      | 状态机 + Gemma                       | 感知模型 + RuleFeedbackEngine 规则 |
| 是否等 LLM | 可短超时调用 Gemma，超时即回退模板              | 绝不等 LLM，即时反馈                 |
| 典型延迟    | 关键路径 p95 < 1000ms / 开放问答 < 2500ms | ~500ms，与单轮服务消息解耦             |


设计取舍：CPR 按压过程中的高频反馈不能等待 LLM 推理，因此由规则与感知直接生成 GuidanceAction；Gemma 只在状态切换、提问、安抚、报告时介入。这保证了 Gemma 是"增强驱动"而非"单点故障"。

### 3.3 核心协议：三件套

整个系统围绕三个统一对象协作：

```
PerceptionEvent  ──▶  SessionState  ──▶  GuidanceAction  ──▶  SessionLog / HandoverReport
   （输入事实）          （流程真相源）        （唯一动作协议）         （日志与交接）
```

**PerceptionEvent — 统一输入：**

所有输入（语音/视觉/设备/Demo）归一成同一事件格式。感知层只输出事实与置信度，不做医疗决策。处理规则：null 表示"未知"≠ false；低置信视觉结果不能推翻高置信用户反馈；用户与视觉冲突时进入 RECHECK_ON_CONFLICT。

**SessionState — 流程真相源：**

Agent 的短期记忆。只通过 sessionReducer 单点更新，避免状态竞争。包含 scope / confirmed_facts / tool_state / cpr_state / dialogue_state / action_control.cooldowns / handover_timeline 等。

**GuidanceAction — 唯一动作协议：**

Agent 对下游的唯一输出。Android 不直接解析 Gemma 自然语言——自然语言只是 tts.text 字段。结构包含：stage、intent、priority（critical/high/normal/low）、source、tts、ui、haptic、tool_actions、log_event。

---

## 4. 急救状态机与 CPR 启动规则

### 4.1 状态机（S0-S9）

状态机严格遵循 AHA（美国心脏协会）成人心脏骤停院外急救流程：


| 阶段                  | 目标                | 关键守卫                                          |
| ------------------- | ----------------- | --------------------------------------------- |
| S0_INIT → S1        | 启动会话、检查权限、开始录制    | 用户点击一键急救                                      |
| S1_SCENE_SAFE       | 确认场景安全            | —                                             |
| S2_CHECK_RESPONSE   | 判断有无反应            | 有反应 → MONITOR_RESPONSE；无/不确定 → S3             |
| S3_CHECK_BREATHING  | 判断正常呼吸            | 喘息样呼吸不视为正常呼吸                                  |
| S4_SUSPECTED_ARREST | 固化 CPR 启动结论       | 由 CprStartRule 判定                             |
| S5_CALL_EMERGENCY   | 呼叫 120 / GPS / 录制 | 需 emergency_call_status ∈ {started,connected} |
| S6_CPR_READY        | CPR 姿势准备          | 需 cpr_state.started 或有效质量事件                   |
| S7_CPR_LOOP         | 持续 CPR + 实时纠错     | 出现 signs_of_life → MONITOR_BREATHING          |
| S8_ASSISTANCE       | 疲劳/AED/多人协作       | 辅助完成回到 S7                                     |
| S9_HANDOVER         | 交接                | EMS 到达可从任意 CPR 阶段直达                           |


### 4.2 CPR 启动规则（CprStartRule）

CPR 是否启动不由用户、也不由 Gemma 决定，而由单一规则源判定（decideCprStart()）：

1. recheck_required 或存在未解决冲突 → RECHECK_ON_CONFLICT
2. scope.adult_likely !== true → OUT_OF_SCOPE（本版仅支持成人）
3. confirmed_facts.responsive !== false → MONITOR_AND_CALL_HELP
4. normal_breathing === true → MONITOR_AND_CALL_HELP
5. normal_breathing === false 或 agonal_breathing === true → **START_CPR ✅**
6. 其余 → PREPARE_EMERGENCY_CALL（继续判断）

设计要点：用户只报告观察事实（"有没有反应""有没有正常呼吸""是否只是偶尔喘息"），"要不要 CPR"由规则推理。"濒死喘息（agonal breathing）"这种最容易误判的情况被显式当作"无正常呼吸"处理——这是 AHA 指南的核心要求。

---

## 5. 安全体系：ActionValidator + 决策权仲裁

无论是规则还是 Gemma 产出的动作，下发前都要经过两道关卡。这是整个项目"敢用在救命场景"的底气。

### 5.1 第一道：ActionValidator（硬安全校验）


| 校验项        | 规则                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 禁止话术       | 拦截确定诊断 / 结果承诺 / 责任恐吓（如"他已经心脏骤停了""一定能救活""不按他会死"）                                                                                    |
| 禁止意图       | diagnose_disease · declare_cardiac_arrest · change_cpr_start_rule · skip_state_machine · promise_survival · ask_user_to_decide_cpr |
| Gemma 越权防护 | Gemma 来源不得携带 next_stage、不得改阶段、不得创建任何 tool_actions                                                                                  |
| TTS 长度     | 中文默认 ≤30 字，关键阶段 S4-S8 放宽到 ≤60 字                                                                                                    |
| 优先级        | 低优先级动作不得打断正在进行的 critical 播报                                                                                                        |
| 工具确认       | share_* / send_* / delete_video 等外发/删除类工具必须带用户确认                                                                                   |


违规动作会被替换为安全 fallback_template 或被静默阻断。

### 5.2 第二道：决策权仲裁（guidanceArbitration）

当规则动作与 Gemma 动作同时存在时，按"决策权信封"仲裁：

```
RULE_CRITICAL_CORRECTION (60)   规则关键纠正（如「不要停，继续按压」）
  > STATE_MACHINE_CRITICAL (50) 状态机关键/工具动作
  > RULE_FLOW_FAST_PATH (40)    流程快路径
  > GEMMA_AUTONOMY (30)         Gemma 自主（仅当意图在 autonomy 白名单内）
  > GEMMA_REWORD (20)           Gemma 同意图润色
  > DETERMINISTIC_FALLBACK (10) 确定性兜底
```

Gemma 只有在"状态机意图与 Gemma 意图都属于当前阶段的 autonomy 白名单"时才允许换意图；否则只能在同一意图内润色措辞。

---

## 6. Gemma 4 端侧集成

### 6.1 模型选择与部署


| 项目   | 配置                                         |
| ---- | ------------------------------------------ |
| 模型   | litert-community/gemma-4-E2B-it-litert-lm  |
| 格式   | .litertlm（Gemma-4 移动端混合量化：2/4/8-bit 混合权重）  |
| 运行时  | LiteRT-LM（支持一次性调用与 serve 常驻两种路径）           |
| 模型文件 | ~2.6GB（.litertlm 磁盘体积；运行内存随后端而定）           |
| 推理延迟 | ~1.5s 端到端单轮生成（完整一句话，Snapdragon 8 Gen 2 实测） |
| 后端   | 默认 CPU（XNNPACK）；支持 GPU（GpuThenCpu）回退       |


Gemma 在系统中的定位是"受规则约束的急救话术与理解层"，绝不是医疗流程决策层。

### 6.2 Gemma Driver 运行链路

DecisionFrame 是喂给 Gemma 的受控上下文：current_stage + allowed_intents + facts + safety_phrases + user_input + output_schema。Gemma 只输出 JSON 补丁（intent / tts / ui / reason），不输出自由段落，也不能产生状态跳转或工具调用。


| 组件                              | 职责                                         |
| ------------------------------- | ------------------------------------------ |
| runtime.js (GemmaRuntime)       | 模型加载/预热/推理/超时控制；任意失败都回退                    |
| decisionFrame.js                | 构造受控上下文                                    |
| promptBuilder.js / nluPrompt.js | 话术补丁 / NLU prompt 装配                       |
| responseParser.js               | 解析输出，拒绝 stage/tool_actions/diagnosis 等越权字段 |
| fallbackPolicy.js               | 按阶段生成安全模板；连续失败达阈值降级为纯状态机模式                 |


关键超时配置：语音单轮 GEMMA_TURN_TIMEOUT_MS=1000、CPR live GEMMA_LIVE_TIMEOUT_MS=1200、NLU GEMMA_NLU_TIMEOUT_MS=600。超时即走确定性 fallback。

### 6.3 Android 端侧增强层（EdgeGemmaAgent）

让端侧 Gemma 在 Node 服务不可达时仍能增强对话，且永不接管医疗流程。实现三个功能：

**(C) 受控开放问答**：先用规则给出即时回答，再异步用 Gemma 补充一句（ack_then_async）。

**(D) 主动陪伴润色**：ProactiveCoach 纯规则决定换手/AED/安抚时机，Gemma 只润色已安全的模板。

**(E) 呼吸 NLU 兜底**：优先走 EdgeTinyNluResolver / TFLite 文本嵌入分类，Gemma NLU 仅在 regex + 拼音都 miss 后异步纠正。

设计护栏：

- 独占单一 OnDeviceGemmaDriver（generate() 加 Mutex 串行）
- 内部优先级队列：NLU(0) > 开放问答(1) > 主动润色(2)
- 每次端侧生成都先过 GemmaSuiteAsserts 守卫（EdgeGuidanceGuard）：拦截禁止诊断词、CPR 中的"停止按压"类词、超长 TTS、越权意图——非法输出一律拒绝并改说确定性兜底
- 延迟门控：GEMMA_NEAR_REALTIME_GATE_MS = 1200；超时 → ack_then_async（先确定性、Gemma 下一轮补充）
- 全功能 flag-gated，默认 OFF：接进去是行为无副作用的（no-op），翻开 flag 才生效

### 6.4 端侧四功能套件（Gemma Function Suite）

跑在真机上、用生产形态 prompt 喂真实端侧 Gemma，并用端侧评分器判分的端到端探针：


| functionId    | 功能     | 判分要点                                 |
| ------------- | ------ | ------------------------------------ |
| patch         | 话术润色补丁 | intent 在 allowed 内、短 TTS、拒绝诊断        |
| nlu           | 观察事实解析 | 不泄漏 stage / suspected_cardiac_arrest |
| open_question | 受控开放问答 | 简答、绝不让施救者停止按压、拒绝预后判断                 |
| handover      | 交接叙述   | 逐字复述确定性报告，零编造/篡改数字                   |


判分口径：每个功能须 parseOkRate=1.0、assertPassRate=1.0、bannedHits=0 才通过。

### 6.5 Prompt 工程

针对小模型的特点，Prompt 设计遵循：

1. **约束优先**：用硬条件而非软引导（Prompt 引导 "tts.text ≤20 字"；ActionValidator 的强制上限见 §5.1，默认 30 字、关键阶段 60 字）
2. **决策树替代自由推理**：给 if-else 路径
3. **Few-shot 示例**：4 个覆盖典型场景（S6 按压位置、S3 呼吸不确定、S7 规则纠错、S7 情绪安抚）的完整输入-输出对

Token 预算：System Prompt ~1800 + DecisionFrame ~400 + 输出 ~120 = 总计 <2500 token，完全在 E2B 上下文窗口内。

---

## 7. 语音系统

离线语音基于 sherpa-onnx，实现全链路本地闭环。

### 7.1 技术栈


| 子系统       | 实现                        | 关键点                         |
| --------- | ------------------------- | --------------------------- |
| 批式 STT    | SenseVoice（sherpa-onnx）   | HTTP 录音回退路径                 |
| 流式 STT    | zipformer（sherpa-onnx）    | 端点检测尾随静音 0.8s；进程退出自动重连      |
| 批式/流式 TTS | VITS/MeloTTS（sherpa-onnx） | 分句边合边播；"120"读成"幺二零"         |
| TTS 缓存    | 预渲染 WAV                   | 标准急救话术预生成，命中即跳过实时合成，首包近 0ms |
| 意图解析      | regex + 拼音模糊 + Gemma NLU  | 优先规则；不确定/低置信才升级 Gemma       |


### 7.2 "确定性先行 + Gemma 异步增强"（ack_then_async）

这是低延迟语音陪跑的核心模式：

1. 用户提问 → 服务端立刻给出即时确认（"我在，按住别停，听我说。"），不等 Gemma
2. 异步调用 Gemma 生成答案
3. 若未被新输入打断，流式播报 Gemma 答案

CPR 高频纠错与任何 priority=critical 热路径永远不等 Gemma。

性能口径：关键语音路径 p95 < 1000ms，开放问答答复 p95 < 3000ms。

---

## 8. 视觉 CPR 识别

### 8.1 技术方案

CPR 按压质量识别基于 MediaPipe Pose：

```
摄像头帧 → MediaPipe PoseLandmarker → 肩/肘/腕/髋 landmarks → CprMetricsDeriver
        → cpr_quality { compression_rate, interruption_seconds, hand_position, arm_straight, quality_score }
```

关键参数：频率窗口 4000ms、目标 100-120 bpm、中断触发阈值 2s、手臂伸直阈值 155°。

### 8.2 诚实标注原则

- 只做运动学近似，不臆测深度：单目视觉不输出伪深度字段
- confidence < minConfidence 时不更新时序窗口，输出 null
- 只有真正的实时识别才标"实时识别"；脚本注入标"演示数据"；无感知模型的纯采集标"仅录制/采集"
- 就绪门控：要求 pose coverage 与 confidence ≥ 0.75、frame stability ≥ 0.7（三者同时满足才判定 vision_ready）

### 8.3 RuleFeedbackEngine 纠错优先级（实际实现）

仅在 S7_CPR_LOOP 阶段生效，自上而下扫描，命中第一个满足条件且不在冷却窗口内的反馈：


| 顺序  | 类型     | 触发条件                                           | 优先级      | 最小间隔 |
| --- | ------ | ---------------------------------------------- | -------- | ---- |
| 1   | 中断警告   | interruption_seconds ≥ 2                       | critical | 5s   |
| 2   | 手位偏移   | left / right / too_high / too_low / off_center | high     | 8s   |
| 3   | 频率偏慢   | < 100 BPM                                      | high     | 8s   |
| 4   | 频率偏快   | > 120 BPM                                      | high     | 8s   |
| 5   | 手臂弯曲   | arm_straight = false                           | high     | 8s   |
| 6   | 疲劳换手   | fatigue = high / exhausted                     | normal   | 15s  |
| 7   | AED 协助 | aed_available 或 aed_status = available         | normal   | 15s  |
| 8   | 鼓励     | encourage_tick（上层在连续无纠正时触发）                    | normal   | 20s  |


匹配规则：从上往下扫，命中第一个满足条件且已过冷却窗口的反馈，只发一条，确保施救者任何时刻只收到一条最重要的反馈。两个实现细节：

- **中断的例外**：若施救者仍在以可纠正的频率（<100 或 >120 BPM）持续按压，则把中断秒数视为过期，优先发频率纠正而非"不要停"。
- **情绪安抚不在本引擎**：施救者情绪的安抚由 Gemma 主动陪伴层负责（见 §6.3 (D)），不作为规则反馈项。

---

## 9. 交接报告系统

当急救人员到达（S9_HANDOVER），系统自动生成结构化交接报告（HandoverReport）：


| 字段       | 内容                          |
| -------- | --------------------------- |
| 事件时间线    | 发现时间、开始 CPR 时间、各阶段时间戳       |
| CPR 质量摘要 | 累计按压次数、平均频率、综合质量评分、中断次数和总时长 |
| 纠错事件     | 按时间排序的纠错记录                  |
| AED 状态   | 是否使用、电击次数                   |
| 施救者信息    | 是否有换人、疲劳状态                  |


报告生成由 Gemma 的叙述 Prompt（handover_narrative_system_prompt）将结构化数据转化为自然语言摘要。端侧四功能套件中的 handover 测试要求：逐字复述确定性报告，零编造/篡改数字。

---

## 10. 测试与质量保障

### 10.1 测试规模

test/ 下共 34 个测试文件，全部基于 Node.js 内置 node:test，可离线快速回归：


| 主题                      | 验证重点                                                  |
| ----------------------- | ----------------------------------------------------- |
| 状态机 / CPR 主流程 / Demo 回放 | S0-S9 推进、S6 准备门、S7 循环、S8 协助、S9 交接                     |
| 安全 Guard / 调度 / 紧急呼叫    | Tier-1 硬约束、禁忌话术拦截、critical 不被吞、Demo 不自动拨真 120         |
| Gemma 合约 / 决策边界         | patch 不越权改阶段/工具、autonomy vs restricted、NLU 缓存/预算/超时回退 |
| 语音 / STT / TTS / 开放问答   | 中文意图识别、流式 partial/final、ack 先行、120→幺二零、缓存防漂移          |
| 流式会话 / WS / 背压 / 指标     | 事件顺序、STT 重连降级、barge-in、背压丢音频不丢控制帧                     |
| 视觉 CPR / 交接报告           | 频率/中断/手位/肘角、低可见度 gating、叙述数字不可编造                      |


### 10.2 Mock 与真实资源边界

默认测试用 mock 保证离线快速；真实就绪由专门命令把关：

- `verify:local:strict`：缺 Gemma/语音资源直接失败
- `verify:gemma`：验证 Gemma 推理链路
- 端侧四功能套件：真机 + 真实 Gemma + 生产 prompt
- `accept:vivo-voice`：真机 vivo 两轮语音验收

---

## 11. 创新点总结

1. **规则掌舵 + AI 说话**：医疗流程决策权属于可审核状态机，Gemma 只负责话术与理解。这不是"规则 vs AI"的取舍，而是精确划分了"哪些事该让 AI 做、哪些事不该"，让产品同时做到可信 + 好用 + 安全。
2. **双循环分离**：高频 CPR 纠错绕过 LLM，规则 ~500ms 即时反馈；Gemma ~1.5s 只处理低频场景（5-30 秒一次）。Gemma 是增强驱动而非单点故障。
3. **确定性先行 + 异步增强（ack_then_async）**：关键指令立刻播报，AI 答复随后补充。用户永远不会感到"AI 在思考中请等待"。
4. **三层安全防护**：ActionValidator 硬校验 + guidanceArbitration 决策权仲裁 + EdgeGuidanceGuard 端侧守卫。三道关卡确保即使 Gemma 输出异常，系统行为仍然安全可预测。
5. **端侧全栈闭环**：从视觉检测、语音交互、LLM 推理到动作执行，全部在手机本地完成。越是"救护车来不及、信号还不好"的地方越能用。
6. **诚实标注**：不编造数据、不虚报能力。单目视觉不输出伪深度、低置信不当作高置信、Demo 数据不冒充实时识别——这是医疗场景产品最基本的诚意。

---

## 12. 技术栈


| 层           | 技术                                                                   |
| ----------- | -------------------------------------------------------------------- |
| 端侧 LLM      | Gemma 4 E2B · LiteRT-LM 运行时 · 2/4/8-bit 混合量化                         |
| 离线语音        | sherpa-onnx（SenseVoice STT · zipformer 流式 STT · VITS/MeloTTS TTS）    |
| 端侧视觉        | MediaPipe PoseLandmarker · TFLite TextEmbedder                       |
| Agent Core  | Node.js ≥ 20（纯 ESM，零运行时依赖）· node:test                                |
| Android     | Kotlin · Jetpack Compose · MVVM · Coroutine/StateFlow · CameraX      |
| Android SDK | compileSdk 35, minSdk 26, targetSdk 35, AGP 8.7.3, Kotlin 2.0.21     |
| 协议          | PerceptionEvent / SessionState / GuidanceAction（Node 与 Android 共享契约） |
| 测试          | 34 个 node:test 文件 + Android JVM 单元测试 + 端侧四功能套件 + 真机验收                |


---

## 13. 局限性与未来方向

**当前局限：**

- 视觉 CPR 质量评估依赖摄像头角度和光线条件，极端环境下精度下降
- 单目视觉无法检测按压深度（需加速度计辅助）
- E2B 模型对复杂多轮对话能力有限（通过 DecisionFrame 的 facts 间接传递上下文）
- 当前仅覆盖成人疑似心脏骤停 CPR（MVP 范围）
- 节拍器用 AudioTrack 实现，不是真正的触觉反馈

**未来规划：**

- 支持 WearOS 手表加速度计数据融合（提升按压深度检测精度）
- 英文版本支持（Gemma 4 多语言能力强，主要工作在 Prompt + TTS 替换）
- AED 到达时的电极片贴附引导
- 儿童/婴儿 CPR 场景扩展
- 多施救者协作引导
- 正式投放前的医学/合规负责人复核

