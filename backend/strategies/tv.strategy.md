<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: tv
priority: 3
effort: high
required_capabilities:
  - cpu_scheduling
optional_capabilities:
  - frame_rendering
  - gpu
  - surfaceflinger
  - power_rails
  - audio
keywords:
  - TV
  - 电视
  - 遥控器
  - DPad
  - 焦点
  - 音画不同步
  - A/V同步
  - 音视频
  - HDR
  - Dolby
  - 杜比
  - HDCP
  - DRM
  - 刷新率
  - 4K
  - 8K
  - pulldown
  - Leanback
  - HDMI
  - CEC
  - 遥控延迟
  - 焦点卡顿
  - 音频延迟
  - lipsync
compound_patterns:
  - "(遥控|DPad|方向键|焦点).*(慢|卡|延迟|响应)"
  - "(音画|声画|音视频|A/V).*(同步|不同步|偏差|延迟)"
  - "(HDR|Dolby|杜比).*(卡顿|切换|延迟|问题)"
  - "(HDCP|DRM|受保护).*(播放|合成|降级)"
  - "(刷新率|帧率).*(匹配|切换|抖动)"
  - "(TV|电视|leanback).*(启动|卡顿|性能)"

phase_hints:
  - id: tv_input_response
    keywords: ['遥控', 'DPad', '焦点', '按键', '方向键', 'remote', 'dpad', 'focus', 'key input']
    constraints: 'TV 输入链路与手机触控完全不同，使用 dpad_input_latency 而非 touch_to_display_latency。TV 事件类型为 KEY 而非 MOTION，焦点系统是关键瓶颈。'
    critical_tools: ['dpad_input_latency']
    critical: true
  - id: tv_av_sync
    keywords: ['音画不同步', 'A/V同步', 'lipsync', '声画', '音频延迟', '音视频', 'av sync']
    constraints: 'A/V Sync 分析需要 audio atrace category。缺少 audio trace 时必须标注数据不足。优先检查 AudioFlinger underrun 和 video releaseOutputBuffer 时序。'
    critical_tools: ['av_sync_skew', 'media_codec_activity']
    critical: true
  - id: tv_hdr_dv
    keywords: ['HDR', 'Dolby', '杜比', 'HDR10', 'HLG', 'ToneMapping', '色彩空间']
    constraints: 'HDR 分析需要 video atrace category。检查 HDR 模式对 HWC 合成路径的影响，Tone Mapping 开销可能导致 GPU 超预算。HDR 内容通常强制 HWC overlay。'
    critical_tools: ['hdr_pipeline_state', 'surfaceflinger_analysis']
    critical: true
  - id: tv_hdcp_drm
    keywords: ['HDCP', 'DRM', '受保护', 'secure', 'Widevine', '加密', '合成降级']
    constraints: 'HDCP 受保护内容必须走 HWC overlay，不能降级到 client composition。检测 secure buffer 活动和 HWC 合成路径变化。'
    critical_tools: ['hdcp_composition_path', 'surfaceflinger_analysis']
    critical: false
  - id: tv_refresh_rate
    keywords: ['刷新率', '帧率匹配', 'pulldown', '模式切换', '24Hz', '60Hz', '120Hz', '抖动']
    constraints: 'TV 刷新率匹配直接影响观影体验。24fps 内容在 60Hz 显示会 3:2 pulldown 抖动。检查刷新率切换期间的丢帧和黑屏。'
    critical_tools: ['refresh_rate_mode_matching', 'vrr_detection']
    critical: true
  - id: tv_long_run_stability
    keywords: ['长时间', '稳定性', '内存泄漏', '温控', '降频', '长时间运行']
    constraints: 'TV 常开数小时，内存泄漏和温控降频问题比手机更突出。需要检查长时间趋势而非单次快照。'
    critical_tools: ['memory_analysis', 'cpu_cluster_mapping_view', 'thermal_throttling']
    critical: false

plan_template:
  mandatory_aspects:
    - id: tv_input_or_av_check
      match_keywords: ['dpad', 'focus', '遥控', '按键', '音画', 'A/V', 'av_sync']
      suggestion: 'TV 场景必须检查输入响应或 A/V Sync，至少分析一项'
    - id: tv_display_mode_awareness
      match_keywords: ['HDR', '刷新率', 'HDCP', '4K', '显示']
      suggestion: 'TV 显示模式（刷新率/HDR/HDCP）影响整条渲染管线，分析时需考虑当前模式'
    - id: composition_path_check
      match_keywords: ['SF', 'SurfaceFlinger', 'HWC', 'overlay', '合成']
      suggestion: 'TV 上 HWC overlay 至关重要，受保护内容/HDR/4K 都影响合成路径'

---

#### TV 系统性能分析（用户提到 TV/电视/遥控器/音画同步/HDR/HDCP/刷新率等关键词）

**核心目标：** 针对 Android TV 的特殊性能问题进行分析，包括遥控器输入响应、音视频同步、HDR/Dolby Vision 管线、HDCP 合成路径、刷新率匹配等 TV 专属场景。

**TV vs 手机关键差异：**

| 维度 | 手机 | TV |
|------|------|-----|
| 输入方式 | 触摸 (MOTION) | 遥控器 (KEY/DPad) |
| 延迟体感 | 跟手性 | 焦点移动响应 |
| 显示模式 | 固定 60/120Hz | 频繁切换 24/30/50/60/120Hz |
| 内容保护 | 少见 | HDCP 是标配（Netflix/Disney+） |
| HDR | 部分旗舰 | 核心卖点（Dolby Vision/HDR10+） |
| 音视频 | 单独分析 | A/V Sync 是核心指标 |
| 运行时长 | 分钟级 | 小时级 |

**Phase 1 — 问题路由（按用户关注方向）：**

```
IF 遥控器/焦点/按键响应:
  invoke_skill("dpad_input_latency")
  → 如发现焦点系统慢 → invoke_skill("jank_frame_detail") 深钻焦点帧
  → 如发现 InputDispatcher 延迟 → 检查 ANR 风险

IF 音画不同步/A/V Sync:
  invoke_skill("av_sync_skew")
  → 如发现 audio underrun → 检查 AudioFlinger 调度优先级
  → 如发现视频延迟 → invoke_skill("media_codec_activity") 检查解码
  → 如发现刷新率相关 → invoke_skill("refresh_rate_mode_matching")

IF HDR/Dolby Vision:
  invoke_skill("hdr_pipeline_state")
  → 如发现 Tone Mapping 开销大 → 检查 GPU 负载
  → 如发现合成路径变化 → invoke_skill("surfaceflinger_analysis")
  → 如关联 HDCP → invoke_skill("hdcp_composition_path")

IF HDCP/DRM:
  invoke_skill("hdcp_composition_path")
  → 如发现认证失败 → 检查 HDCP 版本兼容性
  → 如发现合成降级 → invoke_skill("surfaceflinger_analysis")

IF 刷新率/帧率匹配:
  invoke_skill("refresh_rate_mode_matching")
  → 如发现 pulldown → 建议切换到匹配的刷新率模式
  → 如发现切换丢帧 → 检查 DisplayMode 切换延迟
  → 关联 → invoke_skill("vrr_detection")

IF TV 启动/卡顿:
  → 按通用场景路由，但注意 TV 特点：
    - Leanback Launcher 的启动链路
    - TV SoC 通常比手机弱，CPU/GPU 预算更紧
    - 4K 分辨率下 GPU fill rate 压力
```

**Phase 2 — TV 通用补充检查：**

```
无论主问题是什么，TV 场景建议额外检查：
1. invoke_skill("refresh_rate_mode_matching") — 确认当前刷新率是否匹配内容
2. invoke_skill("vrr_detection") — 确认 VRR 状态
3. 检查 SurfaceFlinger 合成路径 — overlay vs client 比例
4. 如有功耗问题 → invoke_skill("wattson_rails_power_breakdown")
```

**TV 常见根因速查：**

| 症状 | 第一怀疑 | 验证 Skill |
|------|---------|-----------|
| 遥控器按键响应慢 | 焦点搜索耗时长 | dpad_input_latency → focus_latency_summary |
| 音画不同步 | Audio underrun 或视频解码延迟 | av_sync_skew → audio_underrun_detection |
| HDR 视频卡顿 | Tone Mapping GPU 超预算 | hdr_pipeline_state → tone_mapping_activity |
| Netflix 黑屏 | HDCP 认证失败 | hdcp_composition_path → hdcp_auth_status |
| 电影画面抖动 | 3:2 pulldown | refresh_rate_mode_matching → pulldown_detection |
| 切频道黑屏 | 刷新率切换延迟 | refresh_rate_mode_matching → mode_switch_events |
| 长时间播放变卡 | 内存泄漏/温控 | memory_analysis + thermal_throttling |

**知识模板注入：**

当场景匹配到 TV 时，自动注入以下知识模板：
- `knowledge-tv-input-chain.template.md` — TV 输入链路知识
- `knowledge-tv-display-modes.template.md` — TV 显示模式/刷新率/HDR/HDCP 知识
- `knowledge-tv-av-sync.template.md` — 音视频同步知识
