import { existsSync } from 'node:fs';

// headless chromium 直连（Cloudflare 拦非浏览器客户端时启用）。
// 动态 import：没有安装 playwright-core / chromium 的环境（如 Vercel serverless）降级走 fetch。
type ChromiumPage = {
    goto: (
        url: string,
        opts: object,
    ) => Promise<{ status: () => number } | null>;
    evaluate: <T>(fn: () => T) => Promise<T>;
};
type ChromiumBrowser = {
    newContext: (opts: object) => Promise<{
        newPage: () => Promise<ChromiumPage>;
    }>;
    close: () => Promise<void>;
};
let chromiumLauncher:
    | (() => Promise<{ launch: (opts: object) => Promise<ChromiumBrowser> }>)
    | null = null;
let chromiumInitError: Error | null = null;
async function getChromium() {
    if (chromiumInitError) throw chromiumInitError;
    if (!chromiumLauncher) {
        try {
            const mod = await import('playwright-core');
            chromiumLauncher = () =>
                Promise.resolve({
                    launch: async (opts: object) => {
                        const browser = await (
                            mod as unknown as {
                                chromium: {
                                    launch: (
                                        o: object,
                                    ) => Promise<ChromiumBrowser>;
                                };
                            }
                        ).chromium.launch(opts);
                        return browser;
                    },
                });
        } catch (e) {
            chromiumInitError = new Error(
                `playwright-core not available: ${(e as Error).message}`,
            );
            throw chromiumInitError;
        }
    }
    return chromiumLauncher();
}

// 常见 chromium 可执行文件路径（本地 / Docker 部署）。
function chromiumExecutable(): string | undefined {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
    const candidates = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/home/real186/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return undefined;
}

/**
 * 用 headless chromium 逐个打开 urls，返回第一个 HTTP 200 的页面文本。
 * 每次调用启动一次浏览器、按顺序访问所有候选 URL（每日发布场景传 7 天日期）。
 * 无 chromium 环境（Vercel serverless）时抛错，由调用方降级。
 */
export async function fetchTextViaChromium(
    urls: string[],
    opts?: {
        userAgent?: string;
        navigationTimeoutMs?: number;
    },
): Promise<string> {
    const executablePath = chromiumExecutable();
    if (!executablePath) {
        throw new Error('chromium executable not found');
    }
    const launcher = await getChromium();

    const browser = await launcher.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    try {
        // 必须用非 headless 标识的 UA：Cloudflare 会拦截 Playwright 默认的
        // "HeadlessChrome" UA（实测 403），newContext 设置 UA 才能改网络层请求头。
        const context = await browser.newContext({
            userAgent:
                opts?.userAgent ??
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();

        for (const url of urls) {
            const resp = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: opts?.navigationTimeoutMs ?? 45000,
            });
            const status = resp?.status() ?? 0;
            if (status === 200) {
                return await page.evaluate(() => document.body.innerText);
            }
        }
        throw new Error(
            `chromium: none of ${urls.length} URLs returned 200 (last status: ${urls.length > 0 ? 'n/a' : 'empty'})`,
        );
    } finally {
        await browser.close();
    }
}
