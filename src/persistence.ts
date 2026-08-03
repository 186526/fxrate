import { create, all } from 'mathjs';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { FXRateType } from './fxm/fxManager';

// 汇率快照持久化：冷启动从本地 JSON 直接加载内存汇率表，
// 跳过懒加载的上游全量抓取（Visa 等慢源首访可达 30s+）。
// Vercel serverless（只读 FS 无持久性）下自动禁用。
const math = create(all, { number: 'Fraction' });
const { fraction } = math;

export interface SnapshotData {
    [source: string]: { [from: string]: { [to: string]: FXRateType } };
}

interface SnapshotFile {
    version: string;
    savedAt: string;
    sources: SnapshotData;
}

function cachePath(): string | null {
    if (process.env.VERCEL === '1') return null;
    const dir = process.env.FXRATE_CACHE_DIR || process.cwd();
    try {
        mkdirSync(dir, { recursive: true });
        return join(dir, 'fxrate-cache.json');
    } catch {
        return null;
    }
}

// JSON reviver：mathjs Fraction 序列化为 {mathjs,n,d}（实测无 s 字段），Date 序列化为 ISO 字符串
function reviver(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if (
            obj.mathjs === 'Fraction' &&
            typeof obj.n === 'number' &&
            typeof obj.d === 'number'
        ) {
            return fraction(obj as never);
        }
        if (typeof obj.updated === 'string') {
            obj.updated = new Date(obj.updated);
        }
    }
    return value;
}

export function loadSnapshot(): SnapshotData | null {
    const path = cachePath();
    if (!path || !existsSync(path)) return null;
    try {
        const parsed = JSON.parse(
            readFileSync(path, 'utf-8'),
            reviver,
        ) as SnapshotFile;
        if (parsed.version !== '1') return null;
        return parsed.sources;
    } catch (e) {
        console.error('[persistence] load failed:', e);
        return null;
    }
}

export function saveSnapshot(sources: SnapshotData): void {
    const path = cachePath();
    if (!path) return;
    const snapshot: SnapshotFile = {
        version: '1',
        savedAt: new Date().toISOString(),
        sources,
    };
    try {
        // 原子写：先写临时文件再 rename，避免进程被杀写坏快照
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
        renameSync(tmp, path);
    } catch (e) {
        console.error('[persistence] save failed:', e);
    }
}
