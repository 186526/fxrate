// shutdown Phase 2 子进程 fixture：构建与生产入口相同的应用（makeInstance + 全部 getter 注册），
// 但由 fixture 自己创建 http server 并显式绑定 127.0.0.1（全程不开放对外端口、不发任何外部请求），
// 请求处理复用 src/index.ts 默认导出的 raw handler（等价于 handlers.js NodePlatformAdapter 内部
// 的 handleRequest → respond → handleResponse 流程），并安装生产同款优雅停机（installShutdown）。
// 由测试 spawn（node --import tsx），FXRATE_CACHE_DIR 指向临时目录。
// PORT 未指定时绑定临时端口，实际端口与回环地址随 SHUTDOWN_CHILD_READY 一并打印。

import http from 'node:http';
import net from 'node:net';

import { rootRouter } from 'handlers.js';

import appHandler, { makeInstance, Manager } from '../../src/index';
import { installShutdown } from '../../src/shutdown';

const port = Number(process.env.PORT) || 0;

globalThis.App = await makeInstance(new rootRouter(), Manager);

const server = http.createServer((req, res) => {
    appHandler(req, res).catch((error: unknown) => {
        console.error('[shutdown-child] request handler error:', error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
    });
});

server.listen(port, '127.0.0.1', () => {
    const address = server.address() as net.AddressInfo;
    console.log(`SHUTDOWN_CHILD_READY ${address.port} ${address.address}`);
});

installShutdown(server, Manager);
