# FXRate

Yet another foreign exchange rate API project.

---

## Usage

Test URL: <https://fxrate.sunoaki.net/>

Web UI: [186526/fxrate-web](https://github.com/186526/fxrate-web) (Still work in progress)

### Rest API v1 Usage

-   `GET (/v1)/info` - show instance's details.

```typescript
type source = string;

interface result {
    status: 'ok' as string;
    sources: source[];
    version: string;
    apiVersion: 'v1';
    environment: 'production' | 'development';
}

export default result;
```

-   `GET (/v1)/:source/` - show source's details.

```typescript
enum currency {
    // For example
    USD = 'USD';
}

type UTCString = string;

interface result {
    status: 'ok' as string;
    source: source;
    currency: currency[];
    date: UTCString;
}

export default result;
```

-   `GET (/v1)/:source/:from(?reverse&precision&amount&fees)` - show currency's FX rates to other currency in source's db.

```typescript
// query use ?reverse means calculating how much currency is needed to obtain the $amount $from currency is needed.
// query use ?precision means get data rounded to $precision decimal place. use -1 as the flag means that getting infinite recurrent decimal.
// query use ?amount means convert from/to $amount currency.
// query use ?fees means add $fees% ftf.
interface FXRate {
    updated: UTCString;
    // number: 721.55
    // string: 721.(55)
    cash: number | string | false;
    remit: number | string | false;
    middle: number | string;
}

interface result {
    [to in keyof curreny]: FXRate;
}

return result;
```

-   `GET (/v1)/:source/:from/:to(?reverse&precision&amount&fees&bfs)` - show currency's FX rates to other currency in source's db.

```typescript
// query use ?bfs=1 means allowing cross-rate path finding (BFS) when no direct pair exists,
// e.g. USD/JPY on ncb.hk goes through USD → HKD → JPY. When enabled, the response
// additionally returns the actual path walked: { ..., path: ["USD", "HKD", "JPY"] }.
// BFS is OFF by default because cross rates accumulate rounding errors.
type result = FXRate & { path?: string[] };

export default result;
```

-   `GET (/v1)/:source/:from/:to/:type(/:amount)(?reverse&precision&amount&fees)` - show currency's FX rates to other currency in source's db.

```typescript
type result = FXRate;

export default result[type];
```

### JSONRPC v2 API Usage

Endpoint `(/v1)/jsonrpc` (also `(/v1)/jsonrpc/v2`)

-   `instanceInfo`

    Params: `undefined`  
    Response: Follow `GET (/v1)/info`

-   `listCurrencies`

    Params:

    ```typescript
    {
        source: string;
    }
    ```

    Response: Follow `GET (/v1)/:source/`

-   `listFXRates`

    Params:

    ```typescript
    {
        source: string;
        from: currency;
        precision: number = 2;
        amount: number = 100;
        fees: number = 0;
        reverse: boolean = false;
        bfs: boolean = false; // allow BFS cross-rate path finding (same as ?bfs=1)
    }
    ```

    Response: Follow `GET (/v1)/:source/:from(?reverse&precision&amount&fees)`

-   `getFXRate`

    Params:

    ```typescript
    {
        source: string;
        from: currency;
        to: currency;
        type: 'remit' | 'cash' | 'middle' | 'all';
        precision: number = 2;
        amount: number = 100;
        fees: number = 0;
        reverse: boolean = false;
        bfs: boolean = false;
    }
    ```

    Response: Follow `GET (/v1)/:source/:from/:to/:type(/:amount)(?reverse&precision&amount&fees&bfs)`

## Running

Some APIs require configuration tokens to work properly.

| environment variables | value             | details                                                     | defaults              |
| --------------------- | ----------------- | ----------------------------------------------------------- | --------------------- |
| `PORT`                | `number`          | HTTP listen port                                            | `8080`                |
| `LOG_LEVEL`           | `error`           | silence `fxmManager.log` logs                               | —                     |
| `ENABLE_WISE`         | `1 \| 0`          | Enable Wise FX Rates API                                    | `0`                   |
| `WISE_TOKEN`          | `string`          | configure Wise's API Token                                  | `null`                |
| `WISE_SANDBOX_API`    | `1 \| 0`          | Using Wise's sandbox API environment.                       | `0`                   |
| `ENABLE_CORS`         | `domain`          | configure FXRate's API to allow CORS                        | `null`                |
| `HEADER_USER_AGENT`   | `userAgentString` | configure spider to use which user agent to fetch from site | `fxrate axios/latest` |
| `CHROMIUM_PATH`       | `path`            | chromium executable for Visa anti-bot fallback              | auto-detected         |
| `VERCEL`              | `1`               | Vercel deployment mode (no local listen)                    | —                     |

```bash
yarn install
yarn dev

## In production

yarn start
```

### Notes on Mastercard / Visa rates

Both providers publish a settlement rate **once per day** (US Eastern time). They are fetched on demand and cached for 30 minutes:

-   **mastercard**: new public API `marketingservices/public/mccom-services/currency-conversions/conversion-rates`. Must use Node's native `fetch` (undici TLS/HTTP2 fingerprint) — axios/curl are rejected with 403 by Akamai. Falls back up to 7 days when today's rate is not yet published (401).
-   **visa**: `visa.co.in/cmsapi/fx/rates` (India domain has the most permissive WAF). Plain `fetch` may still hit Cloudflare 403; in that case a headless chromium instance directly opens the API URL (requires `playwright-core` + a chromium binary, see `CHROMIUM_PATH`). Without chromium (e.g. Vercel serverless) the source degrades to `false`.

## License

```markdown
The program's code is under MIT LICENSE (SEE LICENSE IN LICENSE.MIT).

Data copyright belongs to its source (SEE LICENSE IN LICENSE.DATA).
```
