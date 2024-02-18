import axios from 'axios';
import { FXRate, currency } from 'src/types';

const getCMBFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get('https://fx.cmbchina.com/api/v1/fx/rate', {
        headers: {
            'User-Agent': 'fxrate axios/latest',
        },
    });

    const data = req.data.body;

    return data
        .map((fx) => {
            return {
                currency: {
                    from: fx.ccyNbrEng.split(' ')[1] as currency.unknown,
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
        .sort();
};

export default getCMBFXRates;
