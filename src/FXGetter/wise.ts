import axios from 'axios';

import { FXRate, currency } from 'src/types';
import fxmManager from '../fxmManager';

const getWiseFXRates = (
    isInSandbox: boolean = false,
    useTokenInWeb: boolean = true,
    WiseToken: string,
): ((fxmManager?: fxmManager) => Promise<FXRate[]>) => {
    let endPoint = 'https://api.wise.com/v1/rates';
    if (isInSandbox) {
        endPoint = 'https://api.sandbox.transferwise.tech/v1/rates';
    }

    return async (fxmManager?: fxmManager): Promise<FXRate[]> => {
        console.log(isInSandbox, useTokenInWeb, WiseToken);
        if (fxmManager && isInSandbox)
            fxmManager.log('Getting Wise FX Rates in sandbox mode.');
        else if (fxmManager)
            fxmManager.log('Getting Wise FX Rates in production mode.');

        const response = await axios.get(endPoint, {
            headers: {
                Authorization: !useTokenInWeb
                    ? `Bearer ${WiseToken}`
                    : 'Basic OGNhN2FlMjUtOTNjNS00MmFlLThhYjQtMzlkZTFlOTQzZDEwOjliN2UzNmZkLWRjYjgtNDEwZS1hYzc3LTQ5NGRmYmEyZGJjZA==',
            },
        });

        const rates: FXRate[] = [];
        const data: [
            {
                rate: string;
                source: currency;
                target: currency;
                time: string;
            },
        ] = response.data;

        for (const rate of data) {
            rate.source =
                rate.source === 'CNY' ? ('CNH' as currency.CNH) : rate.source;
            rate.target =
                rate.target === 'CNY' ? ('CNH' as currency.CNH) : rate.target;

            rates.push({
                currency: {
                    from: rate.source as currency.unknown,
                    to: rate.target as currency.unknown,
                },
                rate: {
                    middle: parseFloat(rate.rate),
                },
                unit: 1,
                updated: new Date(rate.time),
            });
        }

        return rates.sort();
    };
};

export default getWiseFXRates;
