import axios from 'axios';

import { FXRate, currency } from 'src/types';

export function parseYYYYMMDDHHmmss(dateStr) {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    const hour = dateStr.substring(8, 10);
    const minute = dateStr.substring(10, 12);
    const second = dateStr.substring(12, 14);

    return new Date(
        `${year}/${month}/${day} ${hour}:${minute}:${second} UTC+8`,
    );
}

const getNCBCNFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.post(
        'https://ibs.ncbchina.cn/NCB/mForeignExchangePriceQuery',
        { ccyPair: '', bsnsTp: '1' },
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const data: {
        bsnsTp: 'SETFORE_EX';
        ccyPair: string;
        cstCashBuyPrc: number;
        cstCashMdlPrc: number;
        cstCashSellPrc: number;
        cstExgBuyPrc: number;
        cstExgMdlPrc: number;
        cstExgSellPrc: number;
        mktQtnDt: string;
        mktQtnSt: string;
        mktQtnTm: string;
        qtnUnit: null;
    }[] = res.data.mktQtnInfoArrList;

    const FXRates: FXRate[] = [];

    data.forEach((fx) => {
        if (fx.bsnsTp !== 'SETFORE_EX') return;

        const currencyName = fx.ccyPair.split('/').filter((k) => k != 'CNY')[0];

        FXRates.push({
            currency: {
                from: currencyName as unknown as currency.unknown,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                sell: {
                    remit: fx.cstExgBuyPrc,
                    cash: fx.cstCashBuyPrc,
                },
                buy: {
                    remit: fx.cstExgSellPrc,
                    cash: fx.cstCashSellPrc,
                },
                middle: fx.cstExgMdlPrc,
            },
            unit: currencyName === 'JPY' ? 100 : 1,
            updated: parseYYYYMMDDHHmmss(
                `${fx.mktQtnDt}${fx.mktQtnTm.padStart(6, '0')}`,
            ),
        });
    });

    return FXRates;
};

export default getNCBCNFXRates;
