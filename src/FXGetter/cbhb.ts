import axios from 'axios';
import * as cheerio from 'cheerio';
import { FXRate, currency } from 'src/types.d';

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const getCBHBFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.cbhb.com.cn/cbhbank/apply/whpj/whpj.shtml',
        {
            headers: {
                'User-Agent': process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
            },
            timeout: 10000,
        },
    );
    const $ = cheerio.load(res.data);
    const updated = new Date();

    return $('tr')
        .toArray()
        .map((row): FXRate | null => {
            const cells = $(row)
                .find('td')
                .toArray()
                .map((cell) => $(cell).text().trim());
            if (cells.length < 4) return null;

            const from = cells[0].match(/\(([A-Z]{3})\)/)?.[1];
            if (!from) return null;

            const remitBuy = Number(cells[1]);
            const cashBuy = Number(cells[2]);
            const sell = Number(cells[3]);
            const values = [remitBuy, cashBuy, sell];
            if (
                values.some((value) => !Number.isFinite(value) || value <= 0) ||
                remitBuy >= sell ||
                cashBuy >= sell
            ) {
                return null;
            }

            return {
                currency: {
                    from: from as currency,
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
                },
                unit: 100,
                updated,
            };
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getCBHBFXRates;
