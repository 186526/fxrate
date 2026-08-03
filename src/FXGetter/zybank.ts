import { constants } from 'node:crypto';
import https from 'node:https';

import axios from 'axios';
import * as cheerio from 'cheerio';
import { FXRate, currency } from 'src/types.d';

const currencyMap: Record<string, currency> = {
    澳大利亚元: currency.AUD,
    加元: currency.CAD,
    瑞士法郎: currency.CHF,
    欧元: currency.EUR,
    英镑: currency.GBP,
    港元: currency.HKD,
    日元: currency.JPY,
    澳门元: currency.MOP,
    挪威克朗: currency.NOK,
    新西兰元: currency.NZD,
    马来西亚林吉特: currency.MYR,
    新加坡元: currency.SGD,
    美元: currency.USD,
};

const parseDate = (value: string): Date => {
    const date = new Date(`${value.replace(' ', 'T')}+08:00`);
    return Number.isFinite(date.getTime()) ? date : new Date();
};

const getZYBankFXRates = async (): Promise<FXRate[]> => {
    // The public query server requires both an untrusted certificate and legacy TLS renegotiation.
    const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
        secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
    });
    const res = await axios.post<string>(
        'https://pibs.zyebank.com/pweb/CurrentRateQry.do',
        null,
        {
            httpsAgent,
            timeout: 30000,
            responseType: 'text',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Referer: 'https://pibs.zyebank.com/pweb/HistoryRateQryPre.do',
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            },
        },
    );

    const $ = cheerio.load(res.data);
    const rates: FXRate[] = [];
    $('table.rateList tr').each((_index, element) => {
        const cells = $(element)
            .find('td')
            .map((_cellIndex, cell) => $(cell).text().trim())
            .get();
        if (cells.length < 6) return;

        const from = currencyMap[cells[0]];
        const remitBuy = parseFloat(cells[1]);
        const cashBuy = parseFloat(cells[2]);
        const remitSell = parseFloat(cells[3]);
        const cashSell = parseFloat(cells[4]);

        if (
            !from ||
            ![remitBuy, remitSell].every(
                (value) => Number.isFinite(value) && value > 0,
            ) ||
            remitBuy >= remitSell
        ) {
            return;
        }

        // The source currently publishes a malformed JPY cash-buy quote above its sell quote.
        // Omit only that invalid cash field so downstream cash lookup falls back to the valid remit quote.
        const validCashBuy =
            Number.isFinite(cashBuy) &&
            Number.isFinite(cashSell) &&
            cashBuy > 0 &&
            cashSell > 0 &&
            cashBuy < cashSell;

        rates.push({
            currency: {
                from,
                to: currency.CNY,
            },
            rate: {
                buy: {
                    cash: validCashBuy ? cashBuy : undefined,
                    remit: remitBuy,
                },
                sell: {
                    cash:
                        Number.isFinite(cashSell) && cashSell > 0
                            ? cashSell
                            : undefined,
                    remit: remitSell,
                },
                middle: (remitBuy + remitSell) / 2,
            },
            unit: 100,
            updated: parseDate(cells[5]),
        });
    });

    if (rates.length === 0) {
        throw new Error('Zhongyuan Bank returned no rates');
    }
    return rates.sort();
};

export default getZYBankFXRates;
