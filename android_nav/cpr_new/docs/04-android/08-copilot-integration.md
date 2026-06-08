# 08 · first-aid-co-pilot Node Agent 联调指南

`cpr_new` 通过 HTTP + WebSocket 承接 `first-aid-co-pilot` 的 Node voice server，**不**在 Android 内跑 JS/Kotlin Agent 核心。

## 架构

```text
cpr_new (Kotlin APK)
  ├─ HTTP  POST /api/turn     回合：启动、按钮、感知、交接
  └─ WS    /ws/live           流式 guidance + 服务端 TTS PCM

first-aid-co-pilot (Node.js)
  └─ npm run voice:serve :8787
```

医疗流程在 Node 状态机；Android 只执行 `GuidanceAction`（UI / TTS / 音频节拍 / 拨号）。

## 切换后端

`core/di/ServiceLocator.kt`：

```kotlin
var agentBackend = AgentBackend.REMOTE_COPILOT  // 联调 Node
// var agentBackend = AgentBackend.MOCK          // 离线演示
```

## 地址配置

`app/build.gradle.kts` → `BuildConfig`：

| 环境 | COPILOT_BASE_URL | COPILOT_WS_URL |
|------|------------------|----------------|
| 模拟器 | `http://10.0.2.2:8787` | `ws://10.0.2.2:8787/ws/live` |
| 真机 + adb reverse | `http://127.0.0.1:8787` | `ws://127.0.0.1:8787/ws/live` |

真机：

```powershell
adb reverse tcp:8787 tcp:8787
```

## 联调步骤

1. 启动 Node：

```powershell
cd C:\Users\Liam\AndroidStudioProjects\first-aid-co-pilot
npm run voice:serve
```

2. 确认健康：`http://127.0.0.1:8787/api/health` → `"ok": true`

3. 安装并运行 `cpr_new`：

```powershell
cd C:\Users\Liam\AndroidStudioProjects\cpr_new
.\gradlew.bat :app:installDebug
```

4. App 内流程：
   - **开始急救** → `session_started` → S1 话术
   - 点 **Agent 主按钮** 或底部 **快捷回复** → 推进 S2/S3/…
   - 进入 S7 后 Mock 感知每 2s 上报 `cpr_quality_update`
   - Agent 下发节拍 → **AudioMetronome**（AudioTrack click，非震动）
   - **结束** → 交接报告

## 关键代码路径

| 模块 | 路径 |
|------|------|
| HTTP 传输 | `agent/copilot/HttpAgentTransport.kt` |
| WebSocket | `agent/copilot/WebSocketAgentChannel.kt` |
| Agent 实现 | `agent/copilot/RemoteGuidanceAgent.kt` |
| 动作映射 | `agent/copilot/CopilotActionMapper.kt` |
| 音频节拍 | `hardware/audio/AudioMetronomeController.kt` |
| 服务端 TTS | `hardware/audio/LiveAudioPlayer.kt` |
| 会话编排 | `feature/session/CprSessionViewModel.kt` |

## 离线兜底

- 完全连不上：提示运行 `npm run voice:serve`
- S7/S8 中途断连：显示「继续按压」，本地 110bpm 音频节拍保持（`offline=partial`）

## 语音半双工（已实现）

- `LiveAudioCapture`：16kHz PCM → WS 二进制帧
- 播报期间暂停采集；支持 `barge_in` 打断
- HTTP 回合返回的 `tts.audio.url` / `data_url` 由 `TurnTtsPlayer` 播放
- WS 流式 TTS 仍走 `LiveAudioPlayer`

## 尚未实现

- 分享/删除确认门控
- 端侧嵌入 STT/TTS（完全离线）
