// 基金数据服务层:封装对东方财富接口的请求
// 职责:发请求、处理超时/错误映射、调用解析器、盘中估算
// 设计(spec §7):数据层不吞错,抛出有语义的错误类型

import { fetch } from "@tauri-apps/plugin-http";
import type {
  FundCandidate,
  FundDetail,
  FundEstimate,
  HoldingStock,
  StockQuote,
} from "../types/fund";
import { NetworkError, FundNotFoundError } from "../types/fund";
import { parsePingzhongdata, parseFundSearch } from "./parse";

const PINGZHONGDATA_URL = (code: string) =>
  `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
const FUND_SEARCH_URL = "https://fund.eastmoney.com/js/fundcode_search.js";
const HOLDINGS_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition";
const STOCK_QUOTE_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get";

const REQUEST_TIMEOUT = 10000;

interface FetchOptions {
  method?: "GET" | "POST";
  body?: string;
  referer?: string;
}

/** 统一的带超时 fetch 包装,返回文本 */
async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  try {
    const response = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: opts.referer ?? "https://fund.eastmoney.com/",
        ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: opts.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!response.ok) {
      throw new NetworkError(`接口返回状态码 ${response.status}`, response.status);
    }
    return await response.text();
  } catch (e) {
    if (e instanceof NetworkError) throw e;
    if (e instanceof FundNotFoundError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort") || msg.includes("timeout") || msg.includes("Timeout")) {
      throw new NetworkError("请求超时,请检查网络连接");
    }
    throw new NetworkError(`网络请求失败: ${msg}`);
  }
}

/** fetch JSON(用于持仓接口,响应是 JSON 而非 JS) */
async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new NetworkError(`JSON 解析失败: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * 获取基金详情(净值、走势、持仓、经理)
 */
export async function fetchFundDetail(code: string): Promise<FundDetail> {
  const text = await fetchText(PINGZHONGDATA_URL(code));
  return parsePingzhongdata(text, code);
}

/**
 * 获取基金搜索候选列表
 */
export async function fetchFundCandidates(): Promise<FundCandidate[]> {
  const text = await fetchText(FUND_SEARCH_URL);
  return parseFundSearch(text);
}

// ============ 持仓股 ============

interface FundMNInverstPositionResponse {
  Datas: {
    fundStocks: Array<{
      GPDM: string; // 代码
      GPJC: string; // 名称
      JZBL: string; // 持仓占比 %
      TEXCH: string; // 交易所 "1"=SH "2"=SZ
      INDEXNAME?: string; // 行业
    }> | null;
  } | null;
  Expansion: string | null; // 持仓截止日
  Success: boolean;
  ErrCode: number;
  ErrMsg: string;
}

/**
 * 获取基金前10重仓股(含占比、名称、持仓截止日)
 * 数据来源:季报,有滞后(截止日见返回的 asOf)
 */
export async function fetchHoldings(
  code: string
): Promise<{ holdings: HoldingStock[]; asOf: string | null }> {
  const data = await fetchJson<FundMNInverstPositionResponse>(HOLDINGS_URL, {
    method: "POST",
    referer: "https://mpservice.com/index.html",
    body: `FCODE=${code}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0`,
  });

  if (!data.Success) {
    throw new NetworkError(`持仓接口返回错误: ${data.ErrMsg}`);
  }

  const stocks = data.Datas?.fundStocks ?? [];
  const holdings: HoldingStock[] = stocks.map((s) => {
    const market = s.TEXCH === "1" ? "1" : "0"; // 1=SH, 2=SZ→0
    return {
      raw: `${market}.${s.GPDM}`,
      market,
      code: s.GPDM,
      name: s.GPJC,
      weight: Number(s.JZBL) || 0,
    };
  });

  return { holdings, asOf: data.Expansion ?? null };
}

// ============ 持仓股实时行情 ============

interface Push2UlistResponse {
  rc: number;
  data: {
    diff: Array<{
      f2: number; // 现价
      f3: number; // 涨跌幅 %
      f12: string; // 代码
      f14: string; // 名称
    }> | null;
  } | null;
}

/**
 * 批量获取股票实时行情
 * @param secids 形如 ["0.300308","1.688347"](marketPrefix.code)
 * @returns code -> StockQuote
 */
export async function fetchStockQuotes(
  secids: string[]
): Promise<Map<string, StockQuote>> {
  const result = new Map<string, StockQuote>();
  if (secids.length === 0) return result;

  const url = `${STOCK_QUOTE_URL}?fields=f2,f3,f12,f14&secids=${secids.join(",")}&fltt=2`;
  const data = await fetchJson<Push2UlistResponse>(url);

  if (data.rc !== 0 || !data.data?.diff) return result;

  for (const d of data.data.diff) {
    result.set(d.f12, {
      code: d.f12,
      name: d.f14,
      price: d.f2,
      changePct: d.f3,
    });
  }
  return result;
}

// ============ 盘中估算 ============

/**
 * 计算基金盘中估算涨幅与估算净值(纯函数,便于测试)
 *
 * 算法(加权混合模型):
 *   估算涨幅 = Σ(持仓股涨幅% × 持仓占比%) / 100
 *   估算净值 = 上一净值 × (1 + 估算涨幅/100)
 *
 * 模型解释:基金 = 前十重仓(已知波动)+ 剩余资产(未知)。
 * 已知的持仓按实际涨跌计入,剩余资产按"当日不动"假设(贡献0)。
 * 分母用 100(全基金),相当于把前十的波动摊到整个基金。
 *
 * 为什么不用纯归一化(分母=前十占比)?
 *   归一化会假设"剩余资产也按同样比例波动",对多数基金而言高估波动。
 *   实际上剩余 56% 资产(小盘股+债券+现金)波动通常小于重仓股,
 *   所以混合模型(剩余按0)更接近真实。真实值介于两者之间。
 *
 * coverage(覆盖率)反映这个估算的可信度:
 *   coverage 高(如 0.8)= 前十占基金 80%,估算接近真实
 *   coverage 低(如 0.3)= 只覆盖 30%,估算偏差较大,仅供参考
 *
 * 注:持仓占比是季报数据,有滞后,估算值仅供参考
 *
 * @param holdings 持仓(需有 weight)
 * @param quotes 持仓股实时行情
 * @param prevDwjz 上一交易日单位净值(基准)
 * @returns 估算结果(含覆盖率,供 UI 显示可信度),或 null(数据不足时)
 */
export function computeEstimate(
  holdings: HoldingStock[],
  quotes: Map<string, StockQuote>,
  prevDwjz: number
): (FundEstimate & { coverage: number }) | null {
  if (holdings.length === 0 || prevDwjz <= 0) return null;

  // 仅对有占比且有行情的持仓股累加
  let weightedSum = 0; // Σ(涨幅% × 占比%)
  let validWeightSum = 0; // 有效持仓占比合计(用于计算 coverage)
  let validCount = 0;
  for (const h of holdings) {
    if (!h.weight || h.weight <= 0) continue;
    const q = quotes.get(h.code);
    if (!q) continue;
    weightedSum += q.changePct * h.weight;
    validWeightSum += h.weight;
    validCount++;
  }

  // 至少要有 1 只有效数据才估算
  if (validCount === 0 || validWeightSum <= 0) return null;

  // 加权混合:分母用 100(全基金)。前十波动摊到整个基金,剩余资产按不动处理。
  const estGszl = weightedSum / 100;
  const estGsz = prevDwjz * (1 + estGszl / 100);

  return {
    estGsz,
    estGszl,
    estGztime: Date.now(),
    // 覆盖率:有效持仓占比合计 / 100(如 43.72 → 0.4372)
    coverage: validWeightSum / 100,
  };
}

/**
 * 判断当前是否为 A 股交易时段
 * 周一至周五 9:30-11:30, 13:00-15:00(节假日无法判断,粗略)
 */
export function isTradingHours(now: Date = new Date()): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // 周末

  const minutes = now.getHours() * 60 + now.getMinutes();
  // 9:30-11:30
  if (minutes >= 570 && minutes <= 690) return true;
  // 13:00-15:00
  if (minutes >= 780 && minutes <= 900) return true;
  return false;
}

/**
 * 批量获取多个基金的完整详情(含盘中估算)
 * 并发控制 + 单个失败不影响其它
 */
export async function fetchFundDetails(
  codes: string[],
  concurrency = 5
): Promise<Map<string, FundDetail | Error>> {
  const result = new Map<string, FundDetail | Error>();
  const queue = [...codes];
  const trading = isTradingHours();

  async function worker() {
    while (queue.length > 0) {
      const code = queue.shift();
      if (!code) break;
      try {
        const detail = await fetchFundDetail(code);

        // 交易时段才尝试估算(非交易时段省请求)
        if (trading && !detail.isHB && detail.holdings.length >= 0) {
          try {
            const { holdings, asOf } = await fetchHoldings(code);
            // 用持仓占比 + 名称丰富 holdings(覆盖 pingzhongdata 的纯代码版)
            if (holdings.length > 0) {
              detail.holdings = holdings;
              detail.holdingsAsOf = asOf ?? undefined;
            }

            const secids = holdings.map((h) => h.raw);
            const quotes = await fetchStockQuotes(secids);
            detail.quotes = quotes;

            const est = computeEstimate(holdings, quotes, detail.dwjz);
            if (est) detail.estimate = est;
          } catch (e) {
            // 估算失败不影响主数据,降级为只显示历史净值
            console.warn(`[estimate] ${code} 估算失败:`, e);
          }
        }

        result.set(code, detail);
      } catch (e) {
        result.set(code, e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, codes.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return result;
}
