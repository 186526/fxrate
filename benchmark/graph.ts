// 合成汇率图构建：details-bfs / list-rates 共用。
// 星形（star）：BASE 直连全部叶子，叶子间必须经过 BASE（BFS 深度 2）。
// 网格（mesh）：任意两节点直连（稠密边）。
// 全部为内存数据，绝不访问网络。

import fxManager from '../src/fxm/fxManager';
import type { FXRate } from '../src/types.d';

export const BASE = 'USD';
export const UPDATED = new Date('2026-08-03T00:00:00Z');

export type Topology = 'star' | 'mesh';

function fxRate(from: string, to: string, middle: number): FXRate {
    return {
        currency: { from: from as never, to: to as never },
        rate: { middle },
        unit: 1,
        updated: UPDATED,
    };
}

export function buildGraph(nodeCount: number, topology: Topology): fxManager {
    if (nodeCount < 2) {
        throw new Error('nodeCount must be >= 2');
    }
    const leaves = Array.from(
        { length: nodeCount - 1 },
        (_, i) => `C${String(i + 1).padStart(3, '0')}`,
    );
    const rates: FXRate[] = [];
    if (topology === 'mesh') {
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
    return topology === 'mesh' ? nodeCount * (nodeCount - 1) : nodeCount - 1;
}
