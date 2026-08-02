// 测试专用的 types.d.ts runtime stub：
// types.d.ts 是纯声明文件（.d.ts），ts-jest ESM 模式下不产生运行时 JS，
// 因此 `import { currency } from '../types'` 在测试里会找不到运行时导出。
// 本文件提供与 enum currency 等值的运行时对象，经 jest moduleNameMapper
// 将 '../types' / 'src/types' 解析到此文件，保证测试可运行。
export enum currency {
    USD = 'USD',
    EUR = 'EUR',
    GBP = 'GBP',
    JPY = 'JPY',
    AUD = 'AUD',
    CAD = 'CAD',
    CHF = 'CHF',
    CNY = 'CNY',
    SEK = 'SEK',
    NZD = 'NZD',
    KRW = 'KRW',
    SGD = 'SGD',
    NOK = 'NOK',
    MXN = 'MXN',
    INR = 'INR',
    RUB = 'RUB',
    ZAR = 'ZAR',
    BRL = 'BRL',
    TWD = 'TWD',
    DKK = 'DKK',
    PLN = 'PLN',
    THB = 'THB',
    IDR = 'IDR',
    HUF = 'HUF',
    CZK = 'CZK',
    ILS = 'ILS',
    CLP = 'CLP',
    PHP = 'PHP',
    AED = 'AED',
    COP = 'COP',
    SAR = 'SAR',
    MYR = 'MYR',
    RON = 'RON',
    KWD = 'KWD',
    VND = 'VND',
    ARS = 'ARS',
    TRY = 'TRY',
    HKD = 'HKD',
    PKR = 'PKR',
    BDT = 'BDT',
    LKR = 'LKR',
    MOP = 'MOP',
    KZT = 'KZT',
    TJS = 'TJS',
    MNT = 'MNT',
    LAK = 'LAK',
    IRR = 'IRR',
    RMB = 'CNY', // eslint-disable-line @typescript-eslint/no-duplicate-enum-values -- RMB 是 CNY 的别名（与 src/types.d.ts 语义一致）
    CNH = 'CNH',
    AUX = 'AUX',
    AUY = 'AUY',
    BND = 'BND',
    unknown = 'unknown',
}

export interface FXRate {
    currency: {
        from: currency;
        to: currency;
    };
    rate: {
        buy?: {
            cash?: number;
            remit?: number;
        };
        sell?: {
            cash?: number;
            remit?: number;
        };
        middle?: number;
    };
    unit: 1 | 10 | 100 | 10000 | number;
    updated: Date;
}

export interface FXPath {
    from: currency;
    end: currency;
    path: currency[];
}

export enum JSONRPCMethods {
    instanceInfo = 'instanceInfo',
    listCurrencies = 'listCurrencies',
    getFXRate = 'getFXRate',
    listFXRates = 'listFXRates',
}
