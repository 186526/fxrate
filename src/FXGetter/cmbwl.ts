import axios from 'axios';
import * as cheerio from 'cheerio';

import { currency, FXRate } from 'src/types.d';

const REMIT_URL =
    'https://www.cmbwinglungbank.com/ibanking/CnCoFiiTtrateDsp.jsp';
const CASH_URL =
    'https://www.cmbwinglungbank.com/ibanking/CnCoFiiNotratDsp.jsp';

const currencyNames: Record<string, currency> = {
    澳元: 'AUD' as currency.AUD,
    '人民幣(離岸)': 'CNH' as currency.CNH,
    加元: 'CAD' as currency.CAD,
    丹麥克朗: 'DKK' as currency.DKK,
    歐元: 'EUR' as currency.EUR,
    日元: 'JPY' as currency.JPY,
    紐西蘭元: 'NZD' as currency.NZD,
    澳門葡幣: 'MOP' as currency.MOP,
    英鎊: 'GBP' as currency.GBP,
    新加坡元: 'SGD' as currency.SGD,
    瑞典克朗: 'SEK' as currency.SEK,
    瑞士法郎: 'CHF' as currency.CHF,
    泰銖: 'THB' as currency.THB,
    美元: 'USD' as currency.USD,
    人民幣: 'CNY' as currency.CNY,
    汶萊元: 'BND' as currency.BND,
    印度盧比: 'INR' as currency.INR,
    印尼盾: 'IDR' as currency.IDR,
    馬來西亞元: 'MYR' as currency.MYR,
    挪威克朗: 'NOK' as currency.NOK,
    菲律賓披索: 'PHP' as currency.PHP,
    南非蘭特: 'ZAR' as currency.ZAR,
    新台幣: 'TWD' as currency.TWD,
    韓國圜: 'KRW' as currency.KRW,
};

interface ParsedRate {
    buy: number;
    sell: number;
}

const parseRates = (
    html: string,
    sellColumn: number,
): Map<currency, ParsedRate> => {
    const $ = cheerio.load(html);
    const rates = new Map<currency, ParsedRate>();

    $('table tr').each((_index, row) => {
        const cells = $(row)
            .find('td')
            .map((_cellIndex, cell) =>
                $(cell).text().replace(/\s+/g, ' ').trim(),
            )
            .get();
        const from = currencyNames[cells[0]];
        if (!from || cells.length <= sellColumn) return;

        const buy = parseFloat(cells[1]);
        const sell = parseFloat(cells[sellColumn]);
        if (
            !Number.isFinite(buy) ||
            !Number.isFinite(sell) ||
            buy <= 0 ||
            sell <= 0 ||
            buy >= sell
        ) {
            return;
        }

        rates.set(from, { buy, sell });
    });

    return rates;
};

const parseUpdated = (html: string): Date => {
    const match = html.match(
        /更新時間\s*:\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})/,
    );
    if (!match) return new Date();

    const updated = new Date(
        `${match[1]}-${match[2]}-${match[3]}T${match[4]}+08:00`,
    );
    return Number.isNaN(updated.getTime()) ? new Date() : updated;
};

const getCMBWLFXRates = async (): Promise<FXRate[]> => {
    const headers = {
        'User-Agent':
            process.env['HEADER_USER_AGENT'] ??
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
    };
    const [remitResponse, cashResponse] = await Promise.all([
        axios.get<string>(REMIT_URL, { headers, timeout: 10000 }),
        axios.get<string>(CASH_URL, { headers, timeout: 10000 }),
    ]);

    const remitRates = parseRates(remitResponse.data, 2);
    // 现钞页另有电子渠道优惠价；通用牌价采用分行渠道列。
    const cashRates = parseRates(cashResponse.data, 2);
    const updated = new Date(
        Math.max(
            parseUpdated(remitResponse.data).getTime(),
            parseUpdated(cashResponse.data).getTime(),
        ),
    );
    const currencies = new Set([...remitRates.keys(), ...cashRates.keys()]);

    return [...currencies]
        .map((from): FXRate => {
            const remit = remitRates.get(from);
            const cash = cashRates.get(from);
            return {
                currency: {
                    from,
                    to: 'HKD' as currency.HKD,
                },
                rate: {
                    buy: {
                        ...(remit ? { remit: remit.buy } : {}),
                        ...(cash ? { cash: cash.buy } : {}),
                    },
                    sell: {
                        ...(remit ? { remit: remit.sell } : {}),
                        ...(cash ? { cash: cash.sell } : {}),
                    },
                },
                unit: 1,
                updated,
            };
        })
        .sort((a, b) =>
            String(a.currency.from).localeCompare(String(b.currency.from)),
        );
};

export default getCMBWLFXRates;
