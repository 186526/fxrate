import axios from 'axios';

import { currency, FXRate } from 'src/types.d';

interface hsbcCnRateItem {
    exchangeRateCurrency: string;
    notesSellingRate: string;
    transferSellingRate: string;
    notesBuyingRate: string;
    transferBuyingRate: string;
}

const getHSBCCNFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        'https://www.services.cn-banking.hsbc.com.cn/mobile/channel/digital-proxy/cnyTransfer/ratesInfo/remittanceRate?locale=en_CN',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
                'Content-Type': 'application/json',
            },
        },
    );

    const data = req.data.data.counterForRepeatingBlock;
    // API 返回 data.lastUpdateDate（如 "2026-08-03"，数据发布日期，无时分秒）——
    // updated 应反映数据发布时间而非拉取时刻，解析为当天 00:00 +08:00。
    const rawDate = req.data.data.lastUpdateDate as string | undefined;
    const updated = rawDate
        ? new Date(`${rawDate}T00:00:00+08:00`)
        : new Date();
    const updatedValid = Number.isNaN(updated.getTime()) ? new Date() : updated;

    return data.map((k: hsbcCnRateItem) => {
        return {
            currency: {
                from: 'CNY' as currency.CNY,
                to: k.exchangeRateCurrency as unknown as currency.unknown,
            },
            rate: {
                buy: {
                    cash: parseFloat(k.notesSellingRate),
                    remit: parseFloat(k.transferSellingRate),
                },
                sell: {
                    cash: parseFloat(k.notesBuyingRate),
                    remit: parseFloat(k.transferBuyingRate),
                },
            },
            unit: 1,
            updated: updatedValid,
        };
    });
};

export default getHSBCCNFXRates;
