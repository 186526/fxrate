import fxManager from '../fxm/fxManager';
import syncRequest from 'sync-request';
import axios from 'axios';
import { fraction } from 'mathjs';

import { LRUCache } from 'lru-cache';
import { currency } from 'src/types';

const cache = new LRUCache<string, string>({
    max: 500,
});

const currenciesList: string[] = [
    'AFN',
    'ALL',
    'DZD',
    'AOA',
    'ARS',
    'AMD',
    'AWG',
    'AUD',
    'AZN',
    'BSD',
    'BHD',
    'BDT',
    'BBD',
    'BYN',
    'BZD',
    'BMD',
    'BTN',
    'BOB',
    'BAM',
    'BWP',
    'BRL',
    'BND',
    'BGN',
    'BIF',
    'KHR',
    'CAD',
    'CVE',
    'KYD',
    'XOF',
    'XAF',
    'XPF',
    'CLP',
    'CNY',
    'COP',
    'KMF',
    'CDF',
    'CRC',
    'CUP',
    'CZK',
    'DKK',
    'DJF',
    'DOP',
    'XCD',
    'EGP',
    'SVC',
    'ETB',
    'EUR',
    'FKP',
    'FJD',
    'GMD',
    'GEL',
    'GHS',
    'GIP',
    'GBP',
    'GTQ',
    'GNF',
    'GYD',
    'HTG',
    'HNL',
    'HKD',
    'HUF',
    'ISK',
    'INR',
    'IDR',
    'IQD',
    'ILS',
    'JMD',
    'JPY',
    'JOD',
    'KZT',
    'KES',
    'KWD',
    'KGS',
    'LAK',
    'LBP',
    'LSL',
    'LRD',
    'LYD',
    'MOP',
    'MKD',
    'MGA',
    'MWK',
    'MYR',
    'MVR',
    'MRU',
    'MUR',
    'MXN',
    'MDL',
    'MNT',
    'MAD',
    'MZN',
    'MMK',
    'NAD',
    'NPR',
    'ANG',
    'NZD',
    'NIO',
    'NGN',
    'NOK',
    'OMR',
    'PKR',
    'PAB',
    'PGK',
    'PYG',
    'PEN',
    'PHP',
    'PLN',
    'QAR',
    'RON',
    'RUB',
    'RWF',
    'SHP',
    'WST',
    'STN',
    'SAR',
    'RSD',
    'SCR',
    'SLE',
    'SGD',
    'SBD',
    'SOS',
    'ZAR',
    'KRW',
    'SSP',
    'LKR',
    'SDG',
    'SRD',
    'SZL',
    'SEK',
    'CHF',
    'TWD',
    'TJS',
    'TZS',
    'THB',
    'TOP',
    'TTD',
    'TND',
    'TRY',
    'TMT',
    'UGX',
    'UAH',
    'AED',
    'USD',
    'UYU',
    'UZS',
    'VUV',
    'VES',
    'VND',
    'YER',
    'ZMW',
    'ZWL',
];

export default class mastercardFXM extends fxManager {
    ableToGetAllFXRate: boolean = false;

    public get fxRateList() {
        const fxRateList: fxManager['_fxRateList'] = {} as any;

        currenciesList.forEach((from) => {
            fxRateList[from] = {} as any;
            currenciesList.forEach((to) => {
                const currency = new Proxy(
                    {},
                    {
                        get: (_obj, prop) => {
                            if (
                                ![
                                    'cash',
                                    'remit',
                                    'middle',
                                    'updated',
                                ].includes(prop.toString())
                            ) {
                                return undefined;
                            }

                            if (!cache.has(`${from}${to}`)) {
                                const request = syncRequest(
                                    'GET',
                                    `https://www.mastercard.us/settlement/currencyrate/conversion-rate?fxDate=0000-00-00&transCurr=${from}&crdhldBillCurr=${to}&bankFee=0&transAmt=1`,
                                );
                                cache.set(
                                    `${from}${to}`,
                                    request.getBody().toString(),
                                );
                            }

                            if (
                                ['cash', 'remit', 'middle'].includes(
                                    prop.toString(),
                                )
                            ) {
                                const data = JSON.parse(
                                    cache.get(`${from}${to}`),
                                );
                                return fraction(data.data.conversionRate);
                            } else {
                                const data = JSON.parse(
                                    cache.get(`${from}${to}`),
                                );
                                return new Date(data.data.fxDate);
                            }
                        },
                    },
                );
                fxRateList[from][to] = currency;
            });
        });

        return fxRateList;
    }

    public async getfxRateList(from: currency, to: currency) {
        if (
            !(
                currenciesList.includes(from as string) &&
                currenciesList.includes(to as string)
            )
        ) {
            throw new Error('Currency not supported');
        }

        if (cache.has(`${from}${to}`)) {
            return this.fxRateList[from][to];
        }

        const req = await axios.get(
            `https://www.mastercard.us/settlement/currencyrate/conversion-rate?fxDate=0000-00-00&transCurr=${from}&crdhldBillCurr=${to}&bankFee=0&transAmt=1`,
            {
                headers: {
                    'User-Agent': 'fxrate axios/latest',
                },
            },
        );

        const data = req.data;
        cache.set(`${from}${to}`, JSON.stringify(data));

        return this.fxRateList[from][to];
    }

    constructor() {
        super([]);
    }
    public update(): void {
        throw new Error('Method is deprecated');
    }
}
