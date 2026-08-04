import { performance } from 'node:perf_hooks';

type MetricType = 'counter' | 'gauge' | 'summary';
type MetricLabels = Readonly<Record<string, string>>;

export interface MetricSampleSnapshot {
    readonly name: string;
    readonly labels: MetricLabels;
    readonly value: number;
}

export interface MetricFamilySnapshot {
    readonly name: string;
    readonly help: string;
    readonly type: MetricType;
    readonly samples: readonly MetricSampleSnapshot[];
}

interface MetricSeries {
    readonly labels: Record<string, string>;
    value: number;
    count: number;
    sum: number;
}

interface RegisteredMetric {
    readonly name: string;
    readonly help: string;
    readonly type: MetricType;
    readonly labelNames: readonly string[];
    readonly initialLabels: readonly MetricLabels[];
    readonly series: Map<string, MetricSeries>;
}

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_SERIES_PER_FAMILY = 256;
const MAX_LABEL_VALUE_LENGTH = 200;
const ALL = 'all';

export const SHUTDOWN_OUTCOMES = [
    'graceful',
    'deadline',
    'second_signal',
] as const;
export type ShutdownOutcome = (typeof SHUTDOWN_OUTCOMES)[number];

export interface ShutdownSummarySnapshot {
    readonly sum: number;
    readonly count: number;
}

export interface ShutdownMetricsSnapshot {
    readonly graceful: ShutdownSummarySnapshot;
    readonly deadline: ShutdownSummarySnapshot;
    readonly second_signal: ShutdownSummarySnapshot;
}

const registry: RegisteredMetric[] = [];
const registeredNames = new Set<string>();

const register = (
    name: string,
    help: string,
    type: MetricType,
    labelNames: readonly string[],
    initialLabels: readonly MetricLabels[],
): RegisteredMetric => {
    if (!METRIC_NAME_PATTERN.test(name) || registeredNames.has(name)) {
        throw new TypeError(`Invalid or duplicate Prometheus metric: ${name}`);
    }
    for (const labelName of labelNames) {
        if (!LABEL_NAME_PATTERN.test(labelName)) {
            throw new TypeError(`Invalid Prometheus label: ${labelName}`);
        }
    }
    const metric: RegisteredMetric = {
        name,
        help,
        type,
        labelNames: [...labelNames],
        initialLabels: initialLabels.map((labels) => ({ ...labels })),
        series: new Map(),
    };
    registeredNames.add(name);
    registry.push(metric);
    resetMetric(metric);
    return metric;
};

const normalizeLabels = (
    metric: RegisteredMetric,
    labels: MetricLabels,
): Record<string, string> => {
    const normalized: Record<string, string> = {};
    for (const labelName of metric.labelNames) {
        const value = labels[labelName];
        if (typeof value !== 'string') {
            throw new TypeError(
                `Missing Prometheus label ${labelName} for ${metric.name}`,
            );
        }
        normalized[labelName] = value.slice(0, MAX_LABEL_VALUE_LENGTH);
    }
    return normalized;
};

const labelKey = (metric: RegisteredMetric, labels: MetricLabels): string =>
    metric.labelNames
        .map((name) => {
            const value = labels[name] ?? '';
            return `${value.length}:${value}`;
        })
        .join('|');

const seriesFor = (
    metric: RegisteredMetric,
    labels: MetricLabels,
): MetricSeries | undefined => {
    const normalized = normalizeLabels(metric, labels);
    const key = labelKey(metric, normalized);
    const current = metric.series.get(key);
    if (current) return current;
    if (metric.series.size >= MAX_SERIES_PER_FAMILY) return undefined;
    const created: MetricSeries = {
        labels: normalized,
        value: 0,
        count: 0,
        sum: 0,
    };
    metric.series.set(key, created);
    return created;
};

function resetMetric(metric: RegisteredMetric): void {
    metric.series.clear();
    for (const labels of metric.initialLabels) seriesFor(metric, labels);
}

const increment = (
    metric: RegisteredMetric,
    labels: MetricLabels,
    amount = 1,
): void => {
    if (!Number.isFinite(amount) || amount < 0) return;
    const series = seriesFor(metric, labels);
    if (series) series.value += amount;
};

const decrement = (
    metric: RegisteredMetric,
    labels: MetricLabels,
    amount = 1,
): void => {
    if (!Number.isFinite(amount) || amount < 0) return;
    const series = seriesFor(metric, labels);
    if (series) series.value = Math.max(0, series.value - amount);
};

const observe = (
    metric: RegisteredMetric,
    labels: MetricLabels,
    value: number,
): void => {
    if (!Number.isFinite(value) || value < 0) return;
    const series = seriesFor(metric, labels);
    if (!series) return;
    series.count += 1;
    series.sum += value;
};

const samplesFor = (metric: RegisteredMetric): MetricSampleSnapshot[] => {
    const samples: MetricSampleSnapshot[] = [];
    const series = [...metric.series.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
    );
    for (const [, current] of series) {
        if (metric.type === 'summary') {
            samples.push(
                {
                    name: `${metric.name}_sum`,
                    labels: current.labels,
                    value: current.sum,
                },
                {
                    name: `${metric.name}_count`,
                    labels: current.labels,
                    value: current.count,
                },
            );
        } else {
            samples.push({
                name: metric.name,
                labels: current.labels,
                value: current.value,
            });
        }
    }
    return samples;
};

const escapeHelp = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/(?:\r\n|\r|\n)/g, '\\n');

const escapeLabelValue = (value: string): string =>
    value
        .replace(/\\/g, '\\\\')
        .replace(/(?:\r\n|\r|\n)/g, '\\n')
        .replace(/"/g, '\\"');

const formatLabels = (labels: MetricLabels): string => {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return `{${entries
        .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
        .join(',')}}`;
};

const formatNumber = (value: number): string => {
    if (!Number.isFinite(value)) return '0';
    return Object.is(value, -0) ? '0' : String(value);
};

const rpcBatchItems = register(
    'fxrate_rpc_batch_items',
    'Number of JSON-RPC items received per batch request.',
    'summary',
    [],
    [{}],
);
const rpcRejectedTotal = register(
    'fxrate_rpc_rejected_total',
    'Total JSON-RPC requests rejected by the request budget.',
    'counter',
    ['reason'],
    [{ reason: ALL }],
);
const workActive = register(
    'fxrate_work_active',
    'Current bounded executor work items in progress.',
    'gauge',
    ['kind'],
    [{ kind: ALL }],
);
const workQueueWaitSeconds = register(
    'fxrate_work_queue_wait_seconds',
    'Seconds work items spend in bounded executor queues before starting.',
    'summary',
    ['kind'],
    [{ kind: ALL }],
);
const sourceFetchSeconds = register(
    'fxrate_source_fetch_seconds',
    'Seconds spent fetching and validating an upstream source response.',
    'summary',
    ['source'],
    [{ source: ALL }],
);
const chromiumActive = register(
    'fxrate_chromium_active',
    'Current headless Chromium browser instances whose closure is unconfirmed.',
    'gauge',
    [],
    [{}],
);
const cacheHitsTotal = register(
    'fxrate_cache_hits_total',
    'Total runtime cache hits.',
    'counter',
    ['cache', 'source'],
    [{ cache: ALL, source: ALL }],
);
const shutdownSeconds = register(
    'fxrate_shutdown_seconds',
    'Seconds from the first shutdown signal to process exit coordination.',
    'summary',
    ['outcome'],
    [{ outcome: ALL }, ...SHUTDOWN_OUTCOMES.map((outcome) => ({ outcome }))],
);

const observeWithAggregate = (
    metric: RegisteredMetric,
    labelName: string,
    labelValue: string,
    value: number,
): void => {
    observe(metric, { [labelName]: ALL }, value);
    if (labelValue !== ALL) observe(metric, { [labelName]: labelValue }, value);
};

const incrementWithAggregate = (
    metric: RegisteredMetric,
    labelName: string,
    labelValue: string,
): void => {
    increment(metric, { [labelName]: ALL });
    if (labelValue !== ALL) increment(metric, { [labelName]: labelValue });
};

export const metricClockSeconds = (): number => performance.now() / 1000;

export const metricElapsedSeconds = (startedAt: number): number =>
    Math.max(0, metricClockSeconds() - startedAt);

export const observeRpcBatchItems = (items: number): void => {
    observe(rpcBatchItems, {}, items);
};

export const recordRpcRejection = (reason: string): void => {
    incrementWithAggregate(rpcRejectedTotal, 'reason', reason);
};

export const recordWorkStarted = (kind: string): void => {
    increment(workActive, { kind: ALL });
    if (kind !== ALL) increment(workActive, { kind });
};

export const recordWorkFinished = (kind: string): void => {
    decrement(workActive, { kind: ALL });
    if (kind !== ALL) decrement(workActive, { kind });
};

export const observeWorkQueueWait = (kind: string, seconds: number): void => {
    observeWithAggregate(workQueueWaitSeconds, 'kind', kind, seconds);
};

export const observeSourceFetch = (source: string, seconds: number): void => {
    observeWithAggregate(sourceFetchSeconds, 'source', source, seconds);
};

export const recordChromiumStarted = (): void => {
    increment(chromiumActive, {});
};

export const recordChromiumFinished = (): void => {
    decrement(chromiumActive, {});
};

export const recordCacheHit = (cache: string, source: string): void => {
    increment(cacheHitsTotal, { cache: ALL, source: ALL });
    if (cache !== ALL || source !== ALL) {
        increment(cacheHitsTotal, { cache, source });
    }
};

export const observeShutdown = (
    outcome: ShutdownOutcome,
    seconds: number,
): void => {
    observeWithAggregate(shutdownSeconds, 'outcome', outcome, seconds);
};

const shutdownSummarySnapshot = (
    outcome: ShutdownOutcome,
): ShutdownSummarySnapshot => {
    const series = seriesFor(shutdownSeconds, { outcome });
    if (!series) {
        throw new Error(`shutdown metric series unavailable for ${outcome}`);
    }
    return Object.freeze({ sum: series.sum, count: series.count });
};

export const getShutdownMetricsSnapshot = (): ShutdownMetricsSnapshot =>
    Object.freeze({
        graceful: shutdownSummarySnapshot('graceful'),
        deadline: shutdownSummarySnapshot('deadline'),
        second_signal: shutdownSummarySnapshot('second_signal'),
    });

export const restoreShutdownMetrics = (
    snapshot: ShutdownMetricsSnapshot,
): void => {
    resetMetric(shutdownSeconds);
    let aggregateSum = 0;
    let aggregateCount = 0;
    for (const outcome of SHUTDOWN_OUTCOMES) {
        const saved = snapshot[outcome];
        const series = seriesFor(shutdownSeconds, { outcome });
        if (!series) {
            throw new Error(
                `shutdown metric series unavailable for ${outcome}`,
            );
        }
        series.sum = saved.sum;
        series.count = saved.count;
        aggregateSum += saved.sum;
        aggregateCount += saved.count;
    }
    const aggregate = seriesFor(shutdownSeconds, { outcome: ALL });
    if (!aggregate) {
        throw new Error('shutdown aggregate metric series unavailable');
    }
    aggregate.sum = aggregateSum;
    aggregate.count = aggregateCount;
};

export const renderMetrics = (): string => {
    const lines: string[] = [];
    for (const metric of registry) {
        lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
        lines.push(`# TYPE ${metric.name} ${metric.type}`);
        for (const sample of samplesFor(metric)) {
            lines.push(
                `${sample.name}${formatLabels(sample.labels)} ${formatNumber(sample.value)}`,
            );
        }
    }
    return `${lines.join('\n')}\n`;
};

export const getMetricsSnapshot = (): readonly MetricFamilySnapshot[] =>
    Object.freeze(
        registry.map((metric) =>
            Object.freeze({
                name: metric.name,
                help: metric.help,
                type: metric.type,
                samples: Object.freeze(
                    samplesFor(metric).map((sample) =>
                        Object.freeze({
                            ...sample,
                            labels: Object.freeze({ ...sample.labels }),
                        }),
                    ),
                ),
            }),
        ),
    );

export const resetMetricsForTests = (): void => {
    for (const metric of registry) resetMetric(metric);
};
