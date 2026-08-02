import axios from 'axios';
import { FXRate, currency } from 'src/types.d';
import * as cheerio from 'cheerio';

const getJCBJPYBasedFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get('https://www.jcb.jp/rate/jpy.html', {
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    const $ = cheerio.load(res.data);

    const date = new Date(
        $($('.rate2TableArea>p')[0])
            .text()
            .replaceAll('換算日の基準レート', '')
            .replaceAll('日', '')
            .replaceAll('月', '-')
            .replaceAll('年', '-') + ' UTC+9',
    );

    return $('.rate2TableArea>table>tbody>tr')
        .toArray()
        .map((el) => {
            const e = $(el);
            const currency = e.find('td:nth-child(1)').text();
            const midPrice = e.find('td:nth-child(4)').text();

            return {
                currency: {
                    from: currency as currency,
                    to: 'JPY' as currency.JPY,
                },
                rate: {
                    middle: parseFloat(midPrice),
                },
                unit: 1,
                updated: date,
            } as FXRate;
        })
        .sort();
};

// JCB 美元基准牌价（https://www.jcb.jp/rate/usd.html）：
// 页面是日期归档列表（usdMMDDYYYY.html），首链接即最新日期页。
// 表格结构：表头 [Buy, Mid, Sell]，数据行 [USD, =, Buy, Mid, Sell, Ccy]。
// Buy/Sell 是 JCB（银行）视角：rate.buy = 银行买 USD 价（客户卖 USD 得外币），
// rate.sell = 银行卖 USD 价（客户买 USD 付外币）——与前端契约一致（rate.buy < rate.sell）。
const getJCBUSDBasedFXRates = async (): Promise<FXRate[]> => {
    const listRes = await axios.get('https://www.jcb.jp/rate/usd.html', {
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    const $list = cheerio.load(listRes.data);
    const latestHref = $list('#list-rate ul li a').first().attr('href');
    if (!latestHref) throw new Error('JCB USD rate page: no date link found');

    const res = await axios.get(`https://www.jcb.jp${latestHref}`, {
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    const $ = cheerio.load(res.data);
    // 日期页 URL 形如 /rate/usd07312026.html → 2026-07-31（UTC+9，JCB 日本时间）。
    const digits = latestHref.match(/\d+/)?.[0] ?? '';
    const date = new Date(
        `${digits.slice(4, 8)}-${digits.slice(0, 2)}-${digits.slice(2, 4)}T00:00:00+09:00`,
    );

    return $('table tr')
        .toArray()
        .map((el) => {
            const cells = $(el)
                .find('td')
                .map((_, c) => $(c).text().trim())
                .get();
            // 数据行格式：[USD, =, Buy, Mid, Sell, Ccy]（共 6 列）；表头/空行跳过。
            if (cells.length < 6 || cells[0] !== 'USD' || cells[1] !== '=') {
                return null;
            }
            const to = cells[5];
            const buy = parseFloat(cells[2]);
            const middle = parseFloat(cells[3]);
            const sell = parseFloat(cells[4]);

            return {
                currency: {
                    from: 'USD' as currency.USD,
                    to: to as unknown as currency.unknown,
                },
                rate: {
                    buy: { cash: buy, remit: buy },
                    sell: { cash: sell, remit: sell },
                    middle,
                },
                unit: 1,
                updated: date,
            } as FXRate;
        })
        .filter((r): r is FXRate => r !== null)
        .sort();
};

const getJCBFXRates = async (): Promise<FXRate[]> => {
    const k = await Promise.all([
        getJCBJPYBasedFXRates(),
        getJCBUSDBasedFXRates(),
    ]);
    return k.flat(1);
};

export default getJCBFXRates;
export { getJCBJPYBasedFXRates, getJCBUSDBasedFXRates };
