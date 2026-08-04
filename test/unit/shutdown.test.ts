// shutdown（Phase 2）：子进程启动真实服务入口（makeInstance + 默认 handler + installShutdown），
// 验证首次 SIGTERM/SIGINT 后：① 停止接收新连接（再连接返回 ECONNREFUSED）；② 等待在途请求
// 自然结束后进程以 0 退出；③ 超过可配置硬截止（SHUTDOWN_DEADLINE_MS）强制 exit 0。
// fixture 显式绑定 127.0.0.1 并打印实际监听地址，测试断言只监听回环地址、全程不访问公网。
// 每个 test 各自 spawn 独立子进程，无跨 test 状态依赖。

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CRITICAL_SOURCES } from '../../src/fxmManager';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = join(repoRoot, 'test', 'fixtures', 'shutdown-child.ts');

// Phase 7 readiness 语义：仅注册不算就绪，关键源须已加载有效数据。子进程的 Manager
// 冷启动时 loadSnapshot() 读回该快照 → 全部关键源 restore 为 ready 且新鲜（非 degraded），
// /info 才能 200 status=ok。
function seedSnapshot(cacheDir: string): void {
    const now = new Date().toISOString();
    const sources: Record<string, unknown> = {};
    for (const source of CRITICAL_SOURCES) {
        sources[source] = {
            USD: {
                CNY: {
                    middle: 7,
                    cash: 6.9,
                    remit: 6.95,
                    updated: now,
                },
            },
        };
    }
    writeFileSync(
        join(cacheDir, 'fxrate-cache.json'),
        JSON.stringify({ version: '1', savedAt: now, sources }),
        'utf-8',
    );
}

function httpGet(
    port: number,
    path: string,
): Promise<{ status: number; body: string }> {
    return new Promise((resolveResult, reject) => {
        const req = http.get(
            { host: '127.0.0.1', port, path, agent: false },
            (res) => {
                let body = '';
                res.setEncoding('utf-8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () =>
                    resolveResult({ status: res.statusCode ?? 0, body }),
                );
            },
        );
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    });
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor timed out');
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    }
}

// 打开一个「在途请求」连接：只写 HTTP 请求行 + 部分 header，不写完，
// 让 server.close() 认为仍有活动请求而等待它，从而可观察停机中间态。
function openPartialRequest(port: number): Promise<net.Socket> {
    return new Promise((resolveSocket, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
            socket.write('GET /info HTTP/1.1\r\nHost: localhost\r\n');
            resolveSocket(socket);
        });
        socket.on('error', reject);
    });
}

// 断言端口已拒绝新连接（server.close() 后 OS 不再接受新 TCP 连接）。
// 信号处理可能有一两 tick 延迟，故带重试；若始终可连接则超时失败。
async function expectConnectionRefused(
    port: number,
    timeoutMs = 3000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await new Promise<void>((resolveRefused, reject) => {
                const socket = net.connect({ host: '127.0.0.1', port });
                socket.once('connect', () => {
                    socket.destroy();
                    reject(new Error(`port ${port} still accepts connections`));
                });
                socket.once('error', (error: NodeJS.ErrnoException) => {
                    if (error.code === 'ECONNREFUSED') resolveRefused();
                    else reject(error);
                });
            });
            return;
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
        }
    }
}

async function waitForExit(
    started: StartedChild,
    timeoutMs: number,
): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (!started.exited()) {
        if (Date.now() > deadline) {
            throw new Error('process did not exit in time');
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    }
    return started.child.exitCode;
}

interface StartedChild {
    child: ChildProcess;
    port: number;
    stdout: () => string;
    exited: () => boolean;
}

async function startChild(
    cacheDir: string,
    extraEnv: Record<string, string> = {},
): Promise<StartedChild> {
    seedSnapshot(cacheDir);
    let stdout = '';
    let exited = false;
    const child = spawn(process.execPath, ['--import', 'tsx', fixturePath], {
        cwd: repoRoot,
        env: {
            ...process.env,
            FXRATE_CACHE_DIR: cacheDir,
            LOG_LEVEL: 'error',
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    child.on('exit', () => {
        exited = true;
    });
    await waitFor(() => /SHUTDOWN_CHILD_READY \d+ \S+/.test(stdout), 30000);
    const match = /SHUTDOWN_CHILD_READY (\d+) (\S+)/.exec(stdout);
    const port = Number(match?.[1]);
    const address = match?.[2];
    // 只绑定回环地址：全程不开放对外端口、不访问公网
    expect(address).toBe('127.0.0.1');
    return { child, port, stdout: () => stdout, exited: () => exited };
}

describe('shutdown (Phase 2, offline, loopback-only)', () => {
    let cacheDir: string;

    beforeAll(() => {
        cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-shutdown-'));
    });

    afterAll(() => {
        rmSync(cacheDir, { recursive: true, force: true });
    });

    async function stopChild(started: StartedChild): Promise<void> {
        if (!started.exited()) {
            started.child.kill('SIGKILL');
            await new Promise<void>((resolveKill) => {
                if (started.exited()) return resolveKill();
                const timer = setTimeout(resolveKill, 5000);
                timer.unref?.();
                started.child.once('exit', () => {
                    clearTimeout(timer);
                    resolveKill();
                });
            });
        }
    }

    test('harness: child starts the real app on 127.0.0.1 and serves /info', async () => {
        const started = await startChild(cacheDir);
        try {
            const res = await httpGet(started.port, '/info');
            expect(res.status).toBe(200);
            const body = JSON.parse(res.body) as { status?: string };
            expect(body.status).toBe('ok');
        } finally {
            await stopChild(started);
        }
    }, 60000);

    test('SIGTERM: listener rejects new connections, exits 0 after in-flight drain', async () => {
        const started = await startChild(cacheDir, {
            SHUTDOWN_DEADLINE_MS: '20000',
        });
        const inflight = await openPartialRequest(started.port);
        try {
            started.child.kill('SIGTERM');
            // 有在途连接时 server.close() 不会立刻触发 'close'，进程应仍在（deadline 20s 远未到）
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
            expect(started.exited()).toBe(false);
            // 新连接必须被拒绝（listener 已停止接收）
            await expectConnectionRefused(started.port);
            // 放行在途请求 → server 'close' → 进程以 0 退出。
            // 若优雅关闭失效，进程要等到 20s 硬截止才退出，8s 的 waitForExit 会先超时失败。
            inflight.destroy();
            const code = await waitForExit(started, 8000);
            expect(code).toBe(0);
            await expectConnectionRefused(started.port);
        } finally {
            inflight.destroy();
            await stopChild(started);
        }
    }, 30000);

    test('SIGTERM: process stays alive until both server.close and stopAllInterval finish', async () => {
        // 原阻断时序：无在途连接时 server.close() 几乎瞬间完成，而 stopAllInterval
        // （在途刷新 drain + 快照落盘）仍在进行——此时必须等待两者都完成才能退出，
        // 否则会在快照落盘前 process.exit 丢数据。fixture 用 SHUTDOWN_STOP_DELAY_MS
        // 注入 1500ms 的慢侧；deadline 20s 远大于延迟，不会被兜底提前退出。
        const started = await startChild(cacheDir, {
            SHUTDOWN_DEADLINE_MS: '20000',
            SHUTDOWN_STOP_DELAY_MS: '1500',
        });
        try {
            started.child.kill('SIGTERM');
            // server.close 无在途连接会立刻回调，但 stopAllInterval 被延迟 1500ms，
            // 700ms 处进程必须仍存活（若 coordination 缺失早已 exit 0）。
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 700));
            expect(started.exited()).toBe(false);
            // 延迟结束后 stopAllInterval 完成 → 两者都满足 → 进程以 0 退出。
            const code = await waitForExit(started, 8000);
            expect(code).toBe(0);
        } finally {
            await stopChild(started);
        }
    }, 30000);

    test('SIGTERM: configurable hard deadline forces exit 0 with in-flight connection', async () => {
        const deadlineMs = 800;
        const started = await startChild(cacheDir, {
            SHUTDOWN_DEADLINE_MS: String(deadlineMs),
        });
        const inflight = await openPartialRequest(started.port);
        const signalledAt = Date.now();
        try {
            started.child.kill('SIGTERM');
            // 在途连接未放行，deadline 未到 → 进程不应立刻退出
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
            expect(started.exited()).toBe(false);
            const code = await waitForExit(started, 10000);
            expect(code).toBe(0);
            const elapsed = Date.now() - signalledAt;
            // 不是等 close（连接一直开着），而是被 ~deadline 兜底强制退出
            expect(elapsed).toBeGreaterThan(deadlineMs - 200);
            expect(elapsed).toBeLessThan(5000);
            await expectConnectionRefused(started.port);
        } finally {
            inflight.destroy();
            await stopChild(started);
        }
    }, 30000);

    test('SIGINT: process exits 0 within deadline', async () => {
        const started = await startChild(cacheDir);
        try {
            started.child.kill('SIGINT');
            const code = await waitForExit(started, 10000);
            expect(code).toBe(0);
            await expectConnectionRefused(started.port);
        } finally {
            await stopChild(started);
        }
    }, 30000);
});
