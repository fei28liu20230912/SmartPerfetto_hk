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
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      props[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
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
  if (hasGms) return 'google_tv';

  return 'aosp';
}

function inferVoiceAssistant(processList: string[]): DeviceProfile['voiceAssistant'] {
  const joined = processList.join(' ').toLowerCase();
  if (joined.includes('vizzini')) return 'vizzini';
  if (joined.includes('katniss')) return 'katniss';
  if (joined.includes('walleve')) return 'walleve';
  return 'unknown';
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
// Bugreport 文本解析主入口
// ────────────────────────────────────────────

function parseBugreportText(text: string): DeviceProfile {
  const profile: DeviceProfile = { ...EMPTY_DEVICE_PROFILE };

  // 1. build.prop 段
  const buildPropsMatch = text.match(
    /------ SYSTEM PROPERTIES[\s\S]*?------([\s\S]*?)(?=------|$)/
  );
  if (buildPropsMatch) {
    const props = parseBuildProps(buildPropsMatch[1]);
    Object.assign(profile, extractDeviceInfoFromProps(props));
  }

  // 2. /proc/meminfo 段
  const meminfoMatch = text.match(
    /------ \d+\.\d+ .+ was the start of a new incident[\s\S]*?\/proc\/meminfo[\s\S]*?\n([\s\S]*?)(?=\n[^\s]|\n------|$)/
  ) || text.match(
    /MemTotal:[\s\S]*?MemFree:/m
  );
  if (meminfoMatch) {
    const meminfo = parseMeminfo(meminfoMatch[0] || meminfoMatch[1]);
    profile.memoryTotalMb = meminfo.memoryTotalMb;
    profile.memoryTier = meminfo.memoryTier;
  }

  // 3. /proc/cpuinfo 段
  const cpuinfoMatch = text.match(
    /\/proc\/cpuinfo:[\s\S]*?\n([\s\S]*?)(?=\n[^\s]|\n------|$)/
  );
  if (cpuinfoMatch) {
    const cpuinfo = parseCpuinfo(cpuinfoMatch[1]);
    profile.cpuCoreCount = cpuinfo.cpuCoreCount;
    profile.hasBigLittle = cpuinfo.hasBigLittle;
  }

  // 4. /proc/zoneinfo 段
  const zoneinfoMatch = text.match(
    /\/proc\/zoneinfo:[\s\S]*?\n([\s\S]*?)(?=\n[^\s]|\n------|$)/
  );
  if (zoneinfoMatch) {
    profile.memoryWatermarks = parseZoneinfo(zoneinfoMatch[1]);
  }

  // 5. 进程列表 → OS 变体
  const processList = extractProcessList(text);
  profile.osVariant = inferOsVariant(processList);
  profile.voiceAssistant = inferVoiceAssistant(processList);

  // 6. IO 调度器
  const ioSched = parseIoScheduler(text);
  if (ioSched) profile.ioScheduler = ioSched;

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
      // 直接读取文本文件 (前 10MB)
      const { createReadStream: crs } = await import('fs');
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const MAX_READ = 10 * 1024 * 1024;

      await new Promise<void>((resolve, reject) => {
        const stream = crs(filePath, { encoding: 'utf-8' });
        stream.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalSize += buf.length;
          if (totalSize <= MAX_READ) chunks.push(buf);
          else stream.destroy();
        });
        stream.on('close', () => resolve());
        stream.on('error', reject);
      });

      text = Buffer.concat(chunks).toString('utf-8');
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

  return lines.join('\n');
}
