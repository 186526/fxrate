// rpc-load：JSON-RPC 请求处理负载基准（完全离线）。
// 模拟 handlers.js-jsonrpc 的 batch dispatch：JSON.parse body → 逐条校验 → mock 方法处理。
// 三个维度 body bytes / batch items / concurrency 全部显式记录在每行结果中。
// 用法：yarn tsx benchmark/rpc-load.ts --body-bytes=1024,262144,1048576 --batch=1,10,100,1000 --concurrency=1,4,16 --output=/tmp/fxrate-benchmark/rpc-baseline.json

import esMain from 'es-main';
import { parseArgs } from 'node:util';
import {
    environment,
    parseCsvNumbers,
    summarize,
    writeJson,
    heapUsedMb,
} from './common';

export interface RpcLoadOptions {
    bodyBytes: number[];
    batch: number[];
    concurrency: number[];
    output: string;
}

export function parseOptions(args: string[]): RpcLoadOptions {
    const { values } = parseArgs({
        args,
        strict: false,
        options: {
            'body-bytes': { type: 'string', default: '1024,262144,1048576' },
            batch: { type: 'string', default: '1,10,100,1000' },
            concurrency: { type: 'string', default: '1,4,16' },
            output: { type: 'string' },
        },
    });
    return {
        bodyBytes: parseCsvNumbers(String(values['body-bytes'] ?? '1024')),
        batch: parseCsvNumbers(String(values.batch ?? '1,10,100')),
        concurrency: parseCsvNumbers(String(values.concurrency ?? '1,4')),
        output: values.output ?? '',
    };
}

export function processBatch(body: string): { items: number } {
    const parsed: unknown = JSON.parse(body);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const results: unknown[] = [];
    for (const raw of items) {
        const item = raw as {
            jsonrpc?: string;
            id?: unknown;
            method?: string;
            params?: Record<string, unknown>;
        };
        if (item.jsonrpc !== '2.0' || typeof item.method !== 'string') {
            throw new Error('invalid jsonrpc request');
        }
        item.params ??= {};
        results.push({
            id: item.id,
            result: {
                status: 'ok',
                source: 'mock',
                currency: ['USD', 'CNY'],
                date: new Date().toUTCString(),
            },
        });
    }
    return { items: items.length };
}

function buildBody(batchSize: number, targetBytes: number): string {
    const items: Array<{
        jsonrpc: string;
        id: number;
        method: string;
        params: { pad: string };
    }> = [];
    for (let i = 0; i < batchSize; i += 1) {
        items.push({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'instanceInfo',
            params: { pad: '' },
        });
    }
    let body = JSON.stringify(items);
    const deficit = targetBytes - Buffer.byteLength(body, 'utf-8');
    if (deficit > 0) {
        items[0].params.pad = 'x'.repeat(deficit);
        body = JSON.stringify(items);
    }
    return body;
}

interface RpcScenarioResult {
    bodyBytes: number;
    batch: number;
    concurrency: number;
    requests: number;
    items: number;
    wallMs: number;
    itemsPerSec: number;
    stats: ReturnType<typeof summarize>;
    heapUsedMb: number;
}

async function runScenario(
    bodyBytes: number,
    batchSize: number,
    concurrency: number,
): Promise<Omit<RpcScenarioResult, 'bodyBytes' | 'batch' | 'concurrency'>> {
    const body = buildBody(batchSize, bodyBytes);
    const totalRequests = Math.max(2, Math.ceil(4000 / batchSize));
    const perWorker = Math.ceil(totalRequests / concurrency);

    const latencies: number[] = [];
    let itemsProcessed = 0;
    const start = process.hrtime.bigint();

    const worker = async (): Promise<void> => {
        for (let i = 0; i < perWorker; i += 1) {
            const reqStart = process.hrtime.bigint();
            const { items } = processBatch(body);
            latencies.push(Number(process.hrtime.bigint() - reqStart) / 1e6);
            itemsProcessed += items;
        }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    return {
        requests: perWorker * concurrency,
        items: itemsProcessed,
        wallMs,
        itemsPerSec: itemsProcessed / (wallMs / 1000),
        stats: summarize(latencies),
        heapUsedMb: heapUsedMb(),
    };
}

export async function run(opts: RpcLoadOptions) {
    const results: RpcScenarioResult[] = [];
    for (const bodyBytes of opts.bodyBytes) {
        for (const batch of opts.batch) {
            for (const concurrency of opts.concurrency) {
                const row = await runScenario(bodyBytes, batch, concurrency);
                results.push({ bodyBytes, batch, concurrency, ...row });
            }
        }
    }
    return {
        name: 'rpc-load',
        args: {
            bodyBytes: opts.bodyBytes,
            batch: opts.batch,
            concurrency: opts.concurrency,
        },
        environment: environment(),
        results,
    };
}

export async function main(args: string[]): Promise<void> {
    const opts = parseOptions(args);
    const payload = await run(opts);
    writeJson(opts.output, payload);
    console.log(`[rpc-load] wrote ${opts.output}`);
}

if (esMain(import.meta)) {
    main(process.argv.slice(2))
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
