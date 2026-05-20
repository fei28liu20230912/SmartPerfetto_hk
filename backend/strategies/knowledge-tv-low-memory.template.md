<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# TV 低内存设备性能优化知识

TCL TV 入门级机型（MT9221 1GB/1.5GB、RT2875P 1.5GB）在长期运行、多任务、4K 播放等场景下
内存压力极大，需要系统性优化常驻内存、IO 调度、内存水位、CPU 调度和线程优先级。

## 1. 常驻内存优化

TV 系统常驻进程多，低内存设备必须严格控制常驻内存占用。

### 关键常驻进程及优化方向

| 进程/服务 | 典型内存占用 | 优化手段 | Trace 验证 |
|----------|------------|---------|-----------|
| SystemUI / Launcher | 80-150MB | 延迟加载非可见模块，减少图片缓存，Leanback 页面懒加载 | `android.oom_adj_intervals` 查看 adj 等级 |
| Google Play Services (GMS) | 100-200MB | 低内存设备禁用非必要 GMS 模块，或切换 AOSP 去掉 GMS | `lmk_analysis` 观察 GMS 进程被杀频率 |
| 语音助手 (Walleve/Katniss/Vizzini) | 50-120MB | 冷启动代替常驻，非活跃时释放算法模型内存 | `dmabuf_analysis` 查看 GPU/DSP buffer 占用 |
| Cast / DLNA 服务 | 30-60MB | 按需启动，空闲超时自动退出 | `memory_analysis` 查看进程 RSS 趋势 |
| OTA / Update Engine | 20-40MB | 检查期间才启动，完成后立即退出 | `android.oom_adj_intervals` |
| HAL 层服务 (audio HAL / TV HAL) | 20-50MB | 合并小 HAL 进程，共享内存池 | `dmabuf_analysis` 查看 HAL buffer |

### 优化策略

```
常驻内存预算（1GB 设备）：
- SystemServer + 核心 HAL: ~120MB（不可压缩）
- SystemUI / Launcher: <80MB（严格控制）
- 语音助手: 0MB（冷启动，不常驻）
- Cast 服务: 0MB（按需启动）
- 可用给前台 App: ~300-400MB
- 留给 GPU / dmabuf: ~150-200MB
- 内核 + 页表 + 其他: ~150MB
```

**Trace 诊断方法：**
- `memory_analysis` → 查看各进程 RSS / PSS 趋势
- `android.oom_adj_intervals` → 查看进程 adj 等级分布
- `android_heap_graph_summary` → 如有 heap dump，分析 retained size
- `lmk_analysis` → 查看 LMK 杀进程频率和原因

## 2. IO 调度策略

低内存设备 eMMC 读写慢，IO 压力大时会触发直接回收（direct reclaim），导致前台卡顿。

### IO 调度器选择

| 调度器 | 适用场景 | 说明 |
|-------|---------|------|
| `bfq` | 低端 eMMC | 按进程公平分配带宽，防止后台 IO 饿死前台 |
| `deadline` | 一般场景 | 简单高效，保证请求延迟上限 |
| `noop` | 高端 UFS | 无排序开销，硬件自身有 NCQ |
| `mq-deadline` | 现代 kernel | 多队列版 deadline |

**低内存 TV 推荐配置：**
```bash
# 查看当前调度器
cat /sys/block/mmcblk0/queue/scheduler

# 设置为 bfq（适合低端 eMMC）
echo bfq > /sys/block/mmcblk0/queue/scheduler

# 关键调优参数
echo 128 > /sys/block/mmcblk0/queue/nr_requests    # 减少队列深度
echo 0 > /sys/block/mmcblk0/queue/add_random        # 关闭随机熵贡献
echo 1 > /sys/block/mmcblk0/queue/rotational        # 标记为旋转设备优化
```

### IO 优先级与 cgroup

```bash
# 前台 App IO 优先级（be=best-effort, 0=最高）
ionice -c 2 -n 0 -p <foreground_pid>

# 后台同步/OTA 低优先级
ionice -c 2 -n 7 -p <ota_pid>
ionice -c 3 -p <backup_pid>    # idle 级别

# cgroup v2 IO 限流
echo "259:0 10485760" > /sys/fs/cgroup/background/io.max   # 后台限 10MB/s
```

**Trace 诊断方法：**
- `block_io_analysis` → 查看 IO 延迟分布和阻塞进程
- `io_pressure` → 查看系统级 IO 压力
- 关注 `direct reclaim` slice：`s.name GLOB '*direct reclaim*'`，出现即表示内存紧张导致同步 IO 等待

## 3. 内存水位（Watermark）调优

Linux 内存回收依赖三个水位线：`high`（开始后台回收）、`low`（加重回收）、`min`（直接回收/触发 LMK）。

### 水位线机制

```
可用内存
  │
  │  high ──── 开始 kswapd 后台回收
  │
  │  low  ──── kswapd 加重回收，唤醒 lmkd
  │
  │  min  ──── 直接回收（direct reclaim），前台卡顿！
  │
  └────────────── 0
```

### 低内存 TV 推荐配置

```bash
# 查看当前水位（单位：页）
cat /proc/zoneinfo | grep -A5 "Node 0, zone Normal" | grep -E "min|low|high|present|managed"

# 1GB 设备推荐（以页为单位，4KB/页）
# 总内存 ~262144 页，Normal zone ~200000 页
echo "18432 22528 26624" > /proc/sys/vm/min_free_kbytes   # 约 72MB/88MB/104MB
# 即 min=72MB, low=88MB, high=104MB

# 关键参数
echo 10 > /proc/sys/vm/swappiness          # 低内存 TV 尽量不用 swap，但保留少量应急
echo 3000 > /proc/sys/vm/vfs_cache_pressure # 加速 dentry/inode cache 回收
echo 1 > /proc/sys/vm/overcommit_memory     # 不允许过度分配
echo 50 > /proc/sys/vm/overcommit_ratio     # 限制 overcommit 比例
```

### LMK 策略配置

```xml
<!-- lowmem.mk 或 init.rc 中的 lmkd 配置 -->
<!-- 1GB 设备推荐（单位：页） -->
<property name="ro.lmk.low" value="1001" />        <!-- OOM_ADJ 开始杀的阈值 -->
<property name="ro.lmk.medium" value="800" />       <!-- 中等压力 -->
<property name="ro.lmk.critical" value="500" />     <!-- 紧急压力 -->
<property name="ro.lmk.debug" value="true" />       <!-- 开启 debug 日志 -->
```

**Trace 诊断方法：**
- `lmk_analysis` → LMK 杀进程频率、被杀进程 adj 等级
- 搜索 `direct reclaim` slice → 出现即内存水位过低
- `memory_analysis` → 可用内存趋势，观察是否频繁接近 min 水位
- `android_oom_adj_intervals` → 进程 adj 等级随时间变化

## 4. CPU 调度策略

低内存 TV 的 SoC 通常 CPU 核心少（4核）、频率低，调度优化直接影响前台流畅度。

### sched 调优

```bash
# 查看 CPU topology
cat /sys/devices/system/cpu/cpu*/topology/core_id

# HMP（异构多核）调优
echo 1 > /proc/sys/kernel/sched_boost           # 前台进程 boost
echo 20 > /proc/sys/kernel/sched_upmigrate      # 小核→大核迁移阈值（%）
echo 10 > /proc/sys/kernel/sched_downmigrate    # 大核→小核迁移阈值（%）

# schedtune（如支持）
echo "0-3:0 4-7:1" > /sys/devices/system/cpu/cpu*/schedtune/prefer_idle
```

### cgroup CPU 分配

```bash
# 前台组：更多 CPU 时间
echo 1024 > /sys/fs/cgroup/frontend/cpu.weight

# 后台组：限制 CPU
echo 128 > /sys/fs/cgroup/background/cpu.weight

# 后台大核限制（防止后台抢占大核）
echo "0-3" > /sys/fs/cgroup/background/cpuset.cpus   # 绑定小核
echo "0-7" > /sys/fs/cgroup/frontend/cpuset.cpus      # 前台可用全部核
```

### 频率调控（DVFS）

```bash
# 查看当前 governor
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# 低内存 TV 推荐 interactive / schedutil
echo schedutil > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

# 关键调优
echo 800000 > /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq  # 最低频率不宜太低
echo 50000 > /sys/devices/system/cpu/cpu0/cpufreq/schedutil/hispeed_load  # 50% 负载即提频
```

**Trace 诊断方法：**
- `cpu_analysis` → CPU 利用率和频率分布
- `cpu_frequency_counters` → 频率驻留时间
- `cpu_utilization_in_interval` → 时间段内 CPU 利用率
- `cpu_cluster_mapping_view` → 大小核利用率对比
- `thermal_throttling` → 温控降频检测

## 5. 线程调度优先级调整

TV 关键线程需要保证调度优先级，防止被后台任务抢占。

### 关键线程优先级映射

| 线程/进程 | 推荐优先级 | 调度策略 | 说明 |
|----------|-----------|---------|------|
| SurfaceFlinger 主线程 | SCHED_FIFO -4 | FIFO | 渲染管线核心，绝不能被抢占 |
| AudioFlinger / AudioTrack | SCHED_FIFO -2 | FIFO | 音频优先级最高，防止 underrun |
| HWUI RenderThread | nice -10 | SCHED_OTHER | 渲染线程需要高优先级 |
| InputDispatcher | nice -8 | SCHED_OTHER | 输入分发需要及时 |
| VoiceInteractionSession | nice -4 | SCHED_OTHER | 语音交互期间需要响应 |
| 语音算法线程 (cae_front/cae_back) | nice -6 | SCHED_OTHER | 讯飞算法线程需要实时性 |
| kswapd | nice 0 | SCHED_OTHER | 内存回收不要人为降低 |
| 后台同步/OTA | nice 18 | SCHED_OTHER + cgroup限制 | 最低优先级 |
| Dex2oat / 编译线程 | nice 19 | SCHED_OTHER + cgroup限制 | 后台编译不要影响前台 |

### 调优命令

```bash
# 查看关键线程优先级
ps -T -p <pid> -o pid,tid,name,nice,rtprio,sched

# 设置 SurfaceFlinger 为 FIFO
chrt -f -p 4 <sf_tid>

# 设置音频线程
chrt -f -p 2 <audio_tid>

# 设置 nice 值
renice -n -10 -p <hwui_tid>
renice -n 18 -p <ota_tid>

# cgroup 冻结非必要后台
echo 1 > /sys/fs/cgroup/frozen/cgroup.freeze
```

### Walleve 语音算法线程特殊处理

```
com.tcl.walleve 进程中的讯飞算法线程：
- cae_front: 建议 nice -6，保证算法处理及时
- cae_back:  建议 nice -6，与 cae_front 同级
- 两者都应放在 foreground cgroup，避免被绑到小核
```

**Trace 诊断方法：**
- `slice` 中搜索 `sched_wakeup` + `sched_switch` → 查看线程调度延迟
- 关注 RenderThread 被 D 状态（IO wait）阻塞的帧
- `lock_contention_analysis` → 锁竞争导致的高优先级线程等待
- `binder_analysis` → Binder 事务阻塞导致优先级翻转

## 6. 综合诊断流程

```
Step 1: 确认设备配置
  → 从 build.prop 获取 SoC 型号和内存大小
  → 确定是 1GB/1.5GB 紧张型还是 2GB+ 宽裕型

Step 2: 内存全景扫描
  → invoke_skill("memory_analysis") — RSS/PSS 全景
  → invoke_skill("lmk_analysis") — LMK 频次和被杀进程
  → invoke_skill("dmabuf_analysis") — GPU/DMA buffer 占用
  → 搜索 "direct reclaim" — 是否出现直接回收

Step 3: IO 压力评估
  → invoke_skill("block_io_analysis") — IO 延迟和吞吐
  → invoke_skill("io_pressure") — 系统级 IO 压力
  → 检查 direct reclaim 是否伴随 IO 尖峰

Step 4: CPU 调度分析
  → invoke_skill("cpu_analysis") — 利用率和频率
  → invoke_skill("cpu_cluster_mapping_view") — 大小核分布
  → invoke_skill("thermal_throttling") — 温控降频

Step 5: 关键线程调度检查
  → SurfaceFlinger / AudioFlinger 优先级
  → RenderThread 被抢占次数
  → 语音算法线程 (cae_front/cae_back) 调度延迟
  → 后台进程是否抢占大核

Step 6: 输出优化建议
  → 按上述 1-5 模块逐条给出具体调优参数
  → 标注优先级：P0（必须修）P1（建议修）P2（可选）
```

## 关键 SQL 查询

```sql
-- 查找 direct reclaim 事件（内存严重不足的信号）
SELECT slice.name, ts, dur, ROUND(dur/1e6, 2) AS dur_ms
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
WHERE slice.name GLOB '*direct reclaim*'
ORDER BY dur DESC LIMIT 50;

-- 查看各进程内存压力（RSS 分布）
SELECT process_name, SUM(size) / 1024 / 1024 AS total_mb
FROM (
  SELECT p.name AS process_name, sp.value AS size
  FROM counter c
  JOIN process_counter_track sp ON c.track_id = sp.id
  JOIN process p ON sp.upid = p.upid
  WHERE c.name GLOB '*rss*'
)
GROUP BY process_name
ORDER BY total_mb DESC LIMIT 20;

-- 查看线程调度延迟（高优先级线程被抢占）
SELECT t.name AS thread_name, p.name AS process_name,
       COUNT(*) AS preempt_count,
       ROUND(AVG(s.dur)/1e6, 2) AS avg_wait_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
LEFT JOIN process p ON t.upid = p.upid
WHERE s.name GLOB '*sched*wakeup*' AND s.dur > 1000000
GROUP BY thread_name
ORDER BY avg_wait_ms DESC LIMIT 30;

-- 查看音频线程调度情况
SELECT t.name AS thread_name, s.name, ts,
       ROUND(s.dur/1e6, 2) AS dur_ms
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
WHERE (t.name GLOB '*AudioFlinger*' OR t.name GLOB '*cae_front*' OR t.name GLOB '*cae_back*')
  AND s.dur > 5000000
ORDER BY s.dur DESC LIMIT 50;
```
