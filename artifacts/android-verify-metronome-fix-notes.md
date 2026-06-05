# android-verify — 节拍器"听不到"根因与修复说明

## 根因（已用 adb 坐实）
节拍器 `AudioTrack` 的 `AudioAttributes.usage = USAGE_ASSISTANCE_SONIFICATION`，在该 vivo V2318A(Android 13) 上映射到 **STREAM_SYSTEM(1)**。
手机当前处于**静音铃声模式**（`settings get global mode_ringer = 0` / SILENT），`dumpsys audio` 显示：

- `ringer mode muted streams = 0xa6 (STREAM_SYSTEM, STREAM_RING, STREAM_NOTIFICATION, STREAM_SYSTEM_ENFORCED)`
- `- STREAM_SYSTEM: Muted: true, streamVolume:0`
- `- STREAM_MUSIC: Muted: false, streamVolume:14/15`（TTS 在这条，不受静音影响）
- 本 App 轨道：`piid:415 type:android.media.AudioTrack u/pid:10299/22584 state:started usage=USAGE_ASSISTANCE_SONIFICATION`
- `ducked players` / `faded out players` 均为空 → 不是 ducking 常驻

结论：轨道在播、在写 PCM、音量初值 1.0、click 振幅正常（CLICK_GAIN=0.6），但**所在的 STREAM_SYSTEM 被静音模式 force-mute 成 0 → 完全听不到**。这对一个必须被听到的 CPR 节拍是设计缺陷。

排除项：click buffer 非空且振幅足够；MODE_STREAM 循环持续 write（logcat 无 underrun/write 失败/track stop）；`setVolume` 初值=FULL_VOLUME(1.0)；未发生 `setDucked(true)` 常驻；usage→stream 映射才是问题。

## 修复（最小代码改动）
文件：`android/app/src/main/java/com/firstaid/copilot/live/audio/MetronomeController.kt`
- `AudioTrackMetronome.buildTrack()`：`setUsage(USAGE_ASSISTANCE_SONIFICATION)` → **`setUsage(USAGE_MEDIA)`**（保留 `CONTENT_TYPE_SONIFICATION`）。
- 同步更新该处 KDoc，说明改用 STREAM_MUSIC 的原因。
- 理由：`USAGE_MEDIA` → STREAM_MUSIC，**不被静音铃声模式静音**（静音只压 SYSTEM/RING/NOTIFICATION），CPR 节拍因此在静音/振动模式下仍可闻；与 TTS 同流，app 内音量 ducking（setVolume 1.0↔0.3）照常生效。
- 差异见 `android-verify-metronome-fix.diff`。

> 备选：若还想穿透"勿扰(DND)"，可用 `USAGE_ALARM`（→STREAM_ALARM）；本机 DND 已关、且 STREAM_ALARM 当前音量较低(1/7)，故选 USAGE_MEDIA 更直接、当前即响亮。

## 验证状态（重要）
- **暂未能重新构建/装机验证**：`gradle :app:installDebug` 在 `compileDebugKotlin` 阶段失败，错误**全部来自 `LiveCprCoachScreen.kt`**（`MinimalTopStatus`/`Switch`/`LinearProgressIndicator` 未解析、`DemoInjectionDrawer` 新旧签名不匹配等）。
- 该文件被 git 标记为已修改、diff 409 行(+230/−193)、**最后写入 20:54**（在本次构建之后）→ 正被并发大改成无法编译的中间态。与本修复无关，**未触碰**，也未动 git。
- 我的改动是单一枚举常量+注释，必然可编译；其有效性也有 dumpsys 佐证（STREAM_MUSIC 未被静音）。
- 待 `LiveCprCoachScreen.kt` 重新可编译后，重装即生效：
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\useAndroidDevEnv.ps1   # 或内联 env
  cd C:\fabuild\android
  gradle :app:installDebug
  ```
  然后用 Demo 抽屉"运行 6 步 CPR setup"驱回 S7，`dumpsys audio` 应显示该轨道 `usage=USAGE_MEDIA`，并在静音模式下仍 `state:started` 且可闻。

## 设备/服务状态
- `adb reverse tcp:8787 tcp:8787` 仍在；8787 服务未碰。
- `mode_ringer` 未被我改动（仍=0 静音）；`cmd audio` 不支持 set-ring-mode，`VOLUME_UP` 键事件路由到 STREAM_MUSIC，无法经 adb 安全解除静音。
