import { Buffer } from 'node:buffer';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
    getShutdownMetricsSnapshot,
    restoreShutdownMetrics,
    SHUTDOWN_OUTCOMES,
    type ShutdownMetricsSnapshot,
    type ShutdownSummarySnapshot,
} from './metrics';

export const SHUTDOWN_METRICS_FILENAME = 'fxrate-shutdown-metrics.json';
export const SHUTDOWN_METRICS_VERSION = 1;
export const MAX_SHUTDOWN_METRICS_BYTES = 4 * 1024;

interface ShutdownMetricsFile {
    readonly version: typeof SHUTDOWN_METRICS_VERSION;
    readonly outcomes: ShutdownMetricsSnapshot;
}

let tempSequence = 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null);

const hasExactKeys = (
    value: Record<string, unknown>,
    expected: readonly string[],
): boolean => {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return (
        actual.length === sortedExpected.length &&
        actual.every((key, index) => key === sortedExpected[index])
    );
};

const parseSummary = (value: unknown): ShutdownSummarySnapshot | null => {
    if (!isPlainObject(value) || !hasExactKeys(value, ['count', 'sum'])) {
        return null;
    }
    const { count, sum } = value;
    if (
        !Number.isSafeInteger(count) ||
        (count as number) < 0 ||
        typeof sum !== 'number' ||
        !Number.isFinite(sum) ||
        sum < 0
    ) {
        return null;
    }
    return { count: count as number, sum };
};

const parseFile = (value: unknown): ShutdownMetricsSnapshot | null => {
    if (
        !isPlainObject(value) ||
        !hasExactKeys(value, ['outcomes', 'version']) ||
        value.version !== SHUTDOWN_METRICS_VERSION ||
        !isPlainObject(value.outcomes) ||
        !hasExactKeys(value.outcomes, SHUTDOWN_OUTCOMES)
    ) {
        return null;
    }
    const graceful = parseSummary(value.outcomes.graceful);
    const deadline = parseSummary(value.outcomes.deadline);
    const secondSignal = parseSummary(value.outcomes.second_signal);
    if (!graceful || !deadline || !secondSignal) return null;
    return {
        graceful,
        deadline,
        second_signal: secondSignal,
    };
};

const cachePath = (): string | null => {
    if (process.env.VERCEL === '1') return null;
    const directory = process.env.FXRATE_CACHE_DIR ?? process.cwd();
    try {
        mkdirSync(directory, { recursive: true });
        return join(directory, SHUTDOWN_METRICS_FILENAME);
    } catch (error) {
        console.error('[shutdown-metrics] cache directory unavailable:', error);
        return null;
    }
};

export const loadShutdownMetricsSnapshot =
    (): ShutdownMetricsSnapshot | null => {
        const path = cachePath();
        if (!path || !existsSync(path)) return null;
        try {
            if (statSync(path).size > MAX_SHUTDOWN_METRICS_BYTES) {
                console.error(
                    `[shutdown-metrics] file exceeds ${MAX_SHUTDOWN_METRICS_BYTES} bytes, ignoring`,
                );
                return null;
            }
            const parsed = parseFile(
                JSON.parse(readFileSync(path, 'utf-8')) as unknown,
            );
            if (!parsed) {
                console.error('[shutdown-metrics] invalid file, ignoring');
                return null;
            }
            return parsed;
        } catch (error) {
            console.error('[shutdown-metrics] load failed:', error);
            return null;
        }
    };

export const restoreShutdownMetricsFromDisk = (): void => {
    const snapshot = loadShutdownMetricsSnapshot();
    if (snapshot) restoreShutdownMetrics(snapshot);
};

export const persistShutdownMetricsToDisk = (): void => {
    const path = cachePath();
    if (!path) return;
    const file: ShutdownMetricsFile = {
        version: SHUTDOWN_METRICS_VERSION,
        outcomes: getShutdownMetricsSnapshot(),
    };
    const serialized = JSON.stringify(file);
    if (Buffer.byteLength(serialized, 'utf-8') > MAX_SHUTDOWN_METRICS_BYTES) {
        console.error(
            `[shutdown-metrics] serialized state exceeds ${MAX_SHUTDOWN_METRICS_BYTES} bytes, ignoring`,
        );
        return;
    }
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.${tempSequence++}.tmp`;
    try {
        writeFileSync(temporaryPath, serialized, 'utf-8');
        renameSync(temporaryPath, path);
    } catch (error) {
        console.error('[shutdown-metrics] save failed:', error);
        if (existsSync(temporaryPath)) {
            try {
                unlinkSync(temporaryPath);
            } catch (cleanupError) {
                console.error(
                    '[shutdown-metrics] temporary file cleanup failed:',
                    cleanupError,
                );
            }
        }
    }
};
