# FirstAid Copilot — 三方向优化与开发计划

> 基线快照（2026-06-04）：单元测试 **153/153 通过**；本地模型就绪（Gemma `gemma-4-E2B-it.litertlm` 2.41GB、sherpa STT/TTS）；诊断 smoke 全过（`S2 → S3`，`ask_breathing_check`）。`voice server` 已重启到最新代码，`/api/health` 暴露 `live_ws_path: /ws/live`，NLU 解析层已接入。
>
> 本计划在以下三个方向 plan 之上做"落地与加固"：
> - Streaming Low-Latency Voice（流式低延迟语音）— 代码完成、已接入
> - Hybrid NLU Diagnosis（混合意图解析诊断）— **已落地**：默认开启 + 异步纠正下一轮（`.env` `INTENT_NLU=on` / `GEMMA_NLU_ASYNC=1`，不阻塞回合；并修复 Live 下意图解析 stage 恒为 `S1` 的 bug）
> - Real Vision Perception MVP（视觉感知）— 仅规划、尚无代码

---

## 优先级总览

| 编号 | 工作项 | 重要性 | 风险/成本 | 状态 |
| --- | --- | --- | --- | --- |
| P0-A | NLU 延迟瓶颈：让 `INTENT_NLU` 升级真正生效 | 高（决定该方向成败） | 中-高（可能涉及模型方案/下载） | 部分落地（异步纠正 + Live stage 修复已上线） |
| P0-B | Streaming 医疗安全：final 复核 + barge-in 鲁棒 + STT 自愈 | 高（安全相关） | 中 | 部分落地（barge-in / 断句 VAD 已上线） |
| P1 | Vision 起步：`cprMetrics.js` 纯算法库 + 单测 | 中（解锁整个视觉方向） | 低（独立、可即时验证） | 待启动 |
| P2 | 可观测性与增强：度量、缓存、异步润色、背压 | 中-低 | 低-中 | 待启动 |

**重要性≠执行顺序**：P1 风险最低、可立即产出可验证成果，适合作为"逐项执行"的破冰第一步；P0-A 在动手前需要先做一次延迟实测以确定方案。建议执行顺序见文末第 6 节。

---

## P0-A　NLU 延迟瓶颈

### 问题
当前 `GEMMA_NLU_TIMEOUT_MS` 默认 **600ms**，而本地是 2.4GB CPU Gemma，单次推理远超该值。即使开启 `INTENT_NLU`，模糊语料也几乎**永远 timeout 回退正则**（实测"他好像没气了"`intent_ms=0`、未升级），Hybrid NLU 方向等于"挂着但不生效"。

### 方案 / 改动
1. **先实测基线**：开 `INTENT_NLU=on` + 临时放宽 `GEMMA_NLU_TIMEOUT_MS=30000`，对一组模糊语料实测单次 NLU 真实耗时（p50/p95），作为后续决策依据。
2. **降低单次延迟**（按实测择一/组合）：
   - 常驻 `serve` 预热与会话复用（`src/gemma/runtime.js` 已有 serve/超时概念，确认是否真正复用进程而非每次冷启）。
   - 评估更小/量化的 NLU 专用模型（NLU 只需闭集槽位抽取，远比通用对话简单，可用更小模型）。
   - 可选 GPU/加速后端。
3. **结果缓存**：`transcript → NLU 结果` 短期 LRU 缓存，避免相同模糊句重复推理。
4. **升级节流/预算**：每会话/每分钟 NLU 调用上限，防止 S1–S6 频繁 miss 打爆 CPU。
5. **延迟兜底策略**（**已落地**）：若实测仍偏慢，落地"先按正则回退即时追问，Gemma 异步纠正下一轮"的降级路径，保证回合不被阻塞（`GEMMA_NLU_ASYNC=1`；并修复 Live 下意图解析 stage 恒为 `S1` 的 bug）。

### 验收标准
- 实测：`INTENT_NLU=on` 下，S3 输入"他好像没气了" → `intent_resolution.source=gemma_nlu`、解析出 `no_normal_breathing`（`normal_breathing.value=false`）。
- 单回合端到端延迟（含 NLU）p95 ≤ **1.5s**（S1–S6 回合式场景）。
- 在样例模糊语料集上 NLU 回退率 < **50%**。
- 既有 `node --test` 153 项 + `hybrid-nlu` 测试全部仍通过。

### 风险与回退
CPU 上 Gemma 可能仍偏慢 → 接受"异步纠正下一轮"降级；`INTENT_NLU=off` 始终可一键回退到纯正则现状。

---

## P0-B　Streaming 医疗安全

### 问题
1. **barge-in 无声学回声消除**：播报时麦克风输入被整体当回声丢弃，打断完全依赖客户端能量检测主动发 `barge_in`（见 `src/voice/liveSession.js` 第 95–108 行）；嘈杂/外放环境下可能打断失败或误打断。
2. **流式 zipformer 无 final 复核**：医疗关键词（"有/没有呼吸"）误识别可能误推流程（原 plan 第 8 节列了 SenseVoice 复核但未实现）。
3. **流式 STT 进程退出后不自动重连**，只降级 buffered，长会话延迟劣化（`liveSession.js` `onSttFinal`/`exit` 路径）。

### 方案 / 改动
1. **final 复核**：对流式 `final` 中命中关键否定/呼吸词的结果，触发一次 SenseVoice 离线复核纠偏（仅对关键 final，不进高频热路径）。
2. **barge-in 鲁棒性**（**部分落地**）：客户端 VAD 已改为"更高打断阈值（`bargeInMinRms≈0.08`）+ 持续约 320ms"防误打断，断句静音窗放宽到 1200ms 并加"整段≥250ms 真实语音"门控；服务端能量门控双保险与协议时延契约文档化待续。
3. **STT 自愈**：`sttSession` `exit` 后尝试重启流式 STT，超过 N 次再降级 buffered，并发 `state` 事件告知客户端。

### 验收标准
- 构造含噪/边界词音频样例，final 复核对关键词（有/没有呼吸）误判可量化下降。
- 测试：STT 子进程被杀后，下一个 turn 能自动恢复 `stt_mode=streaming`。
- 测试：播报中收到 `barge_in` → 200ms 内停播并 flush（在现有 `cancelSpeech` 基础上补测）。
- 不破坏既有 `voice-live-streaming` 与 `streaming-stt` 测试。

### 风险与回退
SenseVoice 复核增加延迟 → 仅对关键 final 触发；`/api/turn` 半双工路径与现有按钮始终可作回退。

---

## P1　Vision 起步：cprMetrics 纯算法库

### 问题
三方向中唯一尚无代码者（`src/vision/` 为空，`src/index.js` 无 vision 导出）。

### 方案 / 改动
- 新建 `src/vision/cprMetrics.js`：输入关键关节点（手腕/肘/肩/髋），输出 `compression_rate / interruption_seconds / hand_position / arm_straight / quality_score / confidence`，作为 Web 与 Android 共享的 SSOT。
- 在 `src/index.js` 导出；新增对应单测。
- 输出严格对齐现有 `cpr_quality` PerceptionEvent 契约（`ruleFeedbackEngine`/`sessionReducer` 已消费这些字段，后端零改动）。

### 验收标准
- 单测：合成正弦 110bpm → `compression_rate ∈ [105,115]`；振幅骤降 → `interruption_seconds` 累计、恢复清零；手腕 X 偏移 → `hand_position` 判 left/right；肘角 < ~155° → `arm_straight=false`；低可见度 → 对应字段输出 `null`（不臆测）。
- `node --test` 全绿，且不破坏现有 153 项。

### 风险与回退
算法参数需真实数据标定 → 先用合成信号建立可验证基线，后续用录制视频校准；不测按压深度（单目无尺度，原 plan 已诚实声明）。

---

## P2　可观测性与增强（随 P0/P1 推进）

- NLU/STT 命中率、回退率、延迟分布的结构化日志，为调优提供数据。
- Gemma 异步润色下一轮非关键话术（原 Streaming plan 架构图有、尚未落地）。
- 慢客户端的 WS 写背压控制（弱网音频堆积）。

---

## 6. 建议执行顺序与里程碑

1. **里程碑 M1（破冰，低风险）**：P1 `cprMetrics.js` + 单测落地并全绿。解锁 Vision 方向，且不触碰现有链路。
2. **里程碑 M2（实测定方案）**：P0-A 第 1 步——开 `INTENT_NLU` + 放宽超时，实测真实 NLU 延迟，据此选定降延迟方案。
3. **里程碑 M3（NLU 落地）**：按 M2 结论实施 P0-A 降延迟 + 缓存 + 节流，达成验收。
4. **里程碑 M4（语音加固）**：P0-B STT 自愈 + barge-in 协议 + final 复核。
5. **里程碑 M5（增强）**：P2 度量与背压。

> 每个里程碑完成后跑 `node --test` 与 `npm run verify:local` 做回归基线校验。
