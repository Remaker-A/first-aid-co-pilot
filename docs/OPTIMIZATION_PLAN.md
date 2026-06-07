# FirstAid Copilot — 三方向优化与开发计划

> 基线快照（2026-06-04）：单元测试 **153/153 通过**；本地模型就绪（Gemma `gemma-4-E2B-it.litertlm` 2.41GB、sherpa STT/TTS）；诊断 smoke 全过（`S2 → S3`，`ask_breathing_check`）。`voice server` 已重启到最新代码，`/api/health` 暴露 `live_ws_path: /ws/live`，NLU 解析层已接入。
>
> 本计划在以下三个方向 plan 之上做"落地与加固"：
> - Streaming Low-Latency Voice（流式低延迟语音）— 代码完成、已接入
> - Hybrid NLU Diagnosis（混合意图解析诊断）— **已落地**：默认开启 + 异步纠正下一轮（`.env` `INTENT_NLU=on` / `GEMMA_NLU_ASYNC=1`，不阻塞回合；并修复 Live 下意图解析 stage 恒为 `S1` 的 bug）
> - Real Vision Perception MVP（视觉感知）— 仅规划、尚无代码

---

## 进展更新（2026-06-06）

> 单元测试 **355/355 通过**（基线 153 → 329 → 355）。本轮把 P0-B/P2 的"已写好但未接入生产链路"的安全/可观测骨架完成"最后一公里"，全部**默认 OFF、`.env` 显式开启**，默认事件契约与延迟字节不变。

- **P0-B STT final 复核（接入 + 加固 + 度量）**：`liveSessionEnv.js` 把 `STT_FINAL_REVIEW` 等开关从 `.env` 注入 WS 会话（`server.js`）；`liveSession.js` 新增 `breathingPolarity()`，把复核从"整句不同就替换"升级为可审计的 **"有呼吸↔没有呼吸"极性反转**判定（`没/无/不` 负向断言防误判）；每轮 `metrics` 事件新增 `review` 段（triggered/corrected/polarity_flip）。异构纠偏成立：流式 zipformer ↔ 复核用 SenseVoice。
- **P0-B barge-in 兜底接入**：服务端能量门控 `VOICE_BARGE_IN_ENERGY_GATE`（+ RMS/时长调参项）可经 `.env` 启用为客户端 VAD 的双保险。
- **P2 可观测性**：新增 `metricsAggregator.js` + **`GET /api/metrics`**，聚合延迟 p50/p95、TTS 缓存命中率、intent 回退分布、gemma skip/stale、复核纠偏计数。
- **P2 背压**：`MiniWebSocketConnection.sendBinary` 改为"有损背压"——音频帧在 socket 积压超 1MB 时丢弃并计数，控制/状态 JSON 帧永不丢，弱网不再堆爆内存。
- 启用方式见根目录 `.env.example`（本轮新增的完整模板）。

### 端侧 Gemma 扩能层（C/D/E，全部 on-device）

> 让端侧 Gemma 真正进入实时会话并在 Node 服务端不可达时离线增强；医疗流程决策权仍归服务端状态机。组件 `EdgeGemmaAgent` 实现三项产品功能：（E）NLU 意图/观察事实兜底、（C）受控开放问答、（D）主动话术润色。

- **不可逾越的红线**：端侧 Gemma 永不切 stage、不发起工具调用、不做诊断、CPR 进行中绝不让施救者停下按压；CPR 高频纠错与 `critical` 动作的热路径**绝不**等待 Gemma。
- **核心模式**：确定性先行 + Gemma 异步增强（`ack_then_async`）——先出确定性结果，模型答复只增强**下一轮**。
- **单驱动调度**：独占唯一 `OnDeviceGemmaDriver`（`generate()` 是 `Mutex`），内部优先级队列保证 NLU（E）/开放问答（C）优先于主动润色（D），低优请求不会饿死交互请求。全部 flag-gated、默认 OFF，接线即默认行为不变。
- **安全校验**：一切端侧输出先过 `GemmaSuiteAsserts`（benchmark grader 升级为生产 guard，**逻辑不变**），命中禁词/停止按压词/超长/越权 intent/NLU 越权键（如泄漏 `stage`、`suspected_cardiac_arrest`）/不可解析即拒绝并回退确定性模板。
- **延迟门（复用 `gemmaLatencyGate`）**：NLU 近实时门 `GEMMA_NEAR_REALTIME_GATE_MS=1200ms`、单次预算 `GEMMA_GENERATE_BUDGET_MS=1500ms`，超门即 `ack_then_async`（正则即时、Gemma 下一轮纠正）；开放问答即时确定性 ack + 异步答复 **p95 < 3000ms**（与 Vivo 实机验收同门）。
- **Phase 4 测试与文档**：新增 JVM 单测 `EdgeGuardContractTest`（禁词 / 停止按压词 / 超长 / 越权 intent + NLU 安全红线，按 S7 CPR-loop 与呼吸观测场景取例）与 `EdgeGemmaLatencyAcceptanceTest`（NLU / 开放问答 p50/p95，复用 `gemmaLatencyGate` / `LatencyStats`）；guard 的完整评分契约另由既有 `GemmaFunctionSuiteTest` 覆盖（与生产 guard 同一 SSOT）。测试均为纯 JVM（`org.json` + `kotlinx-coroutines-test`），不依赖设备或真实模型。

---

## 优先级总览

| 编号 | 工作项 | 重要性 | 风险/成本 | 状态 |
| --- | --- | --- | --- | --- |
| P0-A | NLU 延迟瓶颈：让 `INTENT_NLU` 升级真正生效 | 高（决定该方向成败） | 中-高（可能涉及模型方案/下载） | 部分落地（异步纠正 + Live stage 修复已上线） |
| P0-B | Streaming 医疗安全：final 复核 + barge-in 鲁棒 + STT 自愈 | 高（安全相关） | 中 | 已落地（final 复核接入+极性消歧+度量、能量门控兜底接入、STT 自愈；默认 OFF/`.env` 开启） |
| P1 | Vision 起步：`cprMetrics.js` 纯算法库 + 单测 | 中（解锁整个视觉方向） | 低（独立、可即时验证） | 待启动 |
| P2 | 可观测性与增强：度量、缓存、异步润色、背压 | 中-低 | 低-中 | 部分落地（per-turn `metrics` + `/api/metrics` 聚合 + WS 写背压；异步润色待续） |

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
