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

    test('no benchmark artifacts leak into the repo working directory', () => {
        expect(existsSync(join(process.cwd(), 'fxrate-benchmark'))).toBe(false);
    });
});
