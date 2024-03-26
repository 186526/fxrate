class FXRates {
    public endpoint: URL;

    private requestDetails: { methods: string; params: any; id: string }[] = [];
    private callbacks: { [id: string]: (resp: any) => any } = {};

    private inBatch = false;

    generateID() {
        function _p8(s?: boolean) {
            const p = (Math.random().toString(16) + '000000000').substr(2, 8);
            return s ? '-' + p.substr(0, 4) + '-' + p.substr(4, 4) : p;
        }
        return _p8() + _p8(true) + _p8(true) + _p8();
    }
    constructor(endpoint: URL = new URL('http://localhost:8080/v1/jsonrpc')) {
        this.endpoint = endpoint;
    }

    private addToQueue(
        method: string,
        params: any,
        callback?: (resp: any) => any,
    ) {
        const id = this.generateID();

        this.requestDetails.push({
            methods: method,
            params: params,
            id: id,
        });

        this.callbacks[id] = callback;

        if (this.inBatch) return this;
        else {
            const answer = new Promise((resolve) => {
                this.callbacks[id] = resolve;
            });

            this.done();

            return answer;
        }
    }

    info(
        callback?: (resp: {
            environment: string;
            sources: string[];
            version: string;
            status: 'ok' | string;
            apiVersion: string;
        }) => any,
    ) {
        return this.addToQueue('instanceInfo', '', callback);
    }

    listCurrencies(
        source: string,
        callback?: (resp: { currency: string[]; date: Date }) => any,
    ) {
        return this.addToQueue(
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
        callback?: (resp: {
            [currency: string]: {
                cash?: number | string;
                middle: number | string;
                remit?: number | string;
                updated: Date;
            };
        }) => any,
        precision = 2,
        amount = 100,
        fees = 0,
        reverse = false,
    ) {
        return this.addToQueue(
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
        type: 'cash' | 'remit' | 'middle',
        callback: (rates: number | string) => any,
        precision = 2,
        amount = 100,
        fees = 0,
        reverse = false,
    ) {
        return this.addToQueue(
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
            callback,
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

        const resp = await fetch(this.endpoint, {
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

        return 0;
    }
}

export default FXRates;
