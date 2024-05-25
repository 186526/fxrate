import { Fraction } from 'mathjs';
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
    RMB = CNY,
    unknown,
}

export interface FXRate {
    currency: {
        from: currency;
        to: currency;
    };
    rate: {
        buy?: {
            cash?: Fraction | number;
            remit?: Fraction | number;
        };
        sell?: {
            cash?: Fraction | number;
            remit?: Fraction | number;
        };
        middle?: Fraction | number;
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
