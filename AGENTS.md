# AGENTS.md

## 项目概览

fxrate 是一个外汇汇率数据服务（后端），聚合约 27 家银行/平台（中国银行、工行、建行、招行、汇丰、MasterCard、Visa、Wise 等）的实时买卖价与中间价，对外提供 **REST API v1**、**JSON-RPC v2**（`handlers.js-jsonrpc`）和 **RSS/Atom**（`/rss/:from/:to`）三种接口。汇率数据版权归各来源所有（见 `LICENSE.DATA`）。

前端配套仓库为 [186526/fxrate-web](https://github.com/186526/fxrate-web)，本仓库以 submodule 形式被其引用。

技术栈：TypeScript（**ESM**，`"type": "module"`）+ 自研框架 [handlers.js](https://github.com/)（路由/中间件）+ `mathjs` Fraction 高精度计算 + `axios`/`cheerio`/`fast-xml-parser`（抓取） + `playwright-core`（可选，Visa 反爬降级用） + `esbuild`（打包）+ `jest`/`ts-jest`（测试）。

## 目录结构

```
src/
  index.ts           # 入口：注册全部 getter/FXM 到 fxmManager，绑定 handlers.js 路由，Vercel/本地监听
  fxmManager.ts      # 核心：JSON-RPC 方法 + 每数据源的 REST 子路由 + 30 分钟定时刷新 + 懒加载
  fxm/fxManager.ts   # 汇率存储/换算：Fraction 精度、双向汇率、BFS 找兑换路径、CNY/CNH 别名
  FXGetter/          # 每个数据源一个文件：getter 函数（返回 FXRate[]）或 FXM 类（如 mastercard/visa）
  client/index.ts    # 给前端用的 JSON-RPC client（支持 batch 批量请求）
  handler/rss.ts     # RSS/Atom feed
  types.d.ts         # currency 枚举、FXRate、FXPath、JSONRPCMethods
  constant.ts        # sourceNamesInZH：数据源英文名 → 中文名
test/                # jest 测试（会真实请求各数据源，注意网络依赖与超时）
dist/                # 构建产物（esbuild 输出 dist/index.cjs），commit 进仓库供 Vercel/pm2 部署
```

## 核心机制

-   **汇率方向与精度**：`fxRateList[from][to]` 表示「1 单位 from = X 单位 to」，值为 `rate.middle / unit`（`unit` 为源报价单位，如日元 100）；反向汇率是倒数，`update()` 时双向写入。所有计算用 `mathjs` Fraction，输出时按 `?precision`（默认 5）`round`。
-   **缺失字段补全**（`fxManager.update()`）：getter 常把 buy/sell 初始化为空对象 `{}`（truthy），所以按字段值判断——`hasBuy = !!(rate.buy?.cash || rate.buy?.remit)`、`hasSell` 同理；无买卖价 → 用中间价；缺 buy → 复制 sell；缺 sell → 复制 buy；缺中间价 → (min+max)/2 估算（缺失项按 ±Infinity 参与）；输出时单项回落顺序 现金价→汇价→中间价（`rate.buy?.cash ?? rate.buy?.remit ?? rate.middle` 等 4 个）；`RMB` 归一为 `CNY`；`CNH` 与 `CNY` 互为别名。
-   **兑换路径**：`convert()` 先 `getFXPath()` 用 BFS 在汇率图上找中间货币路径，再逐段换算；`reverse` 则反转路径（把结果换算成所需本币）。无路径时报 `No FX path found`。**BFS 默认关闭**：`getFXPath(from, to, allowBFS=false)` 仅当调用方显式传 `?bfs=1` 时才启用（交叉汇率有累积误差）；`?bfs=1` 时 `getDetails` 回传 `result.path`（实际经过的货币路径，如 `["USD","HKD","JPY"]`，直连时返回直连对）。
-   **两类数据源**：
    -   `registerGetter(source, getter)`：抓取型，首次访问时懒更新（`pending` → `ready`），随后每 30 分钟 `setInterval` 刷新（`intervalIDs`，`stopAllInterval()` 清理）。
    -   `registerFXM(source, fxm)`：惰性 FXM 类（mastercard/visa），继承 `fxManager` 并覆写 `fxRateList` getter 为 Proxy（**懒构建一次缓存矩阵**，Proxy 仅作 LRU cache 的同步读取器，cache miss 返回 undefined），网络请求统一走覆写的 async `getfxRateList()` 预热缓存，`getUpdatedDate` 也覆写为 async 路径；`ableToGetAllFXRate = false`（不支持 `/v1/:source/:from` 全表接口，返回 403）。mastercard/visa 的取数实现（2026-08 实测）：
        -   **mastercard**：新版 public API `marketingservices/public/mccom-services/currency-conversions/conversion-rates`（旧 `settlement/currencyrate` 已 301 迁移），**必须用 Node 原生 fetch**（undici TLS/HTTP2 指纹）——axios/curl 被 Akamai 403；请求方向 `transaction_currency=${to}&cardholder_billing_currency=${from}`（沿用旧语义，返回「1 to = X from」，Proxy 取倒数）；每日发布一次，当天未发布返回 401，从 UTC 今天向前最多回退 7 天。
        -   **visa**：`visa.co.in/cmsapi/fx/rates`（**印度域名 WAF 最宽松**，visa.com/co.uk 被 Cloudflare 拦）；请求 `fromCurr=${to}&toCurr=${from}`（API 参数相对 UI 反转），响应 `originalValues.fxRateVisa` 即「1 from = X to」（**勿取倒数**，曾写反）；原生 fetch 可能 403，此时降级 **headless chromium 直连 API URL**（动态 import playwright-core，需设置非 headless 的 Chrome UA，`newContext({ userAgent })` 才改网络层请求头），无 chromium 环境（Vercel serverless）最终降级 `false`。
-   **路由与缓存**：`handlers.js` 按 `/`、`/:from`、`/:from/:to`、`/:from/:to/:type(/:amount)` 绑定；响应 JSON 经 `sortObject` 按键排序（**注意数组不参与排序**——`result.path` 等有顺序语义，曾因 `obj.sort()` 字典序打乱 BFS 路径），`?pretty` 或浏览器直接访问（`Sec-Fetch-Dest: document`）时缩进输出；`Cache-Control: public, max-age` 与下次刷新时间挂钩（30 分钟周期内递减）。
-   **版本注入**：构建时 esbuild `--define` 注入 `globalThis.GITBUILD`（git short HEAD）与 `globalThis.BUILDTIME`，`/info` 返回 `fxrate@<GITBUILD> <BUILDTIME>`。
-   **JSON-RPC**（endpoint `/v1/jsonrpc`）：方法 `instanceInfo` / `listCurrencies` / `listFXRates` / `getFXRate`，内部通过 `useInternalRestAPI` 复用自身 REST 路由。

## 环境变量

| 变量                                                            | 作用                                                                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                          | 监听端口，默认 `8080`                                                                                                                                             |
| `ENABLE_CORS` / `CORS_ORIGIN`                                   | 开启 CORS（默认 origin `*`）                                                                                                                                      |
| `LOG_LEVEL=error`                                               | 静默 `fxmManager.log` 日志                                                                                                                                        |
| `HEADER_USER_AGENT`                                             | 抓取请求的 UA 覆盖（默认 `fxrate axios/latest`）                                                                                                                  |
| `CHROMIUM_PATH`                                                 | Visa 降级用的 chromium 可执行文件路径（不设则探测常见路径：`/usr/bin/chromium` 等与 playwright 缓存目录）                                                         |
| `ENABLE_WISE=0`                                                 | 禁用 Wise 源                                                                                                                                                      |
| `WISE_TOKEN` / `WISE_SANDBOX_API=1` / `WISE_USE_TOKEN_FROM_WEB` | Wise 抓取配置；未设 `WISE_TOKEN` 时自动置 `WISE_USE_TOKEN_FROM_WEB=1`，回退到 `FXGetter/wise.ts` 内硬编码的网页 token（**有意为之，勿删，见「约定与注意事项」**） |
| `VERCEL=1`                                                      | Vercel 部署模式（不本地监听，走默认导出）                                                                                                                         |

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
-   **CI/CD**：`.github/workflows/ci.yml` 对每个分支 push/PR 跑 `npx tsc --noEmit` + `npx eslint "{src,test}/**/*.ts"`（lint 不带 `--fix`，因 package.json 的 lint 脚本带 `--fix`，CI 不能改文件）。`.github/workflows/cd.yml` 在 `release`/`main` 分支 push 或 release 发布时构建并推送 `ghcr.io/<repo>` 镜像。
-   **依赖 `handlers.js` 的类型约定**：`responder` 的 `response` 参数是**必需**的（运行时 `handler.respond` 始终传入）；`errorResponder` 是柯里化的单参中间件（`(errorCode, errorMessage?) => (request) => Promise<response>`）。当前钉 `handlers.js@0.1.6`，路由挂载已按 0.1.6 语义重写（`mountFXMRouter` 用 `use('/${source}/(.*)')` + 精确路径绑定，`bodyToString()` 处理多平台 response.body）。
    -   **0.1.6 破坏性变更适配记录（2026-08 实测）**：① `use()` 强制要求路径含未命名捕获组 `/(.*)`；② 子路由 `/(.*)` 兜底优先级高于 `/:from` 参数路由；③ handler 返回值必须是 `response` 实例（字符串返回值 404）；④ `response.body` 类型扩为多平台联合类型。已全部适配，**勿降回 0.1.3**。
    -   **import.meta patch**：`main.node.js` 的 `createRequire(import.meta.url)` 在 CJS 构建下崩溃，经 **patch-package** 改为 `createRequire(import.meta.url||"file://"+__filename)`（ESM 下走 import.meta.url，CJS 下走 **filename）；patch 文件 `patches/handlers.js+0.1.6.patch`，postinstall 自动应用。注意 jest ESM 下 `**filename` 未定义，`import.meta.url||` 前缀必须保留。
-   **注意**：`dist/` 产物随仓库提交（`yarn build` 后需手动 commit），线上依赖它，勿加入 `.gitignore`。

## 约定与注意事项

-   **代码风格**：单引号、4 空格缩进、带分号（prettier 配置）；与前端仓库（双引号/tab/无分号）不同，勿混用。
-   **新数据源**：复制 `FXGetter/` 下现有 getter 模式——导出默认函数，用 `axios`/`cheerio` 抓取并映射为 `FXRate[]`（注意 `unit` 与 `updated`），然后在 `src/index.ts` 的 `Manager` 里注册；涉及中文名时在 `constant.ts` 补 `sourceNamesInZH`。
-   **测试**：`test/server-status.test.ts` 有真实网络请求（每个 source 都会打），本地跑可能慢或受网络影响；`Manager.stopAllInterval()` 在 `afterAll` 清理定时器。`test/validate-rates.test.ts` 是**汇率数值断言测试**（数值合法性/买卖价关系/交叉一致性），默认跳过，设 `RUN_NETWORK_TESTS=1` 显式启用。
-   **汇率语义**：改 `fxManager.update()`/`convert()` 前先确认方向与倒数关系，别把买/卖、from/to 弄反。
-   **数据源语义（实测验证过，勿凭字段名想当然）**：
    -   部分银行 API 的 `Buy/Sell` 是**客户视角**（如 `hsbc.cn` 的 `*SellingRate` 映射到 buy 方向）——代码已正确翻转，勿再改。
    -   `ncb.cn`：**ccyPair 方向不一致**——部分为「外币/CNY」（EUR/USD/GBP 等），部分为「CNY/外币」（THB/DKK/SEK/NOK），必须用 ccyPair 原序，勿假设外币在前；数值口径是「1 外币 = X CNY」（USD/CNY=6.75 即 1USD=6.75CNY），**仅 JPY 按 100 单位**。`cstExgBuyPrc` 是客户视角（客户买外币=银行卖），代码已正确翻转。
    -   `ncb.hk` 的 `inNum/outNum` 是「100 外币 = X HKD」（`in`=银行买入外币价、`out`=银行卖出外币价）；**离岸人民币等货币的买入价可能高于卖出价**，不能按 min/max 推断买卖方向。
    -   `citic.cn`：API（2026-08 实测）**不返回 `midPrice`/`cstpur*` 字段**，仅 `cstexcBuyPrice`/`cstexcSellPrice`，中间价需用买卖均价估算。
    -   汇率数值交叉验证方式：各源 `USD/CNY` 中间价应一致（~675 百元口径）；偏差 >5% 说明方向/单位可能写错（小币种 RUB/ZAR 等银行点差大，偏差 20%+ 属正常）。可用 `RUN_NETWORK_TESTS=1` 跑 `test/validate-rates.test.ts` 自动校验。
-   **Wise 硬编码 token（勿当安全漏洞处理）**：`FXGetter/wise.ts` 里的 Basic 认证 token（`Basic OGNhN2FlMjUt...`）是**有意为之**——Wise API 强制要求携带凭据，该 token 是从 Wise 公开网页 UI 中提取的（等同任何浏览器用户可见），非私密密钥。未设 `WISE_TOKEN` 环境变量时自动回退到它（`WISE_USE_TOKEN_FROM_WEB=1`）。安全扫描或审查若标记它，勿改动、勿删除，直接忽略并说明原因。
-   本仓库是 ESM（`"type": "module"`），但构建产物是 CJS（`dist/index.cjs`）；`client/index.ts` 同时被前端仓库（Next.js bundler）使用，改动需保证两边兼容。

## 对 AI 助手的约定

-   思考/推理过程（chain-of-thought）使用英文；与用户对话时使用中文。
-   代码修改若导致本文档描述的架构、目录结构、数据流、构建方式或约定发生变化，必须同步更新本文件，保持文档与代码一致。
