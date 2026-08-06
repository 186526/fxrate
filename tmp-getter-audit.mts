import { globSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import fxManager from './src/fxm/fxManager.ts';
// 复用 src/index.ts 的 getter 注册表（只取名字与 getter 函数）
const { Manager } = await import('./src/index.ts');
// 直接读 index.ts 里注册的 getter 名
const src = await (await import('node:fs/promises')).readFile('./src/index.ts', 'utf8');
const getterNames = [...src.matchAll(/\[['"]([a-zA-Z0-9._]+)['"]\]\s*:\s*([a-zA-Z0-9_]+)\s*[,}]/g)].map(m => m[1]).filter(n => !n.startsWith('_') && n !== 'source');
console.log('getters found:', getterNames.length);
const results = [];
for (const name of getterNames) {
  try {
    const mod = await import(`./src/FXGetter/${name}.ts`);
    const fn = mod.default ?? Object.values(mod)[0];
    if (typeof fn !== 'function') { results.push([name, 'NO_FN']); continue; }
    const rates = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
    const m = new fxManager([]);
    let ok = 0, bad = 0, firstErr = '';
    for (const r of rates) { try { m.update(r); ok++; } catch (e) { bad++; firstErr ||= (e as Error).message; } }
    results.push([name, bad === 0 ? 'OK' : `VALIDATE_FAIL(${bad}/${rates.length}) ${firstErr.slice(0, 90)}`]);
  } catch (e) {
    results.push([name, 'FETCH_FAIL ' + (e as Error).message.slice(0, 80)]);
  }
}
for (const [n, r] of results) console.log(n.padEnd(22), r);
