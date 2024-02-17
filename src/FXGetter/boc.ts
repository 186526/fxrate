import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { FXRate, currency } from '../types';
import cheerio from 'cheerio';

const parser = new XMLParser();

const enNames = {
    阿联酋迪拉姆: 'AED',
    澳大利亚元: 'AUD',
    巴西里亚尔: 'BRL',
    加拿大元: 'CAD',
    瑞士法郎: 'CHF',
    丹麦克朗: 'DKK',
    欧元: 'EUR',
    英镑: 'GBP',
    港币: 'HKD',
    印尼卢比: 'IDR',
    印度卢比: 'INR',
    日元: 'JPY',
    韩国元: 'KRW',
    澳门元: 'MOP',
    林吉特: 'MYR',
    挪威克朗: 'NOK',
    新西兰元: 'NZD',
    菲律宾比索: 'PHP',
    卢布: 'RUB',
    沙特里亚尔: 'SAR',
    瑞典克朗: 'SEK',
    新加坡元: 'SGD',
    泰国铢: 'THB',
    土耳其里拉: 'TRY',
    新台币: 'TWD',
    美元: 'USD',
    南非兰特: 'ZAR',
};

const getBOCFXRatesFromRSSHub = async (
    RSSHubEndpoint: string = 'https://rsshub.app/boc/whpj',
): Promise<FXRate[]> => {
    // Thanks to https://rsshub.app/ for providing the RSS feed of BOC's FX rates
    const res = await axios.get(RSSHubEndpoint, {
        headers: {
            'User-Agent': 'fxrate axios/latest',
        },
    });

    const originalData: string = res.data;
    const jsonData = parser.parse(originalData).rss.channel.item;

    const FXrates: FXRate[] = [];

    jsonData.forEach((item: any) => {
        const tmp = item.description.split('<br>');
        const FXRate: FXRate = {
            currency: {
                from: item.guid.split(' ')[1] as currency.unknown,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                buy: {},
                sell: {},
                middle: parseFloat(tmp[4].split('：')[1]),
            },
            unit: 100,
            updated: new Date(item.pubDate),
        };

        if (tmp[0].split('：')[1])
            FXRate.rate.buy.remit = parseFloat(tmp[0].split('：')[1]);
        if (tmp[1].split('：')[1])
            FXRate.rate.buy.cash = parseFloat(tmp[1].split('：')[1]);
        if (tmp[2].split('：')[1])
            FXRate.rate.sell.remit = parseFloat(tmp[2].split('：')[1]);
        if (tmp[3].split('：')[1])
            FXRate.rate.sell.cash = parseFloat(tmp[3].split('：')[1]);

        FXrates.push(FXRate);
    });

    return FXrates;
};

const getBOCFXRatesFromBOC = async (): Promise<FXRate[]> => {
    const result = await Promise.all(
        [
            'index.html',
            'index_1.html',
            'index_2.html',
            'index_3.html',
            'index_4.html',
            'index_5.html',
            'index_6.html',
            'index_7.html',
            'index_8.html',
            'index_9.html',
        ].map(async (index) => {
            const res = await axios.get(
                `https://www.boc.cn/sourcedb/whpj/${index}`,
                {
                    headers: {
                        'User-Agent': 'fxrate axios/latest',
                    },
                },
            );
            const $ = cheerio.load(res.data);
            // Thanks to RSSHub for the code to get BOC's FX Rate
            return Array.from(
                new Set(
                    $('div.publish table tbody tr')
                        .slice(2)
                        .toArray()
                        .map((el) => {
                            const e = $(el);
                            const zhName = e.find('td:nth-child(1)').text();
                            const enName = enNames[zhName] || '';
                            const date = e.find('td:nth-child(7)').text();

                            const xhmr = e.find('td:nth-child(2)').text();

                            const xcmr = e.find('td:nth-child(3)').text();

                            const xhmc = e.find('td:nth-child(4)').text();

                            const xcmc = e.find('td:nth-child(5)').text();

                            const FXRate: FXRate = {
                                currency: {
                                    from: enName as currency.unknown,
                                    to: 'CNY' as currency.CNY,
                                },
                                rate: {
                                    buy: {},
                                    sell: {},
                                    middle: parseFloat(
                                        e.find('td:nth-child(6)').text(),
                                    ),
                                },
                                updated: new Date(date + ' UTC+8'),
                                unit: 100,
                            };

                            if (xhmr) FXRate.rate.buy.remit = parseFloat(xhmr);
                            if (xcmr) FXRate.rate.buy.cash = parseFloat(xcmr);
                            if (xhmc) FXRate.rate.sell.remit = parseFloat(xhmc);
                            if (xcmc) FXRate.rate.sell.cash = parseFloat(xcmc);

                            return FXRate;
                        }),
                ),
            ).sort();
        }),
    );
    return result.flat().sort();
};

export default getBOCFXRatesFromBOC;
export { getBOCFXRatesFromRSSHub };
