import axios from 'axios';

import { currency, FXRate } from 'src/types';

const getHSBCHKFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        `https://rbwm-api.hsbc.com.hk/digital-pws-tools-investments-eapi-prod-proxy/v1/investments/exchange-rate?locale=en_HK`,
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const data = req.data.detailRates;

    const answers: FXRate[] = data
        .map((k) => {
            const answer: FXRate = {
                currency: {
                    from: k.ccy as currency.unknown,
                    to: 'HKD' as currency.HKD,
                },
                rate: {
                    buy: {},
                    sell: {},
                },
                updated: new Date(k.lastUpdateDate),
                unit: 1,
            };

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

                console.log(answer, CNHAnswer);

                return [answer, CNHAnswer];
            } else return answer;
        })
        .flat()
        .sort();

    return answers;
};

export default getHSBCHKFXRates;
