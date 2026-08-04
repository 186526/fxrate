import type { FXRate } from '../../src/types';

export const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_FRESHNESS_MS = 7 * DAY;
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const CARD_FETCH_TIMEOUT_MS = 45_000;
export const GETTER_CONCURRENCY = 12;
export const CANARY_HOOK_TIMEOUT_MS = 290_000;

export const theoreticalCanaryTimeoutMs = (
    getterSources: number,
    getterConcurrency: number,
    getterTimeoutMs: number,
    cardTimeoutMs: number,
): number =>
    Math.max(
        Math.ceil(getterSources / getterConcurrency) * getterTimeoutMs,
        cardTimeoutMs,
    );

// Deadline 只决定最终分类，不假装能取消不支持 AbortSignal 的第三方 getter。
// 超时后继续等待底层 promise settle 才释放 worker 槽，避免连续 timeout 突破
// GETTER_CONCURRENCY；workflow 的 job timeout 提供进程级最终收敛。
export const fetchWithTimeout = <T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                if (timedOut) {
                    reject(new Error(`${label} timeout ${timeoutMs}ms`));
                } else {
                    resolve(value);
                }
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });

export interface SourceSpec {
    minRates?: number;
    freshnessMs?: number;
    fetchTimeoutMs?: number;
    allowedWafFailure?: boolean;
}

export interface SourceResult {
    source: string;
    status: 'ok' | 'waf-failure' | 'failed' | 'empty' | 'invalid' | 'stale';
    rateCount: number;
    issues: string[];
    latestUpdated: Date | null;
    allowedWafFailure: boolean;
}

export const toNum = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'object') {
        const n = Number(
            (value as { valueOf(): number | string | bigint }).valueOf(),
        );
        return Number.isFinite(n) ? n : undefined;
    }
    return Number(value);
};

export const cardUpdatedDate = (value: unknown): Date => {
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
        return new Date(value);
    }
    return new Date(Number.NaN);
};

const invalidQuoteIssues = (rate: FXRate, source: string): string[] => {
    const issues: string[] = [];
    const r = rate.rate;
    const cells: Array<[string, unknown]> = [
        ['buy.cash', r.buy?.cash],
        ['buy.remit', r.buy?.remit],
        ['sell.cash', r.sell?.cash],
        ['sell.remit', r.sell?.remit],
        ['middle', r.middle],
    ];
    let hasPositiveQuote = false;
    for (const [label, value] of cells) {
        const n = toNum(value);
        if (n === undefined) continue;
        if (Number.isNaN(n)) issues.push(`${source} ${label}=NaN`);
        else if (!Number.isFinite(n))
            issues.push(`${source} ${label}=Infinity`);
        else if (n <= 0) issues.push(`${source} ${label}=${n} (非正)`);
        else hasPositiveQuote = true;
    }
    if (!hasPositiveQuote) {
        issues.push(
            `${source} 无任何有限正数报价（middle/buy/sell 全部缺省或非法）`,
        );
    }
    const d = new Date(rate.updated);
    if (Number.isNaN(d.getTime())) {
        issues.push(`${source} updated=Invalid Date`);
    }
    return issues;
};

export const classifySource = (
    source: string,
    rates: FXRate[],
    spec: SourceSpec,
    fetchError: string | null,
    now: number,
): SourceResult => {
    const allowed = spec.allowedWafFailure === true;
    if (fetchError !== null) {
        return {
            source,
            status: allowed ? 'waf-failure' : 'failed',
            rateCount: 0,
            issues: [`${source} 抓取失败: ${fetchError}`],
            latestUpdated: null,
            allowedWafFailure: allowed,
        };
    }
    const issues: string[] = [];
    const minRates = spec.minRates ?? 1;
    if (rates.length === 0) {
        return {
            source,
            status: 'empty',
            rateCount: 0,
            issues: [`${source} 成功但返回空数组`],
            latestUpdated: null,
            allowedWafFailure: allowed,
        };
    }
    let latest: Date | null = null;
    let validCount = 0;
    for (const rate of rates) {
        const rateIssues = invalidQuoteIssues(rate, source);
        issues.push(...rateIssues);
        if (rateIssues.length > 0) continue;
        validCount += 1;
        const updated = new Date(rate.updated);
        if (
            !Number.isNaN(updated.getTime()) &&
            (latest === null || updated.getTime() > latest.getTime())
        ) {
            latest = updated;
        }
    }
    if (validCount < minRates) {
        issues.push(
            `${source} 有效汇率 ${validCount} 条 < 最小要求 ${minRates}`,
        );
    }
    const freshnessMs = spec.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    if (latest === null) {
        issues.push(`${source} 无任何合法 updated`);
    } else if (latest.getTime() < now - freshnessMs) {
        issues.push(
            `${source} 数据陈旧: 最新 updated ${latest.toISOString()} 早于窗口 ${Math.round(freshnessMs / DAY)} 天`,
        );
    } else if (latest.getTime() > now + FUTURE_SKEW_MS) {
        issues.push(
            `${source} 数据伪造/时钟偏移: updated ${latest.toISOString()} 晚于 now + ${Math.round(FUTURE_SKEW_MS / 60_000)} 分钟`,
        );
    }
    if (issues.length > 0) {
        return {
            source,
            status: 'invalid',
            rateCount: validCount,
            issues,
            latestUpdated: latest,
            allowedWafFailure: allowed,
        };
    }
    return {
        source,
        status: 'ok',
        rateCount: validCount,
        issues: [],
        latestUpdated: latest,
        allowedWafFailure: allowed,
    };
};
