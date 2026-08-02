import axios from 'axios';

import { FXRate, currency } from 'src/types.d';

export function parseYYYYMMDDHHmmss(dateStr: string) {
    // Fall back to now instead of producing an Invalid Date when the
    // source format changes and the string is not 14 digits.
    if (!/^\d{14}$/.test(dateStr)) return new Date();

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
            timeout: 10000,
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

        // NCB 的 ccyPair 方向不一致：部分为「外币/CNY」，部分为「CNY/外币」（THB/DKK/SEK/NOK）。
        // 数值一律是「1 外币 = X CNY」口径（实测：USD/CNY=6.75 即 1USD=6.75CNY），仅 JPY 按 100 单位报价。
        // 直接用 ccyPair 原序，勿假设外币在前。
        const [from, to] = fx.ccyPair.split('/');
        const isJpy = from === 'JPY' || to === 'JPY';

        FXRates.push({
            currency: {
                from: from as unknown as currency.unknown,
                to: to as unknown as currency.unknown,
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
            unit: isJpy ? 100 : 1,
            updated: parseYYYYMMDDHHmmss(
                `${fx.mktQtnDt}${fx.mktQtnTm.padStart(6, '0')}`,
            ),
        });
    });

    return FXRates;
};

export default getNCBCNFXRates;
