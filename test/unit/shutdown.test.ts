// shutdown baseline（Phase 0）：子进程启动真实服务入口（makeInstance + listen），
// 验证 harness 可探测到当前 SIGTERM 行为——已知缺陷（计划 §5.2）：信号只清定时器/写快照，
// 不关闭 HTTP listener，进程在 deadline 内不退出。Phase 2 修复后本文件改为断言
// 「SIGTERM 后停止接收并在 deadline 内优雅退出」。全程只访问 127.0.0.1，不访问公网。
// 每个 test 各自 spawn 独立子进程，无跨 test 状态依赖。

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = join(repoRoot, 'test', 'fixtures', 'shutdown-child.ts');

function getFreePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as net.AddressInfo;
            server.close(() => resolvePort(address.port));
        });
    });
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

interface StartedChild {
    child: ChildProcess;
    port: number;
    stdout: () => string;
    exited: () => boolean;
}

async function startChild(cacheDir: string): Promise<StartedChild> {
    const port = await getFreePort();
    let stdout = '';
    let exited = false;
    const child = spawn(process.execPath, ['--import', 'tsx', fixturePath], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: String(port),
            FXRATE_CACHE_DIR: cacheDir,
            LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    child.on('exit', () => {
        exited = true;
    });
    await waitFor(() => stdout.includes('SHUTDOWN_CHILD_READY'), 30000);
    return { child, port, stdout: () => stdout, exited: () => exited };
}

describe('shutdown baseline (Phase 0, offline)', () => {
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

    test('harness: child starts the real app and serves /info', async () => {
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

    test('baseline: SIGTERM does not close the listener within deadline (known Phase 2 bug)', async () => {
        const started = await startChild(cacheDir);
        try {
            started.child.kill('SIGTERM');
            await new Promise((resolveSleep) => setTimeout(resolveSleep, 1500));
            // 当前实现（§5.2）：SIGTERM 只清 timer + 写快照，不关闭 listener → 进程仍在。
            expect(started.exited()).toBe(false);
            const res = await httpGet(started.port, '/info');
            expect(res.status).toBe(200);
        } finally {
            await stopChild(started);
        }
    }, 30000);
});
