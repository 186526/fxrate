// shutdown baseline 子进程 fixture：与生产入口相同的启动路径（makeInstance + listen）。
// 由测试 spawn（node --import tsx），FXRATE_CACHE_DIR 指向临时目录；
// 只监听本机指定端口，不发起任何外部请求。

import { makeInstance, Manager } from '../../src/index';
import { rootRouter } from 'handlers.js';

const port = Number(process.env.PORT) || 18080;

const app = await makeInstance(new rootRouter(), Manager);
app.listen(port);
console.log(`SHUTDOWN_CHILD_READY ${port}`);
