// card-heap：Card（Visa/MasterCard）稀疏类型化缓存 vs 旧密集 Proxy 矩阵的堆/吞吐基准。
// baseline：重建 Phase 1/4 旧实现形态——LRU 存 JSON 字符串 + 全量 N² Proxy cell，
//           字段读取即 JSON.parse；build 测 N² 单元格物化堆开销，access 测逐 cell 读取吞吐。
// candidate：当前实现——稀疏矩阵（行/单元格按需物化，绝不全量构建）+ typed CardRate LRU
//           （写缓存时一次性解析，字段读取零 JSON.parse）；build 测按需物化堆开销，
//           access 用真实 createCardRateCell 读取 typed LRU（每次读取克隆 Fraction/Date）。
// denseTyped：FXRATE_CARD_DENSE_MATRIX=1 回退的全量 typed 密集矩阵（一次性物化 N² 个
//           live typed 单元格）——量化回退旗标的堆成本。
// 用法：node --expose-gc ./node_modules/.bin/tsx benchmark/card-heap.ts --pairs=500 --output=/tmp/fxrate-benchmark/heap-baseline.json

import esMain from 'es-main';
import { parseArgs } from 'node:util';
import { LRUCache } from 'lru-cache';
import { fraction } from 'mathjs';
import visaFXM from '../src/FXGetter/visa';
import mastercardFXM from '../src/FXGetter/mastercard';
import {
    createCardDenseMatrix,
    createCardRateCellFactory,
    type CardRate,
} from '../src/FXGetter/cardCapacity';
import type { FXRateType } from '../src/fxm/fxManager';
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

interface DenseBuildResult {
    cells: number;
    gcAvailable: boolean;
    retainedHeapMb: number;
}

// 旧实现单元格形态：N 个「LRU 存 JSON 字符串 + Proxy 字段读取即 JSON.parse」cell，全部保留引用。
function measureDenseCells(count: number): DenseBuildResult {
    const cache = new LRUCache<string, string>({ max: count });
    const payload = JSON.stringify({ data: { fxRateVisa: '7.25' } });
    for (let i = 0; i < count; i += 1) {
        cache.set(`K${i}`, payload);
    }
    const gcAvailable = forceGc();
    const heapBeforeMb = heapUsedMb();
    const grid: Array<{ middle: number | undefined }> = [];
    for (let i = 0; i < count; i += 1) {
        const key = `K${i}`;
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
    forceGc();
    const heapAfterMb = heapUsedMb();
    cache.clear();
    grid.length = 0;
    return {
        cells: count,
        gcAvailable,
        retainedHeapMb: heapAfterMb - heapBeforeMb,
    };
}

interface SparseBuildResult {
    theoreticalCells: number;
    touchedRows: number;
    touchedCells: number;
    touched: number;
    gcAvailable: boolean;
    retainedHeapMb: number;
}

// 当前实现：稀疏矩阵按需物化，仅触碰 pairs 个 pair 的堆开销。
function measureSparseBuild(
    fxm: visaFXM | mastercardFXM,
    pairs: number,
): SparseBuildResult {
    const list = fxm.fxRateList;
    const currencies = Object.keys(list);
    const theoreticalCells = currencies.length ** 2;
    const rows0 = fxm.sparseRows;
    const cells0 = fxm.sparseCells;
    const gcAvailable = forceGc();
    const heapBeforeMb = heapUsedMb();
    let touched = 0;
    for (let i = 0; i < pairs; i += 1) {
        const from = currencies[i % currencies.length];
        const to = currencies[(i * 7 + 3) % currencies.length];
        if (from === to) continue;
        if (list[from][to] !== undefined) touched += 1;
    }
    forceGc();
    const heapAfterMb = heapUsedMb();
    return {
        theoreticalCells,
        touchedRows: fxm.sparseRows - rows0,
        touchedCells: fxm.sparseCells - cells0,
        touched,
        gcAvailable,
        retainedHeapMb: heapAfterMb - heapBeforeMb,
    };
}

// 候选单元格形态：N 个「typed CardRate LRU + createCardRateCell live getter」cell，全部保留引用。
function measureSparseCells(count: number): DenseBuildResult {
    const cache = new LRUCache<string, CardRate>({ max: count });
    const rate: CardRate = {
        middle: fraction('7.25'),
        cash: fraction('7.25'),
        remit: fraction('7.25'),
        updated: new Date(),
    };
    for (let i = 0; i < count; i += 1) {
        cache.set(`K${i}`, rate);
    }
    const cellForKey = createCardRateCellFactory(cache);
    const gcAvailable = forceGc();
    const heapBeforeMb = heapUsedMb();
    const grid: FXRateType[] = [];
    for (let i = 0; i < count; i += 1) {
        grid.push(cellForKey(`K${i}`));
    }
    forceGc();
    const heapAfterMb = heapUsedMb();
    cache.clear();
    grid.length = 0;
    return {
        cells: count,
        gcAvailable,
        retainedHeapMb: heapAfterMb - heapBeforeMb,
    };
}

interface DenseTypedBuildResult {
    rows: number;
    cells: number;
    gcAvailable: boolean;
    retainedHeapMb: number;
}

// 回退实现（FXRATE_CARD_DENSE_MATRIX=1）：全量 N×N typed 密集矩阵，行/格一次性物化。
function measureDenseTypedBuild(
    currencies: readonly string[],
    cache: LRUCache<string, CardRate>,
    normalize: (code: string) => string,
): DenseTypedBuildResult {
    const gcAvailable = forceGc();
    const heapBeforeMb = heapUsedMb();
    const matrix = createCardDenseMatrix(currencies, cache, normalize);
    forceGc();
    const heapAfterMb = heapUsedMb();
    return {
        rows: currencies.length,
        cells: currencies.length ** 2,
        gcAvailable,
        retainedHeapMb: heapAfterMb - heapBeforeMb,
    };
}

function measureJsonParseAccess(pairs: number) {
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

function measureTypedAccess(pairs: number) {
    const cellCount = pairs * pairs;
    const cache = new LRUCache<string, CardRate>({ max: cellCount });
    const rate: CardRate = {
        middle: fraction('7.25'),
        cash: fraction('7.25'),
        remit: fraction('7.25'),
        updated: new Date(),
    };
    for (let i = 0; i < pairs; i += 1) {
        for (let j = 0; j < pairs; j += 1) {
            cache.set(`K${i}-K${j}`, rate);
        }
    }
    const cellForKey = createCardRateCellFactory(cache);
    const grid: FXRateType[] = [];
    for (let i = 0; i < pairs; i += 1) {
        for (let j = 0; j < pairs; j += 1) {
            grid.push(cellForKey(`K${i}-K${j}`));
        }
    }
    const gcAvailable = forceGc();
    const heapBeforeMb = heapUsedMb();
    const latencies: number[] = [];
    let acc = 0;
    const start = process.hrtime.bigint();
    for (const cell of grid) {
        const t0 = process.hrtime.bigint();
        acc += Number(cell.middle) || 0;
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
    const visa = new visaFXM();
    const mastercard = new mastercardFXM();
    const visaCurrencies = Object.keys(visa.fxRateList);
    const mastercardCurrencies = Object.keys(mastercard.fxRateList);
    const visaCells = visaCurrencies.length ** 2;
    const mastercardCells = mastercardCurrencies.length ** 2;
    const normalize = (code: string): string => (code === 'CNH' ? 'CNY' : code);

    const sparseCellVisa = measureSparseCells(visaCells);
    const sparseCellMastercard = measureSparseCells(mastercardCells);
    const sparseVisa = measureSparseBuild(visa, opts.pairs);
    const sparseMastercard = measureSparseBuild(mastercard, opts.pairs);
    const denseVisa = measureDenseCells(visaCells);
    const denseMastercard = measureDenseCells(mastercardCells);
    const denseTypedVisa = measureDenseTypedBuild(
        visaCurrencies,
        new LRUCache<string, CardRate>({ max: visaCells }),
        normalize,
    );
    const denseTypedMastercard = measureDenseTypedBuild(
        mastercardCurrencies,
        new LRUCache<string, CardRate>({ max: mastercardCells }),
        normalize,
    );

    const baselineAccess = measureJsonParseAccess(opts.pairs);
    const candidateAccess = measureTypedAccess(opts.pairs);

    const denseMatrixHeapMb =
        denseVisa.retainedHeapMb + denseMastercard.retainedHeapMb;
    const denseTypedMatrixHeapMb =
        denseTypedVisa.retainedHeapMb + denseTypedMastercard.retainedHeapMb;
    const sparseCellShapeHeapMb =
        sparseCellVisa.retainedHeapMb + sparseCellMastercard.retainedHeapMb;
    const sparseOnDemandHeapMb =
        sparseVisa.retainedHeapMb + sparseMastercard.retainedHeapMb;

    return {
        name: 'card-heap',
        args: {
            pairs: opts.pairs,
            candidate: opts.candidate,
        },
        environment: environment(),
        build: {
            gcAvailable: sparseVisa.gcAvailable,
            visaCells,
            mastercardCells,
            totalCells: visaCells + mastercardCells,
            sparse: {
                rows: sparseVisa.touchedRows + sparseMastercard.touchedRows,
                cells: sparseVisa.touchedCells + sparseMastercard.touchedCells,
            },
            retainedHeapMb: sparseOnDemandHeapMb,
        },
        access: candidateAccess,
        baseline: {
            build: {
                visa: denseVisa,
                mastercard: denseMastercard,
                totalRetainedHeapMb: denseMatrixHeapMb,
            },
            access: baselineAccess,
        },
        denseTypedRollback: {
            build: {
                visa: denseTypedVisa,
                mastercard: denseTypedMastercard,
                totalRetainedHeapMb: denseTypedMatrixHeapMb,
            },
        },
        comparison: {
            denseMatrixHeapMb,
            denseTypedMatrixHeapMb,
            sparseCellShapeHeapMb,
            sparseOnDemandHeapMb,
            cellShapeSavingMb: denseMatrixHeapMb - sparseCellShapeHeapMb,
            cellShapeSavingPct:
                denseMatrixHeapMb > 0
                    ? (100 * (denseMatrixHeapMb - sparseCellShapeHeapMb)) /
                      denseMatrixHeapMb
                    : 0,
            onDemandSavingMb: denseMatrixHeapMb - sparseOnDemandHeapMb,
            onDemandSavingPct:
                denseMatrixHeapMb > 0
                    ? (100 * (denseMatrixHeapMb - sparseOnDemandHeapMb)) /
                      denseMatrixHeapMb
                    : 0,
            denseTypedVsDenseJsonSavingPct:
                denseMatrixHeapMb > 0
                    ? (100 * (denseMatrixHeapMb - denseTypedMatrixHeapMb)) /
                      denseMatrixHeapMb
                    : 0,
            baselineAccessOpsPerSec: baselineAccess.opsPerSec,
            candidateAccessOpsPerSec: candidateAccess.opsPerSec,
            accessSpeedupX:
                baselineAccess.opsPerSec > 0
                    ? candidateAccess.opsPerSec / baselineAccess.opsPerSec
                    : 0,
            parseEliminated: true,
        },
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
