// 盘中估算算法单元测试(加权混合模型)
import { describe, it, expect } from "vitest";
import { computeEstimate, isTradingHours } from "./fundApi";
import type { HoldingStock, StockQuote } from "../types/fund";

function mkHolding(code: string, weight: number): HoldingStock {
  return { raw: `0.${code}`, market: "0", code, weight };
}
function mkQuote(code: string, changePct: number): [string, StockQuote] {
  return [code, { code, name: code, price: 10, changePct }];
}

describe("computeEstimate 加权混合估算算法", () => {
  it("全部持仓涨10%,前十占48% → 摊到全基金约4.8%", () => {
    // 三只各16%(合计48%),全部涨10%
    const holdings = [mkHolding("A", 16), mkHolding("B", 16), mkHolding("C", 16)];
    const quotes = new Map([
      mkQuote("A", 10.0),
      mkQuote("B", 10.0),
      mkQuote("C", 10.0),
    ]);
    // Σ(10×16)/100 = 4.8%(前十波动摊到全基金)
    const est = computeEstimate(holdings, quotes, 1.0)!;
    expect(est.estGszl).toBeCloseTo(4.8, 3);
    expect(est.estGsz).toBeCloseTo(1.048, 3);
    expect(est.coverage).toBeCloseTo(0.48, 3);
  });

  it("不同涨幅按占比加权后摊到全基金", () => {
    // A占6.45涨2%, B占5.0跌1%, C占3.0涨10% → 合计14.45%
    const holdings = [mkHolding("A", 6.45), mkHolding("B", 5.0), mkHolding("C", 3.0)];
    const quotes = new Map([
      mkQuote("A", 2.0),
      mkQuote("B", -1.0),
      mkQuote("C", 10.0),
    ]);
    // Σ(涨幅×占比) = 2×6.45 + (-1)×5 + 10×3 = 37.9; /100 = 0.379%
    const est = computeEstimate(holdings, quotes, 1.0)!;
    expect(est.estGszl).toBeCloseTo(0.379, 3);
    expect(est.coverage).toBeCloseTo(0.1445, 4);
  });

  it("全部下跌 → 估算净值下跌(负值)", () => {
    const holdings = [mkHolding("A", 8), mkHolding("B", 4)]; // 合计12
    const quotes = new Map([mkQuote("A", -3.0), mkQuote("B", -3.0)]);
    // Σ(-3×8 + -3×4)/100 = -0.36%
    const est = computeEstimate(holdings, quotes, 1.5)!;
    expect(est.estGszl).toBeCloseTo(-0.36, 3);
    expect(est.estGsz).toBeLessThan(1.5);
  });

  it("空持仓返回 null", () => {
    const est = computeEstimate([], new Map(), 1.0);
    expect(est).toBeNull();
  });

  it("prevDwjz <= 0 返回 null", () => {
    const est = computeEstimate([mkHolding("A", 10)], new Map([mkQuote("A", 1)]), 0);
    expect(est).toBeNull();
  });

  it("部分持仓缺行情,只用有的算", () => {
    // A占6,B占4(缺行情),C占2(缺行情)→ 有效只有A
    const holdings = [mkHolding("A", 6), mkHolding("B", 4), mkHolding("C", 2)];
    const quotes = new Map([mkQuote("A", 10.0)]);
    // Σ=10×6=60; /100=0.6%
    const est = computeEstimate(holdings, quotes, 1.0)!;
    expect(est.estGszl).toBeCloseTo(0.6, 3);
    expect(est.coverage).toBeCloseTo(0.06, 3);
  });

  it("所有持仓都缺行情返回 null", () => {
    const holdings = [mkHolding("A", 6), mkHolding("B", 4)];
    const est = computeEstimate(holdings, new Map(), 1.0);
    expect(est).toBeNull();
  });

  it("持仓缺 weight(weight<=0)的跳过", () => {
    const holdings = [mkHolding("A", 10), mkHolding("B", 0)];
    const quotes = new Map([mkQuote("A", 2), mkQuote("B", 5)]);
    const est = computeEstimate(holdings, quotes, 1.0)!;
    // 只算 A: 2×10/100 = 0.2%
    expect(est.estGszl).toBeCloseTo(0.2, 3);
  });

  it("estGztime 是有效时间戳", () => {
    const est = computeEstimate([mkHolding("A", 10)], new Map([mkQuote("A", 1)]), 1.0)!;
    expect(est.estGztime).toBeGreaterThan(0);
    expect(Date.now() - est.estGztime).toBeLessThan(5000);
  });

  it("coverage 反映前十占比合计(可信度)", () => {
    // 前十占 80% 的基金,coverage 高
    const concentrated = [mkHolding("A", 80)];
    const est1 = computeEstimate(concentrated, new Map([mkQuote("A", 1)]), 1.0)!;
    expect(est1.coverage).toBeCloseTo(0.8, 2);

    // 前十只占 30% 的基金,coverage 低
    const dispersed = [mkHolding("A", 30)];
    const est2 = computeEstimate(dispersed, new Map([mkQuote("A", 1)]), 1.0)!;
    expect(est2.coverage).toBeCloseTo(0.3, 2);
  });
});

describe("isTradingHours 交易时段判断", () => {
  it("周末返回 false", () => {
    const sat = new Date("2026-07-25T10:00:00+08:00");
    const sun = new Date("2026-07-26T14:00:00+08:00");
    expect(isTradingHours(sat)).toBe(false);
    expect(isTradingHours(sun)).toBe(false);
  });

  it("交易日上午 10:00 返回 true", () => {
    const wed = new Date("2026-07-22T10:00:00+08:00");
    expect(isTradingHours(wed)).toBe(true);
  });

  it("交易日 12:00(午休)返回 false", () => {
    const wed = new Date("2026-07-22T12:00:00+08:00");
    expect(isTradingHours(wed)).toBe(false);
  });

  it("交易日下午 14:00 返回 true", () => {
    const wed = new Date("2026-07-22T14:00:00+08:00");
    expect(isTradingHours(wed)).toBe(true);
  });

  it("交易日 16:00(收盘后)返回 false", () => {
    const wed = new Date("2026-07-22T16:00:00+08:00");
    expect(isTradingHours(wed)).toBe(false);
  });

  it("边界:9:30 返回 true,9:29 返回 false", () => {
    expect(isTradingHours(new Date("2026-07-22T09:30:00+08:00"))).toBe(true);
    expect(isTradingHours(new Date("2026-07-22T09:29:00+08:00"))).toBe(false);
  });
});
