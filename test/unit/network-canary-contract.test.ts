import { jest } from '@jest/globals';
import { currency, type FXRate } from 'src/types';
import {
    CANARY_HOOK_TIMEOUT_MS,
    CARD_FETCH_TIMEOUT_MS,
    DAY,
    DEFAULT_FETCH_TIMEOUT_MS,
    GETTER_CONCURRENCY,
    cardUpdatedDate,
    classifySource,
    fetchWithTimeout,
    theoreticalCanaryTimeoutMs,
} from '../canary/network-canary-contract';

const rateAt = (updated: Date): FXRate => ({
    currency: { from: currency.USD, to: currency.CNY },
    rate: { middle: 7 },
    unit: 1,
    updated,
});

describe('network canary Card timestamp contract', () => {
    const now = Date.UTC(2026, 7, 5, 0, 0, 0);
    const allowed = { allowedWafFailure: true };

    test.each([
        ['missing', cardUpdatedDate(undefined)],
        ['invalid', cardUpdatedDate('not-a-date')],
    ])('%s timestamp is a hard data failure', (_name, updated) => {
        const result = classifySource(
            'visa',
            [rateAt(updated)],
            allowed,
            null,
            now,
        );
        expect(result.status).toBe('invalid');
        expect(result.issues).toContain('visa updated=Invalid Date');
    });

    test('stale timestamp is not exempted by allowed WAF status', () => {
        const result = classifySource(
            'visa',
            [rateAt(new Date(now - 8 * DAY))],
            allowed,
            null,
            now,
        );
        expect(result.status).toBe('invalid');
        expect(result.issues.some((issue) => issue.includes('数据陈旧'))).toBe(
            true,
        );
    });

    test('future timestamp beyond skew is a hard data failure', () => {
        const result = classifySource(
            'visa',
            [rateAt(new Date(now + 6 * 60_000))],
            allowed,
            null,
            now,
        );
        expect(result.status).toBe('invalid');
        expect(result.issues.some((issue) => issue.includes('时钟偏移'))).toBe(
            true,
        );
    });

    test('current timestamp remains valid', () => {
        const result = classifySource(
            'visa',
            [rateAt(new Date(now))],
            allowed,
            null,
            now,
        );
        expect(result.status).toBe('ok');
    });

    test('configured source timeout budget stays below the hook deadline', () => {
        const worstCaseMs = theoreticalCanaryTimeoutMs(
            57,
            GETTER_CONCURRENCY,
            DEFAULT_FETCH_TIMEOUT_MS,
            CARD_FETCH_TIMEOUT_MS,
        );
        expect(worstCaseMs).toBeLessThan(CANARY_HOOK_TIMEOUT_MS - 30_000);
    });

    test('timeout does not release the worker slot before the getter settles', async () => {
        jest.useFakeTimers();
        let resolveGetter!: (value: string) => void;
        const getter = new Promise<string>((resolve) => {
            resolveGetter = resolve;
        });
        const wrapped = fetchWithTimeout(getter, 100, 'slow-source');
        let settled = false;
        void wrapped.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await jest.advanceTimersByTimeAsync(100);
        expect(settled).toBe(false);

        resolveGetter('late');
        await expect(wrapped).rejects.toThrow('slow-source timeout 100ms');
        expect(settled).toBe(true);
        jest.useRealTimers();
    });
});
