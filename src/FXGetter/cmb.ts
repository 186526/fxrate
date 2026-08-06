import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

interface cmbRateItem {
    ccyNbrEng: string;
    rthBid: number;
    rtcBid: number;
    rthOfr: number;
    rtcOfr: number;
    rtbBid: number;
    ratDat: string;
    ratTim: string;
}

const getCMBFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get('https://fx.cmbchina.com/api/v1/fx/rate', {
        timeout: 10000,
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    const data = req.data.body;

    // 上游所有报价字段都是字符串（如 "86.05"，百单位口径）：必须转 number，
    // 否则 Phase 3 严格校验（validateFXRate 只接受 number/Fraction）整批拒绝。
    // 任一报价缺失/非正数（Number 转换失败或 ≤0）跳过该行，避免单行坏数据拖垮整源。
    const toNumber = (v: unknown): number | null => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
    };

    return data
        .map((fx: cmbRateItem) => {
            // ccyNbrEng looks like '港币 HKD' — take the last token as the code.
            const parts = fx.ccyNbrEng.split(' ');
            const code = parts[parts.length - 1] || parts[0];
            if (!code) return null;

            const buyRemit = toNumber(fx.rthBid);
            const buyCash = toNumber(fx.rtcBid);
            const sellRemit = toNumber(fx.rthOfr);
            const sellCash = toNumber(fx.rtcOfr);
            const middle = toNumber(fx.rtbBid);
            if (
                buyRemit == null ||
                buyCash == null ||
                sellRemit == null ||
                sellCash == null ||
                middle == null
            ) {
                return null;
            }

            return {
                currency: {
                    from: code as unknown as currency.unknown,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: buyRemit,
                        cash: buyCash,
                    },
                    sell: {
                        remit: sellRemit,
                        cash: sellCash,
                    },
                    middle,
                },
                unit: 100,
                updated: new Date(
                    `${fx.ratDat
                        .replaceAll('年', '-')
                        .replaceAll('月', '-')
                        .replaceAll('日', '')} ${fx.ratTim} UTC+8`,
                ),
            } as FXRate;
        })
        .filter((fx): fx is FXRate => fx !== null)
        .sort();
};

export default getCMBFXRates;
