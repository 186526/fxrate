// 离线专项测试：wise 的 axios 调用点携带 `timeout: 10000`。
// jest.spyOn 拦截 axios.get，用最小离线 fixture 喂给 getter，不发起真实网络请求。
import axios from 'axios';
import { jest } from '@jest/globals';

import getWiseFXRates from '../src/FXGetter/wise';

const getSpy = jest.spyOn(axios, 'get');

const mockByUrl = (url: string): unknown => {
    if (url.includes('api.wise.com') || url.includes('transferwise.tech')) {
        // wise：单条汇率，CNY → CNH 映射。
        return {
            status: 200,
            headers: {},
            data: [
                {
                    rate: '7.2',
                    source: 'USD',
                    target: 'CNY',
                    time: '2026-08-03T00:00:00Z',
                },
            ],
        };
    }
    throw new Error(`wise timeout test hit unexpected URL: ${url}`);
};

const assertAllCallsHaveTimeout = (expectedCalls: number) => {
    const calls = getSpy.mock.calls;
    expect(calls.length).toBe(expectedCalls);
    for (const [, config] of calls) {
        expect(config).toMatchObject({ timeout: 10000 });
    }
};

describe('wise getter carries axios timeout', () => {
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

    test('wise carries timeout', async () => {
        await getWiseFXRates(false, true, '')();
        assertAllCallsHaveTimeout(1);
    });
});
