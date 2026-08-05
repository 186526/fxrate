// 合成汇率图构建：details-bfs / list-rates 共用。
// 星形（star）：BASE 直连全部叶子，叶子间必须经过 BASE（BFS 深度 2）。
// 网格（mesh）：任意两节点直连（稠密边）。
// 分层（layered）：LAYERS 层 × W 宽，仅相邻层完全二分连通（双向）——第 0 层到第
//   LAYERS-1 层的 BFS 必须逐层遍历全部节点，且同层多个父节点会重复入队同一目标，
//   是朴素 BFS（出队标记 + 入队复制 path）从 O(n) 退化到 O(n²) 的典型拓扑。
// 全部为内存数据，绝不访问网络。

import fxManager from '../src/fxm/fxManager';
import type { FXRate } from '../src/types.d';

export const BASE = 'USD';
export const UPDATED = new Date('2026-08-03T00:00:00Z');

export type Topology = 'star' | 'mesh' | 'layered';

// layered 层数；buildGraph 内每层宽 W = floor((nodeCount - 1) / LAYERS)
export const LAYERS = 4;

function fxRate(from: string, to: string, middle: number): FXRate {
    return {
        currency: { from: from as never, to: to as never },
        rate: { middle },
        unit: 1,
        updated: UPDATED,
    };
}

// 分层宽：与 buildGraph('layered') 的推导保持一致，供 details-bfs 生成跨层查询对。
export function layeredWidth(nodeCount: number): number {
    return Math.max(1, Math.floor((nodeCount - 1) / LAYERS));
}

// 分层图各层节点名（与 buildGraph('layered') 的推导完全一致，单一事实来源）：
// 第 l 层节点为 `${层字母}${base26(w, 2)}`（合法 3 位大写货币代码）。
// details-bfs 用它精确采样 layer0→layer1（真实直连边）与 layer0→最后一层
// （必须逐层遍历）——Object.keys 的插入序会跨层交错，不能拿来当层索引。
function layerBase26(n: number, width: number): string {
    let s = '';
    let v = n;
    do {
        s = String.fromCharCode(65 + (v % 26)) + s;
        v = Math.floor(v / 26);
    } while (v > 0);
    return s.padStart(width, 'A');
}

export function layerNodeNames(nodeCount: number): string[][] {
    const W = layeredWidth(nodeCount);
    const layerNames: string[][] = [];
    for (let l = 0; l < LAYERS; l += 1) {
        layerNames.push(
            Array.from(
                { length: W },
                (_, w) => `${String.fromCharCode(65 + l)}${layerBase26(w, 2)}`,
            ),
        );
    }
    return layerNames;
}

export function buildGraph(nodeCount: number, topology: Topology): fxManager {
    if (nodeCount < 2) {
        throw new Error('nodeCount must be >= 2');
    }
    const leaves = Array.from(
        { length: nodeCount - 1 },
        (_, i) =>
            `A${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
    );
    const rates: FXRate[] = [];
    if (topology === 'layered') {
        // 各层节点名来自共享的 layerNodeNames（与 details-bfs 采样同一推导）。
        const layerNames = layerNodeNames(nodeCount);
        for (let l = 0; l + 1 < LAYERS; l += 1) {
            for (const a of layerNames[l]) {
                for (const b of layerNames[l + 1]) {
                    rates.push(
                        fxRate(
                            a,
                            b,
                            1 +
                                ((a.charCodeAt(1) + b.charCodeAt(1)) % 10) *
                                    0.01,
                        ),
                    );
                }
            }
        }
    } else if (topology === 'mesh') {
        const nodes = [BASE, ...leaves];
        for (let i = 0; i < nodes.length; i += 1) {
            for (let j = 0; j < nodes.length; j += 1) {
                if (i === j) continue;
                rates.push(
                    fxRate(nodes[i], nodes[j], 1 + ((i + j) % 10) * 0.01),
                );
            }
        }
    } else {
        for (let i = 0; i < leaves.length; i += 1) {
            rates.push(fxRate(BASE, leaves[i], 1 + (i % 20) * 0.01));
        }
    }
    return new fxManager(rates);
}

export function edgeCount(nodeCount: number, topology: Topology): number {
    if (topology === 'mesh') return nodeCount * (nodeCount - 1);
    if (topology === 'layered') {
        const W = layeredWidth(nodeCount);
        return (LAYERS - 1) * W * W * 2;
    }
    return nodeCount - 1;
}
