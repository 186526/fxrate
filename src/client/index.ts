export interface infoResponse {
    environment: string;
    sources: string[];
    version: string;
    status: 'ok' | string;
    apiVersion: string;
}

export interface fxRateResponse {
    cash?: number | string;
    middle: number | string;
    remit?: number | string;
    updated: Date;
}

export interface fxRateListResponse {
    [currency: string]: fxRateResponse;
}

export interface currencyListResponse {
    currency: string[];
    date: Date;
}

export type getFXRateResponse = number | string | fxRateResponse;

export interface jsonRpcResponse {
    error?: {
        message: string;
        data: unknown;
    };
    id: string;
    result: unknown;
}

interface pendingCallback {
    resolve: (resp: unknown) => void;
    reject: (reason?: unknown) => void;
}

type wireFXRateResponse = Omit<fxRateResponse, 'updated'> & {
    updated: string | number | Date;
};

const requestTimeout = 30_000;

const toDate = (date: string | number | Date): Date =>
    new Date(date instanceof Date ? date.getTime() : date);

const toError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

const isJsonRpcResponse = (response: unknown): response is jsonRpcResponse =>
    typeof response === 'object' &&
    response !== null &&
    'id' in response &&
    typeof response.id === 'string';

class FXRates {
    public endpoint: URL;

    private requestDetails: { methods: string; params: unknown; id: string }[] =
        [];
    private callbacks: { [id: string]: pendingCallback } = {};

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

    private addToQueue<T = unknown>(
        method: string,
        params: unknown,
        callback?: (resp: T) => void,
        transform: (resp: unknown) => T = (resp) => resp as T,
    ): this | Promise<T> {
        const id = this.generateID();

        this.requestDetails.push({
            methods: method,
            params: params,
            id: id,
        });

        if (this.inBatch) {
            this.callbacks[id] = {
                resolve: (resp) => callback?.(transform(resp)),
                reject: () => undefined,
            };
            return this;
        }

        const answer = new Promise<T>((resolve, reject) => {
            this.callbacks[id] = {
                resolve: (resp) => {
                    const result = transform(resp);
                    resolve(result);
                    callback?.(result);
                },
                reject,
            };
        });

        this.done().catch(() => undefined);

        return answer;
    }

    info(callback?: (resp: infoResponse) => void) {
        return this.addToQueue<infoResponse>('instanceInfo', '', callback);
    }

    listCurrencies(
        source: string,
        callback?: (resp: currencyListResponse) => void,
    ) {
        return this.addToQueue<currencyListResponse>(
            'listCurrencies',
            { source },
            callback,
            (resp) => {
                const { currency, date } = resp as {
                    currency: string[];
                    date: string | number | Date;
                };
                return {
                    currency,
                    date: toDate(date),
                };
            },
        );
    }

    listFXRates(
        source: string,
        from: string,
        callback?: (resp: fxRateListResponse) => void,
        precision = 2,
        amount = 100,
        fees = 0,
        reverse = false,
        bfs = false,
    ) {
        return this.addToQueue<fxRateListResponse>(
            'listFXRates',
            { source, from, precision, amount, fees, reverse, bfs },
            callback,
            (resp) => {
                const response = resp as Record<string, wireFXRateResponse>;
                const anz: fxRateListResponse = {};
                for (const x in response) {
                    anz[x] = {
                        middle: response[x].middle,
                        updated: toDate(response[x].updated),
                    };
                    if (response[x].cash) anz[x].cash = response[x].cash;
                    if (response[x].remit) anz[x].remit = response[x].remit;
                }
                return anz;
            },
        );
    }

    getFXRate(
        source: string,
        from: string,
        to: string,
        callback: (rates: getFXRateResponse) => void,
        type: 'cash' | 'remit' | 'middle' | 'all' = 'all',
        precision = 2,
        amount = 100,
        fees = 0,
        reverse = false,
        bfs = false,
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
                bfs,
            },
            callback,
            (resp) => {
                if (typeof resp === 'object' && resp !== null) {
                    const rate = resp as wireFXRateResponse;
                    return {
                        ...rate,
                        updated: toDate(rate.updated),
                    };
                }
                return resp as number | string;
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

        if (requestDetails.length === 0) return;

        const responseBody = requestDetails.map(
            (k) =>
                new Object({
                    jsonrpc: '2.0',
                    id: k.id,
                    method: k.methods,
                    params: k.params,
                }),
        );

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeout);
        const rejectAll = (error: Error) => {
            Object.values(callbacks).forEach(({ reject }) => reject(error));
        };

        try {
            const resp = await this.fetch(this.endpoint, {
                method: 'POST',
                body: JSON.stringify(responseBody),
                signal: controller.signal,
            });

            let body: unknown;
            const content = await resp.text();

            try {
                body = JSON.parse(content);
            } catch (error) {
                console.error(error);
                console.error(content);
                console.error(responseBody);
                throw new Error('Error parsing response');
            }

            const responses = body instanceof Array ? body : [body];
            const pendingIDs = new Set(Object.keys(callbacks));
            let firstError: Error | undefined;

            responses.forEach((response) => {
                if (!isJsonRpcResponse(response)) {
                    firstError ??= new Error('Invalid JSON-RPC response');
                    return;
                }

                const callback = callbacks[response.id];
                if (!callback || !pendingIDs.has(response.id)) return;
                pendingIDs.delete(response.id);

                if (response.error) {
                    const error = new Error(
                        response.error.message +
                            '\n' +
                            String(response.error.data),
                    );
                    callback.reject(error);
                    firstError ??= error;
                    return;
                }

                try {
                    callback.resolve(response.result);
                } catch (error) {
                    const callbackError = toError(error);
                    callback.reject(callbackError);
                    firstError ??= callbackError;
                }
            });

            pendingIDs.forEach((id) => {
                const error = new Error(
                    `Missing JSON-RPC response for request ${id}`,
                );
                callbacks[id].reject(error);
                firstError ??= error;
            });

            if (firstError) throw firstError;
        } catch (error) {
            const requestError = controller.signal.aborted
                ? new Error(`Request timed out after ${requestTimeout}ms`)
                : toError(error);
            rejectAll(requestError);
            throw requestError;
        } finally {
            clearTimeout(timeout);
        }

        return;
    }
}

export default FXRates;
