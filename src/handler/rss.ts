import type fxmManager from '../fxmManager';
import { useInternalRestAPI } from '../fxmManager';
import { router, handler } from 'handlers.js';
import { request, response } from 'handlers.js';
import { Feed } from 'feed';

import { sourceNamesInZH } from '../constant';

interface PriceDetail {
    remit?: number | string | boolean;
    cash?: number | string | boolean;
    middle?: number | string | boolean;
    updated: string;
    sellRemit?: number | string | boolean;
    sellCash?: number | string | boolean;
    sellMiddle?: number | string | boolean;
    sellUpdated: string;
    source: string;
}

export class RSSHandler extends router {
    private fxmManager: fxmManager;

    constructor(fxmManager: fxmManager) {
        super();
        this.fxmManager = fxmManager;
        this.mount();
    }

    async requestPrice(from: string, to: string, excludeSource: string[] = []) {
        const sources = (
            await useInternalRestAPI(`info`, this.fxmManager)
        ).sources.filter((source: string) => !excludeSource.includes(source));

        const answer = await Promise.all(
            sources.map(async (source: string) => {
                try {
                    const buyPrices = await useInternalRestAPI(
                        `${source}/${to}/${from}/?precision=4&fees=0&amount=100`,
                        this.fxmManager,
                    );

                    // 卖出侧 = 反向报价：getDetails(from, to) = 1/卖出价（如 100 CNY = X USD）。
                    // 注意不能加 `&reverse`：reverse 会把路径反转回 to→from（买入侧），
                    // 与上方 buy 请求等价，非对称点差下买卖价会完全相同（2026-08 实测修复）。
                    const sellPrices = await useInternalRestAPI(
                        `${source}/${from}/${to}/?precision=4&fees=0&amount=100`,
                        this.fxmManager,
                    );

                    return {
                        remit: buyPrices.remit,
                        cash: buyPrices.cash,
                        middle: buyPrices.middle,
                        updated: buyPrices.updated,
                        sellRemit: sellPrices.remit,
                        sellCash: sellPrices.cash,
                        sellMiddle: sellPrices.middle,
                        sellUpdated: sellPrices.updated,
                        source,
                    };
                } catch (e) {
                    console.error(
                        `not suppported: ${source} with ${from} to ${to}`,
                        e,
                    );
                    return null;
                }
            }),
        );

        return answer.filter((x): x is PriceDetail => x !== null);
    }

    mount() {
        const toRSS = async (
            request: request<any>,
            response: response<any>,
        ) => {
            if (request.params.from)
                request.params.from = request.params.from.toUpperCase();

            if (request.params.to)
                request.params.to = request.params.to.toUpperCase();

            const { from, to } = request.params as { from: string; to: string };

            const feed = new Feed({
                title: `FXRate 实时 ${from} <=> ${to} 汇率信息`,
                updated: new Date(),
                id: 'https://github.com/186526/fxrate',
                copyright:
                    'MIT, Data copyright belongs to its source. More details at <https://github.com/186526/fxrate>.',
                author: {
                    name: 'Bo Xu',
                    email: 'i@186526.xyz',
                    link: 'https://186526.xyz',
                },
            });

            const prices = await this.requestPrice(from, to);

            prices.forEach((price) => {
                const description = `现汇买入: ${price.remit} 现钞买入: ${price.cash} 买入中间价: ${price.middle} 买入更新时间: ${price.updated}\n现汇卖出: ${price.sellRemit} 现钞卖出: ${price.sellCash} 卖出中间价: ${price.sellMiddle} 卖出更新时间: ${price.sellUpdated}`;

                feed.addItem({
                    title: `${(sourceNamesInZH as Record<string, string>)[price.source] ?? price.source}`,
                    link: `https://github.com/186526/fxrate`,
                    description: description,
                    content: description,
                    date: new Date(price.updated),
                });
            });

            response.body = feed.atom1();
            response.headers.set('Content-Type', 'application/xml');
            response.status = 200;

            return response;
        };
        this.binding('/:from/:to', new handler('GET', [toRSS]));
    }
}
