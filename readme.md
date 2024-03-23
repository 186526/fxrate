# FXRate

Yet another foreign exchange rate API project.

---

## Usage

Test URL: <https://fxrate.186526.eu.org/>

### API v1 Usage

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

-   `GET (/v1)/:source/:from(?reverse&precision&amount)` - show currency's FX rates to other currency in source's db.

```typescript
// query use ?reverse means calculating how much currency is needed to obtain the $amount $from currency is needed.
// query use ?precision means get data rounded to $precision decimal place. use -1 as the flag means that getting infinite recurrent decimal.
// query use ?amount means convert from/to $amount currency.
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

-   `GET (/v1)/:source/:from/:to(?reverse&precision&amount)` - show currency's FX rates to other currency in source's db.

```typescript
// query use ?reverse means calculating how much currency is needed to obtain the $amount $from currency is needed.
// query use ?precision means get data rounded to $precision decimal place. use -1 as the flag means that getting infinite recurrent decimal.
// query use ?amount means convert from/to $amount currency.
type result = FXRate;

export default result;
```

-   `GET (/v1)/:source/:from/:to/:type(/:amount)(?reverse&precision&amount)` - show currency's FX rates to other currency in source's db.

```typescript
// query use ?reverse means calculating how much currency is needed to obtain the $amount $from currency is needed.
// query use ?precision means get data rounded to $precision decimal place. use -1 as the flag means that getting infinite recurrent decimal.
// query use ?amount means convert from/to $amount currency.
type result = FXRate;

export default result[type];
```

## Running

Some APIs require configuration tokens to work properly.

| environment variables | value    | details                               |
| --------------------- | -------- | ------------------------------------- |
| ENABLE_WISE           | `1 \| 0` | Enable Wise FX Rates API              |
| WISE_TOKEN            | `string` | configure Wise's API Token            |
| WISE_SANDBOX_API      | `1 \| 0` | Using Wise's sandbox API environment. |

```bash
yarn install
yarn start
```

## License

```markdown
The Program's code is under MIT LICENSE (SEE LICENSE IN LICENSE.MIT).

Data copyright belongs to its source (SEE LICENSE IN LICENSE.DATA).
```
