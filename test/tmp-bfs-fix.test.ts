import { makeInstance, Manager } from '../src/index';
import { rootRouter, request, interfaces } from 'handlers.js';
const Instance = await makeInstance(new rootRouter(), Manager);
const mk = (path: string) =>
    new request('GET', new URL(`http://this.internal/${path}`), new interfaces.headers({}), '', {});

test('dbs/ocbc CNY-USD BFS both directions after fix', async () => {
    for (const src of ['dbs', 'ocbc']) {
        for (const p of [
            `${src}/CNY/USD?amount=1&bfs=1`,
            `${src}/USD/CNY?amount=1&bfs=1`,
        ]) {
            const r = await Instance.respond(mk(p));
            console.log(`${p}: ${String(r.body).slice(0, 140)}`);
        }
    }
}, 60000);

afterAll((t) => {
    Manager.stopAllInterval();
    t();
});
