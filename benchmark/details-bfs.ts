// details-bfs：FX 图 getDetails CPU 基准（合成星形/网格图，离线）。
// 复刻 getDetails 的路径解析次数：bfs 时显式 getFXPath 一次 + cash/remit/middle 三次 convert（各自再解析一次路径）。
// 直连（BASE→leaf，无 BFS）与交叉（leaf→leaf 必须经过 BASE，bfs=true）分别采样。
// --candidate 复刻 Phase 5 优化 #1：getFXPath 只解析一次，三价经 convertAlongPath 复用同一 path，
// 输出 pathResolutionsPerPair 必须为 1（每 pair 恰好一次路径解析，否则抛错）。
// 用法：yarn tsx benchmark/details-bfs.ts --nodes=12,64,180 --samples=1000 --output=/tmp/fxrate-benchmark/details-baseline.json
//       yarn tsx benchmark/details-bfs.ts --candidate --nodes=12,64,180 --samples=1000 --output=/tmp/fxrate-benchmark/details-candidate.json

import esMain from 'es-main';
import { parseArgs } from 'node:util';
import fxManager from '../src/fxm/fxManager';
import type { FXPath } from '../src/types.d';
import {
    buildGraph,
    edgeCount,
    layerNodeNames,
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

// 统计一次场景内 getFXPath 的调用次数（路径解析次数）：劫持实例方法后，
// convert 内部 this.getFXPath 同样走被包装版本，convertAlongPath 不再触发。
// 只包装实例方法，不改生产代码。
function instrumentPathResolutions(manager: fxManager): {
    pathResolutions: () => number;
} {
    const original = manager.getFXPath.bind(manager);
    let resolved = 0;
    manager.getFXPath = (async (
        from: Parameters<typeof manager.getFXPath>[0],
        to: Parameters<typeof manager.getFXPath>[1],
        allowBFS = false,
    ) => {
        resolved += 1;
        return original(from, to, allowBFS);
    }) as typeof manager.getFXPath;
    return { pathResolutions: () => resolved };
}

async function getDetailsCost(
    manager: fxManager,
    from: string,
    to: string,
    bfs: boolean,
    amount: number,
    candidate: boolean,
): Promise<void> {
    // 与 getDetails 一致：源不可用时不 500，走默认 updated；rateAvailable
    // 近似 rate 门（有直连报价才进入非 bfs 的价格计算）。
    let rateAvailable = true;
    try {
        await manager.getUpdatedDate(from as never, to as never);
    } catch {
        rateAvailable = false;
    }
    if (candidate) {
        // --candidate：复刻 getDetails 优化后——路径只解析一次，cash/remit/middle
        // 经 convertAlongPath 复用同一条 path（每 pair 恰好 1 次路径解析）。
        let fxp: FXPath | undefined;
        if (bfs) {
            try {
                fxp = await manager.getFXPath(from as never, to as never, true);
            } catch {
                // 与 getDetails 一致：无路径时 result.path 回落为 []。
            }
        } else if (rateAvailable) {
            try {
                fxp = await manager.getFXPath(
                    from as never,
                    to as never,
                    false,
                );
            } catch {
                // 与 getDetails 一致：无直连路径时价格由 rate/from===to 门判定。
            }
        }
        if (rateAvailable || from === to || (bfs && fxp)) {
            for (const type of ['cash', 'remit', 'middle'] as const) {
                try {
                    if (fxp) {
                        await manager.convertAlongPath(
                            from as never,
                            to as never,
                            type,
                            amount,
                            fxp.path,
                            false,
                        );
                    } else {
                        await manager.convert(
                            from as never,
                            to as never,
                            type,
                            amount,
                            false,
                            bfs,
                        );
                    }
                } catch {
                    // 与 getDetails 一致：单个 type 失败时该字段为 false。
                }
            }
        }
        return;
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
    pathResolutionsPerPair: number;
}

async function measureScenario(
    manager: fxManager,
    pairs: Array<[string, string]>,
    bfs: boolean,
    amount: number,
    candidate: boolean,
): Promise<{
    wallMs: number;
    opsPerSec: number;
    stats: ReturnType<typeof summarize>;
    pathResolutionsPerPair: number;
}> {
    const { pathResolutions } = instrumentPathResolutions(manager);
    const latencies: number[] = [];
    const start = process.hrtime.bigint();
    for (const [from, to] of pairs) {
        const t0 = process.hrtime.bigint();
        await getDetailsCost(manager, from, to, bfs, amount, candidate);
        latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    return {
        wallMs,
        opsPerSec: pairs.length / (wallMs / 1000),
        stats: summarize(latencies),
        pathResolutionsPerPair: pathResolutions() / pairs.length,
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
                opts.candidate,
            );
        }

        const directPairs: Array<[string, string]> = [];
        const bfsPairs: Array<[string, string]> = [];
        if (opts.topology === 'layered') {
            // 分层图：direct 场景取第 0 层 → 第 1 层（真实直连边）；
            // bfs 场景取第 0 层 → 最后一层（必须逐层遍历，无直连）。
            // 各层节点名取 layerNodeNames（而非 Object.keys 插入序——跨层交错）。
            const layers = layerNodeNames(nodeCount);
            const firstLayer = layers[0]!;
            const secondLayer = layers[1]!;
            const lastLayer = layers[LAYERS - 1]!;
            for (let i = 0; i < opts.samples; i += 1) {
                directPairs.push([
                    firstLayer[randomInt(rng, 0, firstLayer.length)],
                    secondLayer[randomInt(rng, 0, secondLayer.length)],
                ]);
                bfsPairs.push([
                    firstLayer[randomInt(rng, 0, firstLayer.length)],
                    lastLayer[randomInt(rng, 0, lastLayer.length)],
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

        const direct = await measureScenario(
            manager,
            directPairs,
            false,
            100,
            opts.candidate,
        );
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

        const bfs = await measureScenario(
            manager,
            bfsPairs,
            true,
            100,
            opts.candidate,
        );
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
    if (opts.candidate) {
        const violated = results.filter((r) => r.pathResolutionsPerPair !== 1);
        if (violated.length > 0) {
            throw new Error(
                `[details-bfs] candidate must resolve the FX path exactly once per pair, got ${violated
                    .map(
                        (v) =>
                            `${v.scenario}@${v.nodes}nodes=${v.pathResolutionsPerPair}`,
                    )
                    .join(', ')}`,
            );
        }
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
    for (const r of payload.results) {
        console.log(
            `[details-bfs] ${opts.candidate ? 'candidate' : 'baseline'} ${r.scenario}@${r.nodes}nodes: pathResolutionsPerPair=${r.pathResolutionsPerPair} opsPerSec=${r.opsPerSec.toFixed(0)}`,
        );
    }
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
