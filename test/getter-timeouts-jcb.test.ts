// 离线专项测试：jcb 全部 axios 调用点都携带 `timeout: 10000`。
// jest.spyOn 拦截 axios.get，用最小离线 fixture 喂给 getter，不发起真实网络请求。
import axios from 'axios';
import { jest } from '@jest/globals';

import getJCBFXRates from '../src/FXGetter/jcb';

const getSpy = jest.spyOn(axios, 'get');

const html = (body: string) => ({
    status: 200,
    headers: { 'set-cookie': ['sid=1'] },
    data: body,
});

const mockByUrl = (url: string): unknown => {
    if (url.endsWith('/rate/usd.html')) {
        // jcb USD：日期归档列表页，首链接即最新日期页。
        return html(
            '<div id="list-rate"><ul><li><a href="/rate/usd07312026.html">x</a></li></ul></div>',
        );
    }
    if (url.endsWith('/rate/jpy.html')) {
        // jcb JPY：`.rate2TableArea>p` 日期 + 表格行 [ccy, , , mid]。
        return html(
            '<div class="rate2TableArea"><p>2026年8月3日</p><table><tbody><tr><td>USD</td><td>1</td><td>2</td><td>150</td></tr></tbody></table></div>',
        );
    }
    if (url.includes('/rate/usd')) {
        // jcb USD 日期页：数据行 [USD, =, Buy, Mid, Sell, Ccy]。
        return html(
            '<table><tr><td>USD</td><td>=</td><td>7.0</td><td>7.1</td><td>7.2</td><td>CNY</td></tr></table>',
        );
    }
    throw new Error(`jcb timeout test hit unexpected URL: ${url}`);
};

const assertAllCallsHaveTimeout = (expectedCalls: number) => {
    const calls = getSpy.mock.calls;
    expect(calls.length).toBe(expectedCalls);
    for (const [, config] of calls) {
        expect(config).toMatchObject({ timeout: 10000 });
    }
};

describe('jcb getter carries axios timeout', () => {
    beforeAll(() => {
        getSpy.mockImplementation((url: string) =>
            Promise.resolve(mockByUrl(url) as never),
        );
    });
    beforeEach(() => {
        getSpy.mockClear();
    });
    afterAll(() => {
        getSpy.mockRestore();
    });

    test('jcb: all three requests (jpy + usd list + usd page) carry timeout', async () => {
        await getJCBFXRates();
        assertAllCallsHaveTimeout(3);
    });
});
