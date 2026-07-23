// 循环耐久测试 (Looper Test)
// 目的:在重复压力 + 畸形输入下,验证解析器与状态管理的健壮性、一致性、无累积异常
// 对应 spec §9 关键路径的自动化补强

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  parsePingzhongdata,
  parseFundSearch,
} from "./parse";
import { useFundStore } from "../store/fundStore";
import { FundNotFoundError, ParseError } from "../types/fund";
import {
  MINI_PINGZHONGDATA,
  MINI_FUND_SEARCH,
  ERROR_404_RESPONSE,
} from "./__fixtures__/mini_pingzhongdata";

const LOOP = 200; // 循环次数

// 真实大样本(754KB)若存在则加载,否则跳过该组
let REAL_PZD: string | null = null;
const realPath = "/tmp/pzd_real_000001.js";
if (existsSync(realPath)) {
  try {
    REAL_PZD = readFileSync(realPath, "utf8");
  } catch {
    REAL_PZD = null;
  }
}

describe("Looper: 解析器耐久与健壮性", () => {
  it(`精简样本连续解析 ${LOOP} 次,结果始终一致`, () => {
    let last: ReturnType<typeof parsePingzhongdata> | null = null;
    for (let i = 0; i < LOOP; i++) {
      const d = parsePingzhongdata(MINI_PINGZHONGDATA, "000001");
      // 每次结果必须与首次一致(纯函数,无副作用)
      if (last) {
        expect(d.dwjz).toBe(last.dwjz);
        expect(d.name).toBe(last.name);
        expect(d.netWorthTrend.length).toBe(last.netWorthTrend.length);
      }
      last = d;
    }
    expect(last!.dwjz).toBe(1.445);
  });

  it(`搜索数据连续解析 ${LOOP} 次,长度稳定`, () => {
    let len = -1;
    for (let i = 0; i < LOOP; i++) {
      const list = parseFundSearch(MINI_FUND_SEARCH);
      if (len === -1) len = list.length;
      expect(list.length).toBe(len);
    }
    expect(len).toBe(3);
  });

  it.runIf(REAL_PZD !== null)(
    "真实 754KB 样本解析(含全量净值序列完整性校验)",
    () => {
      const d = parsePingzhongdata(REAL_PZD!, "000001");
      expect(d.name).toBe("华夏成长混合");
      expect(d.code).toBe("000001");
      // 真实样本净值点数千个
      expect(d.netWorthTrend.length).toBeGreaterThan(1000);
      // 每个净值点字段完整
      for (const p of d.netWorthTrend) {
        expect(typeof p.x).toBe("number");
        expect(typeof p.y).toBe("number");
        expect(p.x).toBeGreaterThan(0);
      }
      // 持仓股与经理非空
      expect(d.holdings.length).toBeGreaterThan(0);
      expect(d.managers.length).toBeGreaterThan(0);
    }
  );

  it("畸形输入循环:每个都该抛出明确错误类型,绝不静默返回垃圾", () => {
    const malformed = [
      ERROR_404_RESPONSE,
      "",
      "null",
      "{}",
      "var x = 1;",
      "页面未找到 - 东方财富网",
      "<<<garbage>>>",
      "var Data_netWorthTrend = [broken",
      "\x00\x01\x02binary",
    ];
    for (const input of malformed) {
      let threw = false;
      try {
        parsePingzhongdata(input, "999999");
      } catch (e) {
        threw = true;
        // 必须是我们的语义错误类,而不是原生异常(如 SyntaxError)
        expect(
          e instanceof FundNotFoundError || e instanceof ParseError
        ).toBe(true);
      }
      expect(threw).toBe(true); // 绝不能静默通过
    }
  });

  it("字段部分缺失的各种组合,解析不崩溃且能提取已有字段", () => {
    const cases = [
      // 只有名称
      'var fS_name = "A";var fS_code = "1";',
      // 名称 + 净值但格式异常
      'var fS_name = "B";var Data_netWorthTrend = [{"x":1,"y":2}];',
      // ishb=true(货币基金分支)
      'var ishb=true;var fS_name = "C";var fS_code="2";var Data_netWorthTrend = [{"x":3,"y":1,"equityReturn":0}];',
      // 空净值数组
      'var fS_name = "D";var fS_code="3";var Data_netWorthTrend = [];',
    ];
    for (const c of cases) {
      const d = parsePingzhongdata(c, "X");
      expect(d.name.length).toBeGreaterThan(0);
    }
  });
});

describe("Looper: 状态管理添加/刷新/删除循环一致性", () => {
  // 每个测试用独立 store,避免互相污染
  function freshStore() {
    useFundStore.setState({
      funds: [],
      activeCode: null,
      details: new Map(),
      errors: new Map(),
      lastRefreshAt: 0,
      refreshing: false,
      settings: { refreshInterval: 60, carousel: true, carouselInterval: 5 },
    });
    return useFundStore;
  }

  it(`添加 N 只基金后,列表长度与 activeCode 正确`, () => {
    const s = freshStore();
    const N = 50;
    for (let i = 0; i < N; i++) {
      s.getState().addFund({
        code: String(100000 + i),
        name: `基金${i}`,
        addedAt: Date.now(),
      });
    }
    expect(s.getState().funds.length).toBe(N);
    // 首次添加自动设为 active
    expect(s.getState().activeCode).toBe("100000");
  });

  it("添加重复 code 不增长列表", () => {
    const s = freshStore();
    s.getState().addFund({ code: "000001", name: "A", addedAt: 0 });
    for (let i = 0; i < 10; i++) {
      s.getState().addFund({ code: "000001", name: "A", addedAt: 0 });
    }
    expect(s.getState().funds.length).toBe(1);
  });

  it(`交替 添加/删除 循环,最终状态干净`, () => {
    const s = freshStore();
    for (let i = 0; i < LOOP; i++) {
      const code = `F${i}`;
      s.getState().addFund({ code, name: code, addedAt: i });
      if (i % 2 === 0) {
        s.getState().removeFund(code);
      }
    }
    // 奇数 i 的留下
    const remaining = s.getState().funds.map((f) => f.code);
    expect(remaining.length).toBe(LOOP / 2);
    expect(remaining).not.toContain("F0");
    expect(remaining).toContain("F1");
  });

  it("删除 activeCode 后自动切换到剩余第一只", () => {
    const s = freshStore();
    s.getState().addFund({ code: "A", name: "A", addedAt: 0 });
    s.getState().addFund({ code: "B", name: "B", addedAt: 1 });
    expect(s.getState().activeCode).toBe("A");
    s.getState().removeFund("A");
    expect(s.getState().activeCode).toBe("B");
    // 删空后 activeCode 归 null
    s.getState().removeFund("B");
    expect(s.getState().activeCode).toBeNull();
  });

  it("setDetails 正确分离 detail 与 error(模拟刷新结果)", () => {
    const s = freshStore();
    s.getState().addFund({ code: "OK", name: "正常", addedAt: 0 });
    s.getState().addFund({ code: "BAD", name: "异常", addedAt: 0 });
    const mockMap = new Map<string, unknown>([
      ["OK", { code: "OK", name: "正常", dwjz: 1.5, equityReturn: 2 }],
      ["BAD", new Error("模拟断网")],
    ]);
    s.getState().setDetails(mockMap as any);
    expect(s.getState().details.has("OK")).toBe(true);
    expect(s.getState().errors.has("BAD")).toBe(true);
    expect(s.getState().errors.get("BAD")).toBe("模拟断网");
    expect(s.getState().lastRefreshAt).toBeGreaterThan(0);
  });

  it("hydrate / exportPersisted 往返一致性", () => {
    const s = freshStore();
    s.getState().addFund({ code: "X", name: "X", addedAt: 1 });
    s.getState().addFund({ code: "Y", name: "Y", addedAt: 2 });
    s.getState().setActiveCode("Y");
    s.getState().setRefreshInterval(30);
    const exported = s.getState().exportPersisted();
    expect(exported.funds.length).toBe(2);
    expect(exported.activeCode).toBe("Y");
    expect(exported.settings.refreshInterval).toBe(30);

    // 模拟重启:新 store 从 exported 恢复
    freshStore();
    useFundStore.getState().hydrate(exported);
    const restored = useFundStore.getState();
    expect(restored.funds.length).toBe(2);
    expect(restored.activeCode).toBe("Y");
    expect(restored.settings.refreshInterval).toBe(30);
  });
});
