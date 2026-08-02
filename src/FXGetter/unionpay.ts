import axios, { AxiosResponse } from 'axios';
import { FXRate, currency } from 'src/types.d';

import { create, all } from 'mathjs';

const math = create(all, {
    number: 'Fraction',
});

const MAX_WALK_BACK_DAYS = 7;
const MAX_RETRIES = 2;

const fetchDateFile = async (date: number): Promise<AxiosResponse> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await axios.get(
                `https://www.unionpayintl.com/upload/jfimg/${date}.json`,
                {
                    timeout: 10000,
                    headers: {
                        'User-Agent':
                            process.env['HEADER_USER_AGENT'] ??
                            'fxrate axios/latest',
                    },
                },
            );
        } catch (e) {
            if (axios.isAxiosError(e) && e.response?.status === 404) {
                throw e;
            }
            lastError = e;
        }
    }
    throw lastError;
};

const getUnionPayFXRates = async (): Promise<FXRate[]> => {
    const today = parseInt(
        new Date().toISOString().split('T')[0].replaceAll('-', ''),
    );

    let res: AxiosResponse | undefined;

    for (let day = 0; day <= MAX_WALK_BACK_DAYS; day++) {
        try {
            const current = await fetchDateFile(today - day);
            if (current.status === 200) {
                res = current;
                break;
            }
        } catch (e) {
            if (!(axios.isAxiosError(e) && e.response?.status === 404)) {
                throw e;
            }
        }
    }

    if (!res) {
        throw new Error(
            'UnionPay FXRate file not found within the last 7 days',
        );
    }

    const data: {
        exchangeRateJson: {
            transCur: currency;
            baseCur: currency;
            rateData: number;
        }[];
        curDate: string;
    } = res.data;

    const date = new Date(`${data.curDate} 16:30 UTC+8`);

    const answerMap: {
        [from: string]: {
            [to: string]: {
                forward?: number;
                reverse?: number;
            };
        };
    } = {};

    data.exchangeRateJson.forEach((rate) => {
        let firstCurr = rate.transCur,
            secondCurr = rate.baseCur,
            isReverse = false;

        if (!answerMap[rate.transCur]) {
            if (answerMap[rate.baseCur]) {
                firstCurr = rate.baseCur;
                secondCurr = rate.transCur;
                isReverse = true;
            }
        }

        if (!answerMap[firstCurr]) {
            answerMap[firstCurr] = {};
        }

        if (!answerMap[firstCurr][secondCurr]) {
            answerMap[firstCurr][secondCurr] = {
                forward: undefined,
                reverse: undefined,
            };
        }

        if (isReverse) {
            answerMap[firstCurr][secondCurr].reverse = math.divide(
                1,
                rate.rateData,
            );
        } else {
            answerMap[firstCurr][secondCurr].forward = rate.rateData;
        }
    });

    const answer: FXRate[] = [];

    Object.keys(answerMap).forEach((from) => {
        Object.keys(answerMap[from]).forEach((to) => {
            const k: FXRate = {
                currency: {
                    from: from as currency,
                    to: to as currency,
                },
                rate: {},
                updated: date,
                unit: 1,
            };
            if (answerMap[from][to].forward) {
                k.rate.sell = {
                    remit: answerMap[from][to].forward,
                    cash: answerMap[from][to].forward,
                };
            }
            if (answerMap[from][to].reverse) {
                k.rate.buy = {
                    remit: answerMap[from][to].reverse,
                    cash: answerMap[from][to].reverse,
                };
            }
            answer.push(k);
        });
    });

    return answer.sort();
};

export default getUnionPayFXRates;
