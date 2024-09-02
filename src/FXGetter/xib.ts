import axios from 'axios';
import { currency, FXRate } from 'src/types';

import { parseYYYYMMDDHHmmss } from './ncb.cn';

import crypto from 'crypto';
import https from 'https';

const allowLegacyRenegotiationforNodeJsOptions = {
    httpsAgent: new https.Agent({
        // allow sb ABC to use legacy renegotiation
        // 💩 ABC
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    }),
};

const getXIBFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.post(
        'https://ifsp.xib.com.cn/ifsptsi/api/ITSI125005',
        {
            ccyPairCode: '',
            transactionType: '0',
            header: {
                appId: 'XEIP',
                locale: 'zh_CN',
                termType: '',
                termNo: '',
                termMac: '',
                appVersion: '',
            },
        },
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
            ...allowLegacyRenegotiationforNodeJsOptions,
        },
    );

    const data: {
        baseRate: number;
        cashBuyPrice: number;
        cashSellPrice: number;
        companyType: 'XIB';
        currency: string;
        currencyBuyPrice: number;
        currencySellPrice: number;
        squareBuyRate: number;
        squareSellRate: number;
        term: null;
        updateDate: string;
        updateTime: string;
    }[] = req.data.rateList;

    const FXRates: FXRate[] = [];

    data.forEach((fx) => {
        FXRates.push({
            currency: {
                from: fx.currency as unknown as currency.unknown,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                buy: {
                    remit: fx.currencyBuyPrice,
                    cash: fx.cashBuyPrice,
                },
                sell: {
                    remit: fx.currencySellPrice,
                    cash: fx.cashSellPrice,
                },
            },
            unit: 100,
            updated: parseYYYYMMDDHHmmss(`${fx.updateDate}${fx.updateTime}`),
        });
    });

    return FXRates;
};

export default getXIBFXRates;
