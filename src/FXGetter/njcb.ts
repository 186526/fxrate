import axios from 'axios';
import * as cheerio from 'cheerio';
import { FXRate, currency } from 'src/types.d';

const currencyMap: Record<string, currency> = {
    澳大利亚元: 'AUD' as currency.AUD,
    加拿大元: 'CAD' as currency.CAD,
    瑞士法郎: 'CHF' as currency.CHF,
    欧元: 'EUR' as currency.EUR,
    英镑: 'GBP' as currency.GBP,
    港元: 'HKD' as currency.HKD,
    日元: 'JPY' as currency.JPY,
    新加坡元: 'SGD' as currency.SGD,
    美元: 'USD' as currency.USD,
};

const getNJCBFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://ebank.njcb.com.cn/perbank/PB00000016exchangeRateQry.do',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const $ = cheerio.load(res.data);
    const dateMatch = $('body')
        .text()
        .match(/发布日期：\s*(\d{4})年(\d{2})月(\d{2})日/);
    const updated = dateMatch
        ? new Date(
              `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00+08:00`,
          )
        : new Date();

    const rates: FXRate[] = $('#trans_table tr')
        .map((_i, row) => {
            const cells = $(row)
                .find('td')
                .map((_j, cell) => $(cell).text().trim())
                .get();
            if (cells.length < 7) return null;

            const from = currencyMap[cells[0]];
            if (!from) return null;

            const unit = parseInt(cells[1], 10);
            const cashBuy = parseFloat(cells[2]);
            const cashSell = parseFloat(cells[3]);
            const remitBuy = parseFloat(cells[4]);
            const remitSell = parseFloat(cells[5]);
            const middle = parseFloat(cells[6]);
            const values = [
                unit,
                cashBuy,
                cashSell,
                remitBuy,
                remitSell,
                middle,
            ];
            if (!values.every(Number.isFinite) || unit <= 0) return null;

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
                unit,
                updated,
            } as FXRate;
        })
        .get();

    return rates.sort();
};

export default getNJCBFXRates;
