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

    return data
        .map((fx: cmbRateItem) => {
            // ccyNbrEng looks like '港币 HKD' — take the last token as the code.
            const parts = fx.ccyNbrEng.split(' ');
            const code = parts[parts.length - 1] || parts[0];
            if (!code) return null;

            return {
                currency: {
                    from: code as unknown as currency.unknown,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: fx.rthBid,
                        cash: fx.rtcBid,
                    },
                    sell: {
                        remit: fx.rthOfr,
                        cash: fx.rtcOfr,
                    },
                    middle: fx.rtbBid,
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
