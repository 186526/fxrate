import { existsSync } from 'node:fs';

import axios from 'axios';
import * as cheerio from 'cheerio';
import { FXRate, currency } from 'src/types.d';

const PAGE_URL = 'https://www.hfbank.com.cn/bjfw/hqzx/whpj/index.shtml';
const RATE_URL_PART = '/ucms/hfyh/jsp/gryw/whpj.jsp';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const currencyMap: Record<string, currency> = {
    USD: currency.USD,
    EUR: currency.EUR,
    JPY: currency.JPY,
    GBP: currency.GBP,
    HKD: currency.HKD,
    SGD: currency.SGD,
    CAD: currency.CAD,
    AUD: currency.AUD,
    KRW: currency.KRW,
};

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

const fetchViaChromium = async (): Promise<string> => {
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
            ignoreHTTPSErrors: true,
            userAgent: process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
        });
        const page = await context.newPage();
        const rateResponse = page.waitForResponse(
            (response) =>
                response.url().includes(RATE_URL_PART) &&
                response.status() === 200,
            { timeout: 60000 },
        );
        const navigationPromise = page.goto(PAGE_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        const [response] = await Promise.all([rateResponse, navigationPromise]);
        return await response.text();
    } finally {
        await browser.close();
    }
};

const parseRates = (html: string): FXRate[] => {
    const $ = cheerio.load(html);
    const updatedText = $('.titleBox .title').text();
    const updatedMatch = updatedText.match(
        /(\d{4})年(\d{2})月(\d{2})日(\d{2}):(\d{2})/,
    );
    const updated = updatedMatch
        ? new Date(
              `${updatedMatch[1]}-${updatedMatch[2]}-${updatedMatch[3]}` +
                  `T${updatedMatch[4]}:${updatedMatch[5]}:00+08:00`,
          )
        : new Date();

    const rates: FXRate[] = [];
    $('table.infoTable tbody tr').each((_index, element) => {
        const cells = $(element)
            .find('td')
            .map((_cellIndex, cell) => $(cell).text().trim())
            .get();
        if (cells.length < 6) return;

        const from = currencyMap[cells[1]];
        const cashBuy = parseFloat(cells[2]);
        const remitBuy = parseFloat(cells[3]);
        const remitSell = parseFloat(cells[4]);
        const middle = parseFloat(cells[5]);
        if (
            !from ||
            ![cashBuy, remitBuy, remitSell, middle].every(
                (value) => Number.isFinite(value) && value > 0,
            ) ||
            cashBuy >= remitSell ||
            remitBuy >= remitSell
        ) {
            return;
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
                    remit: remitSell,
                },
                middle,
            },
            unit: 1,
            updated: Number.isFinite(updated.getTime()) ? updated : new Date(),
        });
    });
    return rates.sort();
};

const getHFBankFXRates = async (): Promise<FXRate[]> => {
    let directError = 'direct response contained no rates';
    try {
        const res = await axios.get<string>(PAGE_URL, {
            timeout: 10000,
            responseType: 'text',
            headers: {
                'User-Agent': process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
            },
        });
        const rates = parseRates(res.data);
        if (rates.length > 0) return rates;
    } catch (error) {
        directError = (error as Error).message;
    }

    try {
        const rates = parseRates(await fetchViaChromium());
        if (rates.length > 0) return rates;
        throw new Error('chromium response contained no rates');
    } catch (error) {
        throw new Error(
            `Hengfeng Bank unavailable: ${directError}; chromium fallback failed: ${(error as Error).message}`,
        );
    }
};

export default getHFBankFXRates;
