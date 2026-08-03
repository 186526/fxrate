import http from 'node:http';
import process from 'node:process';

import type fxmManager from './fxmManager';

// Phase 2 优雅停机：本地 HTTP 服务收到首次 SIGTERM/SIGINT 后按以下顺序收尾：
//   1) 停止接收新连接（server.close()，Node 会顺带关闭空闲 keep-alive 连接）；
//   2) 停掉所有数据源定时刷新并落盘汇率快照一次（Manager.stopAllInterval()）；
//   3) 等待在途请求自然结束后（server 'close' 事件）以 0 退出；
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

        // 停定时器 + 快照落盘（stopAllInterval 同时做两件事，全程仅调用一次 → flush once）
        manager.stopAllInterval();

        // 停止接收新连接；在途请求结束后触发 'close'，随即退出
        server.close(() => {
            console.log('[shutdown] HTTP server closed, exiting 0');
            forceExit(0);
        });

        // 可配置硬截止：deadline 内未自然结束（如某个在途请求挂死）则强制退出。
        // unref：不因该定时器本身阻止进程自然退出，只作为兜底。
        const timer = setTimeout(() => {
            console.error(
                `[shutdown] hard deadline (${deadlineMs}ms) reached, forcing exit 0`,
            );
            forceExit(0);
        }, deadlineMs);
        timer.unref?.();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
