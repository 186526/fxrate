// card-heap：Card（Visa/MasterCard）Proxy 矩阵与属性读取堆/吞吐基准。
// build：实例化真实 visa/mastercard 类并强制构建 lazy matrix（约 168² + 152² 个 Proxy cell），
//        GC 后测 retained heap（需要 --expose-gc；缺失时 gcAvailable=false、结果降级为非精确）。
// access：以同样的「LRU 缓存 JSON 字符串 + Proxy 属性读取即 JSON.parse」模式合成镜像数据
//        （不访问上游），测量逐 cell 属性读取吞吐与物化堆开销——对应 JSON.parse 热点。
// 用法：node --expose-gc ./node_modules/.bin/tsx benchmark/card-heap.ts --pairs=500 --output=/tmp/fxrate-benchmark/heap-baseline.json

import esMain from 'es-main';
import { parseArgs } from 'node:util';
import { LRUCache } from 'lru-cache';
import visaFXM from '../src/FXGetter/visa';
import mastercardFXM from '../src/FXGetter/mastercard';
import {
    environment,
    forceGc,
    heapUsedMb,
    summarize,
    writeJson,
} from './common';

export interface CardHeapOptions {
    pairs: number;
    output: string;
    candidate: boolean;
}

export function parseOptions(args: string[]): CardHeapOptions {
    const { values } = parseArgs({
        args,
        strict: false,
        options: {
            pairs: { type: 'string', default: '500' },
            output: { type: 'string' },
            candidate: { type: 'boolean', default: false },
        },
    });
    return {
        pairs: Number(values.pairs) || 500,
        output: typeof values.output === 'string' ? values.output : '',
        candidate: values['candidate'] === true,
    };
}

function measureBuild() {
    const visa = new visaFXM();
    const mastercard = new mastercardFXM();
    const gcAvailable = forceGc();
    const heapBeforeMb = heapUsedMb();
    const visaCells = Object.keys(visa.fxRateList).length ** 2;
    const mastercardCells = Object.keys(mastercard.fxRateList).length ** 2;
    forceGc();
    const heapAfterMb = heapUsedMb();
    return {
        gcAvailable,
        visaCells,
        mastercardCells,
        totalCells: visaCells + mastercardCells,
        heapBeforeMb,
        heapAfterMb,
        retainedHeapMb: heapAfterMb - heapBeforeMb,
    };
}

function measureAccess(pairs: number) {
    const cellCount = pairs * pairs;
    const cache = new LRUCache<string, string>({ max: cellCount });
    const payload = JSON.stringify({ data: { fxRateVisa: '7.25' } });
    for (let i = 0; i < pairs; i += 1) {
        for (let j = 0; j < pairs; j += 1) {
            cache.set(`K${i}-K${j}`, payload);
        }
    }
    const grid: Array<{ middle: number | undefined }> = [];
    for (let i = 0; i < pairs; i += 1) {
        for (let j = 0; j < pairs; j += 1) {
            const key = `K${i}-K${j}`;
            grid.push(
                new Proxy({} as Record<string, number | undefined>, {
                    get: (_obj, prop) => {
                        if (prop !== 'middle') return undefined;
                        const cached = cache.get(key);
                        if (!cached) return undefined;
                        return Number(JSON.parse(cached).data.fxRateVisa);
                    },
                }) as { middle: number | undefined },
            );
        }
    }
    const gcAvailable = forceGc();
    const heapBeforeMb = heapUsedMb();
    const latencies: number[] = [];
    let acc = 0;
    const start = process.hrtime.bigint();
    for (const cell of grid) {
        const t0 = process.hrtime.bigint();
        acc += cell.middle ?? 0;
        latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    forceGc();
    const heapAfterMb = heapUsedMb();
    cache.clear();
    return {
        cells: cellCount,
        gcAvailable,
        heapBeforeMb,
        heapAfterMb,
        materializeHeapMb: heapAfterMb - heapBeforeMb,
        wallMs,
        opsPerSec: cellCount / (wallMs / 1000),
        stats: summarize(latencies),
        acc,
    };
}

export async function run(opts: CardHeapOptions) {
    return {
        name: 'card-heap',
        args: {
            pairs: opts.pairs,
            candidate: opts.candidate,
        },
        environment: environment(),
        build: measureBuild(),
        access: measureAccess(opts.pairs),
    };
}

export async function main(args: string[]): Promise<void> {
    const opts = parseOptions(args);
    const payload = await run(opts);
    writeJson(opts.output, payload);
    console.log(`[card-heap] wrote ${opts.output}`);
}

if (esMain(import.meta)) {
    main(process.argv.slice(2))
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
