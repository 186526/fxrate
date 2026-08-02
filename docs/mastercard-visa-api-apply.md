# MasterCard / Visa 汇率 API 申请指南

> 目的：为 fxrate 的 `mastercard` / `visa` 两个数据源申请官方 API 凭据，替代当前被 WAF 拦截的网页抓取（上游 Akamai/Cloudflare 已全面封锁服务器端请求，2026-08 实测）。
>
> 更新时间：2026-08-03

## ⚠️ 关键结论：sandbox 返回的是 mock 数据，不是实时汇率

调查确认（2026-08-03）：

-   **Visa**：官方开发者社区明确回复 _"Sandbox does not output real/up to date exchange rates. In production environment you can expect up to date actual and correct rates."_；官方文档承认 sandbox _"pulls data from a simulator which has only static, predefined rates"_，仅支持 USD/GBP/RUB → INR/USD/GBP/CAD 等**少量货币对的固定模拟值**（如 USD→KWD 恒返回 `10.00000`）。
-   **MasterCard**：sandbox 返回的是 OpenAPI 文档中的**示例占位数据**（`conversionRate: 42.5`、`example_value` 等），同样为静态模拟响应。

**结论：直接用 sandbox API 不可行（拿不到真实汇率），必须申请 production 环境。**

-   **MasterCard**：production 为表单申请（OAuth 1.0a），审核相对宽松，通过即得真实每日结算汇率；响应结构与现有 getter 完全兼容。
-   **Visa**：production 需 on-boarding 审核（更严，审核项目用途），且请求需 POST + acquirer 上下文，改造更大。

---

## 背景

当前 `FXGetter/mastercard.ts` 与 `FXGetter/visa.ts` 抓取的公共端点（`mastercard.com/settlement/currencyrate`、`usa.visa.com/cmsapi/fx/rates`）已被上游 WAF 拦截：

-   MasterCard：Akamai `Access Denied`（403），即使 headless 浏览器带 `_abck`/`ak_bmsc` cookie 同源请求也 403（API 路径有独立深度保护）
-   Visa：Cloudflare JS 挑战（headless 可过页面，但 `cmsapi` 端点参数格式已失效返回 400，新版前端不再暴露可用调用）

**恢复这两个源真实数据的唯一可靠途径是申请官方 API。** 官方 API 均免费（sandbox 即时可用），凭据申请与认证方式如下。

---

## Visa WebUI 改版调查（2026-08 补充）

针对「重写 handlers.js 后重新研究 Visa WebUI」的结论——**上游确实改版且封死抓取路径**：

| 变更                  | 详情                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 旧端点失效            | `usa.visa.com/cmsapi/fx/rates` 返回 400（参数格式已变），旧版汇率计算器页面组件不再渲染                                                   |
| 计算器迁入 Shadow DOM | 新版用 `DM-CALCULATOR` Shadow DOM 组件封装，原生 DOM 查询找不到表单（`shadowRoot` 隔离），币种选择为自定义下拉组件                        |
| 区域域名统一拦截      | `usa.visa.com` / `www.visa.co.uk` / `visa.com.sg` / `visa.com.hk` / `visa.com.au` / `visa.com.cn` 全部 Cloudflare 403（服务器 IP 全被拦） |
| visaeurope.com 合并   | 302 重定向到 visa.co.uk，无独立汇率入口                                                                                                   |
| cf_clearance 不可复用 | playwright 过挑战后 cookie 不落盘（HttpOnly + 动态校验），服务器端 HTTP 客户端无法复用                                                    |

**结论**：Visa WebUI 抓取路径已彻底失效（改版 + WAF 升级双管齐下），新版计算器迁入 Shadow DOM 使逆向成本剧增且脆弱（每次改版即失效）。**不推荐继续投入 WebUI 方案**，唯一可靠路径是申请 Visa 官方 FX Rates API 的 **production** 环境。

---

## 一、MasterCard：Standard Currency Conversion Calculator API

### 1. 产品概述

| 项      | 值                                                                                          |
| ------- | ------------------------------------------------------------------------------------------- |
| 产品名  | Standard Currency Conversion Calculator                                                     |
| 服务 ID | `currency-conversion-calculator`                                                            |
| 文档    | https://developer.mastercard.com/currency-conversion-calculator/                            |
| 认证    | **OAuth 1.0a**（consumer key + RSA 私钥签名）                                               |
| 定价    | 免费（sandbox 与 production 均免费申请）                                                    |
| 说明    | 提供每日卡组织结算汇率（daily cardholder currency conversion rates），每天发布、24 小时有效 |

### 2. 申请步骤

1. **注册 Mastercard Developers 账号**

    - 访问 https://developer.mastercard.com ，点击 Sign Up / Register
    - 填写公司/个人邮箱，完成邮箱验证（个人开发者可申请）

2. **创建 Project**

    - 登录后进入 Project Dashboard → **Create New Project**
    - 选择产品 **Currency Conversion Calculator**
    - 完成项目创建后，系统生成 **Consumer Key** 与 **P12 私钥文件**（Key File，格式 `.p12`，需设置 Key Password）

3. **获取 sandbox 测试凭据**（即时）

    - 项目详情页的 Sandbox 环境 → Credentials 区域
    - 可见 `consumerKey`，并下载 `.p12` 私钥文件（含密码）

4. **申请 production 访问**（如需线上使用）
    - 在项目中选择 Production 环境 → 提交生产接入申请
    - MasterCard 审核通过后发放生产凭据（同一套 consumer key + 私钥，环境不同）

### 3. 认证方式（OAuth 1.0a）

每次请求需用 RSA 私钥对请求参数做 OAuth 1.0a 签名，`Authorization` 头形如：

```
Authorization: OAuth oauth_consumer_key="xxx", oauth_signature_method="RSA-SHA256", oauth_timestamp="...", oauth_nonce="...", oauth_version="1.0", oauth_signature="base64..."
```

**密钥转换**（P12 → RSA PEM，供 Node.js 使用）：

```bash
# P12 转 RSA 私钥（输入创建 key 时设置的密码）
openssl pkcs12 -in mykey.p12 | openssl rsa -out mykey.pem

# 若需要公钥/证书
openssl pkcs12 -in mykey.p12 -nokeys -clcerts -out cert.pem
```

**Node.js 推荐库**：

-   `oauth-1.0a` + `crypto`（自行实现 RSA-SHA256 签名）
-   或官方 `@mastercard/oauth1-signer`（npm：`@mastercard/oauth1-signer`）

示例（`@mastercard/oauth1-signer`）：

```ts
import { sign } from '@mastercard/oauth1-signer';
import axios from 'axios';
import fs from 'fs';

const consumerKey = process.env.MC_CONSUMER_KEY!;
const privateKey = fs.readFileSync(process.env.MC_KEY_PATH!);
const url =
    'https://sandbox.api.mastercard.com/settlement/currencyrate/conversion-rate?fxDate=2026-08-02&transCurr=CNY&crdhldBillCurr=USD&bankFee=0&transAmt=1';

const authHeader = sign({ method: 'GET', url }, { consumerKey, privateKey });
const { data } = await axios.get(url, {
    headers: { Authorization: authHeader },
});
// data = { data: { transAmt, conversionRate, crdhldBillAmt, fxDate } }
```

### 4. API 端点（与现有 getter 数据结构一致）

| 端点                      | 方法 | 说明                                     |
| ------------------------- | ---- | ---------------------------------------- |
| `/conversion-rate`        | GET  | 汇率换算（现有 getter 用的就是这个语义） |
| `/conversion-rate-issued` | GET  | 查询当日汇率是否已发布                   |
| `/settlement-currencies`  | GET  | 支持的币种列表                           |

**Sandbox 基址**：`https://sandbox.api.mastercard.com/settlement/currencyrate`
**Production 基址**：`https://api.mastercard.com/settlement/currencyrate`

**响应示例**（与现有 getter 解析的 `data.data.transAmt / data.data.conversionRate` 完全一致）：

```json
{
    "data": {
        "transCurr": "CNY",
        "transAmt": "1",
        "crdhldBillCurr": "USD",
        "crdhldBillAmt": "0.15",
        "conversionRate": "0.1500",
        "fxDate": "2026-08-02"
    }
}
```

> 现有 getter 的 `divide(transAmt, conversionRate)` 逻辑可直接复用，仅需替换请求方式（axios 直接 GET → 带 OAuth 签名的 GET）。

---

## 二、Visa：Foreign Exchange Rates API

### 1. 产品概述

| 项     | 值                                                                         |
| ------ | -------------------------------------------------------------------------- |
| 产品名 | Foreign Exchange Rates（FX Rates）                                         |
| 文档   | https://developer.visa.com/capabilities/foreign_exchange                   |
| 认证   | **Two-Way SSL（双向认证）** + 用户名/密码                                  |
| 定价   | 免费（sandbox 即时获取测试凭据；production 需审核）                        |
| 说明   | 提供 Visa 卡组织汇率；另有 Enhanced FX Rates API（含历史汇率，需单独申请） |

### 2. 申请步骤

1. **注册 Visa Developer 账号**

    - 访问 https://developer.visa.com → **Create Account**（免费）
    - 邮箱验证后进入 Developer Dashboard

2. **创建 Project**

    - Dashboard → **Start a Project / Add New Project**
    - 搜索并选择 **Foreign Exchange** 产品
    - （若产品带锁图标表示受限，需点击 **Request Access** 提交申请表单，管理员审核后开通）

3. **获取 sandbox 测试凭据**（即时）

    - 项目详情页 → Sandbox 环境 → **Credentials** 区域
    - 获取：**User ID / Password** + **API Key / Shared Secret**
    - 下载 **PKI 客户端证书**（`.p12` 格式，Visa 签发，用于双向 SSL）

4. **申请 production 访问**
    - 需完成 **production on-boarding**（Visa 会审核项目用途，确保合规使用）
    - 联系：`developer@visa.com`（或产品文档内的支持邮箱）
    - 审核通过后由 Visa 提供生产环境凭据

### 3. 认证方式（Two-Way SSL / Mutual TLS）

Visa 的 FX Rates API 使用**双向 SSL 认证**：客户端请求时必须携带 Visa 签发的客户端证书，且请求头含 `Authorization: Basic base64(userId:password)`。

**Node.js 调用要点**：

```ts
import axios from 'axios';
import fs from 'fs';

const httpsAgent = new (await import('https')).Agent({
    pfx: fs.readFileSync(process.env.VISA_P12_PATH!), // Visa 签发的客户端证书
    passphrase: process.env.VISA_P12_PASSWORD,
    rejectUnauthorized: true, // 生产必须校验服务器证书
});

const userId = process.env.VISA_USER_ID!;
const password = process.env.VISA_PASSWORD!;

const { data } = await axios.post(
    'https://sandbox.api.visa.com/forexrates/v1/foreignexchangerates',
    {
        sourceCurrencyCode: 'USD',
        destinationCurrencyCode: 'CNY',
        sourceAmount: '100.00',
        acquirerCountryCode: '840',
        acquiringBin: '408999',
        // ... 请求体字段
    },
    {
        httpsAgent,
        headers: {
            Authorization:
                'Basic ' +
                Buffer.from(`${userId}:${password}`).toString('base64'),
            'Content-Type': 'application/json',
        },
    },
);
```

> 注意：Visa 的 FX API 是 **POST + JSON 请求体**（需传 acquirer/transaction 上下文字段），与 MasterCard 的 GET 风格不同。现有 getter 需整体改写请求构造。

### 4. 环境端点

| 环境          | 基址                                          |
| ------------- | --------------------------------------------- |
| Sandbox       | `https://sandbox.api.visa.com/forexrates/v1/` |
| Certification | `https://cert.api.visa.com/forexrates/v1/`    |
| Production    | `https://api.visa.com/forexrates/v1/`         |

---

## 三、对比与决策建议

| 维度               | MasterCard                           | Visa                          |
| ------------------ | ------------------------------------ | ----------------------------- |
| 认证复杂度         | OAuth 1.0a 签名（中等）              | 双向 SSL + Basic Auth（较高） |
| sandbox 即时性     | ✅ 注册即用                          | ✅ 注册即用                   |
| production 门槛    | 表单申请                             | 需 on-boarding 审核（更严）   |
| 请求风格           | GET 查询参数                         | POST JSON body                |
| 与现有 getter 兼容 | **高**（数据结构完全一致，仅换认证） | 低（需重构请求构造）          |
| 汇率语义           | 每日结算汇率                         | 即时汇率                      |

**建议**：

1. **先申请 MasterCard**（认证相对简单、与现有代码兼容性高），作为主恢复方案
2. **Visa 可稍后**——production 审核更严，且请求构造需重写；若 fxrate 仅做展示，MasterCard 恢复后 Visa 可继续降级（`false`）
3. 凭据通过环境变量注入（`MC_CONSUMER_KEY` / `MC_KEY_PATH` / `VISA_P12_PATH` 等），**勿提交到仓库**

## 四、相关链接

-   MasterCard: https://developer.mastercard.com/currency-conversion-calculator/
-   MasterCard OAuth1.0a: https://developer.mastercard.com/platform/documentation/authentication/using-oauth-1a-to-access-mastercard-apis/
-   MasterCard Postman 快速开始: https://www.postman.com/mastercard/mastercard-developers/overview
-   Visa FX Rates: https://developer.visa.com/capabilities/foreign_exchange
-   Visa Quick Start: https://developer.visa.com/pages/working-with-visa-apis/visa-developer-quick-start-guide
-   Visa Two-way SSL: https://developer.visa.com/pages/working-with-visa-apis/two-way-ssl
