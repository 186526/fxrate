import axios from 'axios';

import { currency, FXRate } from 'src/types';

const getHSBCAUFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        `https://mkdlc.ebanking.hsbc.com.hk/hsbcfxwidget/data/getFXList?callback=JSON.stringify&token=0vg8cORxRLBsrWg9C9UboMT%2BkN2Ykze6vFnRV1nA8DE%3D`,
        {
            headers: {
                'User-Agent': 'fxrate axios/latest',
            },
        },
    );

    const data = JSON.parse([eval][0](req.data)).data;

    const date = new Date(req.headers['date']);

    const answer: FXRate[] = data.fxList.map((k) => {
        return {
            currency: {
                from: 'AUD' as currency.AUD,
                to: k.curr_s as currency.unknown,
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

    answer.push(
        ((answer) => {
            const tmp = answer.find((k) => k.currency.to === 'CNY');
            tmp.currency.to = 'CNH' as currency.CNH;
            return tmp;
        })(answer),
    );

    return answer;
};

export default getHSBCAUFXRates;
