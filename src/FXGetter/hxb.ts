import axios from 'axios';
import * as cheerio from 'cheerio';
import { FXRate, currency } from 'src/types.d';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const parseChinaDate = (value: string): Date => {
    const parsed = new Date(`${value.replace(' ', 'T')}+08:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const getHXBFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://sbank.hxb.com.cn/gateway/forexquote.jsp',
        {
            headers: {
                'User-Agent': process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
            },
            timeout: 10000,
        },
    );
    const $ = cheerio.load(res.data);

    return $('tr')
        .toArray()
        .map((row): FXRate | null => {
            const cells = $(row)
                .find('td')
                .toArray()
                .map((cell) => $(cell).text().trim());
            if (cells.length < 7) return null;

            const pair = cells[0].match(/^([A-Z]{3})CNY$/);
            if (!pair) return null;

            const remitBuy = Number(cells[2]);
            const cashBuy = Number(cells[3]);
            const sell = Number(cells[4]);
            const middle = Number(cells[5]);
            const values = [remitBuy, cashBuy, sell, middle];
            if (
                values.some((value) => !Number.isFinite(value) || value <= 0) ||
                remitBuy >= sell ||
                cashBuy >= sell
            ) {
                return null;
            }

            return {
                currency: {
                    from: pair[1] as currency,
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
                updated: parseChinaDate(cells[6]),
            };
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getHXBFXRates;
