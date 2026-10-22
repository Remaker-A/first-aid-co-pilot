# 项目上下文

> 最后更新：2026-10-22

## 本次迁入（2026-10-22）

- 目标仓库：`Remaker-A/first-aid-co-pilot`，分支 `codex/practice-copilot-training`，基于 `main` 的 `0e67132c7b4abaa21dd7ee185d6f0aaa6803650c`。
- 功能来源：`17-chen/first-aid-co-pilot` 的 `69ef7f30db5807baaa401969cf4ad2e64a9adc99`。
- 保留原急救源码、测试、知识库、提示词与依赖配置；现有 Android 清单只新增独立训练 Activity，原启动入口和配置保留。
- 保留目标仓库已有的 Android 离线功能与 iOS 公开状态说明。`main` 和现有 Release APK 不因本分支变化。
- 本次验证：Node 回归 393/393 通过；17 个训练和原型文件与来源逐字节一致；Android 清单原有配置结构一致；Web 三个场景到复盘、错误重试、挑战延迟反馈通过。
- Android 构建与真机状态见 `CHANGELOG.md` 的本次迁入记录。下文 2026-08-06 的构建结果为来源分支的历史记录，不代表本机重新验证。

## 项目基本信息

- 项目名称：FirstAid Copilot
- 项目目标：构建基于 Gemma 4 的端侧多模态急救现场协作与情境演练 Copilot。
- 目标用户：需要急救现场指导或希望通过情境演练形成急救操作能力的普通用户。

## 产品愿景

- 产品是 Emergency Copilot + Practice Copilot，不是医疗问答机器人、AI 医生或课程平台。
- Human is Pilot，AI is Copilot；用户执行动作，系统观察、指导、纠正和记录。

## 技术架构

- 语言：JavaScript、Kotlin、Python、PowerShell。
- Android：Kotlin、Jetpack Compose、CameraX、MediaPipe、sherpa-onnx、LiteRT-LM。
- Agent Core：Node.js，包含状态机、规则反馈、Gemma 增强、语音服务和交接报告。
- AI 模型：端侧 Gemma 4 E2B；模型只负责理解、表达与交互增强。
- 数据：本地会话状态、日志、知识 JSON 和模型资源，无数据库依赖。

## 当前状态

- 已完成：成人疑似心脏骤停 Emergency MVP、安全仲裁、语音、CPR 视觉检测和交接报告。
- 已完成：Practice Copilot 成人倒地到 CPR 的第一版触控演练规则闭环与独立 Android 入口。
- 已完成：独立可本地预览的 Practice Copilot 手机 Web 原型，覆盖首次使用教程、三个场景、可组合教学节点、“引导练习 / 情境挑战”双模式、多模态输入状态与场景复盘。
- 进行中：把原型确认后的 UI 迁移到 Android，并接入真实语音输入、视觉动作反馈和受控 Gemma 解释。
- 计划：在同一训练框架上扩展场景，同时保持各场景规则可审核。

## 重要设计决策

- Emergency 与 Practice 使用独立 session/domain/entry；Practice 不得调用真实紧急工具。
- Rule Engine 决定医疗流程、训练评价和场景推进；Gemma 不得修改这些结果。
- 情境演练在提交前不通过颜色、顺序或图标泄露正确项，提交后再解释规则结果与正确做法。
- 多场景教学采用“示范—练习—纠正—复盘”节点结构，答题只承担判断类训练。
- 引导与挑战模式共享单一场景和规则数据；挑战模式只改变提示、示范和反馈时机。
- Android `android/` 是当前主客户端；Apple 端需要服从相同协议和规则版本。

## 约束条件

- 不允许 LLM 修改 stage、CPR start decision、医疗事实、priority 或 tool action。
- CPR 高频纠错不得等待 LLM。
- 不为增加功能破坏现有 State Machine、ActionValidator、GuidanceAction 与仲裁架构。

## 已知问题

- Node 与多个 Android 目录存在规则/协议漂移风险，需要跨端 golden conformance tests。
- Practice 首版暂时只有触控输入，尚未形成完整多模态演练。
- Web 原型中的语音与摄像头是体验模拟，尚未读取真实麦克风或摄像头数据。
- 气道异物梗阻和严重出血当前属于产品交互原型内容，迁移到生产客户端前需要专业医疗审核。
- 当前只完成 JVM 与 Debug 构建验证，尚未在真机执行 Practice 入口的 UI/可用性验收。

## 下一步任务

- [x] 使用 JDK 17、Gradle 8.9 和 Android API 35 运行 `testDebugUnitTest` 与 `assembleDebug`（290/290，2026-08-06）。
- [ ] 在 Android 真机安装 Debug APK 并验收独立 Practice 入口。
- [ ] 确认 `prototypes/practice-copilot/` 的产品 UI 后迁移到 Compose。
- [ ] 为 Practice 接入封闭意图语音适配器，仍由 TrainingRuleEngine 评分。
- [ ] 复用现有 CPR 视觉指标，为训练动作生成带置信度的 observation。
- [ ] 接入只解释规则结果的 Gemma feedback layer。

## 证据来源

- `README.md`
- `PRODUCT_REVIEW.md`
- `IMPLEMENTATION_PLAN_v0.2.md`
- `src/engine/`
- `android/app/src/main/java/com/firstaid/copilot/training/`
- `test/` 与 `android/app/src/test/`
