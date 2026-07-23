import { describe, it, expect } from "vitest";
import {
  parsePingzhongdata,
  parseFundSearch,
} from "./parse";
import {
  MINI_PINGZHONGDATA,
  MINI_FUND_SEARCH,
  ERROR_404_RESPONSE,
  EMPTY_RESPONSE,
} from "./__fixtures__/mini_pingzhongdata";
import {
  FundNotFoundError,
  ParseError,
} from "../types/fund";

describe("parsePingzhongdata", () => {
  it("正常解析所有字段", () => {
    const detail = parsePingzhongdata(MINI_PINGZHONGDATA, "000001");
    expect(detail.code).toBe("000001");
    expect(detail.name).toBe("华夏成长混合");
    expect(detail.isHB).toBe(false);
    expect(detail.sourceRate).toBe(1.5);
    expect(detail.minsg).toBe(10);
    expect(detail.syl1n).toBe(61.13);
    expect(detail.syl1y).toBe(-0.14);
    expect(detail.syl3y).toBe(28.9);
    expect(detail.syl6y).toBe(21.02);
  });

  it("提取最新净值与收益率", () => {
    const detail = parsePingzhongdata(MINI_PINGZHONGDATA, "000001");
    // 最后一个净值点:1.445, 10.64%
    expect(detail.dwjz).toBe(1.445);
    expect(detail.equityReturn).toBe(10.64);
    expect(detail.dwjzDate).toBe(1784563200000);
    expect(detail.netWorthTrend).toHaveLength(2);
  });

  it("解析基金经理", () => {
    const detail = parsePingzhongdata(MINI_PINGZHONGDATA, "000001");
    expect(detail.managers).toHaveLength(1);
    expect(detail.managers[0].name).toBe("郑晓辉");
    expect(detail.managers[0].star).toBe(5);
  });

  it("解析持仓股,正确拆分市场前缀", () => {
    const detail = parsePingzhongdata(MINI_PINGZHONGDATA, "000001");
    expect(detail.holdings).toHaveLength(4);
    expect(detail.holdings[0]).toEqual({
      raw: "0.300308",
      market: "0",
      code: "300308",
    });
    expect(detail.holdings[1].code).toBe("688347");
    expect(detail.holdings[1].market).toBe("1");
  });

  it("404 响应抛 FundNotFoundError", () => {
    expect(() => parsePingzhongdata(ERROR_404_RESPONSE, "999999")).toThrow(
      FundNotFoundError
    );
  });

  it("空响应抛 ParseError", () => {
    expect(() => parsePingzhongdata(EMPTY_RESPONSE, "000001")).toThrow(
      ParseError
    );
  });

  it("字段部分缺失时不崩溃(容错)", () => {
    // 缺少 syl 和 stockCodes 的精简样本
    const partial = `var ishb=false;var fS_name = "测试基金";var fS_code = "123456";var Data_netWorthTrend = [{"x":1700000000000,"y":1.0,"equityReturn":0}];`;
    const detail = parsePingzhongdata(partial, "123456");
    expect(detail.name).toBe("测试基金");
    expect(detail.syl1n).toBeUndefined();
    expect(detail.holdings).toEqual([]);
    expect(detail.managers).toEqual([]);
    expect(detail.dwjz).toBe(1.0);
  });
});

describe("parseFundSearch", () => {
  it("解析基金候选列表", () => {
    const list = parseFundSearch(MINI_FUND_SEARCH);
    expect(list).toHaveLength(3);
    expect(list[0]).toEqual({
      code: "000001",
      pinyin: "HXCZHH",
      name: "华夏成长混合",
      type: "混合型-灵活",
      quanpin: "HUAXIACHENGZHANGHUNHE",
    });
    expect(list[2].name).toBe("易方达优势成长混合");
  });

  it("无效格式抛 ParseError", () => {
    expect(() => parseFundSearch("not a valid response")).toThrow(ParseError);
  });
});
