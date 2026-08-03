import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

// 中国外汇交易中心（CFETS）人民币中间价：https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json
// 每日 9:15 发布，25 个货币对，中间价（无买卖价）。
// 记录格式：{ vrtEName: "USD/CNY", price: "6.7894", ... }
const getCFETSFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json',
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
            timeout: 10000,
        },
    );

    const data = res.data as {
        data: { lastDate: string };
        records: {
            vrtEName: string;
            price: string;
        }[];
    };

    // lastDate 格式 "2026-07-31 9:15"（北京时间，小时可能为个位数），
    // 需补零成 "2026-07-31T09:15" 才能被 Date 解析。
    const [d, hhmm] = data.data.lastDate.split(' ');
    const [hh, mm] = hhmm.split(':').map((s: string) => s.padStart(2, '0'));
    const date = new Date(`${d}T${hh}:${mm}+08:00`);

    return data.records
        .map((r) => {
            const [from, to] = r.vrtEName.split('/');
            if (!from || !to) return null;
            const middle = parseFloat(r.price);
            if (!Number.isFinite(middle) || middle <= 0) return null;
            return {
                currency: {
                    from: from as unknown as currency.unknown,
                    to: to as unknown as currency.unknown,
                },
                rate: {
                    middle,
                },
                unit: 1,
                updated: date,
            } as FXRate;
        })
        .filter((r): r is FXRate => r !== null)
        .sort();
};

export default getCFETSFXRates;
