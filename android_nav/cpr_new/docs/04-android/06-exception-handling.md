# 06 · 异常兜底（演示高风险点）

对应分工表第 4 部分职责：**处理断网、权限未开、识别失败、模型加载慢等演示高风险点**。
核心原则：**任何异常都降级为可见提示，绝不崩溃、不中断主流程**。

---

## 统一机制

ViewModel 提供 `raiseIncident(message)`：把异常转成 `CprSessionState.incidentBanner`，
UI 用黄色横幅展示，用户点击即可关闭（`dismissIncident()`）。
所有数据流 `collect` 均被 `runCatching{}.onFailure{ raiseIncident(...) }` 包裹。

---

## 风险点清单

| 风险点 | 触发 | 兜底表现 |
| --- | --- | --- |
| **模型加载慢** | `agent.isReady` / `perceptionSource.isReady` 为 false | 阶段标签后显示「指导引擎加载中…／识别启动中…」 |
| **识别置信度低** | `PerceptionEvent.confidence < 0.5` | 横幅提示「调整手机角度」，该帧不喂 Agent、不刷新质量分 |
| **感知流中断** | 感知 `collect` 抛错 | 横幅「感知数据中断，请检查摄像头/光线」 |
| **Agent 异常** | guidance 流抛错 | 横幅「指导引擎异常，已切换到基础节拍模式」，节拍器仍在跑 |
| **首条指导慢** | `onSessionStart()` 抛错/超时 | 横幅「指导引擎加载较慢，请稍候…」 |
| **无麦克风权限** | `recorder.start()` 返回 null | 记一条 INCIDENT 日志，不录音，流程继续 |
| **无定位权限/无信号** | `location` 返回 null | 报告无定位，记 INCIDENT |
| **拨号失败** | `dialer.dial()` 返回 false | 横幅「无法唤起拨号，请手动拨打 120」 |
| **断网** | — | 全链路离线设计（Mock/端侧模型 + framework API），断网不影响核心流程 |
| **无对应硬件** | 无马达/麦克风/摄像头 | 各控制器能力检测后静默降级 |
| **报告生成失败** | `buildHandover()` 抛错 | 横幅「可凭录音/日志人工交接」 |

---

## 降级哲学

- **能力检测优先**：每个硬件控制器先查能力，没有就静默，不报错打扰用户。
- **主流程不可阻断**：定位、录音、报告等“增强项”失败都只记日志，不影响按压指导。
- **离线第一**：默认 Mock + framework 原生 API，无任何网络依赖，符合“离线运行”原则。
- **资源安全**：`onCleared()` 兜底释放 TTS/录音/震动/感知，防止泄漏。
