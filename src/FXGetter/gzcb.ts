import axios from 'axios';
import * as cheerio from 'cheerio';

import { FXRate, currency } from 'src/types.d';

const currencyMap: Record<string, currency> = {
    HKD: 'HKD' as currency.HKD,
    USD: 'USD' as currency.USD,
    JPY: 'JPY' as currency.JPY,
    CAD: 'CAD' as currency.CAD,
    AUD: 'AUD' as currency.AUD,
    EUR: 'EUR' as currency.EUR,
};

const parseUpdatedTime = (value: string): Date => {
    const match = value.match(
        /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{2}:\d{2}:\d{2})/,
    );
    if (!match) return new Date();

    const [, year, month, day, time] = match;
    const updated = new Date(
        `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${time}+08:00`,
    );
    return Number.isNaN(updated.getTime()) ? new Date() : updated;
};

const getGZCBFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get('http://www.gzcb.com.cn/sy/ywbl/flbz/whhlb/', {
        timeout: 10000,
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    const $ = cheerio.load(res.data);
    const table = $('table')
        .filter((_i, element) => {
            const text = $(element).text();
            return text.includes('CASH BID') && text.includes('FX MID');
        })
        .first();
    if (table.length === 0) {
        throw new Error('GZCB response format changed: rate table is missing');
    }

    const updated = parseUpdatedTime(table.parent().prev('div').text());

    return table
        .find('tbody tr')
        .toArray()
        .map((row) => {
            const cells = $(row)
                .find('td')
                .map((_i, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
                .get();
            if (cells.length < 6) return null;

            const currencyCode = cells[0].match(/\b([A-Z]{3})\b/)?.[1];
            const from = currencyCode ? currencyMap[currencyCode] : undefined;
            if (!from) return null;

            const cashBuy = parseFloat(cells[1]);
            const cashSell = parseFloat(cells[2]);
            const remitBuy = parseFloat(cells[3]);
            const remitSell = parseFloat(cells[4]);
            const middle = parseFloat(cells[5]);
            if (
                [cashBuy, cashSell, remitBuy, remitSell, middle].some(
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
                        cash: cashBuy,
                        remit: remitBuy,
                    },
                    sell: {
                        cash: cashSell,
                        remit: remitSell,
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

export default getGZCBFXRates;
