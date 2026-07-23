// 端到端业务验证(spec §10.1 的 11 条路径)
// 用 clock mock + 详情构造 + overrides 注入,跑 checkAlerts 验证完整生命周期
// mock 掉 Tauri 通知/HTTP 插件,捕获通知调用

import { describe, it, expect, beforeEach, vi } from "vitest";

// mock Tauri 通知插件:捕获 sendNotification 调用
const sentNotifications: Array<{ title: string; body: string }> = [];
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted" as const,
  sendNotification: async (n: { title: string; body: string }) => {
    sentNotifications.push(n);
  },
}));

// mock Tauri http 插件:节假日 API 不实际请求,降级判周末
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async () => {
    throw new Error("mocked: no network in test");
  },
}));

import { checkAlerts } from "./alerts";
import { setMockNow } from "./clock";
import { useFundStore } from "../store/fundStore";
import type { FundDetail, FundItem } from "../types/fund";
import { DEFAULT_SETTINGS } from "../types/settings";

/** 2026-07-23 周四(交易日)的指定时分 */
function mkDate(h: number, m: number): Date {
  return new Date(2026, 6, 23, h, m, 0);
}

/** 构造一个带估算涨幅的 FundDetail */
function mkDetail(code: string, name: string, estGszl: number): FundDetail {
  return {
    code,
    name,
    isHB: false,
    dwjz: 1.5,
    dwjzDate: Date.now(),
    equityReturn: 0,
    netWorthTrend: [],
    managers: [],
    holdings: [],
    estimate: { estGsz: 1.5, estGszl, estGztime: Date.now() },
  };
}

/** 构造基金详情 map(全为成功 FundDetail) */
function mkMap(
  items: Array<{ code: string; name: string; estGszl: number }>
): Map<string, FundDetail | Error> {
  const m = new Map<string, FundDetail | Error>();
  for (const it of items) m.set(it.code, mkDetail(it.code, it.name, it.estGszl));
  return m;
}

function setupFunds(funds: FundItem[]) {
  useFundStore.setState({
    funds,
    settings: {
      ...DEFAULT_SETTINGS,
      alertEnabled: true,
      alertUp: 3,
      alertDown: -2,
    },
    alertToday: "2026-07-23",
    morningChecked: new Set(),
    afternoonNotified: new Set(),
    alertedCodes: new Set(),
    details: new Map(),
    errors: new Map(),
  });
}

const FUND_A: FundItem = { code: "110011", name: "易方达蓝筹", addedAt: 0 };

describe("checkAlerts 端到端业务路径 (spec §10.1)", () => {
  beforeEach(() => {
    sentNotifications.length = 0;
    setMockNow(null);
    setupFunds([FUND_A]);
  });

  it("路径1: 上午11:00 估算涨超阈值 → 发通知+标记", async () => {
    setMockNow(mkDate(11, 0));
    const map = mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 5.0 }]);
    await checkAlerts(map);
    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0].title).toContain("涨超");
    const st = useFundStore.getState();
    expect(st.morningChecked.has("110011")).toBe(true);
    expect(st.alertedCodes.has("110011")).toBe(true);
  });

  it("路径2: 上午去重 — 同一窗口再跑不重复报", async () => {
    setMockNow(mkDate(11, 0));
    const map = mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 5.0 }]);
    await checkAlerts(map);
    await checkAlerts(map); // 第二次
    expect(sentNotifications).toHaveLength(1);
  });

  it("路径3: 下午14:48 突破阈值 → 首次触发", async () => {
    setMockNow(mkDate(14, 48));
    const map = mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 4.0 }]);
    await checkAlerts(map);
    expect(sentNotifications).toHaveLength(1);
    expect(useFundStore.getState().afternoonNotified.has("110011")).toBe(true);
  });

  it("路径4: 下午反复横跳 — 突破后跌回再突破,只报1次", async () => {
    setMockNow(mkDate(14, 48));
    // 第一次突破
    await checkAlerts(mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 4.0 }]));
    expect(sentNotifications).toHaveLength(1);
    // 跌回阈值内
    await checkAlerts(mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 2.0 }]));
    // 再次突破
    await checkAlerts(mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 4.5 }]));
    expect(sentNotifications).toHaveLength(1); // 仍只 1 次
  });

  it("路径5: 跌超阈值 → 发跌超通知", async () => {
    setMockNow(mkDate(11, 0));
    const map = mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: -3.5 }]);
    await checkAlerts(map);
    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0].title).toContain("跌超");
  });

  it("路径6: alertEnabled=false → 全程不报", async () => {
    useFundStore.setState((s) => ({ settings: { ...s.settings, alertEnabled: false } }));
    setMockNow(mkDate(11, 0));
    const map = mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 10.0 }]);
    await checkAlerts(map);
    expect(sentNotifications).toHaveLength(0);
  });

  it("路径7: 15:00 后窗口结束 → none,不报", async () => {
    setMockNow(mkDate(15, 5));
    const map = mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 10.0 }]);
    await checkAlerts(map);
    expect(sentNotifications).toHaveLength(0);
  });

  it("路径8: 区间内未达阈值 → 不报", async () => {
    setMockNow(mkDate(11, 0));
    const map = mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 2.0 }]);
    await checkAlerts(map);
    expect(sentNotifications).toHaveLength(0);
    expect(useFundStore.getState().morningChecked.has("110011")).toBe(false);
  });

  it("路径9: 无估算值(estimate undefined) → 跳过不报", async () => {
    setMockNow(mkDate(11, 0));
    const d = mkDetail("110011", "易方达蓝筹", 5.0);
    d.estimate = undefined; // 无估算
    const map = new Map<string, FundDetail | Error>([["110011", d]]);
    await checkAlerts(map);
    expect(sentNotifications).toHaveLength(0);
  });

  it("路径10: 单基金 override — 用自己的阈值", async () => {
    // 全局 up=3,该基金 override up=8;给 5% 应不报(5<8)
    const fundB: FundItem = {
      ...FUND_A,
      alertOverride: true,
      alertUp: 8,
      alertDown: -5,
    };
    setupFunds([fundB]);
    setMockNow(mkDate(11, 0));
    const map = mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 5.0 }]);
    await checkAlerts(map);
    expect(sentNotifications).toHaveLength(0); // 5 < 8 不报
    // 给 9% 应报
    await checkAlerts(
      mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 9.0 }])
    );
    expect(sentNotifications).toHaveLength(1);
  });

  it("路径11: override 单方向 null — 涨超不报,跌超仍报", async () => {
    const fundB: FundItem = {
      ...FUND_A,
      alertOverride: true,
      alertUp: null, // 涨超不报
      alertDown: -2,
    };
    setupFunds([fundB]);
    setMockNow(mkDate(11, 0));
    // 涨超 5% → 不报
    await checkAlerts(mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: 5.0 }]));
    expect(sentNotifications).toHaveLength(0);
    // 跌超 -3% → 报
    await checkAlerts(
      mkMap([{ code: "110011", name: "易方达蓝筹", estGszl: -3.0 }])
    );
    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0].title).toContain("跌超");
  });
});
