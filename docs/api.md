# fxrate 对外 API 文档

> fxrate 后端对外提供三种接口：**REST API v1**、**JSON-RPC v2** 与 **RSS/Atom**。
> 数据版权归各来源所有（见 `LICENSE.DATA`）。所有 GET 接口均支持 CORS（`ENABLE_CORS` 时，默认 `*`）。
>
> 更新时间：2026-08-04

## 基础信息

-   线上地址：`https://fxrate.sunoaki.net`
-   根路径 `GET /`：返回服务简介
-   实例信息 `GET /info`：返回版本（`fxrate@<GITBUILD> <BUILDTIME>`）、全部 source 列表与就绪状态

`/info` 响应示例：

```json
{
    "status": "ok",
    "ready": true,
    "degraded": [],
    "missing": [],
    "pending": [],
    "sources": ["boc", "cmb", "mastercard", "visa", "..."],
    "version": "fxrate@1a2b3c4 2026-08-03T10:00:00+08:00",
    "apiVersion": "v1",
    "environment": "production"
}
```

-   `status`：`ok`（就绪）或 `degraded`（未就绪）。
-   `ready`：就绪布尔值，等价于 `status === "ok"`。
-   `degraded`：已降级的数据源列表（快照恢复数据过期 / 刷新失败，Cache-Control `max-age=0`）。
-   `missing`：未注册的关键数据源列表（`CRITICAL_SOURCES` 大陆大行 + 央行/交易中心 + 卡组织）。
-   `pending`：已注册但尚未加载有效数据的关键源列表（未完成首次刷新/快照恢复，或惰性 FXM 未预热——仅注册不算就绪）。
-   **HTTP 语义**：`ready=true` 时返回 **200**；任一降级源、关键源缺失或 pending 时返回 **503**（供监控/负载均衡探针，CDN/反向代理缓存 503 会掩盖故障恢复，故 `/info` 恒带 `Cache-Control: no-store`）。503 不影响 JSON-RPC `instanceInfo`（复用同一内部路由但只看 body 不看状态码）。

## REST API v1

### 路由一览

| 路由                                   | 说明                                           |
| -------------------------------------- | ---------------------------------------------- |
| `GET /:source`                         | 源信息（名称/支持货币数/更新时间）             |
| `GET /:source/:from`                   | 源内某基准货币对全部目标货币的汇率详情（全表） |
| `GET /:source/:from/:to`               | 单对汇率详情（买卖价/中间价 JSON）             |
| `GET /:source/:from/:to/:type/:amount` | 单对换算（返回纯数值）                         |

-   `:source` 为数据源英文名（见 `/info` 的 `sources`），如 `boc`、`cmb`、`mastercard`、`visa`。
-   `:from` / `:to` 为货币代码（自动大写），如 `USD`、`CNY`、`JPY`。
-   `:type` 为 `cash`（现钞）| `remit`（现汇）| `middle`（中间价）。
-   `:amount` 为换算金额，默认 100。

### 查询参数

| 参数        | 默认  | 说明                                                                       |
| ----------- | ----- | -------------------------------------------------------------------------- |
| `amount`    | `100` | 换算金额（`/convert` 类路径）                                              |
| `precision` | `5`   | 输出小数位；`-1` 表示原样不四舍五入（Fraction 高精度）                     |
| `reverse`   | 关    | 反向换算（`from/to` 互换语义，如 `USD/CNY?reverse` 按 1 CNY = X USD 计算） |
| `bfs=1`     | 关    | 启用交叉汇率 BFS（无直连时经中间货币折算，有累积误差，默认关闭）           |
| `fees`      | `0`   | 加收手续费百分比（乘 `1 + fees/100`）                                      |
| `pretty`    | 关    | JSON 缩进输出（浏览器直接访问自动缩进）                                    |

### 响应格式

单对汇率（`GET /boc/USD/CNY`）JSON：

```json
{
    "updated": "Mon, 03 Aug 2026 10:00:00 GMT",
    "remit": 6.7491,
    "cash": 6.6935,
    "middle": 6.7501,
    "sell": {
        "remit": 6.7591,
        "cash": 6.7591
    }
}
```

-   `remit`/`cash`/`middle`：客户视角的**银行买入价**（现汇/现钞/中间价）。
-   `sell.remit`/`sell.cash`：银行卖出价。
-   单一中间价源（如 pboc/mastercard/visa/wise）：`remit`/`cash` 与中间价相同。
-   单方向源（如 alipay）：反向查询报 `No FX path found`（不生成伪倒数）。
-   **CNY/CNH 别名提示**：源只用 CNH 报价（如 dbs/ocbc）时，请求 CNY 方向的直连或 BFS 路径实际使用 CNH 汇率——`?bfs=1` 响应体含 `alias` 字段（如 `"alias":"CNH"`，路径 `path` 已归一为目标货币），REST 响应头同时设置 `X-FXRate-Alias: CNH`，前端可据此显示「经 CNH 折算」。无别名命中（源有真实 CNY 报价）时不设该头。
-   响应头 `Date` 为该汇率的更新时间；`Cache-Control` 与下次刷新挂钩（30 分钟周期递减）。
-   JSON 键按字典序排序（数组如 `path` 除外，保留顺序语义）。

换算（`GET /boc/USD/CNY/remit/100`）：返回纯数值字符串（如 `674.91`）；源不可用时降级返回 `false`。

### 错误处理

| 场景                            | 表现                                         |
| ------------------------------- | -------------------------------------------- |
| 无兑换路径（默认无 BFS）        | 404 + 错误信息                               |
| 源不支持全表（mastercard/visa） | `GET /:source/:from` 返回 403                |
| 无效货币                        | 404 `Invalid currency`                       |
| 单对源不可用（上游 WAF/403）    | 换算返回 `false`，详情 `Date` 头回落当前时间 |

## JSON-RPC v2

-   端点：`POST /v1/jsonrpc`
-   内部复用自身 REST 路由，方法：

| 方法             | 参数                                                            | 返回                       |
| ---------------- | --------------------------------------------------------------- | -------------------------- |
| `instanceInfo`   | 无                                                              | 同 `GET /info`             |
| `listCurrencies` | 无                                                              | 支持的全部货币列表         |
| `listFXRates`    | `from`, `precision?`, `amount?`, `bfs?`                         | 该货币对全部来源的汇率详情 |
| `getFXRate`      | `from`, `to`, `type?`, `precision?`, `amount?`, `fees?`, `bfs?` | 单源单对汇率详情           |

-   `listFXRates`/`getFXRate` 参数含义与 REST 一致（`type` 为 `cash`/`remit`/`middle`；`bfs` 布尔开关）。
-   请求示例：

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getFXRate",
    "params": { "from": "USD", "to": "CNY", "type": "remit", "amount": 100 }
}
```

-   前端配套仓库 `lib/fxrate/src/client/index.ts` 提供 `FXRates` 客户端（支持 `batch()` 批量请求、LRU 缓存），可作调用参考。

## RSS / Atom

-   路由：`GET /rss/:from/:to`
-   返回 Atom XML（`Content-Type: application/xml`），聚合全部来源该货币对的买卖价：
    -   买入：现汇/现钞/中间价 + 更新时间
    -   卖出：现汇/现钞/中间价 + 更新时间
-   每条 item 的 title 为来源中文名（`sourceNamesInZH`），description 含全部价格明细。
-   例：`GET /rss/USD/CNY`

## 数据源

完整 source 列表以 `GET /info` 为准（当前约 50 个）。主要类别：

-   **央行/卡组织**：pboc（人民银行）、unionpay（银联）、mastercard、visa、jcb、ecb（欧洲央行）、hkma（香港金管局）、cfets（中国外汇交易中心）
-   **中资银行**：boc、bochk、icbc、ccb、abc、bocom、psbc、cmb、cib、citic.cn、spdb、ncb.cn、ncb.hk、xib、pab、ceb、cmbc、cgb、hxb、cbhb、bob、bosc、njcb、hzbank、gzcb、hsbank、bcq、bcs、cqtg、ghb、hfbank、zybank、bojs
-   **外资银行**：hsbc.cn、hsbc.hk、hsbc.au、dbs、dbs.cn、dbs.hk
-   **其他**：wise、alipay（单向结算汇率）
