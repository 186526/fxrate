// persistence-writer（Phase 5 优化 #8）：节流异步快照写入器基准（完全离线）。
// 覆盖 plan §10.5 阈值：1,000 次 enqueue 在 throttle 窗口内实际写入<=2 次；
// 分别记录 1/10MiB snapshot 的 enqueue p50/p95、后台写入 duration、event-loop lag
// （baseline vs 写入中）与 shutdown flush duration；writer 期间请求路径 p95 相比
// 无落盘 baseline 恶化<=10%；最终文件可解析且无残留临时文件。
// 合成快照 + 临时目录 + 注入 save（包一层真实 saveSnapshotAsync），零公网访问。
// 用法：yarn tsx benchmark/persistence-writer.ts --updates=1000 --snapshot-bytes=1048576,10485760 --throttle-ms=1000 --output=/tmp/fxrate-benchmark/persistence-writer.json

import esMain from 'es-main';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { saveSnapshotAsync, type SnapshotData } from '../src/persistence';
import { SnapshotWriter } from '../src/persistenceWriter';
import {
    createEventLoopLagProbe,
    environment,
    parseCsvNumbers,
    seededRandom,
    sleep,
    summarize,
    writeJson,
    type SampleStats,
} from './common';

export interface PersistenceWriterOptions {
    updates: number;
    snapshotBytes: number[];
    throttleMs: number;
    seed: number;
    output: string;
    flushDeadlineMs: number;
}

export function parseOptions(args: string[]): PersistenceWriterOptions {
    const { values } = parseArgs({
        args,
        strict: false,
        options: {
            updates: { type: 'string', default: '1000' },
            'snapshot-bytes': { type: 'string', default: '1048576,10485760' },
            'throttle-ms': { type: 'string', default: '1000' },
            seed: { type: 'string', default: '20260804' },
            'flush-deadline-ms': { type: 'string', default: '2000' },
            output: { type: 'string' },
        },
    });
    return {
        updates: Math.max(1, Math.round(Number(values.updates) || 1000)),
        snapshotBytes: parseCsvNumbers(
            String(values['snapshot-bytes'] ?? '1048576'),
        ),
        throttleMs: Math.max(
            1,
            Math.round(Number(values['throttle-ms']) || 1000),
        ),
        seed: Number(values.seed) || 20260804,
        output: typeof values.output === 'string' ? values.output : '',
        flushDeadlineMs: Math.max(
            1,
            Math.round(Number(values['flush-deadline-ms']) || 2000),
        ),
    };
}

// ISO 风格 3 位货币代码（与生产快照一致）；64 个 → 每源 4032 个去自对格子。
const CURRENCIES = [
    'AED',
    'ARS',
    'AUD',
    'BGN',
    'BHD',
    'BND',
    'BRL',
    'CAD',
    'CHF',
    'CLP',
    'CNY',
    'COP',
    'CZK',
    'DKK',
    'DZD',
    'EGP',
    'EUR',
    'GBP',
    'HKD',
    'HUF',
    'IDR',
    'ILS',
    'INR',
    'IQD',
    'IRR',
    'ISK',
    'JOD',
    'JPY',
    'KES',
    'KRW',
    'KWD',
    'KZT',
    'LBP',
    'LKR',
    'MAD',
    'MXN',
    'MYR',
    'NGN',
    'NOK',
    'NZD',
    'OMR',
    'PEN',
    'PHP',
    'PKR',
    'PLN',
    'QAR',
    'RON',
    'RUB',
    'SAR',
    'SEK',
    'SGD',
    'THB',
    'TRY',
    'TWD',
    'UAH',
    'USD',
    'UYU',
    'VND',
    'XCD',
    'ZAR',
    'CUP',
    'JMD',
    'TZS',
    'UGS',
];
// 最多 32 个抓取型源 × 每源全对矩阵 ≈ 129k 格（约 11.7MiB），足以覆盖 10MiB 目标。
const SNAPSHOT_SOURCE_COUNT = 32;

// 确定性合成快照：目标字节大小的 {source:{from:{to:{middle,cash,remit,updated}}}}。
// 与生产 dumpSnapshot 同构（抓取型源 × 货币对），reviver/校验契约兼容。
function buildSnapshot(targetBytes: number, rng: () => number): SnapshotData {
    // 单元格用 loose 类型构建（number 报价即可量字节/往返），返回时收敛为 SnapshotData。
    const sources: Record<string, Record<string, Record<string, unknown>>> = {};
    const updated = new Date('2026-08-04T00:00:00.000Z');
    let cellCount = 0;
    let bytes = 0;
    outer: for (
        let sourceIdx = 0;
        sourceIdx < SNAPSHOT_SOURCE_COUNT;
        sourceIdx += 1
    ) {
        const source = `bank-${sourceIdx + 1}`;
        for (const from of CURRENCIES) {
            for (const to of CURRENCIES) {
                if (from === to) continue;
                const base = 6.5 + rng() * 0.9;
                sources[source] ??= {};
                sources[source]![from] ??= {};
                sources[source]![from]![to] = {
                    middle: base,
                    cash: base - 0.02 - rng() * 0.01,
                    remit: base + 0.02 + rng() * 0.01,
                    updated,
                };
                cellCount += 1;
                // 每 4000 格（约一个源）量一次实际字节，达标即停
                if (cellCount % 4000 === 0) {
                    bytes = Buffer.byteLength(JSON.stringify(sources), 'utf-8');
                    if (bytes >= targetBytes) break outer;
                }
            }
        }
    }
    return sources as unknown as SnapshotData;
}

// 模拟 JSON-RPC handler 的请求路径：小对象 stringify + parse（真实请求路径无大块同步工作）。
// 单次采样做 10 轮，把每样本时长抬到 ~0.3ms 量级——比 setImmediate 调度抖动高一个数量级，
// 让 p50/p95 落在稳定的绝对值上，避免 20µs 尺度下百分位被调度噪声左右。
const REQUEST_PAYLOAD = {
    jsonrpc: '2.0',
    id: 1,
    result: {
        status: 'ok',
        source: 'mock',
        currency: ['USD', 'CNY'],
        date: '2026-08-04T00:00:00.000Z',
    },
};

function requestPathSample(): void {
    for (let i = 0; i < 10; i += 1) {
        const serialized = JSON.stringify(REQUEST_PAYLOAD);
        JSON.parse(serialized);
    }
}

// 异步请求路径采样（并发 worker，按时间窗）：模拟负载下的 JSON-RPC handler——
// 每次请求先 setImmediate 让出事件循环再做小工作，4 个 worker 并发跑满整个采样窗。
// 后台 stringify 同步阻塞事件循环时，正在等待的请求被如实延迟。采样窗取 throttle
// 窗口量级，被阻塞的请求占比 = 阻塞时长/窗口时长，p50/p95/p99 如实反映请求路径代价
// （单次短阻塞对 p95 无影响，长阻塞则如实显现——这正是 plan §10.5 要度量的）。
const REQUEST_PATH_CONCURRENCY = 4;

async function measureRequestPathAsync(windowMs: number): Promise<SampleStats> {
    const latencies: number[] = [];
    const windowStart = Date.now();
    const worker = async (): Promise<void> => {
        while (Date.now() - windowStart < windowMs) {
            const start = process.hrtime.bigint();
            await new Promise<void>((resolve) => setImmediate(resolve));
            requestPathSample();
            latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
        }
    };
    await Promise.all(
        Array.from({ length: REQUEST_PATH_CONCURRENCY }, () => worker()),
    );
    return summarize(latencies);
}

interface SaveProbe {
    writesMs: number[];
    count: number;
    active: boolean;
}

function trackingSave(
    probe: SaveProbe,
    cacheFile: string,
): (sources: SnapshotData) => Promise<void> {
    return async (sources: SnapshotData): Promise<void> => {
        probe.active = true;
        probe.count += 1;
        const start = process.hrtime.bigint();
        try {
            await saveSnapshotAsync(sources, cacheFile);
        } finally {
            probe.writesMs.push(Number(process.hrtime.bigint() - start) / 1e6);
            probe.active = false;
        }
    };
}

async function waitForIdle(probe: SaveProbe, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (probe.active && Date.now() < deadline) {
        await sleep(1);
    }
}

export interface ScenarioResult {
    snapshotBytes: number;
    actualBytes: number;
    updates: number;
    throttleMs: number;
    enqueue: SampleStats;
    writesInWindow: number;
    totalWrites: number;
    writesWithinBudget: boolean;
    enqueueWithinBudget: boolean;
    write: SampleStats & { count: number };
    eventLoopLag: {
        baselineMs: { samples: number; maxMs: number; p95Ms: number };
        duringWriteMs: { samples: number; maxMs: number; p95Ms: number };
    };
    requestPath: {
        baselineMs: SampleStats;
        candidateMs: SampleStats;
        degradationPct: number;
        withinBudget: boolean;
    };
    flushMs: number;
    flushWithinDeadline: boolean;
    finalFileParseable: boolean;
    residualTempFiles: number;
}

async function runScenario(
    snapshotBytes: number,
    updates: number,
    throttleMs: number,
    seed: number,
    flushDeadlineMs: number,
): Promise<ScenarioResult> {
    const dir = mkdtempSync(join(tmpdir(), 'fxrate-persistence-writer-'));
    const cacheFile = join(dir, 'fxrate-cache.json');
    const rng = seededRandom(seed);
    const snapshot = buildSnapshot(snapshotBytes, rng);
    const actualBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf-8');

    const probe: SaveProbe = { writesMs: [], count: 0, active: false };
    const writer = new SnapshotWriter({
        throttleMs,
        path: cacheFile,
        producer: () => snapshot,
        save: trackingSave(probe, cacheFile),
    });

    try {
        // 请求路径采样窗取 throttle 窗口量级：被阻塞请求占比 = 阻塞时长/窗口时长，
        // 与生产（一次写入落在 1s throttle 窗口内）同尺度。
        const samplingWindowMs = Math.max(throttleMs, 200);

        // 0) 预热：快照构建刚完成，先跑一轮请求路径让 JIT/分配器稳定，
        //    避免 GC 尾延迟污染 baseline。
        await measureRequestPathAsync(50);

        // 1) 无落盘 baseline：请求路径 + event-loop lag（writer 完全空闲）。
        const baselineMs = await measureRequestPathAsync(samplingWindowMs);
        const lagProbe = createEventLoopLagProbe();
        lagProbe.start();
        await sleep(200);
        const lagBaseline = lagProbe.stop();

        // 2) enqueue：updates 次 O(1) 入队，逐次计时；期间不得有任何落盘。
        const enqueueLatencies: number[] = [];
        for (let i = 0; i < updates; i += 1) {
            const start = process.hrtime.bigint();
            writer.enqueue();
            enqueueLatencies.push(
                Number(process.hrtime.bigint() - start) / 1e6,
            );
        }
        const enqueueStats = summarize(enqueueLatencies);

        // 3) 等待首个 throttle 窗口结束：窗口内全部 enqueue 收敛为一次写。
        await sleep(throttleMs + 50);
        await waitForIdle(probe, throttleMs + 2000);
        const writesInWindow = probe.writesMs.length;

        // 4) event-loop lag during write：flush 立即触发一次重 dump（跳过 throttle），
        //    lag 探针在 flush 之前启动，保证把同步 stringify 阻塞窗口计入。
        lagProbe.start();
        // monitorEventLoopDelay 需先完成至少一个采样 tick；否则紧接着进入
        // setImmediate stringify 时，首个阻塞窗口可能发生在 histogram 建立前。
        await sleep(10);
        writer.enqueue();
        await writer.flush();
        const lagDuringWrite = lagProbe.stop();

        // 5) 请求路径 candidate：并发采样循环与 flush 写并行——stringify 阻塞时
        //    正在等待 setImmediate 的请求被延迟，p50/p95/p99 反映真实代价。
        writer.enqueue();
        const candidatePromise = measureRequestPathAsync(samplingWindowMs);
        await writer.flush();
        const candidateMs = await candidatePromise;

        // 候选不比 baseline 慢时按 0 记（负值只反映采样噪声，无业务意义）
        const degradationPct = Math.max(
            0,
            baselineMs.p95 > 0
                ? ((candidateMs.p95 - baselineMs.p95) / baselineMs.p95) * 100
                : 0,
        );

        // 6) shutdown flush：停机语义——入队一次（置脏 + 排定时器）后 flush，
        //    取消定时器、重 dump 一次并落盘，记时长。
        writer.enqueue();
        const flushStart = process.hrtime.bigint();
        await writer.flush();
        const flushMs = Number(process.hrtime.bigint() - flushStart) / 1e6;

        // 7) 校验最终文件可解析、无残留临时文件。
        let finalFileParseable = false;
        try {
            finalFileParseable =
                typeof JSON.parse(readFileSync(cacheFile, 'utf-8')) ===
                'object';
        } catch {
            finalFileParseable = false;
        }
        const residualTempFiles = readdirSync(dir).filter((f) =>
            f.endsWith('.tmp'),
        ).length;

        const writeStats = summarize(probe.writesMs);
        const totalWrites = probe.writesMs.length;
        return {
            snapshotBytes,
            actualBytes,
            updates,
            throttleMs,
            enqueue: enqueueStats,
            writesInWindow,
            totalWrites,
            writesWithinBudget: writesInWindow <= 2,
            enqueueWithinBudget: enqueueStats.p95 <= 1,
            write: { count: totalWrites, ...writeStats },
            eventLoopLag: {
                baselineMs: lagBaseline,
                duringWriteMs: lagDuringWrite,
            },
            requestPath: {
                baselineMs,
                candidateMs,
                degradationPct,
                withinBudget: degradationPct <= 10,
            },
            flushMs,
            flushWithinDeadline: flushMs <= flushDeadlineMs,
            finalFileParseable,
            residualTempFiles,
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

export async function run(opts: PersistenceWriterOptions) {
    const results: ScenarioResult[] = [];
    for (const snapshotBytes of opts.snapshotBytes) {
        results.push(
            await runScenario(
                snapshotBytes,
                opts.updates,
                opts.throttleMs,
                opts.seed,
                opts.flushDeadlineMs,
            ),
        );
    }
    return {
        name: 'persistence-writer',
        args: {
            updates: opts.updates,
            snapshotBytes: opts.snapshotBytes,
            throttleMs: opts.throttleMs,
            seed: opts.seed,
            flushDeadlineMs: opts.flushDeadlineMs,
        },
        environment: environment(),
        results,
    };
}

export function budgetFailures(results: ScenarioResult[]): string[] {
    return results.flatMap((result) => {
        const failures: string[] = [];
        if (!result.writesWithinBudget) failures.push('writesInWindow>2');
        if (!result.enqueueWithinBudget) failures.push('enqueue.p95>1ms');
        if (!result.requestPath.withinBudget) {
            failures.push('requestPath.degradation>10%');
        }
        if (!result.flushWithinDeadline)
            failures.push('flush deadline exceeded');
        if (!result.finalFileParseable)
            failures.push('final file is not parseable');
        if (result.residualTempFiles !== 0)
            failures.push('residual temp files');
        return failures.map(
            (failure) => `${result.actualBytes} byte snapshot: ${failure}`,
        );
    });
}

export async function main(
    args: string[],
    enforceBudgets = false,
): Promise<void> {
    const opts = parseOptions(args);
    const payload = await run(opts);
    writeJson(opts.output, payload);
    console.log(`[persistence-writer] wrote ${opts.output}`);
    const failures = budgetFailures(payload.results);
    if (enforceBudgets && failures.length > 0) {
        throw new Error(
            `persistence-writer budget failed:\n${failures.join('\n')}`,
        );
    }
}

if (esMain(import.meta)) {
    main(process.argv.slice(2), true)
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
