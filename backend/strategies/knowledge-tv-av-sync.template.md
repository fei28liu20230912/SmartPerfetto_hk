<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# TV 音视频同步 (A/V Sync) 知识

音画不同步是 TV 最常见的客诉之一。理解 A/V Sync 需要知道音频和视频各自的时钟链路。

## 两种播放模式

### Non-Tunneled（普通模式）

```
Video:  MediaCodec 解码 → releaseOutputBuffer → Surface → SurfaceFlinger → Present Fence → 上屏
Audio:  MediaCodec 解码 → AudioTrack.write → AudioFlinger → HAL → DAC → 扬声器

同步点：App 层用 PTS (Presentation Time Stamp) 对齐
         - 视频按 PTS 延迟 releaseOutputBuffer
         - 音频按 PTS 调度 AudioTrack write
         - 两者独立运行，靠 App 侧时钟协调
```

### Tunneled（隧道模式）

```
Video:  MediaCodec → HAL Sideband Stream → HWC Overlay → 直接上屏
Audio:  MediaCodec → Audio HAL → 直接输出

同步点：HAL 层由 Audio PTS 时钟驱动
         - 视频帧由 HAL 根据 Audio PTS 时钟自动调度
         - App 进程看不到 releaseOutputBuffer（sideband 绕过）
         - A/V sync 在 HAL/驱动层完成，延迟更低但可观测性更差
```

## A/V Sync 偏差来源

| 偏差来源 | 方向 | 量级 | Trace 信号 |
|---------|------|------|-----------|
| 视频解码慢 → 视频晚 | 视频滞后 | 10-100ms | releaseOutputBuffer 延迟 |
| Audio track underrun → 音频断续 | 音频不稳定 | 间歇性 | AudioFlinger underrun counter |
| SurfaceFlinger 合成延迟 → 视频晚 | 视频滞后 | 5-30ms | SF Duration 抬升 |
| 刷新率不匹配 → 视频帧跳变 | 视频抖动 | ±8ms (60Hz) | FrameTimeline jank |
| DRM/HDCP 握手 → 视频晚启动 | 视频滞后 | 100-500ms | HDCP slice |
| HDR 切换 → 显示模式切换 | 视频暂时中断 | 200-1000ms | DisplayMode 变化 |
| Audio HAL 延迟 → 音频晚 | 音频滞后 | 5-50ms | Audio HAL latency |

## TV A/V Sync 评估方法

### 方法一：ESD (Expected Signal Delay) — Perfetto 原生

Android 13+ 提供 `android_esd_metric` 表，直接给出音视频延迟差：

```sql
INCLUDE PERFETTO MODULE android.media;
SELECT
  ts,
  audio_ts,
  video_ts,
  esd_ms  -- Expected Signal Delay: 正值=视频领先，负值=音频领先
FROM android_esd_metric
WHERE esd_ms IS NOT NULL
ORDER BY ts;
```

### 方法二：PTS 对比 — 通用方法

对比音频和视频的 Presentation TimeStamp：

```sql
-- 视频 PTS（从 MediaCodec releaseOutputBuffer 推算）
-- 音频 PTS（从 AudioTrack write 推算）
-- 偏差 = video_pts - audio_pts
```

### 方法三：Present Fence vs Audio Timestamp

```sql
-- 视频上屏时间：present fence signal 时间
-- 音频播放时间：AudioFlinger HAL timestamp
-- 偏差 = present_fence_ts - audio_playback_ts
```

## 人眼/耳感知阈值

| A/V 偏差 | 用户感知 |
|---------|---------|
| < 5ms | 无法感知 |
| 5-15ms | 敏感用户可感知 |
| 15-45ms | 大部分用户可感知，影响体验 |
| 45-100ms | 明显音画不同步 |
| > 100ms | 严重不同步，不可接受 |

**注意**：音频超前比滞后更被用户敏感（视觉比听觉慢约 80ms 的大脑补偿效应），
所以通常目标让视频略超前音频 0-20ms。

## TV 常见 A/V Sync 问题

1. **Netflix/YouTube 播放音画不同步** — 流媒体 App 的 PTS 管理问题
2. **HDMI ARC 音频延迟** — 通过 HDMI ARC 外接音响时，音频延迟 > 视频延迟
3. **直播场景延迟累积** — 长时间播放后 PTS 漂移，A/V 偏差逐渐增大
4. **Tunneled 模式下无法排查** — App 进程看不到中间过程，需 HAL 层 trace
5. **刷新率切换瞬间 A/V 断裂** — DisplayMode 切换期间视频暂停但音频继续

## Trace 采集配置

```perfetto
data_sources {
  config {
    name: "linux.ftrace"
    ftrace_config {
      atrace_categories: "gfx"
      atrace_categories: "input"
      atrace_categories: "audio"
      atrace_categories: "video"
      atrace_categories: "view"
    }
  }
}
```

**关键**：`audio` atrace category 是 A/V sync 分析的必要条件，很多 trace 采集中忽略了它。
