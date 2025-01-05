import fxManager from '../fxm/fxManager';
import syncRequest from 'sync-request';
import axios from 'axios';

import { fraction } from 'mathjs';

import { LRUCache } from 'lru-cache';
import { currency } from 'src/types';

import dayjs from 'dayjs';

import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const cache = new LRUCache<string, string>({
    max: 500,
});

const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en,zh-CN;q=0.9,zh;q=0.8',
    'sec-ch-ua':
        '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    Referer:
        'https://usa.visa.com/support/consumer/travel-support/exchange-rate-calculator.html',
    'Referrer-Policy': 'no-referrer-when-downgrade',
};

const currenciesList: string[] = [
    'AED',
    'AFN',
    'ALL',
    'AMD',
    'ANG',
    'AOA',
    'ARS',
    'AUD',
    'AWG',
    'AZN',
    'BAM',
    'BBD',
    'BDT',
    'BGN',
    'BHD',
    'BIF',
    'BMD',
    'BND',
    'BOB',
    'BRL',
    'BSD',
    'BTN',
    'BWP',
    'BYN',
    'BZD',
    'CAD',
    'CDF',
    'CHF',
    'CLP',
    'CNY',
    'COP',
    'CRC',
    'CVE',
    'CYP',
    'CZK',
    'DJF',
    'DKK',
    'DOP',
    'DZD',
    'EEK',
    'EGP',
    'ERN',
    'ETB',
    'EUR',
    'FJD',
    'FKP',
    'GBP',
    'GEL',
    'GHS',
    'GIP',
    'GMD',
    'GNF',
    'GQE',
    'GTQ',
    'GWP',
    'GYD',
    'HKD',
    'HNL',
    'HRK',
    'HTG',
    'HUF',
    'IDR',
    'ILS',
    'INR',
    'IQD',
    'IRR',
    'ISK',
    'JMD',
    'JOD',
    'JPY',
    'KES',
    'KGS',
    'KHR',
    'KMF',
    'KRW',
    'KWD',
    'KYD',
    'KZT',
    'LAK',
    'LBP',
    'LKR',
    'LRD',
    'LSL',
    'LTL',
    'LVL',
    'LYD',
    'MAD',
    'MDL',
    'MGA',
    'MKD',
    'MMK',
    'MNT',
    'MOP',
    'MRO',
    'MRU',
    'MTL',
    'MUR',
    'MVR',
    'MWK',
    'MXN',
    'MYR',
    'MZN',
    'NAD',
    'NGN',
    'NIO',
    'NOK',
    'NPR',
    'NZD',
    'None',
    'OMR',
    'PAB',
    'PEN',
    'PGK',
    'PHP',
    'PKR',
    'PLN',
    'PYG',
    'QAR',
    'RON',
    'RSD',
    'RUB',
    'RWF',
    'SAR',
    'SBD',
    'SCR',
    'SDG',
    'SEK',
    'SGD',
    'SHP',
    'SIT',
    'SKK',
    'SLL',
    'SOS',
    'SRD',
    'SSP',
    'STD',
    'STN',
    'SVC',
    'SYP',
    'SZL',
    'THB',
    'TJS',
    'TMT',
    'TND',
    'TOP',
    'TRY',
    'TTD',
    'TWD',
    'TZS',
    'UAH',
    'UGX',
    'USD',
    'UYU',
    'UZS',
    'VEF',
    'VES',
    'VND',
    'VUV',
    'WST',
    'XAF',
    'XCD',
    'XOF',
    'XPF',
    'YER',
    'ZAR',
    'ZMW',
    'ZWL',
];

export default class visaFXM extends fxManager {
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

                            const dateString = dayjs()
                                .utc()
                                .format('MM/DD/YYYY');

                            if (!cache.has(`${from}${to}`)) {
                                const request = syncRequest(
                                    'GET',
                                    `https://usa.visa.com/cmsapi/fx/rates?amount=1&fee=0&utcConvertedDate=${dateString}&exchangedate=${dateString}&fromCurr=${to}&toCurr=${from}`,
                                    {
                                        headers,
                                    },
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
                                return fraction(data.originalValues.fxRateVisa);
                            } else {
                                const data = JSON.parse(
                                    cache.get(`${from}${to}`),
                                );
                                return new Date(
                                    data.originalValues.lastUpdatedVisaRate *
                                        1000,
                                );
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

        const dateString = dayjs().utc().format('MM/DD/YYYY');

        const req = await axios.get(
            `https://usa.visa.com/cmsapi/fx/rates?amount=1&fee=0&utcConvertedDate=${dateString}&exchangedate=${dateString}&fromCurr=${to}&toCurr=${from}`,
            {
                headers,
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
