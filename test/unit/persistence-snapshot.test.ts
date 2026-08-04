// persistence-snapshot（Phase 2，offline）：快照持久化校验契约测试。
// 覆盖：save→load 往返（Fraction/Date 还原）、版本不符忽略、非法 savedAt 忽略、
// 超龄整包忽略（注入假 now 做确定性断言）、新鲜快照正常返回、latestUpdatedAt
// （取最新合法 updated、跳过 invalid、空源返回 null）、环境变量阈值解析。
// 全程临时目录 + 注入时钟，零公网访问，--detectOpenHandles 无泄漏。

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    loadSnapshot,
    saveSnapshot,
    latestUpdatedAt,
    snapshotMaxAgeMs,
    staleRateAgeMs,
    DEFAULT_SNAPSHOT_MAX_AGE_MS,
    type SnapshotData,
    type SourceRates,
} from '../../src/persistence';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fxrate-persist-'));
    process.env.FXRATE_CACHE_DIR = dir;
});

afterEach(() => {
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.FXRATE_SNAPSHOT_MAX_AGE_MS;
    delete process.env.FXRATE_STALE_RATE_AGE_MS;
    rmSync(dir, { recursive: true, force: true });
});

const cacheFile = (): string => join(dir, 'fxrate-cache.json');

const writeSnapshotFile = (payload: unknown): void => {
    writeFileSync(cacheFile(), JSON.stringify(payload), 'utf-8');
};

describe('snapshot save/load round trip', () => {
    test('saveSnapshot then loadSnapshot restores Fraction and Date', () => {
        const now = new Date('2026-08-04T00:00:00Z');
        const sources: SnapshotData = {
            bank: {
                USD: {
                    CNY: {
                        middle: 7,
                        cash: 6.9,
                        remit: 6.95,
                        updated: now,
                    } as unknown as SourceRates[string][string],
                },
            },
        };
        saveSnapshot(sources);
        expect(existsSync(cacheFile())).toBe(true);

        const loaded = loadSnapshot();
        expect(loaded).not.toBeNull();
        const cell = loaded!['bank']!['USD']!['CNY'];
        expect(cell.updated).toBeInstanceOf(Date);
        expect((cell.updated as Date).toISOString()).toBe(now.toISOString());
        expect(latestUpdatedAt(loaded!['bank'])).toEqual(now);
    });
});

describe('snapshot savedAt validation', () => {
    test('wrong version is ignored', () => {
        writeSnapshotFile({
            version: '999',
            savedAt: new Date().toISOString(),
            sources: {},
        });
        expect(loadSnapshot()).toBeNull();
    });

    test('invalid savedAt is ignored', () => {
        writeSnapshotFile({
            version: '1',
            savedAt: 'not-a-date',
            sources: {},
        });
        expect(loadSnapshot()).toBeNull();
    });

    test('snapshot older than maxAgeMs is ignored entirely', () => {
        const now = Date.now();
        writeSnapshotFile({
            version: '1',
            savedAt: new Date(now - 48 * 3_600_000).toISOString(),
            sources: {},
        });
        expect(loadSnapshot({ maxAgeMs: 24 * 3_600_000, now })).toBeNull();
    });

    test('fresh snapshot within maxAgeMs is accepted', () => {
        const now = Date.now();
        writeSnapshotFile({
            version: '1',
            savedAt: new Date(now - 3_600_000).toISOString(),
            sources: {},
        });
        const loaded = loadSnapshot({ maxAgeMs: 24 * 3_600_000, now });
        expect(loaded).not.toBeNull();
    });

    test('missing file returns null', () => {
        expect(loadSnapshot()).toBeNull();
    });
});

describe('latestUpdatedAt', () => {
    test('returns the newest valid updated across all cells', () => {
        const now = Date.now();
        const rates = {
            USD: { CNY: { updated: new Date(now - 5000) } },
            EUR: {
                // invalid Date 被跳过
                JPY: { updated: new Date('invalid') },
                CNY: { updated: new Date(now - 1000) },
            },
        } as unknown as SourceRates;
        expect(latestUpdatedAt(rates)?.getTime()).toBe(now - 1000);
    });

    test('1970 self-rate does not mask real data and empty source returns null', () => {
        const now = Date.now();
        const withSelf = {
            USD: {
                USD: { updated: new Date('1970-01-01T00:00:00Z') },
                CNY: { updated: new Date(now - 1000) },
            },
        } as unknown as SourceRates;
        expect(latestUpdatedAt(withSelf)?.getTime()).toBe(now - 1000);
        expect(latestUpdatedAt({})).toBeNull();
        expect(latestUpdatedAt({ USD: {} })).toBeNull();
    });
});

describe('threshold env parsing', () => {
    test('snapshotMaxAgeMs reads FXRATE_SNAPSHOT_MAX_AGE_MS and falls back to default', () => {
        expect(snapshotMaxAgeMs()).toBe(DEFAULT_SNAPSHOT_MAX_AGE_MS);
        process.env.FXRATE_SNAPSHOT_MAX_AGE_MS = '3600000';
        expect(snapshotMaxAgeMs()).toBe(3_600_000);
        // 非法值回落默认
        process.env.FXRATE_SNAPSHOT_MAX_AGE_MS = 'abc';
        expect(snapshotMaxAgeMs()).toBe(DEFAULT_SNAPSHOT_MAX_AGE_MS);
    });

    test('staleRateAgeMs defaults to snapshotMaxAgeMs when its env is unset', () => {
        delete process.env.FXRATE_SNAPSHOT_MAX_AGE_MS;
        delete process.env.FXRATE_STALE_RATE_AGE_MS;
        expect(staleRateAgeMs()).toBe(DEFAULT_SNAPSHOT_MAX_AGE_MS);
        // 自身 env 未设置 → 跟随 FXRATE_SNAPSHOT_MAX_AGE_MS
        process.env.FXRATE_SNAPSHOT_MAX_AGE_MS = '3600000';
        expect(staleRateAgeMs()).toBe(3_600_000);
        // 自身 env 设置 → 覆盖
        process.env.FXRATE_STALE_RATE_AGE_MS = '60000';
        expect(staleRateAgeMs()).toBe(60_000);
    });

    test('loadSnapshot uses the env max age when no option is given', () => {
        const now = Date.now();
        writeSnapshotFile({
            version: '1',
            savedAt: new Date(now - 2 * 3_600_000).toISOString(),
            sources: {},
        });
        process.env.FXRATE_SNAPSHOT_MAX_AGE_MS = String(3_600_000);
        expect(loadSnapshot({ now })).toBeNull();
        // 放宽阈值后同一文件可加载
        process.env.FXRATE_SNAPSHOT_MAX_AGE_MS = String(4 * 3_600_000);
        expect(loadSnapshot({ now })).not.toBeNull();
    });
});

describe('snapshot security validation', () => {
    const now = Date.now();
    const cell = {
        middle: 7,
        cash: 6.9,
        remit: 6.95,
        updated: new Date(now - 2000).toISOString(),
    };
    const baseSnapshot = (over: Record<string, unknown> = {}): object => ({
        version: '1',
        savedAt: new Date(now - 1000).toISOString(),
        sources: { bank: { USD: { CNY: cell } } },
        ...over,
    });

    test('oversized snapshot file is rejected before parsing', () => {
        writeSnapshotFile(baseSnapshot());
        expect(loadSnapshot({ maxBytes: 1, now })).toBeNull();
        // 默认上限（32 MiB）足够 → 接受
        expect(loadSnapshot({ now })).not.toBeNull();
    });

    test('non-object top level is rejected', () => {
        writeFileSync(cacheFile(), JSON.stringify([1, 2, 3]), 'utf-8');
        expect(loadSnapshot({ now })).toBeNull();
        writeFileSync(cacheFile(), JSON.stringify('nope'), 'utf-8');
        expect(loadSnapshot({ now })).toBeNull();
    });

    test('missing / non-object sources key is rejected', () => {
        writeSnapshotFile({
            version: '1',
            savedAt: new Date(now - 1000).toISOString(),
        });
        expect(loadSnapshot({ now })).toBeNull();
        writeSnapshotFile(baseSnapshot({ sources: [1, 2, 3] }));
        expect(loadSnapshot({ now })).toBeNull();
    });

    test('too many sources is rejected', () => {
        const sources: Record<string, unknown> = {};
        for (let i = 0; i < 201; i++) {
            sources[`src${i}`] = { USD: { CNY: cell } };
        }
        writeSnapshotFile(baseSnapshot({ sources }));
        expect(loadSnapshot({ now })).toBeNull();
    });

    test('invalid currency codes are rejected', () => {
        writeSnapshotFile(
            baseSnapshot({ sources: { bank: { US: { CNY: cell } } } }),
        );
        expect(loadSnapshot({ now })).toBeNull();
        writeSnapshotFile(
            baseSnapshot({ sources: { bank: { USD: { CN: cell } } } }),
        );
        expect(loadSnapshot({ now })).toBeNull();
        writeSnapshotFile(
            baseSnapshot({ sources: { bank: { usd: { CNY: cell } } } }),
        );
        expect(loadSnapshot({ now })).toBeNull();
    });

    test('missing or invalid quotes are rejected', () => {
        const { remit: _remit, ...missingRemit } = cell;
        writeSnapshotFile(
            baseSnapshot({
                sources: { bank: { USD: { CNY: missingRemit } } },
            }),
        );
        expect(loadSnapshot({ now })).toBeNull();
        writeSnapshotFile(
            baseSnapshot({
                sources: {
                    bank: { USD: { CNY: { ...cell, middle: -7 } } },
                },
            }),
        );
        expect(loadSnapshot({ now })).toBeNull();
        writeSnapshotFile(
            baseSnapshot({
                sources: { bank: { USD: { CNY: { ...cell, cash: 'abc' } } } },
            }),
        );
        expect(loadSnapshot({ now })).toBeNull();
        writeSnapshotFile(
            baseSnapshot({
                sources: {
                    bank: { USD: { CNY: { ...cell, cash: 0 } } },
                },
            }),
        );
        expect(loadSnapshot({ now })).toBeNull();
    });

    test('malformed Fraction structures are rejected', () => {
        // 合法 Fraction（{mathjs,n,d}）→ 接受
        writeSnapshotFile(
            baseSnapshot({
                sources: {
                    bank: {
                        USD: {
                            CNY: {
                                middle: { mathjs: 'Fraction', n: 7, d: 1 },
                                cash: 6.9,
                                remit: 6.95,
                                updated: cell.updated,
                            },
                        },
                    },
                },
            }),
        );
        expect(loadSnapshot({ now })).not.toBeNull();
        // 缺 mathjs 标记 → 不是合法 Fraction，拒绝
        writeSnapshotFile(
            baseSnapshot({
                sources: {
                    bank: {
                        USD: {
                            CNY: {
                                middle: { n: 7, d: 1 },
                                cash: 6.9,
                                remit: 6.95,
                                updated: cell.updated,
                            },
                        },
                    },
                },
            }),
        );
        expect(loadSnapshot({ now })).toBeNull();
        // 负 Fraction → 拒绝
        writeSnapshotFile(
            baseSnapshot({
                sources: {
                    bank: {
                        USD: {
                            CNY: {
                                middle: {
                                    mathjs: 'Fraction',
                                    n: -7,
                                    d: 1,
                                },
                                cash: 6.9,
                                remit: 6.95,
                                updated: cell.updated,
                            },
                        },
                    },
                },
            }),
        );
        expect(loadSnapshot({ now })).toBeNull();
    });

    test('future savedAt beyond the allowed clock skew is rejected', () => {
        writeSnapshotFile({
            version: '1',
            savedAt: new Date(now + 10 * 60 * 1000).toISOString(),
            sources: {},
        });
        expect(loadSnapshot({ now })).toBeNull();
        // 小偏差（60s < 默认 5min skew）→ 接受
        writeSnapshotFile({
            version: '1',
            savedAt: new Date(now + 60 * 1000).toISOString(),
            sources: {},
        });
        expect(loadSnapshot({ now })).not.toBeNull();
    });

    test('future rate.updated beyond the allowed clock skew is rejected', () => {
        writeSnapshotFile(
            baseSnapshot({
                sources: {
                    bank: {
                        USD: {
                            CNY: {
                                ...cell,
                                updated: new Date(
                                    now + 10 * 60 * 1000,
                                ).toISOString(),
                            },
                        },
                    },
                },
            }),
        );
        expect(loadSnapshot({ now })).toBeNull();
        writeSnapshotFile(
            baseSnapshot({
                sources: {
                    bank: {
                        USD: {
                            CNY: {
                                ...cell,
                                updated: new Date(
                                    now + 60 * 1000,
                                ).toISOString(),
                            },
                        },
                    },
                },
            }),
        );
        expect(loadSnapshot({ now })).not.toBeNull();
    });

    test('a valid multi-currency snapshot is accepted', () => {
        writeSnapshotFile(
            baseSnapshot({
                sources: {
                    bank: {
                        USD: { CNY: cell, HKD: { ...cell, middle: 7.8 } },
                        EUR: { CNY: cell },
                    },
                    bank2: { USD: { CNY: cell } },
                },
            }),
        );
        const loaded = loadSnapshot({ now });
        expect(loaded).not.toBeNull();
        expect(Object.keys(loaded!)).toEqual(['bank', 'bank2']);
    });
});
