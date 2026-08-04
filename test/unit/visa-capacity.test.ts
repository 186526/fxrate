// visa-capacity（Phase 1 Card 集成，offline）：
// 真实 visaFXM 类 + mock globalThis.fetch + 注入假 chromium launcher（fetchTextViaChromium
// 测试 seam），验证：原生 fetch 成功不启动 chromium、403 降级 chromium 单次启动、原生+chromium
// 双失败合并报错并进入负缓存、500 同 key 并发单飞、CNH/CNY 别名共享、chromium executor 并发上限 1、
// 请求方向（fromCurr=to & toCurr=from）。零公网访问，可 --detectOpenHandles。

import { jest } from '@jest/globals';
import { currency } from 'src/types.d';

import visaFXM, { visaCoordinator } from '../../src/FXGetter/visa';
import { __setChromiumLauncherForTests } from '../../src/FXGetter/chromiumFetcher';

const realFetch = globalThis.fetch;

const visaPayload = {
    originalValues: { fxRateVisa: '7.2', lastUpdatedVisaRate: 1722729600 },
};
const visaBody = JSON.stringify(visaPayload);

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    return new Promise((resolveWait) => {
        const start = Date.now();
        const poll = (): void => {
            if (predicate()) {
                resolveWait();
                return;
            }
            if (Date.now() - start > timeoutMs) {
                resolveWait();
                return;
            }
            setImmediate(poll);
        };
        poll();
    });
}

function fakeLauncher(
    opts: {
        statusFor?: (url: string) => number;
        body?: string;
    } = {},
) {
    const launch = jest.fn(async () => ({
        newContext: jest.fn(async () => ({
            newPage: jest.fn(async () => ({
                goto: jest.fn(async (url: string) => ({
                    status: () => (opts.statusFor ? opts.statusFor(url) : 200),
                })),
                evaluate: jest.fn(async () => opts.body ?? visaBody),
            })),
        })),
        close: jest.fn(async () => undefined),
    }));
    return { launch };
}

let fetchMock: ReturnType<typeof jest.fn>;

beforeEach(() => {
    fetchMock = jest.fn(async () => jsonResponse(visaPayload, 200));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    __setChromiumLauncherForTests(null);
    visaCoordinator.positive.clear();
    visaCoordinator.negative.clear();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    __setChromiumLauncherForTests(null);
    jest.restoreAllMocks();
});

describe('visaFXM capacity integration', () => {
    test('native success caches without launching chromium; proxy output matches', async () => {
        const { launch } = fakeLauncher({});
        __setChromiumLauncherForTests({ launch });
        const fxm = new visaFXM();
        const rate = await fxm.getfxRateList(currency.USD, currency.CNY);
        // fxRateVisa 7.2 即「1 USD = 7.2 CNY」。
        expect(Number(rate?.middle)).toBeCloseTo(7.2, 10);
        expect(visaCoordinator.positive.has('USDCNY')).toBe(true);
        expect(launch).not.toHaveBeenCalled();
    });

    test('native 403 degrades to a single chromium launch', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({}, 403));
        const { launch } = fakeLauncher({});
        __setChromiumLauncherForTests({ launch });
        const fxm = new visaFXM();
        await fxm.getfxRateList(currency.USD, currency.CNY);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(visaCoordinator.positive.has('USDCNY')).toBe(true);
        expect(visaCoordinator.negative.size).toBe(0);
    });

    test('native 403 + chromium 403 yields combined error recorded in negative cache', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({}, 403));
        const { launch } = fakeLauncher({ statusFor: () => 403 });
        __setChromiumLauncherForTests({ launch });
        const fxm = new visaFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/chromium fallback failed/);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(visaCoordinator.positive.has('USDCNY')).toBe(false);
        const record = visaCoordinator.negative.blocked('visa:USD:CNY');
        expect(record).toBeDefined();
        expect((record?.lastError as Error).message).toContain('Visa API 403');

        // blocked 后重复请求零上游、零 chromium。
        const fetchCalls = fetchMock.mock.calls.length;
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/Visa API 403/);
        expect(fetchMock.mock.calls.length).toBe(fetchCalls);
        expect(launch).toHaveBeenCalledTimes(1);
    });

    test('500 same-key concurrent callers trigger one native fetch and no chromium', async () => {
        const { launch } = fakeLauncher({});
        __setChromiumLauncherForTests({ launch });
        const fxm = new visaFXM();
        const promises: Promise<unknown>[] = [];
        for (let i = 0; i < 500; i++) {
            promises.push(fxm.getfxRateList(currency.USD, currency.CNY));
        }
        await Promise.all(promises);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(launch).not.toHaveBeenCalled();
        expect(visaCoordinator.inFlight).toBe(0);
    });

    test('CNH/CNY aliases share one single-flight workflow', async () => {
        const fxm = new visaFXM();
        const [a, b] = await Promise.all([
            fxm.getfxRateList(currency.CNH, currency.USD),
            fxm.getfxRateList(currency.CNY, currency.USD),
        ]);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(visaCoordinator.positive.has('CNYUSD')).toBe(true);
    });

    test('chromium executor caps at 1 concurrent launch under fallback flood', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({}, 403));
        const gate = deferred<void>();
        let active = 0;
        let activePeak = 0;
        const launch = jest.fn(async () => ({
            newContext: jest.fn(async () => ({
                newPage: jest.fn(async () => ({
                    goto: jest.fn(async () => {
                        active++;
                        activePeak = Math.max(activePeak, active);
                        await gate.promise;
                        active--;
                        return { status: () => 200 };
                    }),
                    evaluate: jest.fn(async () => visaBody),
                })),
            })),
            close: jest.fn(async () => undefined),
        }));
        __setChromiumLauncherForTests({ launch });

        const fxm = new visaFXM();
        const pairs: Array<[currency, currency]> = [
            [currency.USD, currency.CNY],
            [currency.EUR, currency.CNY],
            [currency.JPY, currency.CNY],
        ];
        const pending = pairs.map(([from, to]) => fxm.getfxRateList(from, to));
        // chromium 单槽位：第一个工作流进入 gated goto，其余排队。
        await waitFor(() => visaCoordinator.chromiumExecutor?.active === 1);
        expect(visaCoordinator.chromiumExecutor?.queued).toBe(2);
        gate.resolve();
        await Promise.all(pending);
        expect(activePeak).toBe(1);
        expect(visaCoordinator.chromiumExecutor?.active).toBe(0);
        expect(visaCoordinator.chromiumExecutor?.queued).toBe(0);
    });

    test('request direction preserves fromCurr=to & toCurr=from', async () => {
        const fxm = new visaFXM();
        await fxm.getfxRateList(currency.USD, currency.CNY);
        const url = String(fetchMock.mock.calls[0][0]);
        expect(url).toContain('fromCurr=CNY');
        expect(url).toContain('toCurr=USD');
    });
});
