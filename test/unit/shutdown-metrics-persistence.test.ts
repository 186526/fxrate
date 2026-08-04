// shutdown-metrics-persistence（offline）：停机 summary 的独立有界持久化契约。
// 覆盖固定 outcome schema、替换式恢复、损坏/超限/非法值忽略、原子临时文件清理与 Vercel 禁用。

import { jest } from '@jest/globals';
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    getMetricsSnapshot,
    getShutdownMetricsSnapshot,
    observeShutdown,
    resetMetricsForTests,
} from '../../src/metrics';
import {
    MAX_SHUTDOWN_METRICS_BYTES,
    persistShutdownMetricsToDisk,
    restoreShutdownMetricsFromDisk,
    SHUTDOWN_METRICS_FILENAME,
    SHUTDOWN_METRICS_VERSION,
} from '../../src/shutdownMetricsPersistence';

const validOutcomes = {
    graceful: { sum: 1.25, count: 2 },
    deadline: { sum: 3.5, count: 1 },
    second_signal: { sum: 0.5, count: 1 },
};

let cacheDir: string;
const originalVercel = process.env.VERCEL;

const metricsFile = (): string => join(cacheDir, SHUTDOWN_METRICS_FILENAME);

const writeMetricsFile = (value: unknown): void => {
    writeFileSync(metricsFile(), JSON.stringify(value), 'utf-8');
};

const metricValue = (
    sampleName: string,
    outcome: string,
): number | undefined => {
    const family = getMetricsSnapshot().find(
        (candidate) => candidate.name === 'fxrate_shutdown_seconds',
    );
    return family?.samples.find(
        (sample) =>
            sample.name === sampleName && sample.labels['outcome'] === outcome,
    )?.value;
};

beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-shutdown-metrics-'));
    process.env.FXRATE_CACHE_DIR = cacheDir;
    delete process.env.VERCEL;
    resetMetricsForTests();
});

afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.FXRATE_CACHE_DIR;
    rmSync(cacheDir, { recursive: true, force: true });
});

afterAll(() => {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
});

describe('shutdown metrics persistence', () => {
    test('valid state restores exact outcome sums/counts and rebuilds all', () => {
        writeMetricsFile({
            version: SHUTDOWN_METRICS_VERSION,
            outcomes: validOutcomes,
        });

        restoreShutdownMetricsFromDisk();

        expect(getShutdownMetricsSnapshot()).toEqual(validOutcomes);
        expect(metricValue('fxrate_shutdown_seconds_sum', 'all')).toBeCloseTo(
            5.25,
        );
        expect(metricValue('fxrate_shutdown_seconds_count', 'all')).toBe(4);
    });

    test('repeated restore replaces state instead of double counting', () => {
        writeMetricsFile({
            version: SHUTDOWN_METRICS_VERSION,
            outcomes: validOutcomes,
        });

        restoreShutdownMetricsFromDisk();
        restoreShutdownMetricsFromDisk();

        expect(getShutdownMetricsSnapshot()).toEqual(validOutcomes);
        expect(metricValue('fxrate_shutdown_seconds_count', 'all')).toBe(4);
    });

    test('persist writes bounded state atomically without leaving a temp file', () => {
        observeShutdown('graceful', 0.75);
        persistShutdownMetricsToDisk();

        expect(existsSync(metricsFile())).toBe(true);
        expect(readdirSync(cacheDir)).toEqual([SHUTDOWN_METRICS_FILENAME]);
        resetMetricsForTests();
        restoreShutdownMetricsFromDisk();
        expect(getShutdownMetricsSnapshot().graceful).toEqual({
            sum: 0.75,
            count: 1,
        });
    });

    test('corrupt and oversized files are ignored', () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        observeShutdown('deadline', 0.25);
        const original = getShutdownMetricsSnapshot();

        writeFileSync(metricsFile(), '{not-json', 'utf-8');
        restoreShutdownMetricsFromDisk();
        expect(getShutdownMetricsSnapshot()).toEqual(original);

        writeFileSync(
            metricsFile(),
            'x'.repeat(MAX_SHUTDOWN_METRICS_BYTES + 1),
            'utf-8',
        );
        restoreShutdownMetricsFromDisk();
        expect(getShutdownMetricsSnapshot()).toEqual(original);
    });

    test('invalid values and non-fixed outcome keys are ignored', () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const invalidOutcomes: unknown[] = [
            { ...validOutcomes, graceful: { sum: -1, count: 2 } },
            { ...validOutcomes, deadline: { sum: 1, count: 1.5 } },
            { ...validOutcomes, second_signal: { sum: null, count: 1 } },
            { ...validOutcomes, dynamic: { sum: 1, count: 1 } },
        ];

        for (const outcomes of invalidOutcomes) {
            writeMetricsFile({
                version: SHUTDOWN_METRICS_VERSION,
                outcomes,
            });
            restoreShutdownMetricsFromDisk();
            expect(metricValue('fxrate_shutdown_seconds_count', 'all')).toBe(0);
        }
    });

    test('VERCEL=1 disables both restore and persistence', () => {
        writeMetricsFile({
            version: SHUTDOWN_METRICS_VERSION,
            outcomes: validOutcomes,
        });
        process.env.VERCEL = '1';

        restoreShutdownMetricsFromDisk();
        expect(metricValue('fxrate_shutdown_seconds_count', 'all')).toBe(0);

        rmSync(metricsFile(), { force: true });
        observeShutdown('graceful', 1);
        persistShutdownMetricsToDisk();
        expect(existsSync(metricsFile())).toBe(false);
    });
});
