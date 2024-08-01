import type fxmManager from '../fxmManager';
import { useInternalRestAPI } from '../fxmManager';
import { router, handler } from 'handlers.js';
import { request, response } from 'handlers.js';
import { Feed } from 'feed';

import { sourceNamesInZH } from '../constant';

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
        ).sources.filter((source) => !excludeSource.includes(source));

        const answer = [];

        await Promise.all(
            sources.map(async (source) => {
                try {
                    const buyPrices = await useInternalRestAPI(
                        `${source}/${to}/${from}/?precision=4&fees=0&amount=100`,
                        this.fxmManager,
                    );

                    const sellPrices = await useInternalRestAPI(
                        `${source}/${from}/${to}/?precision=4&fees=0&amount=100&reverse`,
                        this.fxmManager,
                    );

                    answer.push({
                        sell: sellPrices,
                        buy: buyPrices,
                        source,
                    });
                } catch (e) {
                    console.error(
                        `not suppported: ${source} with ${from} to ${to}`,
                        e,
                    );
                }
                return '';
            }),
        );

        return answer;
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

            const { from, to } = request.params;

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
                const description = `现汇买入: ${price.buy.remit} 现钞买入: ${price.buy.cash} 买入中间价: ${price.buy.middle} 买入更新时间: ${price.buy.updated}\n现汇卖出: ${price.sell.remit} 现钞卖出: ${price.sell.cash} 卖出中间价: ${price.sell.middle} 卖出更新时间: ${price.sell.updated}`;

                feed.addItem({
                    title: `${sourceNamesInZH[price.source] ?? price.source}`,
                    link: `https://github.com/186526/fxrate`,
                    description: description,
                    content: description,
                    date: new Date(price.buy.updated ?? price.sell.updated),
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
