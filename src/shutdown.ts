import http from 'node:http';
import process from 'node:process';

import type fxmManager from './fxmManager';

// Phase 2 优雅停机：本地 HTTP 服务收到首次 SIGTERM/SIGINT 后按以下顺序收尾：
//   1) 停止接收新连接（server.close()，Node 会顺带关闭空闲 keep-alive 连接）；
//   2) 停掉所有数据源定时刷新并落盘汇率快照一次（Manager.stopAllInterval()——
//      先停调度器不再接新刷新，再等待在途刷新 settle，最后才写快照，不丢最后一批数据）；
//   3) 退出条件 = HTTP server 'close'（在途请求自然结束）**且** stopAllInterval 完成
//      （在途刷新 settle + 快照落盘）两者同时满足——任一先完成都不能单独 exit：
//      否则 server.close 在无在途请求时瞬间回调，会抢在快照落盘前 process.exit 丢数据；
//   4) 超时未结束则按可配置硬截止（SHUTDOWN_DEADLINE_MS，默认 10000ms）强制 exit 0；
//   5) 再次收到信号立即强制 exit 0（运维期望二次信号快速退出，不等在途请求）。
// 由 src/index.ts 本地入口安装；Vercel serverless 模式不走本地监听，无需停机处理。

export interface ShutdownOptions {
    /** 硬截止毫秒数；缺省读 SHUTDOWN_DEADLINE_MS 环境变量，再缺省 10000 */
    deadlineMs?: number;
}

export function installShutdown(
    server: http.Server,
    manager: fxmManager,
    options: ShutdownOptions = {},
): void {
    const deadlineMs =
        options.deadlineMs ??
        (Number(process.env.SHUTDOWN_DEADLINE_MS) || 10000);

    let shuttingDown = false;
    let exited = false;

    const forceExit = (code: number): void => {
        if (exited) return;
        exited = true;
        process.exit(code);
    };

    const shutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) {
            console.log(`[shutdown] received second ${signal}, forcing exit 0`);
            forceExit(0);
            return;
        }
        shuttingDown = true;
        console.log(
            `[shutdown] received ${signal}, stopping connections, saving snapshot, deadline ${deadlineMs}ms`,
        );

        // 退出条件：HTTP server 关闭（在途请求自然结束）与 stopAllInterval 完成
        // （在途刷新 settle + 快照落盘）两者都满足才 exit。任一单独完成都不能退出——
        // server.close 无在途请求时几乎瞬间回调，若此时直接 process.exit 会抢在
        // 快照落盘前结束进程，丢掉最后一批刷新数据（shutdown exit coordination）。
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            console.log(
                '[shutdown] HTTP server closed and snapshot saved, exiting 0',
            );
            forceExit(0);
        };

        // 可配置硬截止：覆盖 stopAllInterval 的在途刷新 drain 与在途请求等待，
        // 超时强制退出；unref：不因该定时器本身阻止进程自然退出，只作为兜底。
        const timer = setTimeout(() => {
            console.error(
                `[shutdown] hard deadline (${deadlineMs}ms) reached, forcing exit 0`,
            );
            forceExit(0);
        }, deadlineMs);
        timer.unref?.();

        void Promise.allSettled([
            // 停止接收新连接；在途请求结束后触发 'close' 回调
            new Promise<void>((resolveClose) => {
                server.close(() => resolveClose());
            }),
            // 停调度器（不再接新刷新）+ 等待在途刷新 settle 后落盘快照（不丢最后一批数据）
            manager.stopAllInterval(),
        ]).then(finish);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
