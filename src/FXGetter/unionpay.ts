import axios from 'axios';
import { FXRate, currency } from 'src/types';

import { create, all } from 'mathjs';

const math = create(all, {
    number: 'Fraction',
});

const getUnionPayFXRates = async (): Promise<FXRate[]> => {
    let currentDate = parseInt(
        new Date().toISOString().split('T')[0].replaceAll('-', ''),
    );

    let res = await axios
        .get(`https://www.unionpayintl.com/upload/jfimg/${currentDate}.json`, {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        })
        .catch(() => {
            return { status: 404 };
        });

    while (res.status !== 200) {
        currentDate -= 1;

        console.log(
            currentDate + 1,
            'UnionPay FXRate not found, trying',
            currentDate,
        );

        res = await axios.get(
            `https://www.unionpayintl.com/upload/jfimg/${currentDate}.json`,
            {
                headers: {
                    'User-Agent':
                        process.env['HEADER_USER_AGENT'] ??
                        'fxrate axios/latest',
                },
            },
        );
    }

    const data: {
        exchangeRateJson: {
            transCur: currency;
            baseCur: currency;
            rateData: number;
        }[];
        curDate: string;
    } = (res as any).data;

    const date = new Date(`${data.curDate} 16:30 UTC+8`);

    const answerMap: {
        [from: string]: {
            [to: string]: {
                forward: number;
                reverse: number;
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
