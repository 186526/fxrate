import { FXRate, currency } from 'src/types.d';
import axios from 'axios';
import * as cheerio from 'cheerio';

export const enName: Record<string, currency> = {
    '美元(USD)': 'USD' as currency.USD,
    美元: 'USD' as currency.USD,
    '英镑(GBP)': 'GBP' as currency.GBP,
    英镑: 'GBP' as currency.GBP,
    '港币(HKD)': 'HKD' as currency.HKD,
    港币: 'HKD' as currency.HKD,
    '瑞士法郎(CHF)': 'CHF' as currency.CHF,
    瑞士法郎: 'CHF' as currency.CHF,
    瑞典克朗: 'SEK' as currency.SEK,
    丹麦克朗: 'DKK' as currency.DKK,
    挪威克朗: 'NOK' as currency.NOK,
    '日元(JPY)': 'JPY' as currency.JPY,
    日元: 'JPY' as currency.JPY,
    '加拿大元(CAD)': 'CAD' as currency.CAD,
    加拿大元: 'CAD' as currency.CAD,
    '澳大利亚元(AUD)': 'AUD' as currency.AUD,
    澳大利亚元: 'AUD' as currency.AUD,
    '新加坡元(SGD)': 'SGD' as currency.SGD,
    新加坡元: 'SGD' as currency.SGD,
    '欧元(EUR)': 'EUR' as currency.EUR,
    欧元: 'EUR' as currency.EUR,
    '澳门元(MOP)': 'MOP' as currency.MOP,
    澳门元: 'MOP' as currency.MOP,
    '泰国铢(THB)': 'THB' as currency.THB,
    泰国铢: 'THB' as currency.THB,
    新台币: 'TWD' as currency.TWD,
    '新西兰元(NZD)': 'NZD' as currency.NZD,
    新西兰元: 'NZD' as currency.NZD,
    韩元: 'KRW' as currency.KRW,
    韩国元: 'KRW' as currency.KRW,
};

const lookupCurrency = (name: string): currency | undefined => {
    const exact = enName[name];
    if (exact) {
        return exact;
    }

    // map keys mix '美元(USD)' with bare names like '瑞典克朗', so compare both sides bare
    const nameBare = name.replace(/\([^)]*\)/g, '').trim();
    const key = Object.keys(enName).find(
        (k) => k.replace(/\([^)]*\)/g, '').trim() === nameBare,
    );

    return key ? enName[key] : undefined;
};

const getCEBFXRates = async (): Promise<FXRate[]> => {
    // 光大银行官网（cebbank.com）被旧版 TLS（legacy renegotiation）+ 瑞数 WAF（412）双层封锁，
    // 服务器端与 headful 浏览器均无法抓取。改用第三方镜像 cnyrate.com（实时同步光大牌价，
    // 列序「现汇买入|现钞买入|现汇卖出|现钞卖出」与官网一致，实测 2026-08 数值吻合）。
    const res = await axios.get('https://www.cnyrate.com/ceb.html', {
        timeout: 10000,
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    const $ = cheerio.load(res.data);

    const items: FXRate[] = $('tr')
        .map((_i, e) => {
            const c = cheerio.load(e);
            const cells = c('td')
                .map((_j, td) => c(td).text().trim())
                .get();
            if (cells.length < 5) {
                return null;
            }
            const from = lookupCurrency(cells[0]);
            if (!from) {
                return null;
            }
            return {
                currency: {
                    from,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: parseFloat(cells[1]),
                        cash: parseFloat(cells[2]),
                    },
                    sell: {
                        remit: parseFloat(cells[3]),
                        cash: parseFloat(cells[4]),
                    },
                },
                unit: 100,
                updated: new Date(),
            };
        })
        .get();

    return items.filter((i) => i !== null).sort() as FXRate[];
};

export default getCEBFXRates;
