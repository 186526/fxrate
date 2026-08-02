import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

interface icbcRateItem {
    currencyENName: string;
    foreignBuy: number;
    cashBuy: number;
    foreignSell: number;
    cashSell: number;
    reference: number;
    publishDate: string;
    publishTime: string;
}

const getICBCFXRates = async (): Promise<FXRate[]> => {
    // HTTPS endpoint fails with `unsafe legacy renegotiation disabled` TLS error;
    // upstream only serves HTTP.
    const res = await axios.get(
        'http://papi.icbc.com.cn/exchanges/ns/getLatest',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const data = res.data;

    const FXRates: FXRate[] = [];

    if (data.code != 0) throw new Error(`Get ICBC FX Rates failed.`);

    data.data.forEach((fx: icbcRateItem) => {
        FXRates.push({
            currency: {
                from: fx.currencyENName as unknown as currency.unknown,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                buy: {
                    remit: fx.foreignBuy,
                    cash: fx.cashBuy,
                },
                sell: {
                    remit: fx.foreignSell,
                    cash: fx.cashSell,
                },
                middle: fx.reference,
            },
            unit: 100,
            updated: new Date(`${fx.publishDate} ${fx.publishTime} UTC+8`),
        });
    });

    return FXRates.sort();
};

export default getICBCFXRates;
