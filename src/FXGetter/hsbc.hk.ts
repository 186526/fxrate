import axios from 'axios';

import { currency, FXRate } from 'src/types.d';

interface hsbcHkRateItem {
    ccy: string;
    lastUpdateDate: string;
    ttBuyRt?: string;
    bankBuyRt?: string;
    ttSelRt?: string;
    bankSellRt?: string;
}

const getHSBCHKFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        `https://rbwm-api.hsbc.com.hk/digital-pws-tools-investments-eapi-prod-proxy/v1/investments/exchange-rate?locale=en_HK`,
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const data = req.data.detailRates;

    const answers: FXRate[] = data
        .map((k: hsbcHkRateItem) => {
            const answer: FXRate = {
                currency: {
                    from: k.ccy as unknown as currency.unknown,
                    to: 'HKD' as currency.HKD,
                },
                rate: {
                    buy: {},
                    sell: {},
                },
                updated: new Date(k.lastUpdateDate),
                unit: 1,
            };

            answer.rate.buy ??= {};
            answer.rate.sell ??= {};

            if (k.ttBuyRt) answer.rate.buy.remit = parseFloat(k.ttBuyRt);
            if (k.bankBuyRt) answer.rate.buy.cash = parseFloat(k.bankBuyRt);
            if (k.ttSelRt) answer.rate.sell.remit = parseFloat(k.ttSelRt);
            if (k.bankSellRt) answer.rate.sell.cash = parseFloat(k.bankSellRt);

            if (answer.currency.from == 'CNY') {
                const CNHAnswer: FXRate = {
                    ...answer,
                    currency: {
                        ...answer.currency,
                        from: 'CNH' as currency.CNH,
                    },
                    rate: {
                        buy: { ...answer.rate.buy },
                        sell: { ...answer.rate.sell },
                    },
                };

                return [answer, CNHAnswer];
            } else return answer;
        })
        .flat()
        .sort();

    return answers;
};

export default getHSBCHKFXRates;
