import { makeInstance, Manager } from '../src/index';
import { useInternalRestAPI } from '../src/fxmManager';
import { rootRouter } from 'handlers.js';

const Instance = await makeInstance(new rootRouter(), Manager);

describe('Server Status', () => {
    test('/info', async () => {
        const res = await useInternalRestAPI('info', Instance);
        expect(res.status).toEqual('ok');
    });

    test(
        '/:sources/',
        async () => {
            const res = await useInternalRestAPI('info', Instance);
            expect(res.status).toEqual('ok');

            await Promise.all(
                res.sources.map(async (source) => {
                    const p = await useInternalRestAPI(`${source}`, Instance);
                    expect(p.status).toEqual('ok');
                }),
            );

            await new Promise((resolve) => setTimeout(resolve, 5 * 1000));
        },
        45 * 1000,
    );
});

afterAll((t) => {
    Manager.stopAllInterval();
    t();
});
