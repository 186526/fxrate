// 共享 benchmark 工具：参数解析、分位数统计、环境信息、JSON 输出。
// 所有 benchmark 的输出只写入 caller 提供的 --output 路径（/tmp 下），绝不写仓库。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export interface BenchmarkEnvironment {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
    totalMemMb: number;
    pid: number;
}

export function environment(): BenchmarkEnvironment {
    return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
        pid: process.pid,
    };
}

export function parseCsvNumbers(input: string): number[] {
    return input
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
}

export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export interface SampleStats {
    samples: number;
    meanMs: number;
    p50: number;
    p95: number;
    p99: number;
}

export function summarize(samplesMs: number[]): SampleStats {
    const sorted = [...samplesMs].sort((a, b) => a - b);
    const mean =
        sorted.length === 0
            ? 0
            : sorted.reduce((acc, value) => acc + value, 0) / sorted.length;
    return {
        samples: sorted.length,
        meanMs: mean,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
    };
}

export function writeJson(outputPath: string, data: unknown): void {
    if (!outputPath) {
        throw new Error(
            '--output path is required: benchmark JSON is written only to caller-provided paths',
        );
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// mulberry32：确定性伪随机，同一 seed 产生完全相同的查询序列（可复现对比的前提）。
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function randomInt(rng: () => number, min: number, max: number): number {
    return min + Math.floor(rng() * (max - min));
}

export function heapUsedMb(): number {
    return process.memoryUsage().heapUsed / 1024 / 1024;
}

// 需要 node --expose-gc 或 NODE_OPTIONS=--expose-gc；缺失时返回 false（测量降级为非精确）。
export function forceGc(): boolean {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc === 'function') {
        gc();
        return true;
    }
    return false;
}

export interface EventLoopLagStats {
    samples: number;
    maxMs: number;
    p95Ms: number;
}

// 事件循环延迟探针：node:perf_hooks 的 monitorEventLoopDelay（零依赖，内核 timer 采样），
// 在 start()/stop() 窗口内累计事件循环被同步工作（如后台 snapshot stringify）阻塞的时长。
// 返回毫秒统计（内核按纳秒累计，这里统一换算为 ms，与其余 benchmark 指标同单位）。
export function createEventLoopLagProbe(): {
    start: () => void;
    stop: () => EventLoopLagStats;
} {
    let histogram: IntervalHistogram | null = null;
    return {
        start() {
            histogram = monitorEventLoopDelay({ resolution: 1 });
            histogram.enable();
        },
        stop() {
            if (histogram === null) return { samples: 0, maxMs: 0, p95Ms: 0 };
            histogram.disable();
            const stats: EventLoopLagStats = {
                samples: histogram.count,
                maxMs: histogram.max / 1e6,
                p95Ms: histogram.percentile(95) / 1e6,
            };
            histogram = null;
            return stats;
        },
    };
}
