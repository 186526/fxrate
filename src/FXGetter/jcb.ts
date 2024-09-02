import axios from 'axios';
import { FXRate, currency } from 'src/types';
import cheerio from 'cheerio';

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

const getJCBFXRates = async (): Promise<FXRate[]> => {
    const k = await Promise.all([getJCBJPYBasedFXRates()]);
    return k.flat(1);
};

export default getJCBFXRates;
export { getJCBJPYBasedFXRates };
