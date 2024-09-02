import { XMLParser } from 'fast-xml-parser';
import { FXRate, currency } from 'src/types';
import axios from 'axios';

const parser = new XMLParser();

const currencyMap = {
    '840': { name: 'USD' as currency.USD },
    '978': { name: 'EUR' as currency.EUR },
    '826': { name: 'GBP' as currency.GBP },
    '392': { name: 'JPY' as currency.JPY },
    '344': { name: 'HKD' as currency.HKD },
    '36': { name: 'AUD' as currency.AUD },
    '124': { name: 'CAD' as currency.CAD },
    '756': { name: 'CHF' as currency.CHF },
    '702': { name: 'SGD' as currency.SGD },
    '208': { name: 'DKK' as currency.DKK },
    '578': { name: 'NOK' as currency.NOK },
    '752': { name: 'SEK' as currency.SEK },
    '410': { name: 'KRW' as currency.KRW },
    '554': { name: 'NZD' as currency.NZD },
    '446': { name: 'MOP' as currency.MOP },
    '710': { name: 'ZAR' as currency.ZAR },
    '764': { name: 'THB' as currency.THB },
    '458': { name: 'MYR' as currency.MYR },
    '643': { name: 'RUB' as currency.RUB },
    '398': { name: 'KZT' as currency.KZT },
};

const getCCBFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        'http://www.ccb.com/cn/home/news/jshckpj_new.xml',
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );
    const settlements = parser.parse(req.data)['ReferencePriceSettlements'][
        'ReferencePriceSettlement'
    ];
    const result = settlements.map((data: any) => {
        return {
            currency: {
                from: currencyMap[data['Ofrd_Ccy_CcyCd']].name,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                buy: {
                    cash: data['BidRateOfCash'],
                    remit: data['BidRateOfCcy'],
                },
                sell: {
                    cash: data['OfrRateOfCash'],
                    remit: data['OfrRateOfCcy'],
                },
                middle: data['Mdl_ExRt_Prc'],
            },
            unit: 1,
            updated: new Date(
                ((date: number, time: number) => {
                    const dateStringArray = date.toString().split('');
                    const timeStringArray = time
                        .toString()
                        .padStart(6, '0')
                        .split('');
                    dateStringArray.splice(4, 0, '-');
                    dateStringArray.splice(7, 0, '-');
                    timeStringArray.splice(2, 0, ':');
                    timeStringArray.splice(5, 0, ':');
                    return `${dateStringArray.join('')} ${timeStringArray.join('')} UTC+8`;
                })(data['LstPr_Dt'], data['LstPr_Tm']),
            ),
        } as FXRate;
    });
    return result.sort();
};

export default getCCBFXRates;
