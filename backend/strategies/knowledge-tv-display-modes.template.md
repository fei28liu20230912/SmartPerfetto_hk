<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# TV 显示模式与刷新率知识

Android TV 的显示场景比手机复杂得多：电影 24fps、电视节目 25/30fps、游戏 60/120fps，
加上 HDR/Dolby Vision 和 HDCP，刷新率模式切换是 TV 性能分析的日常。

## TV 刷新率模式

| 模式 | 刷新率 | 典型内容 | VSync 间隔 |
|------|--------|---------|-----------|
| 24Hz | 23.976 / 24fps | 电影 (Netflix/Disney+) | ~41.7ms |
| 25Hz | 25fps | PAL 电视广播 | 40ms |
| 30Hz | 29.97 / 30fps | NTSC 电视广播 / 流媒体 | ~33.4ms |
| 50Hz | 50fps | PAL 广播 / 欧洲流媒体 | 20ms |
| 60Hz | 59.94 / 60fps | 游戏 / UI / 大部分 App | ~16.7ms |
| 120Hz | 119.88 / 120fps | VRR 游戏 / 运动补偿 | ~8.3ms |

### 帧率匹配 (Frame Rate Matching)

TV 系统应该根据内容帧率切换显示刷新率，避免 3:2 pulldown 抖动：

| 内容帧率 | 理想显示刷新率 | 常见错误匹配 | 抖动表现 |
|---------|--------------|-------------|---------|
| 24fps | 24Hz / 48Hz / 120Hz | 60Hz (3:2 pulldown) | 每5帧1帧停留2个VSync，画面微抖 |
| 25fps | 50Hz | 60Hz | 每秒5帧重复，卡顿明显 |
| 30fps | 60Hz | 60Hz (正确) | 无抖动 |
| 60fps | 60Hz / 120Hz | 30Hz | 帧丢弃，流畅度减半 |

### Perfetto 中的刷新率切换信号

```
1. VSync 间隔变化 — counter: VSYNC-sf 间隔跳变
2. DisplayMode 切换 — slice: *DisplayMode* / *RefreshRate*
3. setFrameRate 投票 — slice: *setFrameRate* / *FrameRateVote*
4. SurfaceFlinger mode 变更 — slice: SurfaceFlinger.*mode*
5. Panel 自身模式切换延迟 — present fence 突然出现 50-200ms 间隙
```

**刷新率切换期间的关键指标**：
- 切换延迟：从触发到新 VSync 稳定的时间（通常 50-200ms）
- 切换期间丢帧数：DisplayMode 切换中 display 被关闭再开启
- 黑屏时长：部分 TV SoC 刷新率切换需要先 disable display 再 enable

## HDR / Dolby Vision

### HDR 类型

| 类型 | 标准 | 色深 | 亮度范围 | Trace 信号 |
|------|------|------|---------|-----------|
| HDR10 | SMPTE ST 2086 | 10-bit | 1000-4000 nits | *HDR* / *PQ* slices |
| HDR10+ | Samsung + ST 2084 + 动态元数据 | 10-bit | 动态 | *HDR10+* slices |
| Dolby Vision | Dolby (Profile 4/5/7/8) | 10/12-bit | 动态 | *DolbyVision* / *DV* slices |
| HLG | ITU-R BT.2100 | 10-bit | 场景参考 | *HLG* slices |

### HDR 对渲染管线的影响

1. **Tone Mapping** — HDR→SDR 转换时 GPU 负载增加，RenderThread 延长
2. **HWC Overlay 强制** — HDR 内容通常要求 HWC overlay，不能走 client composition
3. **Buffer 格式变化** — RGBA8888 → P010/YUV422_10bit，dequeueBuffer 可能因格式不支持变慢
4. **Display Mode 联动** — HDR 内容通常触发刷新率 + 色彩空间同时切换，切换延迟叠加
5. **Dolby Vision 双层** — Profile 7 的 BL+EL 双层解码，内存带宽翻倍

### Trace 中 HDR 管线检测

```
关键信号：
- Slice: *HDR* / *PQ* / *DolbyVision* — MediaCodec 或 SurfaceFlinger 中
- Counter: *ColorMode* — 显示色彩空间切换
- Slice: *toneMapping* / *ToneMap* — GPU tone mapping 操作
- Counter: *DisplayMode* — 刷新率+HDR 模式联动变化
- HWC: overlay 层格式为 P010/YUV — 说明 HDR 走硬件直出
```

## HDCP (High-bandwidth Digital Content Protection)

### HDCP 版本

| 版本 | 最大分辨率 | TV 支持情况 |
|------|-----------|-----------|
| HDCP 1.4 | 4K@30Hz | 老款 TV |
| HDCP 2.2 | 4K@60Hz | 2015+ TV 主流 |
| HDCP 2.3 | 4K@60Hz / 8K@30Hz | 新款 TV |

### HDCP 对合成路径的影响

1. **受保护内容必须走 HWC Overlay** — Client composition 无法处理加密 buffer
2. **HDCP 握手失败 → 回退低分辨率** — 4K 内容降级到 1080p
3. **Secure Buffer 限制** — 受保护 buffer 不能被 GPU 读取，只能 HWC 直出
4. **多窗口限制** — HDCP 内容通常禁止截屏/PiP/分屏

### Trace 中 HDCP 信号

```
- Slice: *HDCP* / *hdcp* — HDCP 握手/认证
- Slice: *secure* / *Secure* — Secure buffer 相关
- HWC: layer 标记为 DEVICE (overlay) 但无法降级 — 可能因 HDCP
- SF: client composition 缺少某 layer — 该 layer 在 secure overlay 上
```

## 4K/8K 渲染负载

| 分辨率 | 像素数 | vs 1080p | GPU 负载影响 |
|--------|--------|----------|-------------|
| 1920×1080 | 2.07M | 1x | 基线 |
| 3840×2160 | 8.29M | 4x | GPU 渲染时间 ~4x，带宽 ~4x |
| 7680×4320 | 33.18M | 16x | GPU 几乎无法实时渲染 |

4K TV 上常见性能瓶颈：
- **SurfaceFlinger 合成时间翻倍** — 4K client composition 单帧可能超 16ms
- **GPU fill rate 不足** — 复杂 UI blur/shadow 在 4K 下超预算
- **内存带宽饱和** — 多层 4K buffer 读写导致 DDR 带宽瓶颈
- **解码器输出延迟** — 4K HDR 视频解码一帧 > 30ms

## TV 刷新率分析 SQL 参考

```sql
-- 检测刷新率切换事件及期间丢帧
INCLUDE PERFETTO MODULE android.frames.timeline;
WITH
rate_changes AS (
  SELECT
    ts,
    LEAD(ts) OVER (ORDER BY ts) AS next_ts,
    value AS refresh_rate
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name GLOB '*RefreshRate*' OR t.name GLOB '*DisplayMode*'
),
jank_during_switch AS (
  SELECT r.refresh_rate, COUNT(j.ts) AS jank_count
  FROM rate_changes r
  LEFT JOIN actual_frame_timeline_slice j
    ON j.ts >= r.ts AND j.ts < r.next_ts
    AND j.jank_type != 'None'
  GROUP BY r.refresh_rate
)
SELECT * FROM jank_during_switch;
```
