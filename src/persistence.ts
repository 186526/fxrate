import { create, all } from 'mathjs';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FXRateType } from './fxm/fxManager';

// 汇率快照持久化：冷启动从本地 JSON 直接加载内存汇率表，
// 跳过懒加载的上游全量抓取（Visa 等慢源首访可达 30s+）。
// Vercel serverless（只读 FS 无持久性）下自动禁用。
const math = create(all, { number: 'Fraction' });
const { fraction } = math;

export interface SourceRates {
    [from: string]: { [to: string]: FXRateType };
}

export interface SnapshotData {
    [source: string]: SourceRates;
}

interface SnapshotFile {
    version: string;
    savedAt: string;
    sources: SnapshotData;
}

export const SNAPSHOT_VERSION = '1';
export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// 快照字节上限（读文件前检查）：磁盘上被塞一个超大 JSON 时，JSON.parse 阶段
// 可能耗尽内存/CPU——读前用 statSync 的 size 预检即可拦截。默认 32 MiB，
// 可被 FXRATE_SNAPSHOT_MAX_BYTES 覆盖。
export const DEFAULT_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;

// 允许的未来时钟偏差：savedAt / rate.updated 晚于 now + 该值时视为伪造/损坏快照
// 整包拒绝。默认 5 分钟，可被 FXRATE_SNAPSHOT_FUTURE_SKEW_MS 覆盖。
export const DEFAULT_SNAPSHOT_FUTURE_SKEW_MS = 5 * 60 * 1000;

// 快照源数量上限：合法注册源约 60 个，200 已足够；防止任意数量的 key 被注入内存。
export const MAX_SNAPSHOT_SOURCES = 200;

// 快照整体最大年龄：savedAt 早于 now - maxAge 视为过期整包丢弃（冷启动重新走懒加载抓取）。
// 默认 24h，可被 FXRATE_SNAPSHOT_MAX_AGE_MS 覆盖。
export function snapshotMaxAgeMs(): number {
    const raw = process.env.FXRATE_SNAPSHOT_MAX_AGE_MS;
    if (raw === undefined) return DEFAULT_SNAPSHOT_MAX_AGE_MS;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_SNAPSHOT_MAX_AGE_MS;
}

// 快照字节上限：读文件前用文件 size 预检，超限整包拒绝（防 JSON.parse 阶段耗尽资源）。
export function snapshotMaxBytes(): number {
    const raw = process.env.FXRATE_SNAPSHOT_MAX_BYTES;
    if (raw === undefined) return DEFAULT_SNAPSHOT_MAX_BYTES;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0
        ? value
        : DEFAULT_SNAPSHOT_MAX_BYTES;
}

// 允许的未来时钟偏差（savedAt / rate.updated 晚于 now + 该值 → 整包拒绝）。
export function snapshotFutureSkewMs(): number {
    const raw = process.env.FXRATE_SNAPSHOT_FUTURE_SKEW_MS;
    if (raw === undefined) return DEFAULT_SNAPSHOT_FUTURE_SKEW_MS;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0
        ? value
        : DEFAULT_SNAPSHOT_FUTURE_SKEW_MS;
}

// 单源降级阈值：恢复时若该源最新一条汇率的 updated 早于 now - 阈值则标记 degraded
// （Cache-Control max-age=0，不再伪装新鲜度）。自身 env（FXRATE_STALE_RATE_AGE_MS）
// 未设置（或非法）时跟随 snapshotMaxAgeMs()——即「只有比整个快照接受窗口还老的
// 源数据才算退化」，保证 FXRATE_SNAPSHOT_MAX_AGE_MS 放宽时降级阈值同步放宽。
export function staleRateAgeMs(): number {
    const raw = process.env.FXRATE_STALE_RATE_AGE_MS;
    if (raw !== undefined) {
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return snapshotMaxAgeMs();
}

// 某 source 快照中最新一条合法汇率的 updated 时间；无任何合法记录返回 null。
// invalid Date 不参与；1970 自报价（selfRate）时间戳极早，有真实数据时永远不会成为最大值。
export function latestUpdatedAt(source: SourceRates): Date | null {
    let latest: Date | null = null;
    for (const from in source) {
        const node = source[from];
        for (const to in node) {
            const updated = node[to]?.updated;
            if (!(updated instanceof Date)) continue;
            if (Number.isNaN(updated.getTime())) continue;
            if (latest === null || updated.getTime() > latest.getTime()) {
                latest = updated;
            }
        }
    }
    return latest;
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

// 供异步快照 writer 在构造期一次性解析缓存文件路径（与同步 saveSnapshot 的
// cachePath() 同规则：VERCEL=1 或目录不可用 → null，此时 writer 整体禁用）。
export function snapshotCachePath(): string | null {
    return cachePath();
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

export interface LoadSnapshotOptions {
    /** 快照最大年龄（毫秒），显式覆盖环境变量（测试用）。 */
    maxAgeMs?: number;
    /** 当前时间（epoch ms），可注入假时钟（测试用）。 */
    now?: number;
    /** 快照字节上限，显式覆盖环境变量（测试用）。 */
    maxBytes?: number;
    /** 允许的未来时钟偏差（毫秒），显式覆盖环境变量（测试用）。 */
    futureSkewMs?: number;
}

// 单格报价合法性：与 fxManager.validateFXRate 的契约一致（有限正数或 s>0 的 Fraction）。
// 快照 restore 直接替换内存汇率表引用，任何畸形值都必须在此被拒绝，不能进内存。
const isValidQuote = (value: unknown): boolean => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    return (
        math.isFraction(value) &&
        (value as { s: number; n: number }).s > 0 &&
        (value as { s: number; n: number }).n > 0
    );
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

// 严格快照结构校验：顶层 sources 必须是普通对象、源数量有上限、货币代码必须
// 是 3 位大写字母、每个单元格必须含合法的 middle/cash/remit（有限正数或 Fraction）
// 与合法 updated（Date 且不超未来时钟偏差）。任何一条不满足都抛错（整包拒绝），
// 复用 fxManager 的 validate 契约，绝不让任意对象替换内存汇率表。
function validateSnapshot(
    sources: unknown,
    options: { now: number; futureSkewMs: number },
): asserts sources is SnapshotData {
    if (!isPlainObject(sources)) {
        throw new Error('snapshot sources must be a plain object');
    }
    const sourceNames = Object.keys(sources);
    if (sourceNames.length > MAX_SNAPSHOT_SOURCES) {
        throw new Error(
            `snapshot has ${sourceNames.length} sources, exceeding limit ${MAX_SNAPSHOT_SOURCES}`,
        );
    }
    for (const source of sourceNames) {
        const node = sources[source];
        if (!isPlainObject(node)) {
            throw new Error(`snapshot source ${source} must be a plain object`);
        }
        for (const from of Object.keys(node)) {
            if (!/^[A-Z]{3}$/.test(from)) {
                throw new Error(
                    `snapshot source ${source} has invalid from currency "${from}"`,
                );
            }
            const fromNode = node[from];
            if (!isPlainObject(fromNode)) {
                throw new Error(
                    `snapshot source ${source} "${from}" must be a plain object`,
                );
            }
            for (const to of Object.keys(fromNode)) {
                if (!/^[A-Z]{3}$/.test(to)) {
                    throw new Error(
                        `snapshot source ${source} has invalid to currency "${to}"`,
                    );
                }
                const cell = fromNode[to];
                if (!isPlainObject(cell)) {
                    throw new Error(
                        `snapshot source ${source} ${from}/${to} cell must be a plain object`,
                    );
                }
                const { middle, cash, remit, updated } = cell;
                if (!isValidQuote(middle)) {
                    throw new Error(
                        `snapshot source ${source} ${from}/${to} has invalid middle quote`,
                    );
                }
                if (!isValidQuote(cash)) {
                    throw new Error(
                        `snapshot source ${source} ${from}/${to} has invalid cash quote`,
                    );
                }
                if (!isValidQuote(remit)) {
                    throw new Error(
                        `snapshot source ${source} ${from}/${to} has invalid remit quote`,
                    );
                }
                if (
                    !(updated instanceof Date) ||
                    Number.isNaN(updated.getTime())
                ) {
                    throw new Error(
                        `snapshot source ${source} ${from}/${to} has invalid updated`,
                    );
                }
                if (updated.getTime() - options.now > options.futureSkewMs) {
                    throw new Error(
                        `snapshot source ${source} ${from}/${to} updated too far in the future (${updated.toISOString()})`,
                    );
                }
            }
        }
    }
}

export function loadSnapshot(
    options: LoadSnapshotOptions = {},
): SnapshotData | null {
    const path = cachePath();
    if (!path || !existsSync(path)) return null;
    try {
        // 读前字节上限：文件 size 超限直接拒绝（不进入 JSON.parse，防资源耗尽）。
        const maxBytes = options.maxBytes ?? snapshotMaxBytes();
        if (statSync(path).size > maxBytes) {
            console.error(
                `[persistence] snapshot too large (limit ${maxBytes} bytes), ignoring`,
            );
            return null;
        }
        const parsed = JSON.parse(
            readFileSync(path, 'utf-8'),
            reviver,
        ) as unknown;
        if (!isPlainObject(parsed)) {
            console.error(
                '[persistence] snapshot must be a JSON object, ignoring',
            );
            return null;
        }
        const snapshot = parsed as unknown as SnapshotFile;
        if (snapshot.version !== SNAPSHOT_VERSION) {
            console.error(
                `[persistence] snapshot version mismatch (${String(snapshot.version)}), ignoring`,
            );
            return null;
        }
        // savedAt 校验：非字符串 / 非法日期 / 超过最大年龄 / 超过未来时钟偏差 →
        // 整包忽略（走冷启动懒加载抓取），避免把停机前的旧汇率当作「刚刷新」恢复。
        if (typeof snapshot.savedAt !== 'string') {
            console.error(
                '[persistence] snapshot has non-string savedAt, ignoring',
            );
            return null;
        }
        const savedAt = new Date(snapshot.savedAt);
        if (Number.isNaN(savedAt.getTime())) {
            console.error(
                '[persistence] snapshot has invalid savedAt, ignoring',
            );
            return null;
        }
        const maxAgeMs = options.maxAgeMs ?? snapshotMaxAgeMs();
        const now = options.now ?? Date.now();
        if (now - savedAt.getTime() > maxAgeMs) {
            console.error(
                `[persistence] snapshot too old (savedAt ${snapshot.savedAt}, age ${Math.round((now - savedAt.getTime()) / 1000)}s > maxAge ${maxAgeMs}ms), ignoring`,
            );
            return null;
        }
        const futureSkewMs = options.futureSkewMs ?? snapshotFutureSkewMs();
        if (savedAt.getTime() - now > futureSkewMs) {
            console.error(
                `[persistence] snapshot savedAt too far in the future (${snapshot.savedAt}), ignoring`,
            );
            return null;
        }
        // 严格结构校验：畸形/超大/注入任意对象 → 整包拒绝（不 restore 进内存）。
        try {
            validateSnapshot(snapshot.sources, { now, futureSkewMs });
        } catch (e) {
            console.error('[persistence] snapshot validation failed:', e);
            return null;
        }
        return snapshot.sources;
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

// 异步原子写（供 throttled SnapshotWriter 后台路径使用）：fs/promises + 唯一
// 临时文件名 + 同目录 rename。失败保留上一份有效文件，尽力清理临时文件，
// 记录错误后向上抛（调用方决定重试/忽略）。explicitPath 注入测试用路径；
// 默认走 cachePath()（VERCEL/目录不可用 → null 时静默跳过）。
let asyncTempSequence = 0;

export async function saveSnapshotAsync(
    sources: SnapshotData,
    explicitPath?: string | null,
): Promise<void> {
    const path = explicitPath !== undefined ? explicitPath : cachePath();
    if (!path) return;
    const snapshot: SnapshotFile = {
        version: SNAPSHOT_VERSION,
        savedAt: new Date().toISOString(),
        sources,
    };
    const tmp = `${path}.${process.pid}.${Date.now()}.${asyncTempSequence++}.tmp`;
    try {
        // 与同步 saveSnapshot 的 cachePath() 等价：写前确保目录存在
        // （缓存目录被删/未挂载时写前重建，避免陈旧预解析路径 ENOENT）。
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, JSON.stringify(snapshot), 'utf-8');
        await rename(tmp, path);
    } catch (e) {
        console.error('[persistence] async save failed:', e);
        try {
            await rm(tmp, { force: true });
        } catch (cleanupError) {
            console.error(
                '[persistence] async save temporary file cleanup failed:',
                cleanupError,
            );
        }
        throw e;
    }
}
