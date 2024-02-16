import axios from 'axios';
import { FXRate, currency } from 'src/types';

const getICBCFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'http://papi.icbc.com.cn/exchanges/ns/getLatest',
        {
            headers: {
                'User-Agent': 'fxrate axios/latest',
            },
        },
    );

    const data = res.data;

    const FXRates: FXRate[] = [];

    if (data.code != 0) throw new Error(`Get ICBC FX Rates failed.`);

    data.data.forEach((fx) => {
        FXRates.push({
            currency: {
                from: fx.currencyENName as currency.unknown,
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

    return FXRates;
};

export default getICBCFXRates;
