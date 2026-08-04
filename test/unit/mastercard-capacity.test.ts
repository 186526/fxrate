// mastercard-capacity（Phase 1 Card 集成，offline）：
// 真实 mastercardFXM 类 + mock globalThis.fetch，验证：首次成功写入正缓存 LRU（max 500 /
// ttl 30m）、二次访问零 fetch、7 日回退（401 逐日回退至第 7 天）、403/网络错误即时失败
// 不放大、负缓存 blocked 后重复请求零上游、500 同 key 并发单飞、请求方向（transaction_currency=
// to & cardholder_billing_currency=from）、Proxy 倒数输出。零公网访问，可 --detectOpenHandles。

import { jest } from '@jest/globals';
import { currency } from 'src/types.d';

import mastercardFXM, {
    mastercardCoordinator,
} from '../../src/FXGetter/mastercard';

const realFetch = globalThis.fetch;

const dateAtOffset = (offset: number): string => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    return date.toISOString().slice(0, 10);
};

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

const SUCCESS_PAYLOAD = {
    data: { transAmt: '1', conversionRate: '7.5', fxDate: '2026-08-04' },
};

let fetchMock: ReturnType<typeof jest.fn>;

beforeEach(() => {
    fetchMock = jest.fn(async (url: string) => {
        const match = /exchange_date=(\d{4}-\d{2}-\d{2})/.exec(String(url));
        if (match?.[1] === dateAtOffset(0)) {
            return jsonResponse(SUCCESS_PAYLOAD);
        }
        return jsonResponse({ data: { errorCode: 'NOT_FOUND' } }, 401);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mastercardCoordinator.positive.clear();
    mastercardCoordinator.negative.clear();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
});

describe('mastercardFXM capacity integration', () => {
    test('first success writes the positive LRU (max 500 / ttl 30m) and proxy output matches', async () => {
        const fxm = new mastercardFXM();
        const rate = await fxm.getfxRateList(currency.USD, currency.CNY);
        // conversionRate 7.5 表示「1 CNY = 7.5 USD」，Proxy 取倒数 → 1 USD = 1/7.5 CNY。
        expect(Number(rate?.middle)).toBeCloseTo(1 / 7.5, 10);
        expect(mastercardCoordinator.positive.has('USDCNY')).toBe(true);
        expect(mastercardCoordinator.positive.max).toBe(500);
        expect(mastercardCoordinator.positive.ttl).toBe(1000 * 60 * 30);

        const calls = fetchMock.mock.calls.length;
        await fxm.getfxRateList(currency.USD, currency.CNY);
        expect(fetchMock.mock.calls.length).toBe(calls);
    });

    test('7-day fallback walks exactly 7 dates and succeeds on the last', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            const match = /exchange_date=(\d{4}-\d{2}-\d{2})/.exec(String(url));
            if (match?.[1] === dateAtOffset(6)) {
                return jsonResponse(SUCCESS_PAYLOAD);
            }
            return jsonResponse({ data: { errorCode: 'NOT_FOUND' } }, 401);
        });
        const fxm = new mastercardFXM();
        await fxm.getfxRateList(currency.USD, currency.CNY);
        expect(fetchMock).toHaveBeenCalledTimes(7);
        expect(mastercardCoordinator.positive.has('USDCNY')).toBe(true);
    });

    test('all 7 dates unpublished fails once, records negative, and blocks repeats', async () => {
        fetchMock.mockImplementation(async () =>
            jsonResponse({ data: { errorCode: 'NOT_FOUND' } }, 401),
        );
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/no published rate in last 7 days/);
        expect(fetchMock).toHaveBeenCalledTimes(7);
        expect(
            mastercardCoordinator.negative.blocked('mastercard:USD:CNY'),
        ).toBeDefined();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/no published rate in last 7 days/);
        expect(fetchMock).toHaveBeenCalledTimes(7);
    });

    test('403 fails immediately without date fallback and blocks repeats', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({}, 403));
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/MasterCard API 403/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const record =
            mastercardCoordinator.negative.blocked('mastercard:USD:CNY');
        expect(record).toBeDefined();
        expect((record?.lastError as Error).message).toContain('API 403');
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/MasterCard API 403/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('network error records negative with the network message', async () => {
        fetchMock.mockImplementation(async () => {
            throw new TypeError('fetch failed');
        });
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/network error for USD\/CNY/);
        const record =
            mastercardCoordinator.negative.blocked('mastercard:USD:CNY');
        expect(record?.lastError).toBeInstanceOf(Error);
        expect((record?.lastError as Error).message).toContain('fetch failed');
    });

    test('500 same-key concurrent callers trigger exactly one upstream fetch', async () => {
        const fxm = new mastercardFXM();
        const promises: Promise<unknown>[] = [];
        for (let i = 0; i < 500; i++) {
            promises.push(fxm.getfxRateList(currency.USD, currency.CNY));
        }
        await Promise.all(promises);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mastercardCoordinator.inFlight).toBe(0);
    });

    test('request direction preserves transaction_currency=to & cardholder_billing_currency=from', async () => {
        const fxm = new mastercardFXM();
        await fxm.getfxRateList(currency.USD, currency.CNY);
        const url = String(fetchMock.mock.calls[0][0]);
        expect(url).toContain('transaction_currency=CNY');
        expect(url).toContain('cardholder_billing_currency=USD');
    });

    test('unsupported currency rejects before any upstream work', async () => {
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.AUX, currency.USD),
        ).rejects.toThrow('Currency not supported');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
