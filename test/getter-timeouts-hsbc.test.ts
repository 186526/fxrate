// 离线专项测试：hsbc.cn / hsbc.au 全部 axios 调用点都携带 `timeout: 10000`。
// jest.spyOn 拦截 axios.get，用最小离线 fixture 喂给 getter，不发起真实网络请求。
import axios from 'axios';
import { jest } from '@jest/globals';

import getHSBCCNFXRates from '../src/FXGetter/hsbc.cn';
import getHSBCAUFXRates from '../src/FXGetter/hsbc.au';

const getSpy = jest.spyOn(axios, 'get');

const mockByUrl = (url: string): unknown => {
    if (url.includes('remittanceRate')) {
        // hsbc.cn：counterForRepeatingBlock + lastUpdateDate。
        return {
            status: 200,
            headers: {},
            data: {
                data: {
                    counterForRepeatingBlock: [
                        {
                            exchangeRateCurrency: 'USD',
                            notesSellingRate: '7',
                            transferSellingRate: '7',
                            notesBuyingRate: '7',
                            transferBuyingRate: '7',
                        },
                    ],
                    lastUpdateDate: '2026-08-03',
                },
            },
        };
    }
    if (url.includes('getFXList')) {
        // hsbc.au：JSONP 形如 `JSON.stringify({data:{...}})`，内部键已加引号（真 JSON）。
        return {
            status: 200,
            headers: {},
            data: 'JSON.stringify({"data":{"fxList":[{"curr_s":"CNY","buy":1.2,"sell":1.4}]}})',
        };
    }
    throw new Error(`hsbc timeout test hit unexpected URL: ${url}`);
};

const assertAllCallsHaveTimeout = (expectedCalls: number) => {
    const calls = getSpy.mock.calls;
    expect(calls.length).toBe(expectedCalls);
    for (const [, config] of calls) {
        expect(config).toMatchObject({ timeout: 10000 });
    }
};

describe('hsbc getters carry axios timeout', () => {
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

    test('hsbc.cn carries timeout', async () => {
        await getHSBCCNFXRates();
        assertAllCallsHaveTimeout(1);
    });

    test('hsbc.au carries timeout', async () => {
        await getHSBCAUFXRates();
        assertAllCallsHaveTimeout(1);
    });
});
