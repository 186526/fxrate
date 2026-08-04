# AGENTS.md

## 项目概览

fxrate 是一个外汇汇率数据服务（后端），聚合约 50 家银行/平台（中国银行、工行、建行、招行、汇丰、MasterCard、Visa、Wise 等）的实时买卖价与中间价，对外提供 **REST API v1**、**JSON-RPC v2**（`handlers.js-jsonrpc`）和 **RSS/Atom**（`/rss/:from/:to`）三种接口。汇率数据版权归各来源所有（见 `LICENSE.DATA`）。

前端配套仓库为 [186526/fxrate-web](https://github.com/186526/fxrate-web)，本仓库以 submodule 形式被其引用。

技术栈：TypeScript（**ESM**，`"type": "module"`）+ 自研框架 [handlers.js](https://github.com/)（路由/中间件）+ `mathjs` Fraction 高精度计算 + `axios`/`cheerio`/`fast-xml-parser`（抓取） + `playwright-core`（可选，Visa 反爬降级用） + `esbuild`（打包）+ `jest`/`ts-jest`（测试）。

## 目录结构

```
src/
  index.ts           # 入口：注册全部 getter/FXM 到 fxmManager，绑定 handlers.js 路由，Vercel/本地监听
  fxmManager.ts      # 核心：JSON-RPC 方法 + 每数据源的 REST 子路由 + 定时刷新（经 RefreshScheduler）+ 懒加载
  metrics.ts         # Phase 6 零依赖 Prometheus registry：固定 family、转义/有界标签、运行时计数与耗时
  shutdownMetricsPersistence.ts # 停机 summary 的独立有界文件持久化（跨重启供 Prometheus pull）
  persistenceWriter.ts      # Phase 5 节流异步快照 writer：O(1) enqueue + trailing 节流 + 串行后台落盘 + 停机 flush
  refreshScheduler.ts# Phase 2 全局刷新调度器：稳定相位抖动 + BoundedExecutor 有界并发 + NegativeBackoffCache 失败退避
  fxm/fxManager.ts   # 汇率存储/换算：Fraction 精度、双向汇率、BFS 找兑换路径、CNY/CNH 别名
  FXGetter/          # 每个数据源一个文件：getter 函数（返回 FXRate[]）或 FXM 类（如 mastercard/visa）
  client/index.ts    # 给前端用的 JSON-RPC client（支持 batch 批量请求）
  handler/rss.ts     # RSS/Atom feed
  handler/limits.ts  # Phase 1 RPC 入口硬限制：受限 body 读取（256 KiB）+ JSON-RPC v2 批量/昂贵条目预算
  handler/rest.ts    # 内部 REST 工具（useInternalRestAPI / useJson / bodyToString 等）
  types.d.ts         # currency 枚举、FXRate、FXPath、JSONRPCMethods
  constant.ts        # sourceNamesInZH：数据源英文名 → 中文名
test/                # jest 测试（会真实请求各数据源，注意网络依赖与超时）
dist/                # 构建产物（esbuild 输出 dist/index.cjs），commit 进仓库供 Vercel/pm2 部署
```

## 核心机制

-   **汇率方向与精度**：`fxRateList[from][to]` 表示「1 单位 from = X 单位 to」，值为 `rate.middle / unit`（`unit` 为源报价单位，如日元 100）；反向汇率默认是倒数，`update()` 时双向写入。若 getter 上报 `oneWay: true`，则只写入 `from → to`，不生成反向边（用于支付宝境外消费等只有单向业务语义的结算汇率），反向直连与 BFS 均不会经过该源。所有计算用 `mathjs` Fraction，输出时按 `?precision`（默认 5）`round`。
-   **缺失字段补全**（`fxManager.update()`）：getter 常把 buy/sell 初始化为空对象 `{}`（truthy），所以按字段值判断——`hasBuy = !!(rate.buy?.cash || rate.buy?.remit)`、`hasSell` 同理；无买卖价 → 用中间价；缺 buy → 复制 sell；缺 sell → 复制 buy；缺中间价 → (min+max)/2 估算（缺失项按 ±Infinity 参与）；输出时单项回落顺序 现金价→汇价→中间价（`rate.buy?.cash ?? rate.buy?.remit ?? rate.middle` 等 4 个）；`RMB` 归一为 `CNY`；`CNH` 与 `CNY` 互为别名。
-   **严格输入校验与原子提交**（`fxManager.update()`，Phase 3）：`validateFXRate` 在触碰 `_fxRateList` 前校验——`unit` 必须有限正数、各报价（buy/sell cash/remit、middle）存在时必须是有限正数（number 或 mathjs Fraction）、`updated` 必须是合法 `Date`（非 Invalid Date）、货币代码必须是 3 位大写字母（`^[A-Z]{3}$`，ISO 风格，兼容 ECB 等源上报的枚举外代码如 BGN/ISK）。**update 为原子提交**：所有正/反向 middle/cash/remit 先在本地结构（含 CNY/CNH 别名解析，写路径与 `fxRateList` Proxy get trap 同规则）计算完成，最后一次性 `this._fxRateList = next` 替换——任何异常（如非法输入、Fraction 转换失败）都发生在提交之前，快照与调用前 deep-equal（无部分写入）。契约测试见 `test/unit/fx-manager-atomic.test.ts`。
-   **兑换路径**：`convert()` 先 `getFXPath()` 用 BFS 在汇率图上找中间货币路径，再逐段换算；`reverse` 则反转路径（把结果换算成所需本币）。无路径时报 `No FX path found`。**BFS 默认关闭**：`getFXPath(from, to, allowBFS=false)` 仅当调用方显式传 `?bfs=1` 时才启用（交叉汇率有累积误差）；`?bfs=1` 时 `getDetails` 回传 `result.path`（实际经过的货币路径，如 `["USD","HKD","JPY"]`，直连时返回直连对）。**BFS 无直连也折算三价**：`getDetails` 用 `hasPath`（路径存在）判定价格计算，无直连报价但 BFS 可达时同样输出 `cash/remit/middle`（不再因 `rate undefined` 跳过，2026-08 Phase 7 修复）。**BFS 多段路径的 `updated`**：取路径上所有相邻边 updated 的最小值（最旧）——交叉汇率是多段折算，任一段陈旧都代表整条路径陈旧；直连（含别名直连，path 长度 1）保持自身 updated。实现为 `fxManager.getPathUpdatedDate(path)`（边读取走 `fxRateList` Proxy，CNY/CNH 别名目标同样正确解析），`getDetails` 的 bfs 分支在 path 长度 > 1 时覆写 `result.updated`（2026-08 Phase 3 修复，修复前 BFS 无直连边时 updated 回落为服务器当前时间）。**CNY/CNH 别名**：`update()` 只写入 getter 上报的货币（如 DBS/OCBC 只有 CNH 无 CNY），直连判断走 Proxy `get` 有别名 fallback，但 **BFS 的邻居枚举走 `Object.keys`（ownKeys）不做别名归一**——`getFXPath` 内须自行用 `isAlias` 判断 CNH↔CNY 等价（否则「目标 CNY 但图里只有 CNH」时反向找不到路径，2026-08 实测修复）；命中别名时路径末节点归一为目标货币，且 `result.alias` 记录实际别名货币（如 `CNH`），REST 响应同时设 `X-FXRate-Alias: CNH` header 供前端提示「经 CNH 折算」。四种 from/to 组合（CNY→CNH、CNH→CNY、CNY→CNY、CNH→CNH）均能解析，测试见 `test/unit/fx-manager-bfs.test.ts`。
-   **RSS/Atom（`/rss/:from/:to`）**：`src/handler/rss.ts` 每源请求两侧——买入侧走 `${to}/${from}`（`getDetails(to, from)`，银行买入 `to` 货币价，如 100 USD = 695 CNY），卖出侧走 `${from}/${to}`（`getDetails(from, to)` = 1/卖出价，如 100 CNY = 14.08 USD）。**卖出侧勿加 `&reverse`**：`reverse` 会把路径反转回 to→from（与买入请求等价），非对称点差下买卖价会完全相同（2026-08 Phase 3 修复）；测试见 `test/unit/rss-buy-sell.test.ts`。
-   **两类数据源**：
    -   `registerGetter(source, getter)`：抓取型，首次访问时懒更新（`pending` → `ready`），随后定时刷新统一交给 `RefreshScheduler`（见下），`intervalIDs` 保留 `refreshDate`（Cache-Control 用）与当前定时器句柄，`stopAllInterval()` 停调度器并落盘快照。
    -   `registerFXM(source, fxm)`：惰性 FXM 类（mastercard/visa），继承 `fxManager` 并覆写 `fxRateList` getter 为 Proxy（**懒构建一次缓存矩阵**，Proxy 仅作 LRU cache 的同步读取器，cache miss 返回 undefined），网络请求统一走覆写的 async `getfxRateList()` 预热缓存，`getUpdatedDate` 也覆写为 async 路径；`ableToGetAllFXRate = false`（不支持 `/v1/:source/:from` 全表接口，返回 403）。mastercard/visa 的取数实现（2026-08 实测）：
        -   **mastercard**：新版 public API `marketingservices/public/mccom-services/currency-conversions/conversion-rates`（旧 `settlement/currencyrate` 已 301 迁移），**必须用 Node 原生 fetch**（undici TLS/HTTP2 指纹）——axios/curl 被 Akamai 403；请求方向 `transaction_currency=${to}&cardholder_billing_currency=${from}`（沿用旧语义，返回「1 to = X from」，Proxy 取倒数）；每日发布一次，当天未发布返回 401，从 UTC 今天向前最多回退 7 天。
        -   **visa**：`visa.co.in/cmsapi/fx/rates`（**印度域名 WAF 最宽松**，visa.com/co.uk 被 Cloudflare 拦）；请求 `fromCurr=${to}&toCurr=${from}`（API 参数相对 UI 反转），响应 `originalValues.fxRateVisa` 即「1 from = X to」（**勿取倒数**，曾写反）；原生 fetch 可能 403，此时降级 **headless chromium 直连 API URL**（动态 import playwright-core，需设置非 headless 的 Chrome UA，`newContext({ userAgent })` 才改网络层请求头），无 chromium 环境（Vercel serverless）最终降级 `false`。
-   **刷新调度器**（`src/refreshScheduler.ts`，Phase 2）：57 个抓取型源的定时刷新收敛为全局有界调度。① **稳定抖动**：每源一个按名字 FNV-1a 哈希的相位偏移（phase ∈ `[0, jitterWindowMs)`，默认窗口=周期），跨重启稳定，首个刷新摊开在整个窗口内（实测 57 源相位无碰撞），避免旧 `setInterval(30min)` 全部源同时起表的 thundering herd；② **全局有界并发**：刷新任务统一经 `BoundedExecutor`（capacity.ts）执行，默认并发上限 4、队列上限 128，绝不 57 个上游抓取同时打出；③ **失败退避**：刷新失败经 `NegativeBackoffCache` 指数退避（默认 60s 起、因子 2、上限=周期），退避期内定时器 tick 直接跳过、`requestFXManager` 的懒加载路径也不再每次请求都全量重抓（直接服务当前实例）；已 `ready` 的源刷新失败**保持 ready** 继续服务旧数据（不再回退 pending 触发懒加载）并标记 **degraded**（Cache-Control max-age=0、readiness 不再 ok，成功刷新后自动解除），空 getter 结果同样视为失败（不把 `refreshDate` 推到 now 伪造新鲜度）。周期可经 `FXRATE_REFRESH_INTERVAL_MS` 覆盖；成功刷新会清退避并解除 degraded。**参数安全整数校验**（Phase 7）：interval/jitter 与 backoff 延时全部约束在 `[1, 2_147_483_647]`（round 后）——Node 对超 `2^31-1` 的延迟会静默转成 1ms，超限配置启动即抛 `TypeError`；`FXRATE_REFRESH_INTERVAL_MS` 只接受正整数（`0.1`/`NaN`/超限回落默认）；concurrency（≤1024）/queueSize（≤1_000_000）/backoffMaxSize 均限有限整数。**停机 drain 契约**：`stop()` 取消全部定时器并关闭执行器（在途自然结束），`drain()` 等待全部在途刷新 settle——`fxmManager.stopAllInterval()` 先 `stop()` 再 `await drain()` 最后才落盘快照，不丢停机前最后一次刷新（见「优雅停机」）。测试见 `test/unit/refresh-scheduler.test.ts` 与 `test/unit/fxm-manager-refresh.test.ts`。
-   **路由与缓存**：`handlers.js` 按 `/`、`/:from`、`/:from/:to`、`/:from/:to/:type(/:amount)` 绑定；响应 JSON 经 `sortObject` 按键排序（**注意数组不参与排序**——`result.path` 等有顺序语义，曾因 `obj.sort()` 字典序打乱 BFS 路径），`?pretty` 或浏览器直接访问（`Sec-Fetch-Dest: document`）时缩进输出；`Cache-Control: public, max-age` 与下次刷新时间挂钩（周期内递减），**degraded 源恒为 `max-age=0`**（见持久化节）。
-   **版本注入**：构建时 esbuild `--define` 注入 `globalThis.GITBUILD`（git short HEAD）与 `globalThis.BUILDTIME`，`/info` 返回 `fxrate@<GITBUILD> <BUILDTIME>`。
-   **就绪门禁**（`/info` + `/readyz`，Phase 6/7）：`fxmManager.readiness()` 按 `CRITICAL_SOURCES`（大陆大行 + 央行/交易中心 + 卡组织，见 `src/fxmManager.ts`）判定关键源**缺失**（`has()` 未注册）、**pending**（已注册但未加载有效数据——未完成首次刷新/快照恢复，仅注册不算就绪，冷启动阶段探针不会误判 ok）与**降级**（`getDegradedSources()`，快照恢复数据过期/刷新失败），并提供全部已加载且未降级的 `readySources` 与等同降级源的 `staleSources`。任一降级源、关键源缺失或 pending 时两条路由均返回 **HTTP 503 + `status: "degraded"`**，否则 200 `status: "ok"`，且恒带 `Cache-Control: no-store`。`/readyz` 是只含 `status`/`ready`/`readySources`/`staleSources`/`degraded`/`missing`/`pending` 的专用探针；`/info` 既有 body 保持不变，继续包含版本、环境与 sources。注意：`useBasic`（`useJson` 内部）会把 status 强制回 200，503 必须在 `useJson` 之后设置；503 不影响 JSON-RPC `instanceInfo`（`useInternalRestAPI` 只解析 body 不看状态码）。测试见 `test/unit/readiness.test.ts` 与 `test/unit/metrics.test.ts`。
-   **Prometheus 指标**（`GET /metrics`，Phase 6）：`src/metrics.ts` 提供零依赖、有界 registry，按 text exposition 0.0.4 输出并安全转义 HELP / 标签。固定 family 为 `fxrate_rpc_batch_items`、`fxrate_rpc_rejected_total`、`fxrate_work_active`、`fxrate_work_queue_wait_seconds`、`fxrate_source_fetch_seconds`、`fxrate_chromium_active`、`fxrate_cache_hits_total`、`fxrate_shutdown_seconds`；summary 输出标准 `_sum`/`_count`。埋点分别位于 RPC 预算包装层、带 `metricsLabel` 的 `BoundedExecutor`、普通 getter / CardCoordinator、Chromium 启停、Card 正负缓存与 shutdown 协调器，非静态占位值；`fxrate_rpc_rejected_total` 的 `reason` 除 `batch_too_large` / `expensive_card_limit` 外，还记录 body 阶段拒绝 `body_limit_exceeded`（413）/ `body_read_failed`（400）——在 `src/handler/limits.ts` 被包装的 `router.respond` 统一汇合点记账（见「RPC 入口硬限制」）；Card 的 source-fetch 时长只在 native/Chromium executor 任务真正开始后观察（排队时间只进 `work_queue_wait`，overload/closed/启动前 abort 为零次，native→Chromium 实际启动两段则为两次）；`fxrate_chromium_active` 表示已启动但关闭尚未确认的实例，`close()` 失败只记录日志且不覆盖主 payload/error，只有成功 close（无连接探测能力）或 `isConnected() === false` 才递减。动态标签截断到 200 字符，每 family 最多 256 个 series，且提供 `all` 聚合序列。`/metrics` 返回 200、`Content-Type: text/plain; version=0.0.4; charset=utf-8` 与 `Cache-Control: no-store`；测试可用 `getMetricsSnapshot()` 读取不可变副本、`resetMetricsForTests()` 重置状态。
-   **JSON-RPC**（endpoint `/v1/jsonrpc`）：方法 `instanceInfo` / `listCurrencies` / `listFXRates` / `getFXRate`，内部通过 `useInternalRestAPI` 复用自身 REST 路由。
-   **RPC 入口硬限制**（`src/handler/limits.ts`，Phase 1）：
    -   **HTTP body 上限 256 KiB**（`MAX_REQUEST_BODY_BYTES`）：handlers.js 的 `handleRequest` 原本无上限读 body（其 `bodyLimit` 中间件是「读完再查」，防不住），`installRequestBodyLimit(adapter)` 在 `makeInstance` 内 `useMappingAdapter()` 之后、`listen`/dispatch 之前替换 adapter 实例的 `handleRequest` 为受限读取器——Content-Length 预检（> 上限未读即拒）+ 流式字节计数（chunked 溢出即停），监听 `aborted`/`error`/`close` 保证读取 Promise 必 settle；超限请求以标记 `request.custom.requestRejected` 返回，被包装的 `router.respond` 在进入路由/数据源之前转成 **HTTP 413**（`handleResponse` 同时强制 `Connection: close` + `shouldKeepAlive=false` 丢弃未读字节，且连接已销毁时跳过写响应）。本地监听与 Vercel 默认 handler 共用同一 adapter，故两路都覆盖。
    -   **JSON-RPC v2 预算**：`fxmManager` 构造函数捕获基类 `v2RPCresponder` 再包一层——批量条数 > `RPC_MAX_BATCH_SIZE`（100）或昂贵卡组织条目（`getFXRate` 且 `params.source` ∈ visa/mastercard）> `RPC_MAX_EXPENSIVE_CARD_ITEMS`（20）时，在逐条 dispatch 之前返回单条 JSON-RPC 错误（HTTP 200）：`-32000`（batch 超限）/`-32001`（昂贵条目超限），零 RPC handler / 内部 REST / 抓取工作。非 JSON body 仍由下游输出 `-32700`；单请求/notification/error 形状与 `?content=` 查询路径不变。`/jsonrpc` 与 `/v1/jsonrpc`（经 `use` 转发）都走被包装的 responder。测试见 `test/unit/rpc-limits.test.ts`（真实 adapter/路由，验证精确边界成功、超限零工作、chunked 溢出 413、abort settle、`--detectOpenHandles` 无泄漏）。

## 环境变量

| 变量                                                            | 作用                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                          | 监听端口，默认 `8080`                                                                                                                                                                                        |
| `ENABLE_CORS` / `CORS_ORIGIN`                                   | 开启 CORS（默认 origin `*`）                                                                                                                                                                                 |
| `LOG_LEVEL=error`                                               | 静默 `fxmManager.log` 日志                                                                                                                                                                                   |
| `HEADER_USER_AGENT`                                             | 抓取请求的 UA 覆盖（默认 `fxrate axios/latest`）                                                                                                                                                             |
| `CHROMIUM_PATH`                                                 | Visa 降级用的 chromium 可执行文件路径（不设则探测常见路径：`/usr/bin/chromium` 等与 playwright 缓存目录）                                                                                                    |
| `ENABLE_WISE=0`                                                 | 禁用 Wise 源                                                                                                                                                                                                 |
| `WISE_TOKEN` / `WISE_SANDBOX_API=1` / `WISE_USE_TOKEN_FROM_WEB` | Wise 抓取配置；未设 `WISE_TOKEN` 时自动置 `WISE_USE_TOKEN_FROM_WEB=1`，回退到 `FXGetter/wise.ts` 内硬编码的网页 token（**有意为之，勿删，见「约定与注意事项」**）                                            |
| `VERCEL=1`                                                      | Vercel 部署模式（不本地监听，走默认导出；持久化自动禁用，serverless 只读 FS 无持久性）                                                                                                                       |
| `FXRATE_CACHE_DIR`                                              | 持久化目录（默认 `process.cwd()`）：汇率快照 `fxrate-cache.json` 与独立停机指标 `fxrate-shutdown-metrics.json`                                                                                               |
| `FXRATE_REFRESH_INTERVAL_MS`                                    | 刷新周期毫秒数（默认 `1800000`=30 分钟；同时决定 Cache-Control 周期与退避窗口上限；只接受正整数且 ≤ `2^31-1`）                                                                                               |
| `FXRATE_DISABLE_REFRESH=1`                                      | 禁用周期刷新调度，但保留按需 getter 请求；仅供确定性 image smoke / 离线进程测试，生产不得设置。                                                                                                              |
| `FXRATE_SNAPSHOT_MAX_AGE_MS`                                    | 快照整体最大年龄（默认 `86400000`=24h）：`savedAt` 超过该阈值整包忽略，冷启动重新走懒加载抓取                                                                                                                |
| `FXRATE_SNAPSHOT_MAX_BYTES`                                     | 快照文件字节上限（默认 `33554432`=32 MiB）：读文件前用 `statSync` size 预检，超限整包拒绝（防 JSON.parse 阶段耗尽资源）                                                                                      |
| `FXRATE_SNAPSHOT_FUTURE_SKEW_MS`                                | 允许的未来时钟偏差（默认 `300000`=5min）：`savedAt` 或任一 `rate.updated` 晚于 `now + 偏差` → 视为伪造/损坏快照整包拒绝                                                                                      |
| `FXRATE_STALE_RATE_AGE_MS`                                      | 单源降级阈值（默认=快照最大年龄 `snapshotMaxAgeMs()`，跟随 `FXRATE_SNAPSHOT_MAX_AGE_MS`）：恢复时某源最新一条汇率 `updated` 早于 `now - 阈值` → 标记 degraded（Cache-Control max-age=0，成功刷新后自动解除） |
| `FXRATE_SNAPSHOT_THROTTLE_MS`                                   | 节流异步快照 writer 的 trailing 窗口毫秒数（默认 `1000`=1s，只接受正整数）：成功刷新只 O(1) 入队，窗口结束由后台串行落盘最新状态；停机 flush 立即写一次                                                      |
| `SHUTDOWN_DEADLINE_MS`                                          | 优雅停机硬截止毫秒数（默认 `10000`；超过该时长仍无法自然关停时强制 `exit 0`，见「优雅停机」）                                                                                                                |

## 优雅停机（graceful shutdown）

-   `src/shutdown.ts` 的 `installShutdown(server, manager)` 在本地 HTTP 入口（`src/index.ts`，`App.listen()` 后保留 `App.adapater.server` 句柄）安装 SIGTERM/SIGINT 处理：首次信号后① `server.close()` 停止接收新连接（Node 顺带关闭空闲 keep-alive）；② `await Manager.stopAllInterval()`——先 `refreshScheduler.stop()` 停调度器（不再接任何新刷新、排队任务以 closed 拒绝），再等全部在途刷新 settle（`refreshScheduler.drain()` + `pendingPromises` 双保险），最后经节流 writer `flush()` 落盘汇率快照一次（重新 dump 最新状态，不丢停机前最后一次刷新）；③ 等在途请求自然结束后（server `'close'` 事件）`exit 0`；④ 超过 `SHUTDOWN_DEADLINE_MS`（默认 10000，覆盖在途刷新 drain）强制 `exit 0`；⑤ 二次信号立即强制 `exit 0`。每个 `forceExit` 路径先观察固定 outcome（`graceful` / `deadline` / `second_signal`），同步持久化累计 summary 后再退出；持久化失败只记录日志，不阻止退出。Vercel serverless 模式不本地监听，不安装。
-   未捕获的 rejection/异常（`unhandledRejection`/`uncaughtException`，`src/index.ts` 模块级）记录日志后以非零码退出——supervisor 语义（pm2/Docker 检测退出码后重启），**不再「只记录不退出」**；曾为容忍单源 playwright/网络超时改成过 log-only（2026-08 bojs 崩溃后），该行为已移除。

## 停机指标持久化

-   `src/shutdownMetricsPersistence.ts` 专用于 `fxrate_shutdown_seconds`，与汇率快照及任何后续 snapshot writer **不共享文件、schema 或写队列**。本地文件固定为 `${FXRATE_CACHE_DIR ?? process.cwd()}/fxrate-shutdown-metrics.json`，schema/version 固定且只接受 `graceful` / `deadline` / `second_signal` 三种 outcome 的有限非负 `sum` 与非负安全整数 `count`；`all` 在恢复时由三者重算。
-   文件读前限制 4 KiB；损坏、超限、额外 key 或非法数值整包忽略。写入使用每次不同的临时文件 + 同目录 `rename`，失败尽力清理临时文件。`VERCEL=1` 时读写均禁用。
-   `src/index.ts` 启动时在路由可 scrape 前恢复一次；`metrics.ts` 的 restore 先重置该 summary 再替换固定序列（重复恢复不会累加），因此上一进程已完成的停机 observation 可由下一进程的 Prometheus pull 读取。

## 汇率快照持久化（persistence）

-   **机制**：`src/persistence.ts` 提供 `saveSnapshot()`（同步，兼容旧 API）与 `saveSnapshotAsync()`（fs/promises + 唯一临时文件名 + 同目录 rename，失败清理临时文件并记录错误）。日常持久化走 **节流异步 writer**（`src/persistenceWriter.ts` 的 `SnapshotWriter`，Phase 5 优化 #8）：每个 `fxmManager` 一个实例，成功刷新仅 O(1) `enqueue()`（置脏 + 重置 trailing 定时器，默认 `FXRATE_SNAPSHOT_THROTTLE_MS`=1000ms，`unref` 不阻退出），stringify/write/rename 全部在后台 drain 循环串行执行——快照数据经惰性 `producer`（`dumpSnapshot()`）在写时读取，**newest-wins**：窗口内任意多次刷新收敛为一次写、写期间再入队自动补写一次、失败保留上一份有效文件且不影响源状态。`flush()` 通过默认 `setImmediate` defer 把 producer/stringify/write 排到事件循环下一轮，信号/请求调用栈只做 O(1) 排队；首次 flush 恒写，后续没有 dirty/失败重试时不重复落盘。停机时 `stopAllInterval()` 先同步置 stopping 门闩，拒绝 `pendingPromises` 快照之后才尝试启动的请求路径刷新，再停止/排空 scheduler 与既有刷新并 `await flush()` 重 dump 最新状态；`stop()` 取消 writer 定时器并停止后续调度。VERCEL/只读 FS（`snapshotCachePath()` 返回 null）时 writer 整体 no-op。同步 `saveSnapshot` 保留供外部/测试直接调用。冷启动构造 `fxmManager` 时 `loadSnapshot()` 读回并 `restoreSnapshot()` 恢复，源标记 `ready` 跳过懒加载上游抓取（Visa 等慢源首访可达 30s+，是 SSR 卡顿根因）。
-   **序列化**：mathjs Fraction 的 `JSON.stringify` 输出 `{mathjs,n,d}`（实测无 s 字段），reviver 用 `fraction({n,d})` 还原；`updated` 为 Date → ISO 字符串还原。
-   **安全校验**（Phase 7）：`loadSnapshot()` 在恢复进内存前做多层防御——① **字节上限**：读文件前 `statSync` size 预检（默认 32 MiB，`FXRATE_SNAPSHOT_MAX_BYTES` 可配），超限整包拒绝；② **顶层结构**：必须是 `{version, savedAt, sources}` 普通对象，version 必须匹配，savedAt 必须是合法字符串日期；③ **源数量上限**（200）与货币代码 `^[A-Z]{3}$`；④ **每格结构**：middle/cash/remit 必须是有限正数或 `s>0` 的 mathjs Fraction（复用 `fxManager.validateFXRate` 的报价契约，畸形对象/字符串/负价/缺字段全部拒绝）、`updated` 必须是合法 Date；⑤ **未来时钟偏差**：`savedAt` 或任一 `rate.updated` 晚于 `now + FXRATE_SNAPSHOT_FUTURE_SKEW_MS`（默认 5min）→ 视为伪造/损坏整包拒绝。`fxmManager.restoreSnapshot()` 只接受经 `loadSnapshot` 校验的数据——绝不让磁盘上的任意对象直接替换内存汇率表。
-   **新鲜度**（Phase 2）：`loadSnapshot()` 校验 `savedAt`——非法日期或超过 `FXRATE_SNAPSHOT_MAX_AGE_MS`（默认 24h）的整包快照直接忽略（走冷启动懒加载抓取）。恢复时按每源最新一条合法 `updated` 判定降级：早于 `now - FXRATE_STALE_RATE_AGE_MS`（默认=快照最大年龄，未设时跟随 `FXRATE_SNAPSHOT_MAX_AGE_MS`）或该源无任何合法记录 → 标记 **degraded**——Cache-Control 恒为 `max-age=0`（绝不对外声称新鲜），`refreshDate` 如实指向最后数据时间；30 分钟定时刷新仍按 `update()` 的 updated 时间戳守卫覆盖旧数据，**成功刷新后自动解除 degraded**。注：`updated` 是源发布时间的源（如 cfets 每日 9:15、hkma 滞后月余）恢复时可能被标 degraded，属如实反映数据陈旧度，不影响可用性。
-   **覆盖范围**：仅抓取型源（`_fxRateList`）。mastercard/visa 数据在各自模块级 LRUCache（未导出）不在快照内。
-   **接入点**：`fxManager.snapshot()/restore()`（访问私有 `_fxRateList`）；`fxmManager.dumpSnapshot()/restoreSnapshot()`（访问私有 `fxms/fxmStatus`）；`fxmManager` 构造函数加载；成功刷新（`updateFXManager` 完成路径）经 `snapshotWriter.enqueue()` 入队；停机时由 `installShutdown` 调用 `stopAllInterval()`（drain 后 `await flush()` 写回，信号监听已从 `fxmManager` 构造函数移除，统一收敛到 `src/shutdown.ts`）。测试可经 `options.snapshotWriter` 注入 writer 或注入 `path: null` 禁用。

## 构建与运行

```bash
yarn install
yarn dev               # dotenvx run + tsx watch src/index.ts（开发热重载）
yarn build             # esbuild 打包为 CJS 到 dist/index.cjs（playwright-core/chromium-bidi 为 --external，运行时从 node_modules 加载）
yarn start             # build + node dist/index.cjs
yarn test              # jest（ts-jest ESM 预设；测试会真实请求数据源，部分用例 45s 超时）
yarn test:coverage
yarn lint              # eslint 9 flat config，--fix
yarn format            # prettier（singleQuote、trailingComma all、tabWidth 4）
```

### jest 环境说明（重要）

-   **`src/types.d.ts` 是纯声明文件**，ts-jest ESM 下不产生运行时 JS，`import { currency } from 'src/types'` 在测试里会失败。`jest.config.ts` 的 `moduleNameMapper` 已把 `src/types`、`src/types.d` 与相对路径变体都映射到 `test/__mocks__/types-runtime.ts`（提供等值的运行时 `enum currency`）。
-   **所有源码的 types import 必须用 `src/types.d` 别名（带 `.d`）**——esbuild 无法解析无扩展名指向 `.d.ts` 的模块（相对路径 `../types` 在 jest 下也无法解析）。新增 getter 时遵循此约定。
-   若在测试里看到 `Cannot find module '../types'`，检查是否误用了相对路径 import。

## 部署

-   **Vercel**：`vercel.json` 将全部路由指向 `dist/index.cjs`（`@vercel/node`），buildCommand 为 `yarn build`。
-   **Docker**：`Dockerfile`（pnpm 装依赖 + pm2-runtime 跑 `dist/index.cjs`），`pm2.json` 指定脚本与 `NODE_ENV`。
-   **CI/CD**：`.github/workflows/ci.yml` 对每个分支 push/PR 跑 `npx tsc --noEmit` + `npx eslint "{src,test}/**/*.ts"`（lint 不带 `--fix`，因 package.json 的 lint 脚本带 `--fix`，CI 不能改文件）+ `yarn test:unit --runInBand`（确定性离线单测）+ `bash scripts/check-dist-consistency.sh`（把 src/ 重建到临时目录、归一化注入的 GITBUILD/BUILDTIME 后与提交的 `dist/index.cjs` 逐字节对比，**防止源码改动忘记重建/提交 dist**，必须在 `yarn build` 之前跑）+ `yarn build`。ci.yml 另含 `workflow_call` 触发——Phase 6 发布门禁：`.github/workflows/cd.yml` 的 `build-smoke-push` job `needs: gates`（复用同一组 CI 门禁，任一失败发布即被阻断），仅在 GitHub Release 发布或 push `v*` tag 时构建镜像，顶层 `concurrency` 按 ref 串行（release: published 与 push: tags 同 ref 不竞态）。构建（`build-push-action` push:false + load）后先对**精确发布镜像**跑确定性 smoke：`scripts/image-smoke.sh --skip-build --image <tag>` 起容器探测 `/info`、`/readyz` 契约（200/503 + 字段，**不等真实银行就绪**）、`/metrics` 8 个 family、JSON-RPC `instanceInfo`，smoke 失败即红不 push；通过后对本地 daemon 中**同一批 tag** 逐个 `docker push`（绝不重新构建）再生成 attestation。镜像 tag：`:版本` + `:主.次` + `:sha-…`，非预发布 v\*（无 `-`）额外 `:latest`；普通 `main` push 不触发。`scripts/image-smoke.sh` 支持 `--local`（无 Docker，用 `node dist/index.cjs` 起本地进程跑同一组断言）、`--url`（对已运行后端做检查）与可选 `--require-ready`（需要真实上游，仅供本机人工验证，不进 CI）。`.github/workflows/canary.yml` 是**网络 canary**（schedule 每日 06:00 UTC + `workflow_dispatch`，不进 PR/单元测试）：只跑 `RUN_NETWORK_TESTS=1 yarn test test/canary/network-canary.test.ts --runInBand --testTimeout=300000`，做真实上游健康度探针（见下）。
-   **依赖 `handlers.js` 的类型约定**：`responder` 的 `response` 参数是**必需**的（运行时 `handler.respond` 始终传入）；`errorResponder` 是柯里化的单参中间件（`(errorCode, errorMessage?) => (request) => Promise<response>`）。当前钉 `handlers.js@0.1.6`，路由挂载已按 0.1.6 语义重写（`mountFXMRouter` 用 `use('/${source}/(.*)')` + 精确路径绑定，`bodyToString()` 处理多平台 response.body）。
    -   **0.1.6 破坏性变更适配记录（2026-08 实测）**：① `use()` 强制要求路径含未命名捕获组 `/(.*)`；② 子路由 `/(.*)` 兜底优先级高于 `/:from` 参数路由；③ handler 返回值必须是 `response` 实例（字符串返回值 404）；④ `response.body` 类型扩为多平台联合类型。已全部适配，**勿降回 0.1.3**。
    -   **import.meta patch**：`main.node.js` 的 `createRequire(import.meta.url)` 在 CJS 构建下崩溃，经 **patch-package** 改为 `createRequire(import.meta.url||"file://"+__filename)`（ESM 下走 import.meta.url，CJS 下走 **filename）；patch 文件 `patches/handlers.js+0.1.6.patch`，postinstall 自动应用。注意 jest ESM 下 `**filename` 未定义，`import.meta.url||` 前缀必须保留。
-   **注意**：`dist/` 产物随仓库提交（`yarn build` 后需手动 commit），线上依赖它，勿加入 `.gitignore`。

## 约定与注意事项

-   **代码风格**：单引号、4 空格缩进、带分号（prettier 配置）；与前端仓库（双引号/tab/无分号）不同，勿混用。
-   **新数据源**：复制 `FXGetter/` 下现有 getter 模式——导出默认函数，用 `axios`/`cheerio` 抓取并映射为 `FXRate[]`（注意 `unit` 与 `updated`），然后在 `src/index.ts` 的 `Manager` 里注册；涉及中文名时在 `constant.ts` 补 `sourceNamesInZH`。
-   **测试**：`test/server-status.test.ts` 有真实网络请求（每个 source 都会打），本地跑可能慢或受网络影响；`Manager.stopAllInterval()` 在 `afterAll` 清理定时器。`test/validate-rates.test.ts` 是**汇率数值断言测试**（数值合法性/买卖价关系/交叉一致性），默认跳过，设 `RUN_NETWORK_TESTS=1` 显式启用。
-   **网络 canary（`test/canary/network-canary.test.ts`）**：真实上游健康度探针，**只在 scheduled/manual workflow 运行**（`.github/workflows/canary.yml`），默认（未设 `RUN_NETWORK_TESTS=1`）网络套件 skip 不碰公网；纯判定契约由 `test/unit/network-canary-contract.test.ts` 离线覆盖。判定契约：① 每个成功来源至少返回一条合法汇率——**每条**汇率至少有一个有限正数报价（middle/buy/sell 全缺省或非法的占位行也判无效），空数组/NaN/Infinity/非正值/非法 updated **硬失败**；② freshness 在来源声明窗口内（默认 7 天；`hkma` 月频滞后源 60 天、`mastercard` 未发布回退 7 天故 8 天），updated 晚于 `now + 5min` 视为伪造/时钟偏移同样硬失败；③ 允许的 WAF 失败（`bea`/`visa`/`mastercard`/`wise`/`ocbchk`/`icbca`）逐项记录（含错误消息），只豁免抓取错误的硬失败分类，不豁免坏数据，且仍计入总失败预算；`mastercard`/`visa` 用 `getfxRateList` 并发抽查 7 个关键货币对；timeout 后等待底层任务 settle 才释放并发槽；④ 配置集合固定断言 59 源，聚合门禁为成功来源 ≥ 48、总失败 ≤ 11。新增/调整来源时同步来源列表、`SOURCE_SPECS` 与阈值。
-   **汇率语义**：改 `fxManager.update()`/`convert()` 前先确认方向与倒数关系，别把买/卖、from/to 弄反。
-   **数据源语义（实测验证过，勿凭字段名想当然）**：
    -   部分银行 API 的 `Buy/Sell` 是**客户视角**（如 `hsbc.cn` 的 `*SellingRate` 映射到 buy 方向）——代码已正确翻转，勿再改。
    -   `ncb.cn`：**ccyPair 方向不一致**——部分为「外币/CNY」（EUR/USD/GBP 等），部分为「CNY/外币」（THB/DKK/SEK/NOK），必须用 ccyPair 原序，勿假设外币在前；数值口径是「1 外币 = X CNY」（USD/CNY=6.75 即 1USD=6.75CNY），**仅 JPY 按 100 单位**。`cstExgBuyPrc` 是客户视角（客户买外币=银行卖），代码已正确翻转。
-   `ncb.hk` 的 `inNum/outNum` 是「100 外币 = X HKD」（`in`=银行买入外币价、`out`=银行卖出外币价）；**离岸人民币等货币的买入价可能高于卖出价**，不能按 min/max 推断买卖方向。
-   `hsbc.au`：数据源是 HSBC 澳洲官网汇率 widget（`mkdlc.ebanking.hsbc.com.hk/hsbcfxwidget`，`hsbc.com.au/calculators/HSBC-exchange-rates/` 页面内嵌 iframe），**所有货币对以 AUD 为基准**（AUD→各外币）。API 的 `buy`/`sell` 是**银行视角**（页面列名 `HSBC Buys`/`HSBC Sells`，2026-08-03 官方 calculate API 实测对照）：`k.buy`=银行买 AUD 价=客户卖 AUD 得外币价（映射到 `rate.sell`），`k.sell`=银行卖 AUD 价=客户买 AUD 付外币价（映射到 `rate.buy`）。**映射 `buy: k.sell, sell: k.buy` 勿再翻转**——曾因误判方向翻转导致交叉汇率偏离 4%。注意该源单边点差约 2%（零售全球账户牌价），经 AUD 的多跳交叉（如 HKD→USD）会叠加两段点差（合计约 4% 损耗），交叉 cash 价显著低于直连源，但直连 AUD 对（AUD↔X）与官方计算器完全吻合。
    -   `citic.cn`：API（2026-08 实测）**不返回 `midPrice`/`cstpur*` 字段**，仅 `cstexcBuyPrice`/`cstexcSellPrice`，中间价需用买卖均价估算。
-   `cfets`（中国外汇交易中心）：`chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json` 每日 9:15 发布 25 个货币对**人民币中间价**（无买卖价），记录 `vrtEName`（如 "USD/CNY"）与 `price`。
-   `dbs`（星展新加坡）/`dbs.cn`（星展中国）/`dbs.hk`（星展香港）：**三个独立法律实体，各自独立 source**。三地 API 结构类似（`{地域}-rates-api/v1/api/...latestForexRates`，均无需认证直连）：SG 返回全组合 530 条需按 `quoteCurrency==='SGD'` 过滤，且**每行带 `baseCurrencyUnit`（JPY 等为 '100'，其余 '1'），共享解析 `parseDBSRow` 必须透传为 `unit`，否则 JPY 差 100 倍**（2026-08 实测修复）；HK 每货币同时给 HKD/USD 计价；CN 给 CNY 计价（含 cash 现钞价）。字段 `ttBuy/ttSell` 是**银行视角**（rate.buy=银行买外币价，rate.sell=银行卖外币价）。**HK 的 CNY/CNH 行 usdTT 是「1 USD = X CNY」方向**（与 USD 行同口径），需取倒数生成「1 CNY = X USD」且**买卖方向对调**（`rate.buy=1/usdTTBuy`、`rate.sell=1/usdTTSell`），否则反向汇率乘积 >1。SG 返回的 KHR/MM1/RUB/TRY 等行 ttBuy/ttSell 为 0 或空（数据垃圾），已过滤。
-   `alipay`（支付宝境外消费汇率）：SEM 汇率换算器页面（`render.alipay.com/p/s/currency-converter-sem/`）背后的 `basement-gzone.alipay.com/mgw_proxy/unauthorized_endpoint`，参数 `requestData=[{"x-basement-operation":"com.alipay.overseatwa.xservices.index.queryRate","x-basement-forward":"{\"positionInfo\":{...}}"}]`，**纯 axios 直连可用**（需伪装 callback 参数），返回 JSONP 包裹的 `commonRateList`，`contrastRate`=1 外币 = X 人民币。**业务语义是购汇价**：用户付人民币、支付宝付商家外币（客户买入外币价），故 getter 注册方向为 `CNY → 外币`（值 = 1/contrastRate，如 1 CNY = 0.1477 USD），`oneWay: true` 保留购汇方向、禁止结汇方向（外币→CNY，支付宝无结汇业务）。**勿改回 `外币 → CNY` 方向**（曾写反导致前端「购汇价」列无值、只有「结汇价」列有值，2026-08 实测修复）。
    -   **不可做公开 getter 的源**（2026-08 侦察结论）：微信支付汇率需商户号+签名（`queryexchagerate` 是商户接口）；渣打 HK/SG 公开牌价需网银登录（`sc.com/hk/deposits/board-rates/` 是存款利率非汇率）；汇丰 SG/UK/US 实时牌价需网银（公开页只有 currencyzone.hsbc.com 的日频市场序列，无买卖价）；天星（EleBank）/ZA/WeLab 汇率在 App 内无公开页面（银探小程序能展示 ZA 等汇率是因为其使用登录态 App API 或人工录入，无法公开复用）。
    -   `hkma`（香港金管局）：`api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily` 官方 API，每单位外币兑港元（usd=1 USD=X HKD），中间价无买卖价；数据按月发布（金管局惯例），滞后约 1-2 天（**实测滞后月余**：官方无实时全币种汇率 API，`daily-figures-interbank-liquidity` 仅 USD/HKD 兑换保证承诺价 cu_weakside/cu_strongside 为日更）。
    -   `hkab`（香港银行公会）：`hkab.org.hk/sc/rates/exchange-rates` Nuxt SSR 页，**每日发布**（RateDate 当天）电汇汇率（T/T rates），HKD 基准，字段 `{CCY}Selling`（银行卖出）/`{CCY}BuyingTT`（电汇买入）/`{CCY}BuyingOD`（现钞买入）。数据在 `__NUXT_DATA__` 扁平 payload 内：字段值是数组索引需递归解引用、**汇率以字符串存储**、13 为 null 哨兵（当日无报价）。**单位：GBP 为 1 单位，其余全部 100 单位**（2026-08 用 USD 交叉验证；USD 787.25=100 USD、JPY 5.0715=100 JPY、WON 0.5705=100 WON）。
    -   **港行/新行组（2026-08 新增，全部 HKD 基准，除 ocbc 为 SGD 基准）**：`cncbi`（中信国际，XML `rate-table/xml/TE01.xml`，全 unit=1）、`ccba`（建银亚洲，JSONP `js/ho_js/hkwhhl01.js`，**上游 ExR_Grp 根键重复 4 次需逐个改名再 JSON.parse**，选零售 `Dif_Dmsn_Val=210`，全 unit=1）、`cmbwl`（招商永隆，HTML 两张 JSP——电汇 `CnCoFiiTtrateDsp.jsp` + 现钞 `CnCoFiiNotratDsp.jsp`，现钞页有分行/电子渠道两列，取分行渠道列索引 2，全 unit=1）、`hsb`（恒生香港，HSBC API `rbwm-api.hsbc.com.hk/pws-hk-hase-rates-papi-prod-proxy`，需 `X-HSBC-Locale/Channel-Id/Chnl-CountryCode` 头，**JPY unit=1000**（`ccyBaseRemark=(per 1,000)`），其余 unit=1）、`icbca`（工银亚洲，`papi.icbc.com.cn/rest/currencies/asia/foreign`，**需 legacy TLS renegotiation Agent**，**JPY 行名 `JPY(100 Units)` → unit=100**，其余 unit=1）、`ocbchk`（华侨香港，POST `ebanking.ocbc.com.hk/digital/api/fx-hk/v1/public/fx-rate/inquiry`，需 5 个 `x-*` 头+UUID，`lastUpdateDatetime` 带错误的 Z 实为香港本地时间，全 unit=1）、`ocbc`（华侨新加坡，`ocbc.com/fxrates/bootstrap.json`，SGD 基准，38 行过滤零价/倒挂后 20 条，**unit 从 `unitForSGDExchange` 透传：USD/CAD/GBP/AUD/NZD/EUR 等 unit=1，CHF/DKK/NOK/SEK/JPY/HKD/THB/CNH/ZAR 等 unit=100**）、`bea`（东亚香港，qiankun SPA + Imperva WAF，**仅 Playwright 可抓**：打开 `hkbea.com/hk-form/?formId=RATE&rateType=ttfx` 等 `waitForResponse` 捕获空体 POST `eform-api/v1/misc/enquiry/RATE/ttfx`，挑战/超时 5 秒 reload 重试；响应为分号串 `货币;unit;买;卖`，**USD unit=100、JPY unit=10000**）。
        -   汇率数值交叉验证方式：各源 `USD/CNY` 中间价应一致（~675 百元口径）；偏差 >5% 说明方向/单位可能写错（小币种 RUB/ZAR 等银行点差大，偏差 20%+ 属正常）。可用 `RUN_NETWORK_TESTS=1` 跑 `test/validate-rates.test.ts` 自动校验。
-   **Wise 硬编码 token（勿当安全漏洞处理）**：`FXGetter/wise.ts` 里的 Basic 认证 token（`Basic OGNhN2FlMjUt...`）是**有意为之**——Wise API 强制要求携带凭据，该 token 是从 Wise 公开网页 UI 中提取的（等同任何浏览器用户可见），非私密密钥。未设 `WISE_TOKEN` 环境变量时自动回退到它（`WISE_USE_TOKEN_FROM_WEB=1`）。安全扫描或审查若标记它，勿改动、勿删除，直接忽略并说明原因。
-   本仓库是 ESM（`"type": "module"`），但构建产物是 CJS（`dist/index.cjs`）；`client/index.ts` 同时被前端仓库（Next.js bundler）使用，改动需保证两边兼容。

## 对 AI 助手的约定

-   思考/推理过程（chain-of-thought）使用英文；与用户对话时使用中文。
-   代码修改若导致本文档描述的架构、目录结构、数据流、构建方式或约定发生变化，必须同步更新本文件，保持文档与代码一致。
