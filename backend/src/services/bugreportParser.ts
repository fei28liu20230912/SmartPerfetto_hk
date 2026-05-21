// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Bugreport Parser — 从 Android bugreport 中提取设备配置信息
 *
 * 支持:
 *   - bugreport-zip (标准 Android bugreport .zip)
 *   - bugreport-txt (已解压的 bugreport 文本)
 *
 * 提取:
 *   - SoC 平台 (ro.board.platform / ro.hardware)
 *   - 设备型号 (ro.product.model)
 *   - 内存总量 (MemTotal from /proc/meminfo)
 *   - OS 变体 (从进程列表和 build 属性推断)
 *   - CPU 拓扑 (核数、大小核)
 *   - GPU 驱动信息
 *   - 内存水位 (/proc/zoneinfo)
 *   - IO 调度器
 *   - LMK 配置 (ro.lmk.*)
 */

import { createReadStream } from 'fs';
import { readFile, stat, readdir } from 'fs/promises';
import { createUnzip } from 'zlib';
import { createReadStream as zipCreateReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join, basename } from 'path';
import type { Readable } from 'stream';

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface DeviceProfile {
  /** 设备型号, e.g. "32S5400AFK" */
  model: string | null;
  /** 设备品牌, e.g. "TCL" */
  brand: string | null;
  /** 设备名, e.g. "batman" */
  device: string | null;
  /** SoC 平台, e.g. "mt9221", "rt2881" */
  socPlatform: string | null;
  /** 硬件标识, e.g. "mt9221" */
  hardware: string | null;
  /** SoC 厂商推断: "mtk" | "rtk" | "unknown" */
  socVendor: 'mtk' | 'rtk' | 'unknown';
  /** 内存总量 MB */
  memoryTotalMb: number | null;
  /** 内存档位: "tight" (<1.5GB) | "moderate" (2GB) | "comfortable" (3GB+) */
  memoryTier: 'tight' | 'moderate' | 'comfortable' | 'unknown';
  /** OS 变体 */
  osVariant: 'firetv' | 'google_tv' | 'aosp_china' | 'aosp' | 'unknown';
  /** Android 版本 */
  androidVersion: string | null;
  /** SDK 版本 */
  sdkVersion: number | null;
  /** build fingerprint */
  buildFingerprint: string | null;
  /** CPU 核数 */
  cpuCoreCount: number | null;
  /** 是否有大小核 */
  hasBigLittle: boolean | null;
  /** GPU 驱动模块名 (mali / pvrsrvkm / unknown) */
  gpuDriver: 'mali' | 'pvrsrvkm' | 'unknown';
  /** 内存水位 min/low/high (KB), from /proc/zoneinfo Normal zone */
  memoryWatermarks: { min: number; low: number; high: number } | null;
  /** IO 调度器 */
  ioScheduler: string | null;
  /** CPU 频率信息 (kHz), from /sys/devices/system/cpu/cpu0/cpufreq */
  cpuFreq: { min: number; max: number } | null;
  /** vm.swappiness */
  swappiness: number | null;
  /** 内存压缩 zram 大小 MB */
  zramSizeMb: number | null;
  /** 页面缓存 readahead (KB) */
  readaheadKb: number | null;
  /** 显示分辨率, e.g. "3840x2160" */
  displayResolution: string | null;
  /** 刷新率, e.g. "60" */
  displayRefreshRate: string | null;
  /** GPU 渲染器 (from OpenGL ES), e.g. "Mali-G52" */
  gpuRenderer: string | null;
  /** 安全补丁级别 */
  securityPatch: string | null;
  /** build type, e.g. "user" / "userdebug" */
  buildType: string | null;
  /** 内核版本 */
  kernelVersion: string | null;
  /** LMK 配置 */
  lmkConfig: {
    low: number | null;
    medium: number | null;
    critical: number | null;
  };
  /** 语音助手标识 */
  voiceAssistant: 'vizzini' | 'katniss' | 'walleve' | 'unknown';
  /** 原始 build.prop 关键属性 (debug 用) */
  rawBuildProps: Record<string, string>;
}

export const EMPTY_DEVICE_PROFILE: DeviceProfile = {
  model: null,
  brand: null,
  device: null,
  socPlatform: null,
  hardware: null,
  socVendor: 'unknown',
  memoryTotalMb: null,
  memoryTier: 'unknown',
  osVariant: 'unknown',
  androidVersion: null,
  sdkVersion: null,
  buildFingerprint: null,
  cpuCoreCount: null,
  hasBigLittle: null,
  gpuDriver: 'unknown',
  memoryWatermarks: null,
  ioScheduler: null,
  cpuFreq: null,
  swappiness: null,
  zramSizeMb: null,
  readaheadKb: null,
  displayResolution: null,
  displayRefreshRate: null,
  gpuRenderer: null,
  securityPatch: null,
  buildType: null,
  kernelVersion: null,
  lmkConfig: { low: null, medium: null, critical: null },
  voiceAssistant: 'unknown',
  rawBuildProps: {},
};

// ────────────────────────────────────────────
// build.prop 解析
// ────────────────────────────────────────────

function parseBuildProps(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // Format 1: key=value (build.prop style)
    const eq = trimmed.indexOf('=');
    if (eq > 0 && !trimmed.startsWith('[')) {
      props[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
      continue;
    }

    // Format 2: [key]: [value] (getprop output in bugreport)
    const getpropMatch = trimmed.match(/^\[(.+?)\]:\s*\[(.*?)\]$/);
    if (getpropMatch) {
      props[getpropMatch[1]] = getpropMatch[2];
    }
  }
  return props;
}

function extractDeviceInfoFromProps(props: Record<string, string>): Partial<DeviceProfile> {
  const socPlatform = props['ro.board.platform']?.toLowerCase() || null;
  const hardware = props['ro.hardware']?.toLowerCase() || null;

  // 推断 SoC 厂商
  let socVendor: 'mtk' | 'rtk' | 'unknown' = 'unknown';
  const socId = socPlatform || hardware || '';
  if (socId.startsWith('mt') || socId.includes('mediatek')) {
    socVendor = 'mtk';
  } else if (socId.startsWith('rt') || socId.includes('realtek')) {
    socVendor = 'rtk';
  }

  // 推断 GPU
  const gpuDriver = props['ro.hardware.gpu']
    ? props['ro.hardware.gpu'].toLowerCase().includes('mali') ? 'mali' as const
      : props['ro.hardware.gpu'].toLowerCase().includes('powervr') ? 'pvrsrvkm' as const
      : 'unknown' as const
    : socVendor === 'mtk' ? 'mali' as const
    : socVendor === 'rtk' ? 'pvrsrvkm' as const
    : 'unknown' as const;

  // Android 版本
  const androidVersion = props['ro.build.version.release'] || null;
  const sdkVersion = props['ro.build.version.sdk'] ? parseInt(props['ro.build.version.sdk'], 10) : null;

  return {
    model: props['ro.product.model'] || null,
    brand: props['ro.product.brand'] || null,
    device: props['ro.product.device'] || null,
    socPlatform,
    hardware,
    socVendor,
    gpuDriver,
    androidVersion,
    sdkVersion,
    buildFingerprint: props['ro.build.fingerprint'] || null,
    rawBuildProps: props,
    lmkConfig: {
      low: props['ro.lmk.low'] ? parseInt(props['ro.lmk.low'], 10) : null,
      medium: props['ro.lmk.medium'] ? parseInt(props['ro.lmk.medium'], 10) : null,
      critical: props['ro.lmk.critical'] ? parseInt(props['ro.lmk.critical'], 10) : null,
    },
  };
}

// ────────────────────────────────────────────
// /proc/meminfo 解析
// ────────────────────────────────────────────

function parseMeminfo(text: string): { memoryTotalMb: number; memoryTier: DeviceProfile['memoryTier'] } {
  const match = text.match(/MemTotal:\s+(\d+)\s+kB/i);
  if (!match) return { memoryTotalMb: 0, memoryTier: 'unknown' };

  const totalKb = parseInt(match[1], 10);
  const totalMb = Math.round(totalKb / 1024);

  let memoryTier: DeviceProfile['memoryTier'] = 'unknown';
  if (totalMb < 1536) memoryTier = 'tight';       // < 1.5GB
  else if (totalMb < 2560) memoryTier = 'moderate'; // 1.5GB ~ 2.5GB
  else memoryTier = 'comfortable';                  // 3GB+

  return { memoryTotalMb: totalMb, memoryTier };
}

// ────────────────────────────────────────────
// /proc/zoneinfo 解析 (内存水位)
// ────────────────────────────────────────────

function parseZoneinfo(text: string): { min: number; low: number; high: number } | null {
  // 找 Normal zone
  const normalMatch = text.match(/Node \d+, zone\s+Normal\s*\n([\s\S]*?)(?=Node \d+, zone|$)/);
  if (!normalMatch) return null;

  const block = normalMatch[1];
  const minMatch = block.match(/^\s*min\s+(\d+)/m);
  const lowMatch = block.match(/^\s*low\s+(\d+)/m);
  const highMatch = block.match(/^\s*high\s+(\d+)/m);

  if (!minMatch || !lowMatch || !highMatch) return null;

  return {
    min: parseInt(minMatch[1], 10) * 4,   // pages → KB (4KB/page)
    low: parseInt(lowMatch[1], 10) * 4,
    high: parseInt(highMatch[1], 10) * 4,
  };
}

// ────────────────────────────────────────────
// /proc/cpuinfo 解析
// ────────────────────────────────────────────

function parseCpuinfo(text: string): { cpuCoreCount: number | null; hasBigLittle: boolean } {
  const processors = text.match(/processor\s*:/g);
  const cpuCoreCount = processors ? processors.length : 0;

  // 检查是否有不同的 CPU implementer/part (大小核标志)
  const parts = new Set<string>();
  const partRegex = /CPU part\s*:\s*(\w+)/g;
  let m;
  while ((m = partRegex.exec(text)) !== null) {
    parts.add(m[1]);
  }

  return {
    cpuCoreCount: cpuCoreCount > 0 ? cpuCoreCount : null,
    hasBigLittle: parts.size > 1,
  };
}

// ────────────────────────────────────────────
// 进程列表 → OS 变体推断
// ────────────────────────────────────────────

function inferOsVariant(processList: string[]): DeviceProfile['osVariant'] {
  const joined = processList.join(' ').toLowerCase();

  // FireTV 特征: Amazon 服务 + Vizzini
  const hasAmazon = joined.includes('amazon') || joined.includes('vizzini');
  // Google TV 特征: GMS + Katniss
  const hasGms = joined.includes('google') || joined.includes('gms') || joined.includes('katniss');
  // AOSP 国内: TCL 服务 + Walleve, 无 GMS
  const hasTcl = joined.includes('tcl') || joined.includes('walleve');

  if (hasAmazon && !hasGms) return 'firetv';
  if (hasGms) return 'google_tv';
  if (hasTcl && !hasGms) return 'aosp_china';

  return 'aosp';
}

/**
 * Infer OS variant from build properties (more reliable than process list).
 * Checks for Google TV, FireTV, or AOSP-specific indicators in getprop.
 */
function inferOsVariantFromProps(props: Record<string, string>): DeviceProfile['osVariant'] | null {
  const clientType = (props['ro.product.clientType'] || props['ro.boot.client_type'] || '').toLowerCase();
  const productType = (props['ro.tcl.product_type'] || '').toLowerCase();
  const gmsPresence = props['ro.com.google.clientidbase'] || '';
  const atraceApps = Object.entries(props)
    .filter(([k]) => k.startsWith('debug.atrace.app_'))
    .map(([, v]) => v.toLowerCase())
    .join(' ');

  // FireTV: Amazon-specific props
  if (clientType.includes('amazon') || atraceApps.includes('vizzini')) return 'firetv';

  // Google TV: GMS + Google apps present
  if (gmsPresence.includes('google') || atraceApps.includes('katniss') || atraceApps.includes('gms')) {
    return 'google_tv';
  }

  // AOSP China: TCL services but no GMS
  if (productType.includes('aosp') || atraceApps.includes('walleve')) return 'aosp_china';

  // If has TCL client type but also GMS → Google TV
  if (clientType.includes('tcl') && gmsPresence) return 'google_tv';

  return null;
}

// ────────────────────────────────────────────
// Voice assistant detection from trace process activity
// ────────────────────────────────────────────

const VOICE_PROCESS_PATTERNS: Array<{
  pattern: string;
  assistant: DeviceProfile['voiceAssistant'];
  label: string;
}> = [
  // Google TV Katniss — multiple sub-processes
  { pattern: 'com.google.android.katniss', assistant: 'katniss', label: 'Katniss (Google TV)' },
  // FireTV Vizzini
  { pattern: 'com.amazon.vizzini', assistant: 'vizzini', label: 'Vizzini (FireTV)' },
  // AOSP China — Walleve
  { pattern: 'com.tcl.walleve', assistant: 'walleve', label: 'Walleve (AOSP China)' },
  // Fallback: partial process name
  { pattern: 'katniss', assistant: 'katniss', label: 'Katniss (partial)' },
  { pattern: 'vizzini', assistant: 'vizzini', label: 'Vizzini (partial)' },
  { pattern: 'walleve', assistant: 'walleve', label: 'Walleve (partial)' },
];

/**
 * Detect voice assistant from trace via trace_processor SQL query.
 * Returns the assistant ID ('katniss'|'vizzini'|'walleve') or null if not found.
 *
 * SQL: list all distinct process names from the trace, then match against
 * known voice assistant package patterns.
 */
export async function inferVoiceAssistantFromTrace(
  traceId: string,
  queryFn: (sql: string) => Promise<{rows: Record<string, any>[]}>,
): Promise<{assistant: DeviceProfile['voiceAssistant']; processes: string[]} | null> {
  try {
    const result = await queryFn(
      `SELECT DISTINCT name FROM process WHERE name IS NOT NULL ORDER BY name`,
    );

    const processNames = (result.rows || []).map((r: Record<string, any>) => String(r.name));

    for (const { pattern, assistant, label } of VOICE_PROCESS_PATTERNS) {
      const matched = processNames.find(p => p.toLowerCase().includes(pattern));
      if (matched) {
        console.log(`[bugreport] Voice assistant detected from trace: ${label} (process: ${matched})`);
        return { assistant, processes: [matched] };
      }
    }

    // No voice assistant process found in trace
    if (processNames.length > 0) {
      console.log(`[bugreport] No voice assistant process found in trace (${processNames.length} processes scanned)`);
    }
    return null;
  } catch (err: any) {
    // Non-fatal: trace may not be loaded yet or query may fail
    console.log(`[bugreport] Trace query for voice assistant failed (non-fatal): ${err.message}`);
    return null;
  }
}

function inferVoiceAssistant(processList: string[]): DeviceProfile['voiceAssistant'] {
  const joined = processList.join(' ').toLowerCase();
  if (joined.includes('vizzini')) return 'vizzini';
  if (joined.includes('katniss')) return 'katniss';
  if (joined.includes('walleve')) return 'walleve';
  return 'unknown';
}

/**
 * Infer voice assistant from build props.
 * Checks atrace app list first, then scans all prop values for voice package names.
 */
function inferVoiceAssistantFromProps(props: Record<string, string>): DeviceProfile['voiceAssistant'] | null {
  // 1. Check atrace app list (explicit tracing config)
  const atraceApps = Object.entries(props)
    .filter(([k]) => k.startsWith('debug.atrace.app_'))
    .map(([, v]) => v.toLowerCase())
    .join(' ');

  if (atraceApps.includes('vizzini')) return 'vizzini';
  if (atraceApps.includes('katniss')) return 'katniss';
  if (atraceApps.includes('walleve')) return 'walleve';

  // 2. Scan all prop values for voice assistant package names
  const allValues = Object.values(props).join(' ').toLowerCase();

  // Check for specific package/process names in any prop value
  if (allValues.includes('com.google.android.katniss')) return 'katniss';
  if (allValues.includes('com.amazon.vizzini')) return 'vizzini';
  if (allValues.includes('com.tcl.walleve')) return 'walleve';

  // 3. Fallback: keyword scan for partial matches
  if (allValues.includes('katniss')) return 'katniss';
  if (allValues.includes('vizzini')) return 'vizzini';
  if (allValues.includes('walleve')) return 'walleve';

  return null;
}

// ────────────────────────────────────────────
// dumpsys proc stats → 进程列表提取
// ────────────────────────────────────────────

function extractProcessList(text: string): string[] {
  const processes = new Set<string>();
  // 匹配常见的进程名模式
  // "  * <pid> <uid> <state> <process_name>"
  const procRegex = /[\s*]+\d+\s+\d+\s+\w+\s+(\S+)/g;
  let m;
  while ((m = procRegex.exec(text)) !== null) {
    processes.add(m[1]);
  }

  // 也匹配 "Process LRU list" 段
  const lruSection = text.match(/Process LRU list[\s\S]*?(?=\n\n\D)/);
  if (lruSection) {
    const nameRegex = /([a-z][a-z0-9_.]*(?::[a-z_]+)?)/gi;
    let nm;
    while ((nm = nameRegex.exec(lruSection[0])) !== null) {
      if (nm[1].includes('.')) processes.add(nm[1]);
    }
  }

  return Array.from(processes);
}

// ────────────────────────────────────────────
// IO 调度器检测
// ────────────────────────────────────────────

function parseIoScheduler(text: string): string | null {
  // 从 dumpsys 或 /sys/block 内容中提取
  const match = text.match(/scheduler:\s*\[([^\]]+)\]/)
    || text.match(/io scheduler:\s*(\S+)/i);
  return match ? match[1] : null;
}

// ────────────────────────────────────────────
// Hidden params extraction helpers
// ────────────────────────────────────────────

function extractSwappiness(text: string): number | null {
  // Match /proc/sys/vm/swappiness lines or getprop [vm.swappiness]
  const match = text.match(/\/proc\/sys\/vm\/swappiness:\s*(\d+)/)
    || text.match(/\[vm\.swappiness\]:\s*\[(\d+)\]/)
    || text.match(/swappiness\s*[:=]\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function extractReadaheadKb(text: string): number | null {
  const match = text.match(/read_ahead_kb:\s*(\d+)/)
    || text.match(/readahead.*?:\s*(\d+)/i)
    || text.match(/\/proc\/sys\/vm\/readahead_ratio:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function extractZramSizeMb(text: string): number | null {
  // Look for zram disk size or swap total from meminfo
  const zramMatch = text.match(/zram.*?(?:disk[\s_]*)?size:\s*(\d+)/i);
  if (zramMatch) {
    const val = parseInt(zramMatch[1], 10);
    // Heuristic: if value > 10000 assume bytes, if > 100 assume KB
    if (val > 10_000_000) return Math.round(val / 1024 / 1024);
    if (val > 10_000) return Math.round(val / 1024);
    return val; // already MB
  }
  // Fallback: SwapTotal from meminfo
  const swapMatch = text.match(/SwapTotal:\s*(\d+)\s+kB/i);
  if (swapMatch) {
    const kb = parseInt(swapMatch[1], 10);
    if (kb > 0) return Math.round(kb / 1024);
  }
  return null;
}

function extractDisplayInfo(text: string): { resolution: string | null; refreshRate: string | null } {
  // Look in dumpsys display section for DisplayDeviceInfo
  const displaySection = text.match(/DUMP OF SERVICE display:[\s\S]*?(?=DUMP OF SERVICE|$)/i);
  const searchArea = displaySection ? displaySection[0] : text;

  // DisplayDeviceInfo typically has lines like:
  // "DisplayDeviceInfo{\"Built-in Screen\", ... width 3840, height 2160, ... refreshRate 60.0 ...}"
  const devMatch = searchArea.match(/DisplayDeviceInfo\{[^}]*?width\s+(\d+),\s*height\s+(\d+)/);
  const resolution = devMatch ? `${devMatch[1]}x${devMatch[2]}` : null;

  const refreshMatch = searchArea.match(/DisplayDeviceInfo\{[^}]*?refreshRate\s+([\d.]+)/);
  const refreshRate = refreshMatch ? refreshMatch[1].replace(/\.0$/, '') : null;

  return { resolution, refreshRate };
}

function extractGpuRenderer(text: string, props: Record<string, string>): string | null {
  // From dumpsys gpu or getprop
  const gpuMatch = text.match(/GLESRenderer:\s*(.+)/)
    || text.match(/GL_RENDERER:\s*(.+)/i)
    || text.match(/GPU renderer:\s*(.+)/i);
  if (gpuMatch) return gpuMatch[1].trim();

  // Infer from vulkan/gpu driver getprop
  const vulkan = props['ro.hardware.vulkan'];
  if (vulkan) {
    const v = vulkan.toLowerCase();
    if (v.includes('powervr') || v.includes('img')) return 'PowerVR';
    if (v.includes('mali')) return 'Mali';
    if (v.includes('adreno')) return 'Adreno';
  }

  // From gpuDriver already detected (pvrsrvkm → PowerVR, mali → Mali)
  // (caller should cross-reference, but we don't have gpuDriver here)

  // Fallback: chipname or platform (but only if it looks like a GPU name, not SoC)
  const chipname = props['ro.hardware.chipname'];
  if (chipname && /^(mali|adreno|powervr|sgx|img)/i.test(chipname)) return chipname;
  // Do NOT fall back to ro.board.platform — that's an SoC name, not GPU

  return null;
}

function extractCpuFreq(text: string): { min: number; max: number } | null {
  // Look for scaling_min_freq / scaling_max_freq or cpuinfo_min_freq / cpuinfo_max_freq
  const minMatch = text.match(/(?:scaling_min_freq|cpuinfo_min_freq):\s*(\d+)/);
  const maxMatch = text.match(/(?:scaling_max_freq|cpuinfo_max_freq):\s*(\d+)/);
  if (minMatch && maxMatch) {
    return { min: parseInt(minMatch[1], 10), max: parseInt(maxMatch[1], 10) };
  }
  return null;
}

function extractSecurityPatch(props: Record<string, string>): string | null {
  return props['ro.build.version.security_patch'] || null;
}

function extractBuildType(props: Record<string, string>): string | null {
  return props['ro.build.type'] || null;
}

function extractKernelVersion(text: string): string | null {
  const match = text.match(/^Kernel:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

// ────────────────────────────────────────────
// Bugreport 文本解析主入口
// ────────────────────────────────────────────

function parseBugreportText(text: string): DeviceProfile {
  const profile: DeviceProfile = { ...EMPTY_DEVICE_PROFILE };

  // 0. Extract build fingerprint from header (always available)
  // Format: "Build fingerprint: 'TCL/G10_4K_US_NF/G10:12/...'"
  const headerFpMatch = text.match(/^Build fingerprint:\s*'?([^'\n]+)'?/m);
  if (headerFpMatch) {
    profile.buildFingerprint = headerFpMatch[1];
    // Parse brand/model/device from fingerprint: "TCL/G10_4K_US_NF/G10:12/..."
    const fpParts = headerFpMatch[1].split('/');
    if (fpParts.length >= 2) {
      profile.brand = fpParts[0] || null;
      profile.device = fpParts[2]?.split(':')[0] || null;
    }
  }

  // 1. SYSTEM PROPERTIES — getprop format: [key]: [value]
  // Matches: "------ SYSTEM PROPERTIES (getprop) ------" ... "------ 0.xxxs was the duration ------"
  const buildPropsMatch = text.match(
    /------\s*SYSTEM PROPERTIES[^-]*------\n([\s\S]*?)(?=\n------\s)/
  );
  if (buildPropsMatch) {
    const props = parseBuildProps(buildPropsMatch[1]);
    Object.assign(profile, extractDeviceInfoFromProps(props));
  }

  // 2. /proc/meminfo — "------ MEMORY INFO (/proc/meminfo) ------"
  const meminfoMatch = text.match(
    /------\s*MEMORY INFO\s*\(\/proc\/meminfo\)\s*------\n([\s\S]*?)(?=\n------)/
  ) || text.match(
    /MemTotal:[\s\S]*?MemFree:/m
  );
  if (meminfoMatch) {
    const meminfo = parseMeminfo(meminfoMatch[0] || meminfoMatch[1]);
    profile.memoryTotalMb = meminfo.memoryTotalMb;
    profile.memoryTier = meminfo.memoryTier;
  }

  // 3. CPU info — try /proc/cpuinfo section, fallback to kernel cmdline + dumpsys
  const cpuinfoMatch = text.match(
    /------\s*CPU INFO\s*\(\/proc\/cpuinfo\)\s*------\n([\s\S]*?)(?=\n------)/
  ) || text.match(
    /\/proc\/cpuinfo:[\s\S]*?\n([\s\S]*?)(?=\n[^\s]|\n------|$)/
  );
  if (cpuinfoMatch) {
    const cpuinfo = parseCpuinfo(cpuinfoMatch[1]);
    profile.cpuCoreCount = cpuinfo.cpuCoreCount;
    profile.hasBigLittle = cpuinfo.hasBigLittle;
  }
  // Fallback: extract CPU core count from kernel command line "mc=N"
  if (!profile.cpuCoreCount) {
    const mcMatch = text.match(/(?:^|\s)mc=(\d+)(?:\s|$)/m);
    if (mcMatch) profile.cpuCoreCount = parseInt(mcMatch[1], 10);
  }
  // Fallback: RTK bugreports have "CPU INFO (top ...)" with N%cpu line
  if (!profile.cpuCoreCount) {
    const topCpuMatch = text.match(/(\d+)%cpu\s/);
    if (topCpuMatch) {
      const pct = parseInt(topCpuMatch[1], 10);
      // 400% = 4 cores, 100% = 1 core, round to nearest integer
      if (pct >= 100) profile.cpuCoreCount = Math.round(pct / 100);
    }
  }
  // Fallback: count ksoftirqd/N kernel threads (one per CPU core)
  if (!profile.cpuCoreCount) {
    const ksoftirqdMatches = text.match(/\[ksoftirqd\/\d+\]/g);
    if (ksoftirqdMatches) {
      const cores = new Set(ksoftirqdMatches.map(m => m.match(/ksoftirqd\/(\d+)/)?.[1]));
      if (cores.size > 0) profile.cpuCoreCount = cores.size;
    }
  }

  // 4. /proc/zoneinfo — "------ ZONEINFO (/proc/zoneinfo) ------"
  const zoneinfoMatch = text.match(
    /------\s*ZONEINFO\s*\(\/proc\/zoneinfo\)\s*------\n([\s\S]*?)(?=\n------)/
  ) || text.match(
    /\/proc\/zoneinfo:[\s\S]*?\n([\s\S]*?)(?=\n[^\s]|\n------|$)/
  );
  if (zoneinfoMatch) {
    profile.memoryWatermarks = parseZoneinfo(zoneinfoMatch[1]);
  }

  // 5. OS 变体推断 — prefer props-based inference, fallback to process list
  let extractedProps: Record<string, string> | null = null;
  if (buildPropsMatch) {
    extractedProps = parseBuildProps(buildPropsMatch[1]);
  }
  const processList = extractProcessList(text);

  // Try props-based first (more reliable, works even without process list)
  if (extractedProps) {
    const fromProps = inferOsVariantFromProps(extractedProps);
    profile.osVariant = fromProps || inferOsVariant(processList);
  } else {
    profile.osVariant = inferOsVariant(processList);
  }

  // Voice assistant inference — prefer props, fallback to process list
  if (extractedProps) {
    const fromProps = inferVoiceAssistantFromProps(extractedProps);
    profile.voiceAssistant = fromProps || inferVoiceAssistant(processList);
  } else {
    profile.voiceAssistant = inferVoiceAssistant(processList);
  }

  // 6. IO 调度器
  const ioSched = parseIoScheduler(text);
  if (ioSched) profile.ioScheduler = ioSched;

  // 7. Hidden params extraction
  const resolvedProps = extractedProps || (buildPropsMatch ? parseBuildProps(buildPropsMatch[1]) : {});

  profile.cpuFreq = extractCpuFreq(text);
  profile.swappiness = extractSwappiness(text);
  profile.readaheadKb = extractReadaheadKb(text);
  profile.zramSizeMb = extractZramSizeMb(text);

  const displayInfo = extractDisplayInfo(text);
  profile.displayResolution = displayInfo.resolution;
  profile.displayRefreshRate = displayInfo.refreshRate;

  profile.gpuRenderer = extractGpuRenderer(text, resolvedProps);
  profile.securityPatch = extractSecurityPatch(resolvedProps);
  profile.buildType = extractBuildType(resolvedProps);
  profile.kernelVersion = extractKernelVersion(text);

  return profile;
}

// ────────────────────────────────────────────
// Zip 解压 + 解析
// ────────────────────────────────────────────

/**
 * 检测是否是 zip 格式 (magic bytes: PK\x03\x04)
 */
export async function isZipFile(filePath: string): Promise<boolean> {
  const { createReadStream } = await import('fs');
  return new Promise((resolve) => {
    const stream = createReadStream(filePath, { start: 0, end: 3 });
    stream.on('data', (buf: Buffer) => {
      resolve(buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04);
    });
    stream.on('error', () => resolve(false));
  });
}

/**
 * 从 zip 中提取 bugreport 文本文件
 * 使用系统 unzip 命令 (比 JS zip 库更可靠)
 */
async function extractBugreportFromZip(zipPath: string): Promise<string | null> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const tmpDir = `/tmp/bugreport_extract_${Date.now()}`;

  try {
    // 列出 zip 内容，找 bugreport txt
    const { stdout } = await execFileAsync('unzip', ['-l', zipPath]);
    const txtMatch = stdout.match(/(bugreport-[\w.-]+\.txt)/m);
    if (!txtMatch) return null;

    const txtName = txtMatch[1];

    // 解压到临时目录
    await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', tmpDir]);

    // 读取文本内容（前 10MB 足够提取设备信息）
    const txtPath = join(tmpDir, txtName);
    const { createReadStream: crs } = await import('fs');
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const MAX_READ = 10 * 1024 * 1024; // 10MB

    await new Promise<void>((resolve, reject) => {
      const stream = crs(txtPath);
      stream.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize <= MAX_READ) chunks.push(chunk);
        else stream.destroy();
      });
      stream.on('close', () => resolve());
      stream.on('error', reject);
    });

    // 清理临时目录
    await execFileAsync('rm', ['-rf', tmpDir]);

    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    // 清理
    try { await execFileAsync('rm', ['-rf', tmpDir]); } catch { /* ignore */ }
    return null;
  }
}

// ────────────────────────────────────────────
// Large bugreport reader — targeted section extraction
// ────────────────────────────────────────────

/** Section markers to search for, each as a regex pattern */
const SECTION_MARKERS = [
  /------\s*SYSTEM PROPERTIES\s*\(getprop\)\s*------/,
  /------\s*MEMORY INFO\s*\(\/proc\/meminfo\)\s*------/,
  /------\s*CPU INFO\s*\(\/proc\/cpuinfo\)\s*------/,
  /------\s*ZONEINFO\s*\(\/proc\/zoneinfo\)\s*------/,
  /------\s*CPU INFO\s*------/,
  /------\s*SYSTEM PROPERTIES\s*------/,
  /------\s*MEMORY INFO\s*------/,
  /------\s*ZONEINFO\s*------/,
];

const SECTION_END = /------\s/;

/**
 * Read a large bugreport text file by assembling header + key sections.
 * Pass 1: first 512KB (header with fingerprint, build info).
 * Pass 2: scan for section markers via line-by-line read, extract each section.
 */
async function readBugreportText(filePath: string): Promise<string> {
  const { createReadStream } = await import('fs');
  const { stat } = await import('fs/promises');

  const { size: fileSize } = await stat(filePath);

  // Phase 1: Read first 512KB for header
  const HEADER_SIZE = 512 * 1024;
  const headerChunks: Buffer[] = [];
  let headerBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf-8', end: HEADER_SIZE });
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      headerBytes += buf.length;
      headerChunks.push(buf);
    });
    stream.on('close', () => resolve());
    stream.on('error', reject);
  });

  const parts: string[] = [Buffer.concat(headerChunks).toString('utf-8')];

  // Phase 2: Line-by-line scan to find and extract key sections
  // We only need sections not already in the header
  const headerText = parts[0];

  // Check which sections are already in header
  const foundInHeader = new Set<string>();
  for (const marker of SECTION_MARKERS) {
    if (marker.test(headerText)) {
      foundInHeader.add(marker.source);
    }
  }

  // If all sections found in header or file is small, skip phase 2
  const allFound = SECTION_MARKERS.every(m => foundInHeader.has(m.source));
  if (allFound || fileSize <= HEADER_SIZE) {
    return parts[0];
  }

  // Phase 2: scan for missing sections
  const sectionChunks: string[] = [];
  let inTargetSection = false;
  let currentSectionLines: string[] = [];
  let lineCount = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    let remainder = '';

    stream.on('data', (chunk: string) => {
      remainder += chunk;
      const lines = remainder.split('\n');
      // Keep last incomplete line
      remainder = lines.pop() || '';

      for (const line of lines) {
        lineCount++;

        if (!inTargetSection) {
          // Check if this line starts a section we need
          for (const marker of SECTION_MARKERS) {
            if (marker.test(line)) {
              // Check if already in header
              if (!foundInHeader.has(marker.source)) {
                inTargetSection = true;
                currentSectionLines = [line];
              }
              break;
            }
          }
        } else {
          currentSectionLines.push(line);
          // Check if this line ends the section
          if (SECTION_END.test(line) && !currentSectionLines[0]?.includes(line.trim())) {
            inTargetSection = false;
            sectionChunks.push(currentSectionLines.join('\n'));
            currentSectionLines = [];
          }
        }
      }
    });

    stream.on('close', () => {
      // Flush remaining
      if (inTargetSection && currentSectionLines.length > 0) {
        sectionChunks.push(currentSectionLines.join('\n'));
      }
      resolve();
    });
    stream.on('error', reject);
  });

  // Combine header + extracted sections
  if (sectionChunks.length > 0) {
    parts.push('\n\n', ...sectionChunks);
  }

  return parts.join('');
}

// ────────────────────────────────────────────
// 公开 API
// ────────────────────────────────────────────

/**
 * 解析 bugreport 文件，返回设备配置信息
 *
 * @param filePath bugreport 文件路径 (.zip 或 .txt)
 * @returns DeviceProfile
 */
export async function parseBugreportFile(filePath: string): Promise<DeviceProfile> {
  try {
    const isZip = await isZipFile(filePath);

    let text: string | null = null;

    if (isZip) {
      text = await extractBugreportFromZip(filePath);
    } else {
      // Two-pass strategy for large bugreports:
      // Pass 1: read first 1MB for header (fingerprint, build info)
      // Pass 2: scan for key sections (meminfo, cpuinfo, zoneinfo, system properties)
      //         using targeted byte-range reads guided by section markers
      text = await readBugreportText(filePath);
    }

    if (!text) return { ...EMPTY_DEVICE_PROFILE };

    return parseBugreportText(text);
  } catch (err) {
    console.error('[bugreportParser] Failed to parse bugreport:', err);
    return { ...EMPTY_DEVICE_PROFILE };
  }
}

/**
 * 将 DeviceProfile 格式化为 AI agent 可读的摘要文本
 * 用于注入到 system prompt 中
 */
export function formatDeviceProfileForPrompt(profile: DeviceProfile): string {
  const lines: string[] = [];

  lines.push('## 设备配置信息 (from Bugreport)');
  lines.push('');

  if (profile.brand || profile.model) {
    lines.push(`- 设备: ${profile.brand || '?'} ${profile.model || '?'}`);
  }
  if (profile.socPlatform) {
    lines.push(`- SoC: ${profile.socPlatform.toUpperCase()} (${profile.socVendor.toUpperCase()})`);
  }
  if (profile.memoryTotalMb) {
    lines.push(`- 内存: ${profile.memoryTotalMb}MB (${profile.memoryTier})`);
  }
  if (profile.osVariant !== 'unknown') {
    const osLabel = {
      firetv: 'FireTV (Amazon)',
      google_tv: 'Google TV (含 GMS)',
      aosp_china: 'AOSP 国内 (无 GMS)',
      aosp: 'AOSP',
    }[profile.osVariant];
    lines.push(`- OS: ${osLabel}`);
  }
  if (profile.androidVersion) {
    lines.push(`- Android: ${profile.androidVersion} (SDK ${profile.sdkVersion || '?'})`);
  }
  if (profile.cpuCoreCount) {
    lines.push(`- CPU: ${profile.cpuCoreCount} 核${profile.hasBigLittle ? ' (大小核)' : ''}`);
  }
  lines.push(`- GPU: ${profile.gpuDriver === 'mali' ? 'Mali (MTK)' : profile.gpuDriver === 'pvrsrvkm' ? 'PowerVR (RTK)' : profile.gpuDriver}`);
  if (profile.voiceAssistant !== 'unknown') {
    const voiceMap = { vizzini: 'Vizzini (FireTV)', katniss: 'Katniss (Google TV)', walleve: 'Walleve (AOSP, 讯飞)' };
    lines.push(`- 语音助手: ${voiceMap[profile.voiceAssistant] || profile.voiceAssistant}`);
  }
  if (profile.ioScheduler) {
    lines.push(`- IO 调度器: ${profile.ioScheduler}`);
  }
  if (profile.cpuFreq) {
    lines.push(`- CPU 频率: ${profile.cpuFreq.min} kHz ~ ${profile.cpuFreq.max} kHz (${Math.round(profile.cpuFreq.max / 1000)} MHz ~ ${Math.round(profile.cpuFreq.min / 1000)} MHz)`);
  }
  if (profile.swappiness !== null) {
    lines.push(`- vm.swappiness: ${profile.swappiness}`);
  }
  if (profile.zramSizeMb !== null) {
    lines.push(`- Zram 大小: ${profile.zramSizeMb}MB`);
  }
  if (profile.readaheadKb !== null) {
    lines.push(`- 页面缓存 readahead: ${profile.readaheadKb}KB`);
  }
  if (profile.displayResolution) {
    lines.push(`- 显示分辨率: ${profile.displayResolution}`);
  }
  if (profile.displayRefreshRate) {
    lines.push(`- 刷新率: ${profile.displayRefreshRate}Hz`);
  }
  if (profile.gpuRenderer) {
    lines.push(`- GPU 渲染器: ${profile.gpuRenderer}`);
  }
  if (profile.securityPatch) {
    lines.push(`- 安全补丁: ${profile.securityPatch}`);
  }
  if (profile.buildType) {
    lines.push(`- Build 类型: ${profile.buildType}`);
  }
  if (profile.kernelVersion) {
    lines.push(`- 内核版本: ${profile.kernelVersion}`);
  }
  if (profile.memoryWatermarks) {
    lines.push(`- 内存水位: min=${profile.memoryWatermarks.min}KB / low=${profile.memoryWatermarks.low}KB / high=${profile.memoryWatermarks.high}KB`);
  }
  if (profile.lmkConfig.low || profile.lmkConfig.critical) {
    lines.push(`- LMK 配置: low=${profile.lmkConfig.low || '?'} / medium=${profile.lmkConfig.medium || '?'} / critical=${profile.lmkConfig.critical || '?'}`);
  }

  if (profile.buildFingerprint) {
    lines.push(`- Build: ${profile.buildFingerprint}`);
  }

  lines.push('');

  // 配置敏感的建议
  lines.push('### 分析建议');
  if (profile.memoryTier === 'tight') {
    lines.push('- ⚠️ 低内存设备，必须优先跑 low_memory_optimization skill');
    lines.push('- 关注 LMK 频次、direct reclaim、常驻内存审计');
  }
  if (profile.socVendor === 'rtk') {
    lines.push('- RTK 平台，GPU 合成路径与 MTK 不同，关注 HWC Client/GPU 合成比例');
  }
  if (profile.osVariant === 'google_tv' && profile.memoryTier === 'tight') {
    lines.push('- ⚠️ Google TV + 低内存，GMS 常驻开销大，重点审计 GMS 进程内存');
  }
  if (profile.voiceAssistant === 'walleve') {
    lines.push('- 语音算法线程 cae_front/cae_back (讯飞)，关注调度优先级');
  }

  lines.push('');
  lines.push('### 使用要求');
  lines.push('- 以上设备参数来自 Bugreport，在分析报告的**诊断摘要**和**优化建议**中必须引用相关参数');
  lines.push('- 提优化建议时需结合设备配置（如低内存设备建议降低缓存、RTK 平台建议调优 HWC 合成策略）');
  lines.push('- 如果分析中发现需要但 trace 中缺失的信息（如 LMK 阈值、swappiness、IO 调度器），应优先从此设备配置中获取');

  return lines.join('\n');
}
