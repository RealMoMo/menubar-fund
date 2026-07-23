// 基金相关类型定义

/** 单个净值点 */
export interface NetWorthPoint {
  /** 时间戳 (ms) */
  x: number;
  /** 单位净值 */
  y: number;
  /** 日收益率 (%) */
  equityReturn: number;
}

/** 基金搜索候选项(fundcode_search.js 解析) */
export interface FundCandidate {
  code: string;
  pinyin: string;
  name: string;
  type: string;
  quanpin: string;
}

/** 自选基金(持久化的核心结构) */
export interface FundItem {
  code: string;
  name: string;
  addedAt: number;
  /** 覆盖全局涨超阈值(%),null=该基金关此方向。仅 alertOverride=true 时生效 */
  alertUp?: number | null;
  /** 覆盖全局跌超阈值(%),null=该基金关此方向。仅 alertOverride=true 时生效 */
  alertDown?: number | null;
  /** true=用本基金自己的阈值,缺省/false=跟随全局设置 */
  alertOverride?: boolean;
}

/** 基金经理 */
export interface FundManager {
  name: string;
  pic?: string;
  star?: number;
  workTime?: string;
  fundSize?: string;
}

/** 持仓股 */
export interface HoldingStock {
  /** 市场前缀+代码,如 "0.300308" */
  raw: string;
  market: string;
  code: string;
  /** 股票名称 */
  name?: string;
  /** 持仓占比 (%) */
  weight?: number;
}

/** 持仓股实时行情 */
export interface StockQuote {
  code: string;
  name: string;
  /** 现价 */
  price: number;
  /** 涨跌幅 (%) */
  changePct: number;
}

/** 盘中估算结果 */
export interface FundEstimate {
  /** 估算净值 */
  estGsz: number;
  /** 估算涨幅 (%) */
  estGszl: number;
  /** 估算时间戳 (ms) */
  estGztime: number;
  /** 覆盖率(0-1):有效持仓占基金总资产的比例,反映估算可信度 */
  coverage?: number;
}

/** 基金详情(pingzhongdata 解析出的完整数据) */
export interface FundDetail {
  code: string;
  name: string;
  /** 是否货币基金 */
  isHB: boolean;
  /** 原费率 */
  sourceRate?: number;
  /** 起购金额 */
  minsg?: number;
  /** 最新单位净值 */
  dwjz: number;
  /** 最新净值日期 (ms) */
  dwjzDate: number;
  /** 最近交易日收益率 (%) */
  equityReturn: number;
  /** 历史净值序列 */
  netWorthTrend: NetWorthPoint[];
  /** 近1年/1月/3年/6月收益率 (%) */
  syl1n?: number;
  syl1y?: number;
  syl3y?: number;
  syl6y?: number;
  /** 基金经理 */
  managers: FundManager[];
  /** 十大持仓股 */
  holdings: HoldingStock[];
  /** 持仓截止日(季报日期,如 "2026-06-30") */
  holdingsAsOf?: string;
  /** 盘中估算(交易时段才有,非交易时段为 undefined) */
  estimate?: FundEstimate;
  /** 持仓股实时行情(code -> quote),详情页用 */
  quotes?: Map<string, StockQuote>;
}

/** 有语义的错误类型(spec §7.1) */
export class NetworkError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "NetworkError";
    this.statusCode = statusCode;
  }
}

export class FundNotFoundError extends Error {
  code: string;
  constructor(code: string) {
    super(`未找到基金 ${code}`);
    this.name = "FundNotFoundError";
    this.code = code;
  }
}

export class ParseError extends Error {
  rawExcerpt?: string;
  constructor(message: string, rawExcerpt?: string) {
    super(message);
    this.name = "ParseError";
    this.rawExcerpt = rawExcerpt;
  }
}
