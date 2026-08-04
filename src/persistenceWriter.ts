// 节流异步快照 writer（Phase 5 优化 #8）：把持久化移出请求/信号关键路径。
// 每个 fxmManager 拥有一个实例：成功刷新仅做 O(1) 的 enqueue（置脏 + 重置
// trailing 定时器），stringify/write/rename 全部发生在后台 drain 循环，与
// 请求 handler、信号回调零交叠。写入串行化（同一时刻至多一个在途写）；
// 写期间再入队则 dirty 置位，当前写完成后立即补写一次（不丢最新状态）。
// 快照数据经惰性 producer 在写时读取 → newest-wins，停机 flush 即「重 dump」。
// flush 只排队：drain 经 defer 推迟到事件循环下一轮，producer/序列化/写盘
// 绝不在调用方（信号/请求）栈内执行。首次落盘恒写（停机空快照也 dump 一次），
// 之后的顺序空闲 flush 为 no-op（幂等）；写失败保留 dirty 供后续显式
// flush/enqueue 重试并退出当前 drain（避免失败风暴）。
import type { SnapshotData } from './persistence';
import { saveSnapshotAsync, snapshotCachePath } from './persistence';

export const DEFAULT_SNAPSHOT_THROTTLE_MS = 1000;

// trailing 窗口毫秒数：FXRATE_SNAPSHOT_THROTTLE_MS 只接受正整数，非法/未设回落默认 1000。
export function snapshotThrottleMs(): number {
    const raw = process.env.FXRATE_SNAPSHOT_THROTTLE_MS;
    if (raw === undefined) return DEFAULT_SNAPSHOT_THROTTLE_MS;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0
        ? value
        : DEFAULT_SNAPSHOT_THROTTLE_MS;
}

export interface SnapshotWriterOptions {
    /** trailing 节流窗口（毫秒）；默认读 FXRATE_SNAPSHOT_THROTTLE_MS */
    throttleMs?: number;
    /** 缓存文件路径；null 禁用 writer（VERCEL/只读 FS）。缺省读 snapshotCachePath() */
    path?: string | null;
    /** 快照数据惰性生产者：写时调用（newest-wins），flush 时重新 dump */
    producer?: () => SnapshotData;
    /** 落盘函数（默认 saveSnapshotAsync）；测试可注入故障 */
    save?: (sources: SnapshotData) => Promise<void>;
    /** 后台写排入事件循环的延迟器（默认 setImmediate）：flush 只排队，producer/
     *  stringify/write 在下一轮执行；测试可注入确定性控制 */
    defer?: (fn: () => void) => void;
    /** 定时器创建（默认 setTimeout + unref）；测试可注入 fake timer */
    setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
    /** 定时器取消（默认 clearTimeout） */
    clearTimer?: (timer: NodeJS.Timeout) => void;
}

const defaultSetTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
};

const defaultClearTimer = (timer: NodeJS.Timeout): void => {
    clearTimeout(timer);
};

const defaultDefer = (fn: () => void): void => {
    setImmediate(fn);
};

const EMPTY_SNAPSHOT: SnapshotData = {};

export class SnapshotWriter {
    private readonly path: string | null;
    private readonly producer: () => SnapshotData;
    private readonly save: (sources: SnapshotData) => Promise<void>;
    private readonly defer: (fn: () => void) => void;
    private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
    private readonly clearTimer: (timer: NodeJS.Timeout) => void;
    private readonly throttleMs: number;

    private dirty = false;
    private writtenOnce = false;
    private stopped = false;
    private timer: NodeJS.Timeout | null = null;
    private inFlight: Promise<void> | null = null;

    constructor(options: SnapshotWriterOptions = {}) {
        this.path =
            options.path !== undefined ? options.path : snapshotCachePath();
        this.producer = options.producer ?? (() => EMPTY_SNAPSHOT);
        this.save =
            options.save ??
            ((sources) => saveSnapshotAsync(sources, this.path));
        this.defer = options.defer ?? defaultDefer;
        this.setTimer = options.setTimer ?? defaultSetTimer;
        this.clearTimer = options.clearTimer ?? defaultClearTimer;
        this.throttleMs = options.throttleMs ?? snapshotThrottleMs();
    }

    /** 是否落盘启用：path 为 null（VERCEL/只读 FS/目录不可用）时整体 no-op */
    public get enabled(): boolean {
        return this.path !== null;
    }

    /** 是否有未落盘（已入队、写失败待重试或正在在途写）状态 */
    public get pending(): boolean {
        return this.dirty || this.inFlight !== null;
    }

    // O(1) 入队：只置脏并（重）排 trailing 定时器，不触碰快照数据本身。
    // 窗口内任意多次 enqueue 收敛为一次写；若写已在途，dirty 交给 drain 循环补写。
    public enqueue(): void {
        if (!this.enabled || this.stopped) return;
        this.dirty = true;
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = this.setTimer(() => {
            this.timer = null;
            void this.flush();
        }, this.throttleMs);
    }

    // 幂等 flush：取消待发定时器，与在途 drain 合并（并发调用共享同一次写）。
    // 只排队——drain 经 defer 推迟到事件循环下一轮才读取 producer 并落盘，
    // producer/stringify/write 绝不占用调用方（信号/请求）栈。首次调用恒执行
    // 一次完整重 dump（停机「flush re-dumps after drain」）；之后若既无入队
    // 也无待重试的失败写，则直接完成（顺序空闲 flush 不重复写）。永不 reject。
    public flush(): Promise<void> {
        if (!this.enabled) return Promise.resolve();
        if (this.timer !== null) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        if (this.inFlight !== null) return this.inFlight;
        const loop = new Promise<void>((resolve) => {
            this.defer(() => {
                void this.drainLoop().then(() => resolve());
            });
        });
        this.inFlight = loop;
        void loop.finally(() => {
            if (this.inFlight === loop) this.inFlight = null;
        });
        return loop;
    }

    // 停机后调用：取消定时器并停止后续调度（enqueue 变 no-op）。幂等。
    public stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.timer !== null) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
    }

    // 串行写循环：首次落盘或 dirty 时执行写；写期间再次 enqueue 会把 dirty
    // 重新置位 → 立即补写。写失败保留 dirty（后续显式 flush/enqueue 可重试）
    // 并退出循环，避免失败风暴/无限重试。退出时清掉已被消费的多余定时器；
    // 失败退出（dirty 仍置位）则保留写期间入队的定时器作为重试机会。
    private async drainLoop(): Promise<void> {
        while (this.dirty || !this.writtenOnce) {
            this.dirty = false;
            const ok = await this.writeCurrentSnapshot();
            if (!ok) {
                this.dirty = true;
                break;
            }
            this.writtenOnce = true;
        }
        if (this.timer !== null && !this.dirty) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
    }

    // 后台写：stringify 前的快照读取与落盘全部在此隔离，任何异常只记录日志，
    // 返回成败供 drain 判定（失败保留 dirty，不把源标记为未更新/不清除待写）。
    private async writeCurrentSnapshot(): Promise<boolean> {
        try {
            await this.save(this.producer());
            return true;
        } catch (error) {
            console.error('[persistence-writer] snapshot write failed:', error);
            return false;
        }
    }
}
