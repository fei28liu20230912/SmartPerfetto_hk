<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# TV 语音交互知识

TV 语音交互分近场（遥控器内置麦克风）和远场（TV 机身麦克风阵列）两种形态，
延迟链路差异大，性能问题表现也不同。

## 近场语音 vs 远场语音

| 维度 | 近场语音 | 远场语音 |
|------|---------|---------|
| 麦克风位置 | 遥控器内 | TV 机身顶部/底部阵列 |
| 拾音距离 | 5-30cm | 3-5m |
| 唤醒词 | 通常无（按键触发） | "Hey Google" / 自定义唤醒词 |
| AEC（回声消除） | 简单/不需要 | 必须，TV 自身喇叭回声 |
| 降噪 | 基础 | 多麦克风 beamforming + 降噪 |
| 延迟瓶颈 | 语音识别（云端/本地） | 唤醒检测 + AEC + 语音识别 |
| 典型延迟 | 500ms-2s | 800ms-3s |
| Trace 可见性 | VoiceInteractionService slice | VoiceInteractionService + DSP/audio HAL slice |

## 语音助手进程（按 OS 变体）

| OS | 语音助手进程 | 说明 |
|----|------------|------|
| FireTV | Vizzni | Amazon 语音服务，集成 Alexa |
| Google TV | Katniss | Google Assistant 语音服务 |
| AOSP（国内） | Walleve | 厂商自研语音助手 |

分析语音交互 trace 时，需根据当前 OS 识别对应的语音进程：

**FireTV — Vizzini**
- 包名: `com.amazon.vizzini`
- slice 匹配: `*Vizzini*`、`*com.amazon.vizzini*`

**Google TV — Katniss**
- 包名: `com.google.android.katniss`
- 多进程架构: `:interactor`（语音算法）、`:search`（画面渲染）
- slice 匹配: `*Katniss*`、`*com.google.android.katniss*`

**AOSP 国内 — Walleve**
- 包名: `com.tcl.walleve`
- 语音算法: 讯飞
- 算法线程: `cae_front`、`cae_back`（讯飞内部设计，不对应近场/远场）
- slice 匹配: `*Walleve*`、`*com.tcl.walleve*`、线程名 `cae_front` / `cae_back`

## 近场语音链路（遥控器语音按键 → 识别结果 → 动作执行）

```
① 用户按住遥控器语音键
   ↓  input_event: KEYCODE_VOICE_ASSIST / KEYCODE_SEARCH
② 蓝牙/IR 传输到 TV
   ↓  10-50ms（蓝牙 BLE 传输）
③ SystemUI 启动 VoiceInteractionSession
   ↓  slice: VoiceInteractionSession.show / onReady
   ↓  ~50-200ms（Session 创建 + UI 动画）
④ 麦克风录音开始
   ↓  AudioRecord.start → AudioFlinger input stream
   ↓  slice: AudioFlinger.* (需 audio atrace tag)
⑤ 语音数据送识别引擎
   ↓  本地: on-device ASR (Google Speech API / 自研)
   ↓  云端: HTTP → 服务器 → 返回结果
   ↓  本地 100-500ms / 云端 500-2000ms
⑥ 识别结果返回
   ↓  slice: VoiceInteractionSession.onComputeResult
⑦ Intent 分发执行
   ↓  startActivity / broadcast
   ↓  50-200ms（目标 App 启动/响应）
```

**近场语音性能关注点：**
- 语音键按下 → 录音启动的间隔（Step ②-④）应 <300ms
- 录音启动到 Session UI 展示应 <500ms
- 云端识别 RTT 受网络影响大，需检查网络延迟
- 识别结果 → 执行动作的延迟应 <200ms

## 远场语音链路（唤醒词 → 识别 → 动作执行）

```
① 持续监听（Always-On DSP）
   ↓  DSP/Hotword 模块运行在低功耗协处理器
   ↓  无 trace 信号（内核底层）
② 唤醒词检测命中
   ↓  slice: HotwordDetector.* / VoiceTrigger.*
   ↓  或 audio HAL 回调: audio_hw.*voice_trigger*
③ 切换到主麦克风阵列
   ↓  AudioRecord.start (多通道)
   ↓  开启 AEC（回声消除）/ NS（降噪）
   ↓  slice: AudioFlinger.input.* + AEC 相关
④ AEC + Beamforming 处理
   ↓  DSP/软件 AEC pipeline
   ↓  延迟 30-80ms（硬件 AEC）/ 80-200ms（软件 AEC）
   ↓  如果 TV 正在播放内容，AEC 是关键瓶颈
⑤ 语音数据送识别引擎
   ↓  同近场 Step ⑤
⑥ 识别结果返回 + 执行
   ↓  同近场 Step ⑥-⑦
```

**远场语音性能关注点：**
- 唤醒词检测延迟（Step ①-②）应 <500ms，否则用户觉得没听到
- AEC 开启时的额外延迟，特别是在大音量播放时
- 唤醒检测误触发率（false accept）影响体验但 trace 难以直接观测
- TV 播放大音量时 AEC 性能退化 → 整体延迟增加
- 远场拾音质量受环境噪声影响，可能导致识别 RTT 增加

## Trace 采集要求

| Category | 必要性 | 说明 |
|----------|-------|------|
| `audio` | 必须 | AudioFlinger input stream、AEC 处理 |
| `input` | 推荐 | 语音键按下事件 |
| `am` (ActivityManager) | 推荐 | VoiceInteractionSession 生命周期 |
| `view` | 推荐 | Session UI 渲染 |
| `hal:audio` | 远场必须 | Audio HAL 层的 hotword/DSP 回调 |
| `sched` | 推荐 | 识别引擎线程调度 |
| `network` | 云端识别必须 | HTTP 请求延迟 |

## 常见性能问题与 Trace 签名

| 问题 | Trace 签名 | 根因 |
|------|-----------|------|
| 语音键按下后长时间无 UI | InputDispatcher → VoiceInteractionSession.show 间隔大 | Session 创建卡在 bindService |
| 录音启动慢 | AudioRecord.start 到 AudioFlinger input stream 激活间隔大 | AudioFlinger input thread 优先级低或被抢占 |
| AEC 导致延迟大 | audio HAL 层 AEC 处理耗时 | 软件 AEC 在大音量场景 CPU 不够 |
| 云端识别慢 | 无直接 trace，通过 network 事件推断 | 网络延迟或服务器响应慢 |
| 识别结果执行卡 | VoiceInteractionSession.onComputeResult → startActivity 间隔大 | 目标 App 冷启动 |
| 远场唤醒延迟 | HotwordDetector 回调到 Session 创建间隔大 | 唤醒检测后主线程被阻塞 |
| 误唤醒 | 频繁出现 HotwordDetector 回调但无后续识别 | 唤醒模型阈值过低 |

## 关键 SQL 查询模式

```sql
-- 语音交互 Session 生命周期
SELECT slice.name, ts, dur
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
WHERE slice.name LIKE '%VoiceInteraction%'
ORDER BY ts;

-- AudioFlinger input stream 活动（录音期间）
SELECT slice.name, ts, dur
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
WHERE slice.name LIKE '%AudioFlinger%input%'
ORDER BY ts;

-- 语音键事件
SELECT slice.name, ts, dur
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
WHERE slice.name LIKE '%InputDispatcher%key%'
  AND (slice.name LIKE '%VOICE%' OR slice.name LIKE '%ASSIST%')
ORDER BY ts;
```
