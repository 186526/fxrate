import { makeInstance, Manager } from '../src/index';
import { rootRouter, request, interfaces } from 'handlers.js';
const Instance = await makeInstance(new rootRouter(), Manager);
test('all sources USD/CNY', async () => {
    const mk = (path: string) =>
        new request(
            'GET',
            new URL(`http://this.internal/${path}`),
            new interfaces.headers({}),
            '',
            {},
        );
    const sources = [
        'boc',
        'icbc',
        'ccb',
        'abc',
        'bocom',
        'citic',
        'cmb',
        'ceb',
        'cib',
        'psbc',
        'hsbc',
        'hsbc.cn',
        'hsbc.hk',
        'ncb.cn',
        'ncb.hk',
        'cathay',
        'poc',
        'unionpay',
        'boc.hk',
        'mastercard',
        'visa',
        'wise',
        'eub',
        'eub.hk',
    ];
    const out: string[] = [];
    for (const s of sources) {
        try {
            const r = await Instance.respond(mk(`${s}/USD/CNY?amount=1`));
            const b = JSON.parse(String(r.body));
            const mid =
                b.middle === false ? 'FALSE' : String(b.middle).slice(0, 8);
            out.push(`${s}: ${mid}`);
        } catch (e) {
            out.push(`${s}: ERR ${(e as Error).message.slice(0, 40)}`);
        }
    }
    process.stdout.write(out.join('\n') + '\n');
}, 300000);
afterAll((t) => {
    Manager.stopAllInterval();
    t();
});
