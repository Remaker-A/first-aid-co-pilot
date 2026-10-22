# 技术决策日志

只记录影响长期维护的决策；保留被替代的历史记录。

## 2026-08-06 — Practice Copilot 与 Emergency Copilot 隔离

- 状态：已接受
- 背景：项目需要把重点扩展到多模态情境教学，但产品仍定位为 Copilot，而不是教育平台。
- 技术决策：使用独立 Training domain、session state、rule engine 和 Android Activity；禁止训练路径初始化 Emergency session 或调用真实工具。
- 选择方案：第一阶段在 `android/` 新增独立 `FirstAid Practice` 启动入口，完成一个成人倒地到 CPR 的垂直场景。
- 原因：以最小影响复用 Android 技术栈，同时保持现有 Emergency 安全架构不变。
- 放弃方案：直接在 Emergency 状态机中加入训练分支；在首页先进行大规模导航重构；让 Gemma 自由生成场景和评分。
- 影响与风险：桌面会出现两个启动入口；后续需要统一视觉与品牌入口。训练规则与 Emergency 规则应通过 conformance tests 防止知识漂移。
- 相关文件：`android/app/src/main/AndroidManifest.xml`、`android/app/src/main/java/com/firstaid/copilot/training/`

## 2026-08-06 — 训练评价由确定性规则引擎拥有

- 状态：已接受
- 背景：训练允许用户自由表达和多模态输入，但医学步骤的正确性必须稳定、可审核和可测试。
- 技术决策：语音、视觉和触控只产生带来源与置信度的 `TrainingObservation`；`TrainingRuleEngine` 独占场景推进与评价权。
- 选择方案：Gemma 后续只能映射封闭动作候选或解释既有 `TrainingEvaluation`。
- 原因：保持“Rule Engine 决策，Gemma 增强交互”的项目原则。
- 放弃方案：用 prompt 让 Gemma直接给分或决定下一场景节点。
- 影响与风险：新增场景必须显式编写和审查规则；内容扩展速度较慢，但结果可复现、可审计。
- 相关文件：`android/app/src/main/java/com/firstaid/copilot/training/domain/TrainingModels.kt`、`android/app/src/main/java/com/firstaid/copilot/training/engine/TrainingRuleEngine.kt`

## 2026-08-06 — 情境演练采用作答后教学反馈

- 状态：已接受
- 背景：训练选项若在提交前使用绿色边框标出正确项，会直接泄露答案；只让用户选答案又不足以完成现场教学。
- 产品决策：先让用户在视觉中性的选项中判断下一步，提交后再由规则结果说明正确做法与原因；触控入口命名为“点击选项”。
- 原因：同时保留现场判断感和明确教学价值，并保证评价结果可复现、可审核。
- 放弃方案：提交前突出推荐答案；只展示操作说明而不让用户判断；由 LLM 自由决定反馈。
- 影响与风险：所有新增场景都必须为错误选择提供具体纠正说明，并避免通过颜色、顺序或图标暗示正确项。
- 相关文件：`prototypes/practice-copilot/index.html`、`prototypes/practice-copilot/app.js`、`prototypes/practice-copilot/styles.css`

## 2026-08-06 — 多场景教学由可组合节点构成

- 状态：已接受
- 背景：Practice Copilot 需要扩展多个急救情境，但不能变成以课程和题库为中心的教育平台，也不能为每个场景复制一套页面逻辑。
- 产品与技术决策：场景由示范、情境判断、语音练习、视觉练习和复盘节点组合；答题只是判断类节点，动作类能力优先使用视觉，现场组织能力优先使用语音。
- 原因：保持现场 Copilot 定位，同时让新增场景能够复用统一交互与规则反馈边界。
- 放弃方案：每个场景独立硬编码页面；只增加静态教程卡片；让 LLM 动态生成场景步骤和评分。
- 影响与风险：场景扩展更一致，但每个节点的医学内容、推进条件和纠正话术都必须经过显式审核；当前气道异物梗阻和严重出血仅为产品原型内容。
- 相关文件：`prototypes/practice-copilot/app.js`、`prototypes/practice-copilot/index.html`

## 2026-08-06 — 首次使用教程强调使用方式与安全边界

- 状态：已接受
- 背景：新用户无法仅凭首页理解语音、视觉、点击三种输入的分工，也容易混淆训练模式和真实急救模式。
- 产品决策：首次进入展示四步可跳过引导，并在首页保留“使用指南”入口；内容只解释如何发挥 Copilot 价值和安全边界，不设计课程等级或学习打卡。
- 原因：降低多模态操作门槛，同时强化“Human is Pilot”和训练/真实急救隔离。
- 放弃方案：永久占用首页的大段使用说明；强制不可跳过教程；把引导做成课程章节。
- 影响与风险：客户端迁移时需要实现本地首次使用状态，并确保用户可以随时重新打开教程。
- 相关文件：`prototypes/practice-copilot/index.html`、`prototypes/practice-copilot/app.js`

## 2026-08-12 — 引导练习与情境挑战共享规则数据

- 状态：已接受
- 背景：新用户需要示范和即时纠正，熟练用户需要更接近现场的无提示练习，但复制场景会产生医学规则漂移。
- 产品与技术决策：同一场景节点同时服务两种模式；引导模式执行全部节点并即时反馈，挑战模式只过滤示范节点、延迟披露评价，并在结尾集中复盘。
- 原因：保持单一规则来源，同时满足学习和能力检验两种使用意图。
- 放弃方案：为挑战模式复制独立场景；使用 LLM 动态决定是否提示；用排行榜和竞争分数作为主要反馈。
- 影响与风险：挑战模式必须记录每次确定性评价，且任何中途提示都不得泄露对错；模拟语音和视觉目前只能验证产品流程，不能代表真实识别准确率。
- 相关文件：`prototypes/practice-copilot/app.js`、`prototypes/practice-copilot/index.html`、`prototypes/practice-copilot/styles.css`
