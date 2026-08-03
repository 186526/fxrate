import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import https from 'https';

import { FXRate, currency } from 'src/types.d';

const currencyMap: Record<string, currency> = {
    USD: 'USD' as currency.USD,
    KRW: 'KRW' as currency.KRW,
    HKD: 'HKD' as currency.HKD,
    JPY: 'JPY' as currency.JPY,
    EUR: 'EUR' as currency.EUR,
    GBP: 'GBP' as currency.GBP,
    CAD: 'CAD' as currency.CAD,
    AUD: 'AUD' as currency.AUD,
    SGD: 'SGD' as currency.SGD,
    CHF: 'CHF' as currency.CHF,
};

const parseUpdatedTime = (value: string): Date => {
    const match = value.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
    if (!match) return new Date();

    const updated = new Date(`${match[0].replace(' ', 'T')}+08:00`);
    return Number.isNaN(updated.getTime()) ? new Date() : updated;
};

const getHSBankFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://hxsh.hsbank.com.cn:20200/qy/page/forerate/forerate.jsp',
        {
            responseType: 'arraybuffer',
            httpsAgent: new https.Agent({
                rejectUnauthorized: false,
                secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
            }),
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const html = new TextDecoder('gbk').decode(res.data);
    const $ = cheerio.load(html);
    const table = $('#exrateEngTable');
    if (table.length === 0) {
        throw new Error(
            'HSBank response format changed: rate table is missing',
        );
    }

    const updated = parseUpdatedTime(table.find('tr').first().text());

    return table
        .find('tr')
        .toArray()
        .map((row) => {
            const cells = $(row)
                .find('td')
                .map((_i, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
                .get();
            if (cells.length !== 5) return null;

            const currencyCode = cells[0].match(/\(([A-Z]{3})\)/)?.[1];
            const from = currencyCode ? currencyMap[currencyCode] : undefined;
            if (!from) return null;

            const middle = parseFloat(cells[1]);
            const remitBuy = parseFloat(cells[2]);
            const cashBuy = parseFloat(cells[3]);
            const sell = parseFloat(cells[4]);
            if (
                [middle, remitBuy, cashBuy, sell].some(
                    (price) => !Number.isFinite(price),
                )
            ) {
                return null;
            }

            return {
                currency: {
                    from,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: remitBuy,
                        cash: cashBuy,
                    },
                    sell: {
                        remit: sell,
                        cash: sell,
                    },
                    middle,
                },
                unit: 100,
                updated,
            } as FXRate;
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getHSBankFXRates;
