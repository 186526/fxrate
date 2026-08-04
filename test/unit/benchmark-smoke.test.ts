// benchmark-smoke：验证 Phase 0 benchmark harness 可运行、输出合法 JSON、
// 且绝不访问网络（mock 上游 + 合成图，全程零 fetch）。输出只写 /tmp（caller 提供路径），不写仓库。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as cardBatchMain } from '../../benchmark/card-batch';
import { main as rpcLoadMain } from '../../benchmark/rpc-load';
import { main as detailsBfsMain } from '../../benchmark/details-bfs';
import { main as listRatesMain } from '../../benchmark/list-rates';
import { main as cardHeapMain } from '../../benchmark/card-heap';
import {
    budgetFailures as persistenceWriterBudgetFailures,
    main as persistenceWriterMain,
    type ScenarioResult as PersistenceWriterScenarioResult,
} from '../../benchmark/persistence-writer';

type FetchFn = typeof fetch;

const originalFetch: FetchFn = globalThis.fetch;
let fetchCalls = 0;

beforeAll(() => {
    globalThis.fetch = ((...args: Parameters<FetchFn>) => {
        fetchCalls += 1;
        return originalFetch(...args);
    }) as FetchFn;
});

afterAll(() => {
    globalThis.fetch = originalFetch;
    expect(fetchCalls).toBe(0);
});

describe('Phase 0 benchmark harness (offline smoke)', () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'fxrate-benchmark-smoke-'));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function assertValidBaseline(out: string, name: string) {
        expect(existsSync(out)).toBe(true);
        const data = JSON.parse(readFileSync(out, 'utf-8')) as {
            name: string;
            environment: { node: string };
        };
        expect(data.name).toBe(name);
        expect(data.environment.node).toBeDefined();
    }

    test('card-batch writes valid baseline JSON', async () => {
        const out = join(dir, 'card.json');
        await cardBatchMain(['--latency=1', '--batch=1,4', `--output=${out}`]);
        assertValidBaseline(out, 'card-batch');
        const data = JSON.parse(readFileSync(out, 'utf-8')) as {
            results: Array<{
                scenario: string;
                requests: number;
                upstreamCalls: number;
                peakConcurrency: number;
                stats: { p50: number; p95: number };
                opsPerSec: number;
                heapUsedMb: number;
            }>;
        };
        expect(data.results.length).toBeGreaterThan(0);
        for (const row of data.results) {
            expect(row.requests).toBeGreaterThan(0);
            expect(row.upstreamCalls).toBeGreaterThan(0);
            expect(row.stats.p95).toBeGreaterThanOrEqual(row.stats.p50);
            expect(row.opsPerSec).toBeGreaterThan(0);
            expect(row.heapUsedMb).toBeGreaterThan(0);
        }
    });

    test('rpc-load records body/batch/concurrency dimensions', async () => {
        const out = join(dir, 'rpc.json');
        await rpcLoadMain([
            '--body-bytes=16,1024',
            '--batch=1,4',
            '--concurrency=1,2',
            `--output=${out}`,
        ]);
        assertValidBaseline(out, 'rpc-load');
        const data = JSON.parse(readFileSync(out, 'utf-8')) as {
            results: Array<{
                bodyBytes: number;
                batch: number;
                concurrency: number;
                items: number;
                itemsPerSec: number;
                stats: { p50: number; p95: number };
            }>;
        };
        expect(data.results.length).toBeGreaterThan(0);
        for (const row of data.results) {
            expect(row.bodyBytes).toBeGreaterThan(0);
            expect(row.batch).toBeGreaterThan(0);
            expect(row.concurrency).toBeGreaterThan(0);
            expect(row.items).toBeGreaterThan(0);
            expect(row.itemsPerSec).toBeGreaterThan(0);
            expect(row.stats.p95).toBeGreaterThanOrEqual(row.stats.p50);
        }
    });

    test('details-bfs measures direct and bfs scenarios', async () => {
        const out = join(dir, 'details.json');
        await detailsBfsMain(['--nodes=4,8', '--samples=5', `--output=${out}`]);
        assertValidBaseline(out, 'details-bfs');
        const data = JSON.parse(readFileSync(out, 'utf-8')) as {
            results: Array<{
                scenario: string;
                bfs: boolean;
                samples: number;
                opsPerSec: number;
                stats: { p50: number; p95: number };
            }>;
        };
        expect(data.results.some((r) => r.scenario === 'direct')).toBe(true);
        expect(data.results.some((r) => r.scenario === 'bfs')).toBe(true);
        for (const row of data.results) {
            expect(row.samples).toBe(5);
            expect(row.opsPerSec).toBeGreaterThan(0);
            expect(row.stats.p95).toBeGreaterThanOrEqual(row.stats.p50);
        }
    });

    test('list-rates measures full-row serial getDetails', async () => {
        const out = join(dir, 'list.json');
        await listRatesMain(['--nodes=4,8', '--samples=3', `--output=${out}`]);
        assertValidBaseline(out, 'list-rates');
        const data = JSON.parse(readFileSync(out, 'utf-8')) as {
            results: Array<{
                targets: number;
                rowsPerSec: number;
                perCallMs: { p50: number; p95: number };
            }>;
        };
        for (const row of data.results) {
            expect(row.targets).toBeGreaterThan(0);
            expect(row.rowsPerSec).toBeGreaterThan(0);
            expect(row.perCallMs.p95).toBeGreaterThanOrEqual(row.perCallMs.p50);
        }
    });

    test('card-heap measures matrix build and access', async () => {
        const out = join(dir, 'heap.json');
        await cardHeapMain(['--pairs=20', `--output=${out}`]);
        assertValidBaseline(out, 'card-heap');
        const data = JSON.parse(readFileSync(out, 'utf-8')) as {
            build: {
                visaCells: number;
                mastercardCells: number;
                retainedHeapMb: number;
            };
            access: { cells: number; opsPerSec: number };
        };
        expect(data.build.visaCells).toBeGreaterThan(0);
        expect(data.build.mastercardCells).toBeGreaterThan(0);
        expect(data.access.cells).toBe(400);
        expect(data.access.opsPerSec).toBeGreaterThan(0);
    });

    test('persistence-writer records enqueue/write/lag/flush and covers plan thresholds', async () => {
        const out = join(dir, 'persistence-writer.json');
        await persistenceWriterMain([
            '--updates=100',
            '--snapshot-bytes=65536,262144',
            '--throttle-ms=50',
            '--flush-deadline-ms=2000',
            `--output=${out}`,
        ]);
        assertValidBaseline(out, 'persistence-writer');
        const data = JSON.parse(readFileSync(out, 'utf-8')) as {
            results: PersistenceWriterScenarioResult[];
        };
        expect(data.results.length).toBe(2);
        for (const row of data.results) {
            expect(row.actualBytes).toBeGreaterThan(0);
            // enqueue p95<=1ms 是完整 benchmark 的验收阈值；smoke 与整套 Jest
            // 并跑时墙钟会受 CPU/GC 抢占，这里只校验结构，避免亚毫秒 flaky gate。
            expect(row.enqueue.p95).toBeGreaterThanOrEqual(row.enqueue.p50);
            expect(typeof row.enqueueWithinBudget).toBe('boolean');
            // plan 阈值：窗口内 1000 次更新实际写入<=2 次（此处 100 次全在一个窗口 → 1 次）
            expect(row.writesInWindow).toBe(1);
            expect(row.writesWithinBudget).toBe(true);
            expect(row.write.count).toBeGreaterThan(0);
            expect(row.write.p95).toBeGreaterThanOrEqual(row.write.p50);
            // event-loop lag：写入期间采样结构完整（无真实上游、纯合成快照）
            expect(row.eventLoopLag.baselineMs.maxMs).toBeGreaterThanOrEqual(0);
            expect(row.eventLoopLag.duringWriteMs.maxMs).toBeGreaterThanOrEqual(
                0,
            );
            // 请求路径候选：记录 p95 退化百分比；10% 阈值属计时敏感，
            // 只在完整 benchmark（1/10MiB）里做硬断言，smoke 只校验结构。
            expect(row.requestPath.degradationPct).toBeGreaterThanOrEqual(0);
            expect(row.requestPath.candidateMs.p95).toBeGreaterThanOrEqual(
                row.requestPath.candidateMs.p50,
            );
            expect(typeof row.requestPath.withinBudget).toBe('boolean');
            // plan 阈值：shutdown flush 在 deadline 内、文件可解析、无残留临时文件
            expect(row.flushMs).toBeGreaterThan(0);
            expect(row.flushWithinDeadline).toBe(true);
            expect(row.finalFileParseable).toBe(true);
            expect(row.residualTempFiles).toBe(0);
        }

        const failed = {
            ...data.results[0]!,
            writesWithinBudget: false,
            enqueueWithinBudget: false,
            requestPath: {
                ...data.results[0]!.requestPath,
                withinBudget: false,
            },
            flushWithinDeadline: false,
            finalFileParseable: false,
            residualTempFiles: 1,
        };
        expect(persistenceWriterBudgetFailures([failed])).toEqual([
            `${failed.actualBytes} byte snapshot: writesInWindow>2`,
            `${failed.actualBytes} byte snapshot: enqueue.p95>1ms`,
            `${failed.actualBytes} byte snapshot: requestPath.degradation>10%`,
            `${failed.actualBytes} byte snapshot: flush deadline exceeded`,
            `${failed.actualBytes} byte snapshot: final file is not parseable`,
            `${failed.actualBytes} byte snapshot: residual temp files`,
        ]);
    });

    test('no benchmark artifacts leak into the repo working directory', () => {
        expect(existsSync(join(process.cwd(), 'fxrate-benchmark'))).toBe(false);
    });
});
