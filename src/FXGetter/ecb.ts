import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

// 欧洲央行参考汇率（EUR 基准）：https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
// 每日约 UTC 16:00 后发布，约 30 种货币的 EUR 参考中间价（无买卖价）。
// 参考汇率是市场中间价（ECB 基准），买卖价不适用，全部用 middle。
const getECBFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
            timeout: 10000,
        },
    );

    const dateMatch = res.data.match(/<Cube time='([^']+)'/);
    const date = dateMatch ? new Date(`${dateMatch[1]}T00:00:00Z`) : new Date();

    const rates: FXRate[] = [];
    // 每行 <Cube currency='USD' rate='1.1485'/>，即 1 EUR = rate Ccy
    const rowRegex = /<Cube currency='([A-Z]{3})' rate='([0-9.]+)'\/>/g;
    let m: RegExpExecArray | null;
    while ((m = rowRegex.exec(res.data)) !== null) {
        const [, ccy, rate] = m;
        rates.push({
            currency: {
                from: 'EUR' as currency.EUR,
                to: ccy as unknown as currency.unknown,
            },
            rate: {
                middle: parseFloat(rate),
            },
            unit: 1,
            updated: date,
        } as FXRate);
    }

    return rates.sort();
};

export default getECBFXRates;
