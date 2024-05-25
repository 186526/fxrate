interface infoResponse {
    environment: string;
    sources: string[];
    version: string;
    status: 'ok' | string;
    apiVersion: string;
}

interface fxRateResponse {
    cash?: number | string;
    middle: number | string;
    remit?: number | string;
    updated: Date;
}

interface fxRateListResponse {
    [currency: string]: fxRateResponse;
}

interface currencyListResponse {
    currency: string[];
    date: Date;
}

type getFXRateResponse = number | string | fxRateResponse;

class FXRates {
    public endpoint: URL;

    private requestDetails: { methods: string; params: any; id: string }[] = [];
    private callbacks: { [id: string]: (resp: any) => any } = {};

    private inBatch = false;

    protected fetch = globalThis.fetch.bind(globalThis);

    private generateID() {
        function _p8(s?: boolean) {
            const p = (Math.random().toString(16) + '000000000').substr(2, 8);
            return s ? '-' + p.substr(0, 4) + '-' + p.substr(4, 4) : p;
        }
        return _p8() + _p8(true) + _p8(true) + _p8();
    }
    constructor(endpoint: URL = new URL('http://localhost:8080/v1/jsonrpc')) {
        this.endpoint = endpoint;
    }

    private addToQueue<T = any>(
        method: string,
        params: any,
        callback?: (resp: T) => any,
    ): this | Promise<T> {
        const id = this.generateID();

        this.requestDetails.push({
            methods: method,
            params: params,
            id: id,
        });

        this.callbacks[id] = callback;

        if (this.inBatch) return this;
        else {
            const answer = new Promise<T>((resolve) => {
                this.callbacks[id] = resolve;
            });

            this.done();

            return answer;
        }
    }

    info(callback?: (resp: infoResponse) => any) {
        return this.addToQueue<infoResponse>('instanceInfo', '', callback);
    }

    listCurrencies(
        source: string,
        callback?: (resp: currencyListResponse) => any,
    ) {
        return this.addToQueue<currencyListResponse>(
            'listCurrencies',
            { source },
            ({ currency, date }) => {
                callback({
                    currency,
                    date: new Date(date),
                });
            },
        );
    }

    listFXRates(
        source: string,
        from: string,
        callback?: (resp: fxRateListResponse) => any,
        precision = 2,
        amount = 100,
        fees = 0,
        reverse = false,
    ) {
        return this.addToQueue<fxRateListResponse>(
            'listFXRates',
            { source, from, precision, amount, fees, reverse },
            (resp) => {
                const anz = {};
                for (const x in resp) {
                    anz[x] = {};
                    if (resp[x].cash) anz[x].cash = resp[x].cash;
                    if (resp[x].remit) anz[x].remit = resp[x].remit;
                    anz[x].middle = resp[x].middle;
                    anz[x].updated = new Date(resp[x].updated);
                }
                callback(anz);
            },
        );
    }

    getFXRate(
        source: string,
        from: string,
        to: string,
        callback: (rates: getFXRateResponse) => any,
        type: 'cash' | 'remit' | 'middle' | 'all' = 'all',
        precision = 2,
        amount = 100,
        fees = 0,
        reverse = false,
    ) {
        return this.addToQueue<getFXRateResponse>(
            'getFXRate',
            {
                source,
                from,
                to,
                type,
                precision,
                amount,
                fees,
                reverse,
            },
            (resp) => {
                if (typeof resp == 'object') {
                    resp.updated = new Date(resp.updated);
                    callback(resp);
                } else callback(resp);
            },
        );
    }

    batch() {
        this.inBatch = true;
        return this;
    }

    async done() {
        this.inBatch = false;

        const requestDetails = this.requestDetails,
            callbacks = this.callbacks;

        this.requestDetails = [];
        this.callbacks = {};

        const responseBody = requestDetails.map(
            (k) =>
                new Object({
                    jsonrpc: '2.0',
                    id: k.id,
                    method: k.methods,
                    params: k.params,
                }),
        );

        const resp = await this.fetch(this.endpoint, {
            method: 'POST',
            body: JSON.stringify(responseBody),
        });

        const body = await resp.json();

        const handler = (k) => {
            if (k.error) {
                throw new Error(k.error.message + '\n' + k.error.data);
            }

            callbacks[k.id](k.result);
        };

        if (body instanceof Array) {
            body.forEach(handler);
        } else handler(body);

        return;
    }
}

export default FXRates;
