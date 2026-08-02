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
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
                'Content-Type': 'application/json',
            },
        },
    );

    const data = req.data.data.counterForRepeatingBlock;

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
            updated: new Date(),
        };
    });
};

export default getHSBCCNFXRates;
