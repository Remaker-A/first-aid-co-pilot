# 01 · 架构设计

## 分层

本模块采用清晰的单向分层，依赖只能由上往下：

```
UI (Compose, 无状态)
   │  读 state / 抛回调
   ▼
Feature/Session (ViewModel 编排 + 状态机)
   │  调用
   ▼
Hardware (硬件适配) + Contract 实现 (Mock/真实)
   │
   ▼
Core/Contract (纯接口与数据模型，无 Android 依赖)
```

- **Core/Contract**：纯 Kotlin 数据类与接口，不含任何业务/Android UI 逻辑，是各方共同遵守的“协议”。
- **Hardware**：只封装系统能力（TTS/震动/定位/录音/权限），不感知业务，可独立复用。
- **Feature/Session**：唯一懂“业务编排”的层，把感知、Agent、硬件串起来。
- **UI**：无状态 Compose，只渲染 `CprSessionState` 并上抛回调。

## 为什么这样设计（可扩展性）

| 诉求 | 设计手段 |
| --- | --- |
| 第 2/3 部分可独立替换 | 依赖**接口**（`GuidanceAgent` / `CprPerceptionSource`），不依赖实现 |
| 一处切换 Mock/真实 | `ServiceLocator` 工厂函数 |
| ViewModel 可单测 | 依赖通过 `CprDependencies` 注入，不在内部 new |
| UI 可预览/可换 | 无状态屏幕，状态外置在 `CprSessionState` |
| 算法演进不破坏编译 | `PerceptionEvent.rawSignals` / `GuidanceAction.metadata` 口袋字段 |
| 不强绑 DI 框架 | 手写 `ServiceLocator`，零额外依赖，后续可平滑迁 Hilt |

## 依赖注入

`CprDependencies` 把会话所需能力打成一个包，由 `ServiceLocator.provideDependencies(context)`
组装，再通过 `CprSessionViewModel.factory(deps)` 注入 ViewModel。

```kotlin
val deps = remember { ServiceLocator.provideDependencies(context) }
val vm: CprSessionViewModel = viewModel(factory = CprSessionViewModel.factory(deps))
```

## 生命周期与资源释放

- 节拍器、感知收集、Agent 收集都跑在 `viewModelScope`，随 ViewModel 销毁自动取消。
- `onCleared()` 中兜底释放 TTS / 录音 / 震动 / 感知，杜绝泄漏。
- 硬件控制器一律用 `applicationContext` 构建，避免持有 Activity。

## 新增依赖

在 `gradle/libs.versions.toml` 与 `app/build.gradle.kts` 中新增：

- `kotlinx-coroutines-android`：驱动感知/Agent 的 `Flow` 数据流。
- `androidx-lifecycle-viewmodel-compose`：Compose 获取 ViewModel。
- `androidx-lifecycle-runtime-compose`：`collectAsStateWithLifecycle`。

硬件能力全部基于 Android framework 原生 API，**未引入** CameraX / Play Services 等重依赖，
保证离线可构建；摄像头取流作为扩展点交给第 3 部分（见契约文档）。
