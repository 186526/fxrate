// details-bfs：FX 图 getDetails CPU 基准（合成星形/网格图，离线）。
// 复刻 getDetails 的路径解析次数：bfs 时显式 getFXPath 一次 + cash/remit/middle 三次 convert（各自再解析一次路径）。
// 直连（BASE→leaf，无 BFS）与交叉（leaf→leaf 必须经过 BASE，bfs=true）分别采样。
// 用法：yarn tsx benchmark/details-bfs.ts --nodes=12,64,180 --samples=1000 --output=/tmp/fxrate-benchmark/details-baseline.json

import esMain from 'es-main';
import { parseArgs } from 'node:util';
import fxManager from '../src/fxm/fxManager';
import {
    buildGraph,
    edgeCount,
    layeredWidth,
    LAYERS,
    BASE,
    type Topology,
} from './graph';
import {
    environment,
    forceGc,
    heapUsedMb,
    parseCsvNumbers,
    randomInt,
    seededRandom,
    summarize,
    writeJson,
} from './common';

export interface DetailsBfsOptions {
    nodes: number[];
    samples: number;
    topology: Topology;
    seed: number;
    output: string;
    candidate: boolean;
}

export function parseOptions(args: string[]): DetailsBfsOptions {
    const { values } = parseArgs({
        args,
        strict: false,
        options: {
            nodes: { type: 'string', default: '12,64,180' },
            samples: { type: 'string', default: '1000' },
            topology: { type: 'string', default: 'star' },
            seed: { type: 'string', default: '20260804' },
            output: { type: 'string' },
            candidate: { type: 'boolean', default: false },
        },
    });
    return {
        nodes: parseCsvNumbers(String(values.nodes ?? '12,64,180')),
        samples: Number(values.samples) || 1000,
        topology:
            values.topology === 'mesh'
                ? 'mesh'
                : values.topology === 'layered'
                  ? 'layered'
                  : 'star',
        seed: Number(values.seed) || 20260804,
        output: typeof values.output === 'string' ? values.output : '',
        candidate: values['candidate'] === true,
    };
}

async function getDetailsCost(
    manager: fxManager,
    from: string,
    to: string,
    bfs: boolean,
    amount: number,
): Promise<void> {
    try {
        await manager.getUpdatedDate(from as never, to as never);
    } catch {
        // 与 getDetails 一致：源不可用时不 500，走默认 updated。
    }
    if (bfs) {
        try {
            await manager.getFXPath(from as never, to as never, true);
        } catch {
            // 与 getDetails 一致：无路径时 result.path 回落为 []。
        }
    }
    for (const type of ['cash', 'remit', 'middle'] as const) {
        try {
            await manager.convert(
                from as never,
                to as never,
                type,
                amount,
                false,
                bfs,
            );
        } catch {
            // 与 getDetails 一致：单个 type 失败时该字段为 false。
        }
    }
}

interface ScenarioResult {
    nodes: number;
    topology: Topology;
    edges: number;
    scenario: 'direct' | 'bfs';
    bfs: boolean;
    samples: number;
    wallMs: number;
    opsPerSec: number;
    stats: ReturnType<typeof summarize>;
    heapUsedMb: number;
}

async function measureScenario(
    manager: fxManager,
    pairs: Array<[string, string]>,
    bfs: boolean,
    amount: number,
): Promise<{
    wallMs: number;
    opsPerSec: number;
    stats: ReturnType<typeof summarize>;
}> {
    const latencies: number[] = [];
    const start = process.hrtime.bigint();
    for (const [from, to] of pairs) {
        const t0 = process.hrtime.bigint();
        await getDetailsCost(manager, from, to, bfs, amount);
        latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    return {
        wallMs,
        opsPerSec: pairs.length / (wallMs / 1000),
        stats: summarize(latencies),
    };
}

export async function run(opts: DetailsBfsOptions) {
    const results: ScenarioResult[] = [];
    for (const nodeCount of opts.nodes) {
        const manager = buildGraph(nodeCount, opts.topology);
        const leaves = Object.keys(manager.fxRateList).filter(
            (key) => key !== BASE,
        );
        const rng = seededRandom(opts.seed ^ nodeCount);

        for (let i = 0; i < 20; i += 1) {
            await getDetailsCost(
                manager,
                BASE,
                leaves[i % leaves.length],
                false,
                100,
            );
        }

        const directPairs: Array<[string, string]> = [];
        const bfsPairs: Array<[string, string]> = [];
        if (opts.topology === 'layered') {
            // 分层图：direct 场景取第 0 层 → 第 1 层（真实直连边）；
            // bfs 场景取第 0 层 → 最后一层（必须逐层遍历，无直连）。
            const W = layeredWidth(nodeCount);
            for (let i = 0; i < opts.samples; i += 1) {
                directPairs.push([
                    leaves[randomInt(rng, 0, W)],
                    leaves[W + randomInt(rng, 0, W)],
                ]);
                bfsPairs.push([
                    leaves[randomInt(rng, 0, W)],
                    leaves[(LAYERS - 1) * W + randomInt(rng, 0, W)],
                ]);
            }
        } else {
            for (let i = 0; i < opts.samples; i += 1) {
                directPairs.push([
                    BASE,
                    leaves[randomInt(rng, 0, leaves.length)],
                ]);
            }
            for (let i = 0; i < opts.samples; i += 1) {
                const a = randomInt(rng, 0, leaves.length);
                let b = randomInt(rng, 0, leaves.length);
                while (b === a) b = randomInt(rng, 0, leaves.length);
                bfsPairs.push([leaves[a], leaves[b]]);
            }
        }

        const direct = await measureScenario(manager, directPairs, false, 100);
        forceGc();
        results.push({
            nodes: nodeCount,
            topology: opts.topology,
            edges: edgeCount(nodeCount, opts.topology),
            scenario: 'direct',
            bfs: false,
            samples: opts.samples,
            ...direct,
            heapUsedMb: heapUsedMb(),
        });

        const bfs = await measureScenario(manager, bfsPairs, true, 100);
        forceGc();
        results.push({
            nodes: nodeCount,
            topology: opts.topology,
            edges: edgeCount(nodeCount, opts.topology),
            scenario: 'bfs',
            bfs: true,
            samples: opts.samples,
            ...bfs,
            heapUsedMb: heapUsedMb(),
        });
    }
    return {
        name: 'details-bfs',
        args: {
            nodes: opts.nodes,
            samples: opts.samples,
            topology: opts.topology,
            seed: opts.seed,
            candidate: opts.candidate,
        },
        environment: environment(),
        results,
    };
}

export async function main(args: string[]): Promise<void> {
    const opts = parseOptions(args);
    const payload = await run(opts);
    writeJson(opts.output, payload);
    console.log(`[details-bfs] wrote ${opts.output}`);
}

if (esMain(import.meta)) {
    main(process.argv.slice(2))
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
