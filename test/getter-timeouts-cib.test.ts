// 离线专项测试：cib / cibHuanyu 全部 axios 调用点都携带 `timeout: 10000`。
// jest.spyOn 拦截 axios.get，用最小离线 fixture 喂给 getter，不发起真实网络请求。
import axios from 'axios';
import { jest } from '@jest/globals';

import getCIBFXRates, { getCIBHuanyuFXRates } from '../src/FXGetter/cib';

const getSpy = jest.spyOn(axios, 'get');

const html = (body: string) => ({
    status: 200,
    headers: { 'set-cookie': ['sid=1'] },
    data: body,
});

const mockByUrl = (url: string): unknown => {
    if (url.includes('ifxQuotationQuery.do')) {
        // cib：首屏页（取 cookie + 更新日期），cheerio 需 .labe_text 元素。
        return html('<div class="labe_text">日期： 2026年8月3日 10:00</div>');
    }
    if (url.includes('ifxQuotationQuery/list')) {
        // cib：报价列表。cell = [?, from, unit, buyRemit, sellRemit, buyCash, sellCash]。
        return {
            status: 200,
            headers: {},
            data: {
                rows: [
                    { cell: ['', 'USD', '100', '7.1', '7.2', '7.0', '7.3'] },
                ],
            },
        };
    }
    throw new Error(`cib timeout test hit unexpected URL: ${url}`);
};

const assertAllCallsHaveTimeout = (expectedCalls: number) => {
    const calls = getSpy.mock.calls;
    expect(calls.length).toBe(expectedCalls);
    for (const [, config] of calls) {
        expect(config).toMatchObject({ timeout: 10000 });
    }
};

describe('cib getters carry axios timeout', () => {
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

    test('cib: both requests carry timeout', async () => {
        await getCIBFXRates();
        assertAllCallsHaveTimeout(2);
    });

    test('cibHuanyu: delegates to cib, both requests carry timeout', async () => {
        await getCIBHuanyuFXRates();
        assertAllCallsHaveTimeout(2);
    });
});
