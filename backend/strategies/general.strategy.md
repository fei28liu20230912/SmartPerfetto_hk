<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: general
priority: 99
effort: high
required_capabilities:
  - cpu_scheduling
optional_capabilities: []
keywords: []
---

#### 通用分析

当前查询未匹配到特定场景策略。请根据用户关注的方向，使用以下决策树选择合适的分析路径。

**决策树 — 按用户关注方向路由：**

| 用户关注方向 | 推荐路径 | 说明 |
|-------------|---------|------|
| **CPU / 调度 / 线程** | `invoke_skill("cpu_analysis")` → 如果发现 throttling → `invoke_skill("thermal_throttling")` | 交叉检查热节流和 CPU 频率 |
| **内存 / OOM / 泄漏** | `invoke_skill("memory_analysis")` → 如果有 heap dump → `invoke_skill("android_heap_graph_summary")` → 如果有 LMK → `invoke_skill("lmk_analysis")` → 如果涉及 GPU 内存 → `invoke_skill("dmabuf_analysis")` | 层层深入内存问题；heap graph 用 retained/cumulative size 定位 retainer |
| **IO / 磁盘 / 存储** | `invoke_skill("block_io_analysis")` 或 `invoke_skill("io_pressure")` | 磁盘 IO 和系统 IO 压力 |
| **GPU / 渲染** | `invoke_skill("gpu_analysis")` | GPU 频率、利用率、Fence 等待 |
| **Binder / IPC** | `invoke_skill("binder_analysis")` → 特定事务 → `invoke_skill("binder_detail")` | Binder 通信分析 |
| **锁竞争 / 死锁** | `invoke_skill("lock_contention_analysis")` | Monitor 竞争、锁链分析 |
| **电源 / 功耗 / 唤醒** | 优先切到 power 策略；或 `invoke_skill("wattson_rails_power_breakdown")` / `invoke_skill("suspend_wakeup_analysis")` | 先看 power_rails/battery_counters/cpu_freq_idle/gpu_work_period 数据完整度；缺 Wattson 数据时退化为 wakelock/Doze/唤醒链 |
| **SurfaceFlinger / 合成** | `invoke_skill("surfaceflinger_analysis")` | SF 合成延迟、GPU/HWC 分析 |
|| **TV / 电视** | 切换到 TV 策略；或 `invoke_skill("dpad_input_latency")` / `invoke_skill("av_sync_skew")` / `invoke_skill("refresh_rate_mode_matching")` / `invoke_skill("voice_interaction_latency")` | 遥控器焦点响应、音画同步、刷新率匹配、语音交互延迟 |
| **非标准/混合渲染架构卡顿** | 先 `detect_architecture`；始终保留 HWUI host 分析（`scrolling_analysis` / `jank_frame_detail`），再按候选链路补：Flutter → `flutter_scrolling_analysis`，TextureView → `textureview_producer_frame_timing`，WebView GL Functor → `webview_drawfunctor_jank_chain`，RN old/new → `rn_bridge_to_frame_jank` / `rn_fabric_render_jank`，GLSurfaceView/NativeActivity → `gl_standalone_swap_jank` | 混合出图要先分开看 host 与 producer，再合并看依赖；避免只看 FrameTimeline 漏掉生产端 jank |
| **网络** | `invoke_skill("network_analysis")` | 网络活动分析 |
| **特定时间段** | `invoke_skill("system_load_in_range", { start_ts, end_ts })` | 任意时间段的系统负载 |
| **不确定方向** | `invoke_skill("scene_reconstruction")` → 按场景路由 | 先做全局场景还原，再针对性深钻 |

**场景专用快速路由**（如果用户的问题明确匹配以下场景，直接使用对应策略）：
- **滑动/卡顿**: scrolling_analysis → jank_frame_detail (逐帧深钻)
- **启动**: startup_analysis → startup_detail
- **ANR**: anr_analysis → anr_detail
- **点击/触摸**: click_response_analysis → click_response_detail (逐事件深钻)
- **TextureView/WebView/Flutter/RN/GL 混合架构卡顿**: detect_architecture → HWUI host skill + architecture-specific producer skill → 合并依赖判断
- **概览/场景还原**: scene_reconstruction → 按场景路由到对应 Skill
- **功耗/耗电**: wattson_rails_power_breakdown → wattson_thread_power_attribution；数据缺失时 battery_charge_timeline / android_kernel_wakelink_summary / suspend_wakeup_analysis fallback
- **TV/电视**: dpad_input_latency / voice_interaction_latency → av_sync_skew / refresh_rate_mode_matching / hdr_pipeline_state / hdcp_composition_path

也可以使用 `list_skills` 发现更多可用技能，或使用 `execute_sql` 做自定义查询。

#### 通用场景关键 Stdlib 表

写 execute_sql 时优先使用（完整列表见方法论模板）：`slice_self_dur`、`cpu_utilization_in_interval(ts, dur)`、`cpu_frequency_counters`、`android_garbage_collection_events`、`android_oom_adj_intervals`、`android_screen_state`、`android_dvfs_counters`、`wattson_rails_aggregation`、`android_battery_charge`
