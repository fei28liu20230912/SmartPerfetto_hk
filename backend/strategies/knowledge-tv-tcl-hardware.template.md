<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# TCL TV 硬件平台与 OS 配置知识

分析 TCL TV 的 Perfetto trace 时，需根据 SoC 型号和内存大小选择合适的性能基线和诊断策略。
本模板记录 TCL TV 常见硬件平台、OS 变体、以及各配置下的性能分析侧重点。

## 1. SoC 平台矩阵

### MTK（联发科）系列

| SoC | 内存 | CPU | GPU | 定位 | 典型机型 |
|-----|------|-----|-----|------|---------|
| MT9221 | 1GB / 1.5GB | 4核 Cortex-A53 | Mali-450 MP2 | 入门级 | SE 系列 / S 系列 |
| MT9653 | 2GB / 3GB | 4核 Cortex-A73 × 2 + A53 × 2 | Mali-G52 MC1 | 中端 | C 系列 / P 系列 |
| MT9655 | 3GB | 4核 Cortex-A73 × 2 + A53 × 2 | Mali-G57 MC2 | 中高端 | C 系列 Pro / Q 系列 |

**MTK 平台特征：**
- GPU: Mali 系列，驱动通过 mali 模块暴露
- HAL: Mediatek 专有 HAL 层，合成路径走 MTK HWC
- HDR/DV: MTK 平台专用 tone mapping 管线
- DVFS: 通过 schedutil / interactive governor 控制
- 电源: 通过 MTK PMIC，power rails 命名含 `VDD_*` / `VPROC_*`
- 音频: MTK Audio HAL，AudioFlinger 路径一致但 HAL 实现不同
- 内存回收: MTK 有定制 lmkd 配置，/proc/zoneinfo 中 Normal zone 通常较小

### RTK（Realtek）系列

| SoC | 内存 | CPU | GPU | 定位 | 典型机型 |
|-----|------|-----|-----|------|---------|
| RT2875P | 1.5GB / 2GB | 4核 Cortex-A53 | IMG PowerVR | 入门/中端 | SE 系列 / 部分定制机型 |
| RT2881 | 2GB | 4核 Cortex-A53 | IMG PowerVR | 中端 | C 系列 |
| RT2881Q | 2GB / 3GB | 4核 Cortex-A73 × 2 + A53 × 2 | IMG PowerVR | 中高端 | P 系列 / Q 系列 |

**RTK 平台特征：**
- GPU: IMG PowerVR 系列，驱动通过 pvrsrvkm 模块暴露
- HAL: Realtek HAL 层，HWC 实现与 MTK 差异大
- 合成路径: RTK 的 HWC layer 合成策略与 MTK 不同，Client/GPU 合成比例通常更高
- HDR/DV: RTK 有自己的 HDR 处理管线，tone mapping 实现不同
- 音频: RTK Audio HAL，AudioFlinger 上层一致但 HAL 层差异大
- IO: RTK 平台 eMMC 控制器性能通常弱于 MTK 同级别，IO 调度更关键

## 2. 内存分级与性能基线

| 内存档位 | 配置 | 性能基线 | 分析侧重点 |
|---------|------|---------|-----------|
| 紧张 | 1GB (MT9221) | 前台 App 可用 ~300MB | LMK 频次、direct reclaim、常驻内存审计、dmabuf 占用、GC pressure |
| 偏紧 | 1.5GB (MT9221/RT2875P) | 前台 App 可用 ~450MB | LMK、内存水位、后台进程数、IO 压力 |
| 中等 | 2GB (MT9653/RT2875P/RT2881/RT2881Q) | 前台 App 可用 ~650MB | 4K 播放时 dmabuf、多任务切换、长时间稳定性 |
| 宽裕 | 3GB (MT9653/MT9655/RT2881Q) | 前台 App 可用 ~1GB | 内存通常不是瓶颈，关注 GPU/调度/HDR 管线 |

### 内存配置对应的推荐诊断 Skill

| 内存 | 首选 Skill | 补充 Skill |
|------|-----------|-----------|
| 1GB / 1.5GB | low_memory_optimization | memory_analysis, lmk_analysis, dmabuf_analysis |
| 2GB | memory_analysis | low_memory_optimization（仅长时间运行场景） |
| 3GB | memory_analysis | 按需，通常不需要低内存专项 |

## 3. OS 变体与系统开销

### FireTV（Amazon）

| 维度 | 说明 |
|------|------|
| 系统服务 | Amazon Fire OS，基于 AOSP 深度定制 |
| 语音助手 | Vizzini (com.amazon.vizzini) |
| Launcher | FireTV Launcher，非 Leanback |
| 常驻开销 | Amazon 服务层额外 ~50-100MB（ContentProvider、推荐引擎、Alexa） |
| 特有进程 | `com.amazon.*` 系列服务 |
| 注意事项 | Amazon 更新策略可能导致后台 OTA 占用 CPU/IO；Whisperjoin 等网络服务常驻 |

### Google TV（含 GMS）

| 维度 | 说明 |
|------|------|
| 系统服务 | Google TV，含完整 GMS |
| 语音助手 | Katniss (com.google.android.katniss)，:interactor（算法）/ :search（渲染） |
| Launcher | Google TV Launcher / Android TV Home |
| 常驻开销 | GMS 服务额外 ~100-200MB（Play Services、Cast、Assistant） |
| 特有进程 | `com.google.*` 系列服务，gms_core、unetwork |
| 注意事项 | GMS 占用内存大，1.5GB 以下机型不推荐跑 Google TV；OTA 通过 Google Play |

### AOSP 国内版（移除 GMS）

| 维度 | 说明 |
|------|------|
| 系统服务 | 纯 AOSP，移除 GMS，厂商自研服务层 |
| 语音助手 | Walleve (com.tcl.walleve)，讯飞算法，线程 cae_front / cae_back |
| Launcher | 厂商自研 Launcher（TVP Home 等） |
| 常驻开销 | 无 GMS，额外 ~30-60MB（厂商服务、OTA、语音） |
| 特有进程 | `com.tcl.*` 系列服务 |
| 注意事项 | 内存占用最低，适合 1GB/1.5GB 机型；语音算法线程需关注调度优先级 |

### OS 开销对比（典型常驻内存）

```
Google TV:  ~250-350MB 系统常驻（含 GMS）
FireTV:     ~200-280MB 系统常驻（含 Amazon 服务）
AOSP 国内:  ~150-200MB 系统常驻（无 GMS，厂商服务）
```

## 4. 设备识别方法

分析 trace 时，可通过以下 SQL 确定设备配置：

```sql
-- 从 build props 获取设备信息（如有）
SELECT key, value
FROM metadata
WHERE key IN ('build.fingerprint', 'build.device', 'build.model', 'build.hardware');

-- 从进程列表推断 OS 变体
SELECT DISTINCT p.name
FROM process p
WHERE p.name GLOB '*google*'    -- Google TV
   OR p.name GLOB '*amazon*'    -- FireTV
   OR p.name GLOB '*tcl*'       -- AOSP 国内
   OR p.name GLOB '*vizzini*'   -- FireTV 语音
   OR p.name GLOB '*katniss*'   -- Google TV 语音
   OR p.name GLOB '*walleve*'   -- AOSP 国内语音
ORDER BY p.name;

-- 从 CPU topology 推断 SoC
SELECT cpu, cluster, freq_max
FROM cpu_frequency_counters
GROUP BY cpu
ORDER BY cpu;

-- 从内存总量推断内存配置
SELECT value / 1024 / 1024 AS total_memory_mb
FROM counter c
JOIN counter_track ct ON c.track_id = ct.id
WHERE ct.name GLOB '*MemTotal*'
LIMIT 1;
```

## 5. 配置敏感的诊断策略

### 入门级（MT9221 1GB/1.5GB + AOSP）
```
1. low_memory_optimization → 必跑，内存是第一瓶颈
2. dpad_input_latency → 入门级 UI 延迟敏感
3. memory_analysis + lmk_analysis → 确认 LMK 不杀前台
4. block_io_analysis → eMMC + 低内存 = IO 压力大
```

### 入门级（MT9221 1GB/1.5GB + Google TV）
```
⚠ GMS 在 1GB 设备上几乎不可接受
1. low_memory_optimization → 必跑
2. memory_ranking → 重点看 GMS 进程占用
3. 建议客户升级内存或切 AOSP
```

### 中端（MT9653/RT2881 2GB + 任意 OS）
```
1. memory_analysis → 2GB 通常够用，看有无泄漏
2. 按场景选择专项 skill（HDR/AV Sync/语音/刷新率）
3. long_run_stability → 长时间播放场景
```

### 中高端（MT9655/RT2881Q 3GB）
```
1. 按场景选择专项 skill，内存通常不是问题
2. 关注 GPU 渲染（4K/8K）、HDR 管线、调度
3. MTK 看 Mali GPU counter，RTK 看 PowerVR
```
