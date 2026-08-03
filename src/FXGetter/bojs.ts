import { existsSync } from 'node:fs';

import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

const PAGE_URL =
    'https://www.jsbchina.cn/CNNEW/kjfsnew/jrxinxinew/whpjnew/index.html?flag=2';
const API_URL = 'https://www.jsbchina.cn/cms/SpotQuotePrivateQry.do';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

type JSBankRow = {
    tradeDate: string;
    CustBid2: string;
    mid: string;
    custoffer2: string;
    custOffer: string;
    custBid: string;
    rateName: string;
};

type JSBankResponse = {
    fMoneyPriceList: JSBankRow[];
};

const currencyMap: Record<string, currency> = {
    AUD: currency.AUD,
    CAD: currency.CAD,
    CHF: currency.CHF,
    EUR: currency.EUR,
    GBP: currency.GBP,
    HKD: currency.HKD,
    JPY: currency.JPY,
    SGD: currency.SGD,
    USD: currency.USD,
};

const isPayload = (value: unknown): value is JSBankResponse =>
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as JSBankResponse).fMoneyPriceList);

const chromiumExecutable = (): string | undefined => {
    const candidates = [
        process.env['CHROMIUM_PATH'],
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/home/real186/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    ].filter((path): path is string => Boolean(path));
    return candidates.find((path) => existsSync(path));
};

const fetchDirect = async (): Promise<JSBankResponse> => {
    const res = await axios.post<unknown>(
        API_URL,
        new URLSearchParams({
            startIndex: '0',
            endIndex: '10',
            startDate: '',
            endDate: '',
            codeFlag: '',
        }),
        {
            timeout: 10000,
            headers: {
                'Content-Type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                Referer: PAGE_URL,
                'User-Agent': process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
                'X-Requested-With': 'XMLHttpRequest',
            },
        },
    );
    if (!isPayload(res.data)) {
        throw new Error('direct request was intercepted by the WAF');
    }
    return res.data;
};

const fetchViaChromium = async (): Promise<JSBankResponse> => {
    const executablePath = chromiumExecutable();
    if (!executablePath) {
        throw new Error('chromium executable not found');
    }

    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    try {
        const context = await browser.newContext({
            userAgent: process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
        });
        const page = await context.newPage();
        // waitForResponse 与 goto 必须并行走（Promise.all），
        // 否则 goto 超时后 waitForResponse 的 promise 无人 await，
        // 其 60s 超时 reject 会成为 unhandledRejection 导致进程崩溃（2026-08 实测）。
        const rateResponse = page.waitForResponse(
            (response) =>
                response.url().includes('/cms/SpotQuotePrivateQry.do') &&
                response.status() === 200,
            { timeout: 60000 },
        );
        const navigationPromise = page.goto(PAGE_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        const [response] = await Promise.all([rateResponse, navigationPromise]);
        const payload: unknown = await response.json();
        if (!isPayload(payload)) {
            throw new Error('chromium response contained no rates');
        }
        return payload;
    } finally {
        await browser.close();
    }
};

const parseDate = (value: string): Date => {
    const date = new Date(`${value.replace(' ', 'T')}+08:00`);
    return Number.isFinite(date.getTime()) ? date : new Date();
};

const getBOJSFXRates = async (): Promise<FXRate[]> => {
    let payload: JSBankResponse;
    try {
        payload = await fetchDirect();
    } catch (directError) {
        try {
            payload = await fetchViaChromium();
        } catch (chromiumError) {
            throw new Error(
                `Jiangsu Bank unavailable: ${(directError as Error).message}; ` +
                    `chromium fallback failed: ${(chromiumError as Error).message}`,
            );
        }
    }

    const rates: FXRate[] = [];
    for (const row of payload.fMoneyPriceList) {
        const match = row.rateName.match(/^([A-Z]{3})CNY$/);
        const from = match ? currencyMap[match[1]] : undefined;
        const cashBuy = parseFloat(row.CustBid2);
        const cashSell = parseFloat(row.custoffer2);
        const remitBuy = parseFloat(row.custBid);
        const remitSell = parseFloat(row.custOffer);
        const middle = parseFloat(row.mid);

        if (
            !from ||
            ![cashBuy, cashSell, remitBuy, remitSell, middle].every(
                (value) => Number.isFinite(value) && value > 0,
            ) ||
            cashBuy >= cashSell ||
            remitBuy >= remitSell
        ) {
            continue;
        }

        rates.push({
            currency: {
                from,
                to: currency.CNY,
            },
            rate: {
                buy: {
                    cash: cashBuy,
                    remit: remitBuy,
                },
                sell: {
                    cash: cashSell,
                    remit: remitSell,
                },
                middle,
            },
            unit: from === currency.JPY ? 100 : 1,
            updated: parseDate(row.tradeDate),
        });
    }

    if (rates.length === 0) {
        throw new Error('Jiangsu Bank returned no rates');
    }
    return rates.sort();
};

export default getBOJSFXRates;
