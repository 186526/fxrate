import axios from 'axios';
import * as cheerio from 'cheerio';
import { FXRate, currency } from 'src/types.d';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const parseChinaDate = (value: string): Date => {
    const parsed = new Date(`${value.replace(' ', 'T')}+08:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const getCGBChinaFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.cgbchina.com.cn/searchExchangePrice.gsp',
        {
            headers: {
                'User-Agent': process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
            },
            timeout: 10000,
        },
    );
    const $ = cheerio.load(res.data);
    const timestamp = $('span._times')
        .text()
        .match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0];
    const updated = timestamp ? parseChinaDate(timestamp) : new Date();

    return $('tr')
        .toArray()
        .map((row): FXRate | null => {
            const cells = $(row)
                .find('td')
                .toArray()
                .map((cell) => $(cell).text().trim());
            if (cells.length < 8) return null;

            const pair = cells[1].match(/^([A-Z]{3})\/(CNY)$/);
            if (!pair) return null;

            const unit = Number(cells[2]);
            const middle = Number(cells[3]);
            const remitBuy = Number(cells[4]);
            const cashBuy = Number(cells[5]);
            const remitSell = Number(cells[6]);
            const cashSell = Number(cells[7]);
            const values = [
                unit,
                middle,
                remitBuy,
                cashBuy,
                remitSell,
                cashSell,
            ];
            if (
                values.some((value) => !Number.isFinite(value) || value <= 0) ||
                remitBuy >= remitSell ||
                cashBuy >= cashSell
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
                        remit: remitSell,
                        cash: cashSell,
                    },
                    middle,
                },
                unit,
                updated,
            };
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getCGBChinaFXRates;
