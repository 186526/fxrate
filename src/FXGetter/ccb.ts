import { XMLParser } from 'fast-xml-parser';
import { FXRate, currency } from 'src/types.d';
import axios from 'axios';

import crypto from 'crypto';
import https from 'https';

interface ccbSettlementItem {
    Ofrd_Ccy_CcyCd: string;
    BidRateOfCash: number;
    BidRateOfCcy: number;
    OfrRateOfCash: number;
    OfrRateOfCcy: number;
    Mdl_ExRt_Prc: number;
    LstPr_Dt: number;
    LstPr_Tm: number;
}

/**
 * Handle this problem with Node 18
 * write EPROTO B8150000:error:0A000152:SSL routines:final_renegotiate:unsafe legacy renegotiation disabled
 * **/
const allowLegacyRenegotiationforNodeJsOptions = {
    httpsAgent: new https.Agent({
        // allow sb CCB to use legacy renegotiation
        // 💩 CCB
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    }),
};

const parser = new XMLParser();

const currencyMap: { [key: string]: { name: currency } } = {
    '840': { name: 'USD' as currency.USD },
    '978': { name: 'EUR' as currency.EUR },
    '826': { name: 'GBP' as currency.GBP },
    '392': { name: 'JPY' as currency.JPY },
    '344': { name: 'HKD' as currency.HKD },
    '36': { name: 'AUD' as currency.AUD },
    '124': { name: 'CAD' as currency.CAD },
    '756': { name: 'CHF' as currency.CHF },
    '702': { name: 'SGD' as currency.SGD },
    '208': { name: 'DKK' as currency.DKK },
    '578': { name: 'NOK' as currency.NOK },
    '752': { name: 'SEK' as currency.SEK },
    '410': { name: 'KRW' as currency.KRW },
    '554': { name: 'NZD' as currency.NZD },
    '446': { name: 'MOP' as currency.MOP },
    '710': { name: 'ZAR' as currency.ZAR },
    '764': { name: 'THB' as currency.THB },
    '458': { name: 'MYR' as currency.MYR },
    '643': { name: 'RUB' as currency.RUB },
    '398': { name: 'KZT' as currency.KZT },
    '784': { name: 'AED' as currency.AED },
    '682': { name: 'SAR' as currency.SAR },
    '348': { name: 'HUF' as currency.HUF },
    '484': { name: 'MXN' as currency.MXN },
    '985': { name: 'PLN' as currency.PLN },
    '949': { name: 'TRY' as currency.TRY },
    '203': { name: 'CZK' as currency.CZK },
    '376': { name: 'ILS' as currency.ILS },
    '496': { name: 'MNT' as currency.MNT },
};

const getCCBFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        'https://www.ccb.com/cn/home/news/jshckpj_new.xml',
        {
            ...allowLegacyRenegotiationforNodeJsOptions,
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );
    const settlements = parser.parse(req.data)['ReferencePriceSettlements'][
        'ReferencePriceSettlement'
    ];

    const result = settlements.map((data: ccbSettlementItem) => {
        if (!(data['Ofrd_Ccy_CcyCd'] in currencyMap)) {
            console.log(
                `[${new Date().toUTCString()}] [CCB] Unsupported currency code ${data['Ofrd_Ccy_CcyCd']}, skipped.`,
            );
            return null;
        }

        return {
            currency: {
                from: currencyMap[data['Ofrd_Ccy_CcyCd']].name,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                buy: {
                    cash: data['BidRateOfCash'],
                    remit: data['BidRateOfCcy'],
                },
                sell: {
                    cash: data['OfrRateOfCash'],
                    remit: data['OfrRateOfCcy'],
                },
                middle: data['Mdl_ExRt_Prc'],
            },
            // CCB's ReferencePriceSettlement quotes every currency per 1 unit
            // (verified: JPY Mdl_ExRt_Prc=0.042804, KRW=0.004685), so unit stays 1.
            unit: 1,
            updated: new Date(
                ((date: number, time: number) => {
                    const dateStringArray = date.toString().split('');
                    const timeStringArray = time
                        .toString()
                        .padStart(6, '0')
                        .split('');
                    dateStringArray.splice(4, 0, '-');
                    dateStringArray.splice(7, 0, '-');
                    timeStringArray.splice(2, 0, ':');
                    timeStringArray.splice(5, 0, ':');
                    return `${dateStringArray.join('')} ${timeStringArray.join('')} UTC+8`;
                })(data['LstPr_Dt'], data['LstPr_Tm']),
            ),
        } as FXRate;
    });
    return result.sort();
};

export default getCCBFXRates;
