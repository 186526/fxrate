/**
 * Represents exchange rate and pricing information returned from the SPDB remote service.
 *
 * This interface models a flat (string-valued) payload typically obtained from a SOAP/HTTP response.
 * All fields are represented as strings in the original payload; numeric values may be formatted with
 * fixed decimals and should be parsed to numbers by consumers when needed.
 *
 * @remarks
 * Keep in mind:
 * - Timestamp fields use the source format (e.g. "YYYY.MM.DD HH:mm:ss") and may require parsing.
 * - Price and rate fields are often scaled (e.g. "100.000000") and may represent per-unit or per-100 units,
 *   depending on ExgRtUnt.
 *
 * @property RET - Raw response fragment (often contains the beginning of a SOAP/XML envelope).
 * @property ReturnCode - Service return/response code (empty string when no code is present).
 * @property UnchSellPrc - "Unchanged" sell price (string-formatted decimal).
 * @property docid - Document identifier for the record.
 * @property AnlSetlExgRt - Analytical settlement exchange rate (string-formatted decimal).
 * @property SellPrc - Sell price (string-formatted decimal).
 * @property CurrencyId - Currency identifier/code (e.g. "01").
 * @property CurrencyName - Human readable currency name like '美元 USD'.
 * @property CashBuyPrc - Cash buy price (string-formatted decimal).
 * @property CREATE_DATE - Creation date/time as provided by the source (e.g. "2025.10.20 22:30:16").
 * @property BuyPrc - Buy price (string-formatted decimal).
 * @property MdlPrc - Middle/median price or model price (string-formatted decimal).
 * @property CashSellPrc - Cash sell price (string-formatted decimal).
 * @property UnchBuyPrc - "Unchanged" buy price (string-formatted decimal).
 * @property USDCnvrPrc - USD conversion price (string-formatted decimal; may be used to derive cross-rates).
 * @property ctime - Processing or cache time indicator (source-specific meaning; often numeric string).
 * @property state - State or status code for the record (source-specific string).
 * @property ExgRtUnt - Exchange rate unit (e.g. "100" means rates are per 100 units).
 * @property EurSetlPrc - EUR settlement price (string-formatted decimal).
 *
 */

export interface SPDBFXReqInfo {
    RET: string;
    ReturnCode: string;
    UnchSellPrc: string;
    docid: string;
    AnlSetlExgRt: string;
    SellPrc: string;
    CurrencyId: string;
    CurrencyName: string;
    CashBuyPrc: string;
    CREATE_DATE: string;
    BuyPrc: string;
    MdlPrc: string;
    CashSellPrc: string;
    UnchBuyPrc: string;
    USDCnvrPrc: string;
    ctime: string;
    state: string;
    ExgRtUnt: string;
    EurSetlPrc: string;
}
