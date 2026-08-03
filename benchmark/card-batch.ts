// card-batch：Card（MasterCard/Visa 类）并发批量基准。
// 用可注入的 mock 上游（固定延迟、绝不访问公网）复刻当前实现——
// 模块级 LRU 只缓存「已完成」结果、无 in-flight 合并，因此同 key 并发会各自打上游。
// 用法：yarn tsx benchmark/card-batch.ts --latency=20 --batch=1,12,64,168,500 --output=/tmp/fxrate-benchmark/card-baseline.json

import esMain from 'es-main';
import { parseArgs } from 'node:util';
import { LRUCache } from 'lru-cache';
import {
    environment,
    parseCsvNumbers,
    sleep,
    summarize,
    writeJson,
    heapUsedMb,
} from './common';

export interface CardBatchOptions {
    latency: number[];
    batch: number[];
    output: string;
    singleFlight: boolean;
    chromiumLimit: number;
    nativeLimit: number;
}

export function parseOptions(args: string[]): CardBatchOptions {
    const { values } = parseArgs({
        args,
        strict: false,
        options: {
            latency: { type: 'string', default: '20' },
            batch: { type: 'string', default: '1,12,64,168,500' },
            output: { type: 'string' },
            'single-flight': { type: 'boolean', default: false },
            'chromium-limit': { type: 'string', default: '1' },
            'native-limit': { type: 'string', default: '8' },
        },
    });
    return {
        latency: parseCsvNumbers(String(values.latency ?? '20')),
        batch: parseCsvNumbers(String(values.batch ?? '1,12,64,168,500')),
        output: values.output ?? '',
        singleFlight: (values['single-flight'] ?? false) as boolean,
        chromiumLimit: Number(values['chromium-limit']) || 1,
        nativeLimit: Number(values['native-limit']) || 8,
    };
}

class CurrentMockCard {
    private readonly cache = new LRUCache<string, number>({ max: 500 });
    public upstreamCalls = 0;
    public peakConcurrency = 0;
    private active = 0;

    constructor(private readonly latencyMs: number) {}

    async get(from: string, to: string): Promise<number> {
        const key = `${from}${to}`;
        const hit = this.cache.get(key);
        if (hit !== undefined) return hit;
        this.active += 1;
        this.peakConcurrency = Math.max(this.peakConcurrency, this.active);
        this.upstreamCalls += 1;
        await sleep(this.latencyMs);
        const value = 7.25;
        this.cache.set(key, value);
        this.active -= 1;
        return value;
    }
}

class SingleFlightMockCard {
    private readonly cache = new LRUCache<string, number>({ max: 500 });
    private readonly inflight = new Map<string, Promise<number>>();
    public upstreamCalls = 0;
    public peakConcurrency = 0;
    private active = 0;

    constructor(private readonly latencyMs: number) {}

    async get(from: string, to: string): Promise<number> {
        const key = `${from}${to}`;
        const hit = this.cache.get(key);
        if (hit !== undefined) return hit;
        const existing = this.inflight.get(key);
        if (existing) return existing;
        const promise = this.fetch(key);
        this.inflight.set(key, promise);
        try {
            return await promise;
        } finally {
            this.inflight.delete(key);
        }
    }

    private async fetch(key: string): Promise<number> {
        this.active += 1;
        this.peakConcurrency = Math.max(this.peakConcurrency, this.active);
        this.upstreamCalls += 1;
        try {
            await sleep(this.latencyMs);
            const value = 7.25;
            this.cache.set(key, value);
            return value;
        } finally {
            this.active -= 1;
        }
    }
}

interface ScenarioResult {
    scenario: 'sameKey' | 'differentKeys';
    latencyMs: number;
    batch: number;
    requests: number;
    upstreamCalls: number;
    peakConcurrency: number;
    wallMs: number;
    stats: ReturnType<typeof summarize>;
    opsPerSec: number;
    heapUsedMb: number;
}

async function runScenario(
    impl: 'current' | 'singleFlight',
    scenario: 'sameKey' | 'differentKeys',
    latencyMs: number,
    count: number,
): Promise<Omit<ScenarioResult, 'scenario' | 'latencyMs' | 'batch'>> {
    const source =
        impl === 'singleFlight'
            ? new SingleFlightMockCard(latencyMs)
            : new CurrentMockCard(latencyMs);

    const latencies: number[] = [];
    const start = process.hrtime.bigint();
    await Promise.all(
        Array.from({ length: count }, async (_, i) => {
            const from =
                scenario === 'sameKey'
                    ? 'USD'
                    : `C${String(i).padStart(4, '0')}`;
            const to =
                scenario === 'sameKey'
                    ? 'CNY'
                    : `T${String(i).padStart(4, '0')}`;
            const reqStart = process.hrtime.bigint();
            await source.get(from, to);
            latencies.push(Number(process.hrtime.bigint() - reqStart) / 1e6);
        }),
    );
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    return {
        requests: count,
        upstreamCalls: source.upstreamCalls,
        peakConcurrency: source.peakConcurrency,
        wallMs,
        stats: summarize(latencies),
        opsPerSec: count / (wallMs / 1000),
        heapUsedMb: heapUsedMb(),
    };
}

export async function run(opts: CardBatchOptions) {
    const results: ScenarioResult[] = [];
    for (const latencyMs of opts.latency) {
        for (const batch of opts.batch) {
            for (const scenario of ['sameKey', 'differentKeys'] as const) {
                const row = await runScenario(
                    opts.singleFlight ? 'singleFlight' : 'current',
                    scenario,
                    latencyMs,
                    batch,
                );
                results.push({ scenario, latencyMs, batch, ...row });
            }
        }
    }
    return {
        name: 'card-batch',
        args: {
            latency: opts.latency,
            batch: opts.batch,
            singleFlight: opts.singleFlight,
            chromiumLimit: opts.chromiumLimit,
            nativeLimit: opts.nativeLimit,
        },
        environment: environment(),
        results,
    };
}

export async function main(args: string[]): Promise<void> {
    const opts = parseOptions(args);
    const payload = await run(opts);
    writeJson(opts.output, payload);
    console.log(`[card-batch] wrote ${opts.output}`);
}

if (esMain(import.meta)) {
    main(process.argv.slice(2))
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
