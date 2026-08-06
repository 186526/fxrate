// list-rates：listFXRates 全行（从 BASE 出发的全部目标）串行 getDetails 基准，离线合成图。
// 复刻 handlerCurrencyAllFXRates 的串行循环；对每次 getDetails 计时并聚合整行耗时。
// --candidate 复刻 Phase 5 优化 #2：getAllReachable 单次遍历枚举全部可达目标并预解析
// 路径，逐目标 getDetails 复用（不再每个目标重跑 BFS/getFXPath）。
// --bfs 开启 bfs=1 语义（无直连目标也要路径解析；默认仅直连）。
// 用法：yarn tsx benchmark/list-rates.ts --nodes=12,50,100,168,200 --samples=200 --output=/tmp/fxrate-benchmark/list-baseline.json
//       yarn tsx benchmark/list-rates.ts --candidate --bfs --nodes=12,50,100,168,200 --samples=200 --output=/tmp/fxrate-benchmark/list-candidate.json

import esMain from 'es-main';
import { parseArgs } from 'node:util';
import fxManager from '../src/fxm/fxManager';
import { getDetails } from '../src/handler/rest';
import { request, interfaces } from 'handlers.js';
import { buildGraph, BASE, type Topology } from './graph';
import {
    environment,
    forceGc,
    heapUsedMb,
    parseCsvNumbers,
    summarize,
    writeJson,
} from './common';

export interface ListRatesOptions {
    nodes: number[];
    samples: number;
    topology: Topology;
    output: string;
    candidate: boolean;
    bfs: boolean;
}

export function parseOptions(args: string[]): ListRatesOptions {
    const { values } = parseArgs({
        args,
        strict: false,
        options: {
            nodes: { type: 'string', default: '12,50,100,168,200' },
            samples: { type: 'string', default: '200' },
            topology: { type: 'string', default: 'star' },
            output: { type: 'string' },
            candidate: { type: 'boolean', default: false },
            bfs: { type: 'boolean', default: false },
        },
    });
    return {
        nodes: parseCsvNumbers(String(values.nodes ?? '12,50,100,168,200')),
        samples: Number(values.samples) || 200,
        topology: values.topology === 'mesh' ? 'mesh' : 'star',
        output: typeof values.output === 'string' ? values.output : '',
        candidate: values['candidate'] === true,
        bfs: values['bfs'] === true,
    };
}

function makeRequest(bfs: boolean): request<any> {
    return new request(
        'GET',
        new URL(`http://this.internal/mock${bfs ? '?bfs=1' : ''}`),
        new interfaces.headers({}),
        '',
        {},
    );
}

async function measureRow(
    manager: fxManager,
    targets: string[],
    req: request<any>,
    candidate: boolean,
    bfs: boolean,
): Promise<{
    targets: number;
    wallMs: number;
    rowsPerSec: number;
    perCall: ReturnType<typeof summarize>;
    perCallRaw: number[];
}> {
    const perCallRaw: number[] = [];
    const start = process.hrtime.bigint();
    if (candidate) {
        // 单次遍历枚举 + 预解析路径，逐目标复用
        const reachable = await manager.getAllReachable(BASE as never, bfs);
        const resolved = Object.keys(reachable);
        for (const to of resolved) {
            const t0 = process.hrtime.bigint();
            await getDetails(
                BASE as never,
                to as never,
                manager,
                req,
                reachable[to],
            );
            perCallRaw.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
        return {
            targets: resolved.length,
            wallMs,
            rowsPerSec: resolved.length / (wallMs / 1000),
            perCall: summarize(perCallRaw),
            perCallRaw,
        };
    }
    for (const to of targets) {
        const t0 = process.hrtime.bigint();
        await getDetails(BASE as never, to as never, manager, req);
        perCallRaw.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    return {
        targets: targets.length,
        wallMs,
        rowsPerSec: targets.length / (wallMs / 1000),
        perCall: summarize(perCallRaw),
        perCallRaw,
    };
}

interface ListRatesResult {
    nodes: number;
    topology: Topology;
    targets: number;
    samples: number;
    perRowMs: ReturnType<typeof summarize>;
    perCallMs: ReturnType<typeof summarize>;
    rowsPerSec: number;
    wallMs: number;
    heapUsedMb: number;
}

export async function run(opts: ListRatesOptions) {
    const results: ListRatesResult[] = [];
    for (const nodeCount of opts.nodes) {
        const manager = buildGraph(nodeCount, opts.topology);
        const targets = Object.keys(manager.fxRateList).filter(
            (key) => key !== BASE,
        );
        const req = makeRequest(opts.bfs);
        const rowTimes: number[] = [];
        const allPerCall: number[] = [];
        for (let i = 0; i < opts.samples; i += 1) {
            const row = await measureRow(
                manager,
                targets,
                req,
                opts.candidate,
                opts.bfs,
            );
            rowTimes.push(row.wallMs);
            allPerCall.push(...row.perCallRaw);
        }
        forceGc();
        results.push({
            nodes: nodeCount,
            topology: opts.topology,
            targets: targets.length,
            samples: opts.samples,
            perRowMs: summarize(rowTimes),
            perCallMs: summarize(allPerCall),
            rowsPerSec:
                (opts.samples * targets.length) /
                (rowTimes.reduce((acc, v) => acc + v, 0) / 1000),
            wallMs: rowTimes.reduce((acc, v) => acc + v, 0),
            heapUsedMb: heapUsedMb(),
        });
    }
    return {
        name: 'list-rates',
        args: {
            nodes: opts.nodes,
            samples: opts.samples,
            topology: opts.topology,
            candidate: opts.candidate,
            bfs: opts.bfs,
        },
        environment: environment(),
        results,
    };
}

export async function main(args: string[]): Promise<void> {
    const opts = parseOptions(args);
    const payload = await run(opts);
    writeJson(opts.output, payload);
    console.log(`[list-rates] wrote ${opts.output}`);
}

if (esMain(import.meta)) {
    main(process.argv.slice(2))
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
