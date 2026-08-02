import { makeInstance, Manager } from '../src/index';
import { rootRouter, request, interfaces } from 'handlers.js';
const Instance = await makeInstance(new rootRouter(), Manager);
test('ncb.hk JPY 修复验证', async () => {
    const mk = (path: string) =>
        new request(
            'GET',
            new URL(`http://this.internal/${path}`),
            new interfaces.headers({}),
            '',
            {},
        );
    const out: string[] = [];
    for (const src of ['ncb.hk', 'hsbc.hk']) {
        for (const p of [
            `${src}/JPY/HKD?amount=1`,
            `${src}/USD/HKD?amount=1`,
            `${src}/JPY/CNY?amount=1`,
        ]) {
            try {
                const r = await Instance.respond(mk(p));
                const b = JSON.parse(String(r.body));
                const mid =
                    b.middle === false ? 'F' : String(b.middle).slice(0, 9);
                out.push(`${p}: ${mid}`);
            } catch (_e) {
                out.push(`${p}: ERR`);
            }
        }
    }
    process.stdout.write(out.join('\n') + '\n');
}, 90000);
afterAll((t) => {
    Manager.stopAllInterval();
    t();
});
