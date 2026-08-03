import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

interface CCBARateRow {
    BidRateOfCash?: number | string;
    BidRateOfCcy?: number | string;
    Mdl_ExRt_Prc?: number | string;
    OfrRateOfCash?: number | string;
    OfrRateOfCcy?: number | string;
    Ofr_Ccy_CcyCd?: string;
    Ofrd_Ccy_CcyCd?: string;
}

interface CCBAExchangeRateGroup {
    Dif_Dmsn_Val?: string;
    ToCusOfrOutGrp?: CCBARateRow[];
    updatetime?: number | string;
}

const currencyMap: Record<string, currency> = {
    '036': 'AUD' as currency.AUD,
    '124': 'CAD' as currency.CAD,
    '392': 'JPY' as currency.JPY,
    '554': 'NZD' as currency.NZD,
    '702': 'SGD' as currency.SGD,
    '710': 'ZAR' as currency.ZAR,
    '756': 'CHF' as currency.CHF,
    '826': 'GBP' as currency.GBP,
    '840': 'USD' as currency.USD,
    '978': 'EUR' as currency.EUR,
    A04: 'CNY' as currency.CNY,
};

const extractGroups = (script: string): CCBAExchangeRateGroup[] => {
    const callback = script.indexOf('jqueryHkInfo(');
    const start = script.indexOf('{', callback);
    const end = script.lastIndexOf(')');
    if (callback < 0 || start < 0 || end <= start) {
        throw new Error('Invalid CCBA exchange-rate payload');
    }

    // The upstream object repeats the ExR_Grp root key for each customer tier.
    // Rename each occurrence before JSON.parse so the retail tier is not lost.
    let groupIndex = 0;
    const json = script
        .slice(start, end)
        .replace(/"ExR_Grp"\s*:/g, () => `"ExR_Grp_${groupIndex++}":`);
    const payload = JSON.parse(json) as Record<string, unknown>;

    return Object.entries(payload)
        .filter(
            ([key, value]) =>
                key.startsWith('ExR_Grp_') && Array.isArray(value),
        )
        .flatMap(([, value]) => value as CCBAExchangeRateGroup[]);
};

const parseUpdated = (value?: number | string): Date => {
    const timestamp = String(value ?? '');
    if (!/^\d{14}$/.test(timestamp)) return new Date();

    const updated = new Date(
        `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}` +
            `T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}+08:00`,
    );
    return Number.isNaN(updated.getTime()) ? new Date() : updated;
};

const getCCBAFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.asia.ccb.com/hongkong/js/ho_js/hkwhhl01.js',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );
    if (typeof res.data !== 'string') {
        throw new Error('Invalid CCBA exchange-rate response');
    }

    const groups = extractGroups(res.data);
    const group =
        groups.find((item) => item.Dif_Dmsn_Val === '210') ?? groups[0];
    if (!group) throw new Error('CCBA exchange-rate group not found');

    const updated = parseUpdated(group.updatetime);
    return (group.ToCusOfrOutGrp ?? [])
        .map((row): FXRate | null => {
            if (row.Ofr_Ccy_CcyCd !== '344') return null;

            const from = row.Ofrd_Ccy_CcyCd
                ? currencyMap[row.Ofrd_Ccy_CcyCd]
                : undefined;
            const buyCash = Number(row.BidRateOfCash);
            const buyRemit = Number(row.BidRateOfCcy);
            const sellCash = Number(row.OfrRateOfCash);
            const sellRemit = Number(row.OfrRateOfCcy);
            const middle = Number(row.Mdl_ExRt_Prc);
            if (
                !from ||
                !Number.isFinite(middle) ||
                middle <= 0 ||
                !Number.isFinite(buyCash) ||
                !Number.isFinite(sellCash) ||
                buyCash <= 0 ||
                buyCash >= sellCash ||
                !Number.isFinite(buyRemit) ||
                !Number.isFinite(sellRemit) ||
                buyRemit <= 0 ||
                buyRemit >= sellRemit
            ) {
                return null;
            }

            return {
                currency: {
                    from,
                    to: 'HKD' as currency.HKD,
                },
                rate: {
                    buy: {
                        cash: buyCash,
                        remit: buyRemit,
                    },
                    sell: {
                        cash: sellCash,
                        remit: sellRemit,
                    },
                    middle,
                },
                // JPY is quoted around 0.05 HKD, confirming per-unit rates.
                unit: 1,
                updated,
            };
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getCCBAFXRates;
