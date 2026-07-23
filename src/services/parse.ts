// pingzhongdata / fundcode_search.js 解析器
// 设计原则(spec §7.3):用正则提取,绝不 eval;每字段独立容错

import type {
  FundCandidate,
  FundDetail,
  FundManager,
  HoldingStock,
  NetWorthPoint,
} from "../types/fund";
import { FundNotFoundError, ParseError } from "../types/fund";

/** 安全提取第一个 var = "值" 的字符串值 */
function extractString(text: string, varName: string): string | undefined {
  // 兼容有无空格:var name="x" / var name = "x"
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*"([^"]*)"`);
  const m = text.match(re);
  return m ? m[1] : undefined;
}

/** 安全提取 var = 标量(非引号,如 ishb=false) */
function extractScalar(text: string, varName: string): string | undefined {
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*([a-zA-Z0-9.]+)`);
  const m = text.match(re);
  return m ? m[1] : undefined;
}

/** 安全提取 var = [数组字面量],返回解析后的值或 undefined */
function extractArray<T>(text: string, varName: string): T[] | undefined {
  // 匹配 "name =[" 或 "name = [" 后到匹配的 "]"
  // 数组可能很长且含嵌套,用平衡括号扫描而非贪婪正则
  const startRe = new RegExp(`${varName}\\s*=\\s*\\[`);
  const startMatch = text.match(startRe);
  if (!startMatch) return undefined;

  const start = startMatch.index! + startMatch[0].length - 1; // 指向 '['
  let depth = 0;
  let inStr = false;
  let quote = "";
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i++; // 跳过转义字符
        continue;
      }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return undefined;

  const arrLiteral = text.slice(start, end + 1);
  try {
    return JSON.parse(arrLiteral) as T[];
  } catch {
    return undefined;
  }
}

function safeNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * 解析 pingzhongdata 响应,提取基金详情
 * @param text pingzhongdata/<code>.js 的原文
 * @param code 基金代码(用于错误信息)
 */
export function parsePingzhongdata(text: string, code: string): FundDetail {
  const name = extractString(text, "fS_name");

  // 若连基金名都取不到,基本是无效响应
  if (!name) {
    // 明确的 404/页面未找到 → 基金不存在
    if (text.includes("页面未找到") || text.includes("404 Not Found")) {
      throw new FundNotFoundError(code);
    }
    // 其它(空响应、乱码、接口变更)→ 解析错误
    throw new ParseError(`无法解析基金 ${code} 的名称字段`, text.slice(0, 200));
  }

  const isHB = extractScalar(text, "ishb") === "true";
  const sourceRate = safeNumber(extractString(text, "fund_sourceRate"));
  const minsg = safeNumber(extractString(text, "fund_minsg"));

  const syl1n = safeNumber(extractString(text, "syl_1n"));
  const syl1y = safeNumber(extractString(text, "syl_1y"));
  const syl3y = safeNumber(extractString(text, "syl_3y"));
  const syl6y = safeNumber(extractString(text, "syl_6y"));

  // 净值序列
  const netWorthTrend =
    extractArray<NetWorthPoint>(text, "Data_netWorthTrend") ?? [];

  // 最新净值与收益率
  let dwjz = 0;
  let dwjzDate = 0;
  let equityReturn = 0;
  if (netWorthTrend.length > 0) {
    const last = netWorthTrend[netWorthTrend.length - 1];
    dwjz = last.y;
    dwjzDate = last.x;
    equityReturn = last.equityReturn ?? 0;
  }

  // 基金经理
  const managerRaw =
    extractArray<FundManager>(text, "Data_currentFundManager") ?? [];
  const managers: FundManager[] = managerRaw.map((m) => ({
    name: m.name,
    pic: m.pic,
    star: m.star,
    workTime: m.workTime,
    fundSize: m.fundSize,
  }));

  // 持仓股
  const stockCodesNew = extractArray<string>(text, "stockCodesNew") ?? [];
  const holdings: HoldingStock[] = stockCodesNew.map((raw) => {
    const [market, scode] = raw.split(".");
    return { raw, market: market ?? "", code: scode ?? "" };
  });

  return {
    code,
    name,
    isHB,
    sourceRate,
    minsg,
    dwjz,
    dwjzDate,
    equityReturn,
    netWorthTrend,
    syl1n,
    syl1y,
    syl3y,
    syl6y,
    managers,
    holdings,
  };
}

/**
 * 解析 fundcode_search.js 响应,提取基金候选列表
 * @param text fundcode_search.js 原文(var r = [[...],[...]])
 */
export function parseFundSearch(text: string): FundCandidate[] {
  // 提取 var r = [ ... ]
  const startMatch = text.match(/var\s+r\s*=\s*\[/);
  if (!startMatch) {
    throw new ParseError("无法解析基金搜索数据", text.slice(0, 200));
  }

  const start = startMatch.index! + startMatch[0].length - 1;
  let depth = 0;
  let inStr = false;
  let quote = "";
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new ParseError("基金搜索数据括号未闭合", text.slice(0, 200));
  }

  const literal = text.slice(start, end + 1);
  let rows: unknown[];
  try {
    rows = JSON.parse(literal);
  } catch (e) {
    throw new ParseError("基金搜索数据 JSON 解析失败", literal.slice(0, 200));
  }

  // 每行格式:[code, pinyin, name, type, quanpin]
  return rows
    .filter((r): r is string[] => Array.isArray(r) && r.length >= 3)
    .map((r) => ({
      code: String(r[0]),
      pinyin: String(r[1] ?? ""),
      name: String(r[2]),
      type: String(r[3] ?? ""),
      quanpin: String(r[4] ?? ""),
    }));
}
