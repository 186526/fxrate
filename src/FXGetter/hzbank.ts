import axios from 'axios';
import * as cheerio from 'cheerio';
import { FXRate, currency } from 'src/types.d';

const getHZBankFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.hzbank.com.cn/hzyh/gjyw/bjfw24/whpj/index.html',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const $ = cheerio.load(res.data);

    const rates: FXRate[] = $('table.whpj tr')
        .map((_i, row) => {
            const cells = $(row)
                .find('td')
                .map((_j, cell) => $(cell).text().trim())
                .get();
            if (cells.length < 5) return null;

            const currencyMatch = cells[0].match(/([A-Z]{3})$/);
            if (!currencyMatch) return null;

            const remitBuy = parseFloat(cells[1]);
            const cashBuy = parseFloat(cells[2]);
            const sell = parseFloat(cells[3]);
            if (![remitBuy, cashBuy, sell].every(Number.isFinite)) return null;

            const parsedUpdated = new Date(`${cells[4]} GMT+0800`);

            return {
                currency: {
                    from: currencyMatch[1] as currency,
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
                    // 页面未公开中间价，按现汇买卖价均值估算。
                    middle: (remitBuy + sell) / 2,
                },
                unit: 100,
                updated: Number.isNaN(parsedUpdated.getTime())
                    ? new Date()
                    : parsedUpdated,
            } as FXRate;
        })
        .get();

    return rates.sort();
};

export default getHZBankFXRates;
