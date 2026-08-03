import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

// 支付宝境外消费汇率（公开 SEM 汇率换算器页面的数据源）：
//   https://render.alipay.com/p/s/currency-converter-sem/（页面）
//   API: https://basement-gzone.alipay.com/mgw_proxy/unauthorized_endpoint
//   参数 requestData: [{ "x-basement-operation": "com.alipay.overseatwa.xservices.index.queryRate", "x-basement-forward": "{positionInfo...}" }]
//   返回 JSONP 包裹的 resultData，含 commonRateList：每条 { currencyInfo.engAbbr, contrastRate, mbarcodeRate }。
//   contrastRate = 1 外币 = X 人民币（USD=6.7704，2026-08 实测）；mbarcodeRate 为会员专属汇率。
// 纯 curl/axios 可直连（2026-08 实测，无需 cookie/referer/UA），但需伪装 callback 参数。
// 语义：支付宝境外消费「付款时按外币换算人民币」，contrastRate 即客户实际结算汇率（中间价性质，无买卖价）。
const getAlipayFXRates = async (): Promise<FXRate[]> => {
    const forward = JSON.stringify({
        positionInfo: { latitude: 22.3, longitude: 114.17 },
    });
    const requestData = JSON.stringify([
        {
            'x-basement-operation':
                'com.alipay.overseatwa.xservices.index.queryRate',
            'x-basement-forward': forward,
        },
    ]);

    const res = await axios.get(
        'https://basement-gzone.alipay.com/mgw_proxy/unauthorized_endpoint',
        {
            params: {
                requestData,
                callback: `jsonp_${Date.now()}`,
            },
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
            },
            timeout: 10000,
        },
    );

    // JSONP 响应：/**/ typeof jsonp_x === 'function' && jsonp_x({...})
    const jsonpMatch = res.data.match(/&&\s*jsonp_\w+\((.*)\)\s*;?\s*$/s);
    if (!jsonpMatch) throw new Error('Alipay: unexpected JSONP response');
    const payload = JSON.parse(jsonpMatch[1]);
    const resultData = JSON.parse(payload.result?.result?.resultData);
    const rows = resultData.commonRateList as {
        currencyInfo: { engAbbr: string };
        contrastRate: number;
        mbarcodeRate?: number;
    }[];

    const date = new Date();
    const rates: FXRate[] = [];
    for (const r of rows) {
        const ccy = r.currencyInfo.engAbbr;
        if (!/^[A-Z]{3}$/.test(ccy) || ccy === 'CNY') continue;
        const middle = Number(r.contrastRate);
        if (!Number.isFinite(middle) || middle <= 0) continue;
        rates.push({
            currency: {
                from: ccy as unknown as currency.unknown,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                middle,
            },
            unit: 1,
            updated: date,
            // 单向结算汇率：支付宝只做「外币账单 → 人民币扣款」，反向（人民币→外币）无实际业务，
            // oneWay 让 fxManager 跳过反向写入，避免出现误导性的 CNY→外币 倒数牌价。
            oneWay: true,
        } as FXRate);
    }
    return rates.sort();
};

export default getAlipayFXRates;
