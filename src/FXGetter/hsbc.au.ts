import axios from 'axios';

import { currency, FXRate } from 'src/types.d';

interface hsbcAuRateItem {
    curr_s: string;
    buy: number;
    sell: number;
}

const getHSBCAUFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        `https://mkdlc.ebanking.hsbc.com.hk/hsbcfxwidget/data/getFXList?callback=JSON.stringify&token=0vg8cORxRLBsrWg9C9UboMT%2BkN2Ykze6vFnRV1nA8DE%3D`,
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    // response is `JSON.stringify({data:{...}})`: unwrap without eval
    const data = JSON.parse(
        req.data
            .replace(/^\s*JSON\.stringify\(/, '')
            .replace(/\)\s*$/, '')
            .replace(/^\{(\w+):/, '{"$1":'),
    ).data;

    const date = new Date();

    const answer: FXRate[] = data.fxList.map((k: hsbcAuRateItem) => {
        return {
            currency: {
                from: 'AUD' as currency.AUD,
                to: k.curr_s as unknown as currency.unknown,
            },
            rate: {
                sell: {
                    cash: k.buy,
                    remit: k.buy,
                },
                buy: {
                    cash: k.sell,
                    remit: k.sell,
                },
            },
            unit: 1,
            updated: date,
        } as FXRate;
    });

    const cnyRate = answer.find((k) => k.currency.to === 'CNY');
    if (cnyRate) {
        answer.push({
            ...cnyRate,
            currency: { ...cnyRate.currency, to: 'CNH' as currency.CNH },
        });
    }

    return answer;
};

export default getHSBCAUFXRates;
