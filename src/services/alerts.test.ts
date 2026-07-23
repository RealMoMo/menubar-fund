import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAlertWindow,
  resolveThresholds,
  checkThresholdHit,
  parseHHMM,
} from "./alerts";
import type { FundItem } from "../types/fund";
import type { Settings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import { setMockNow } from "./clock";

function mkDate(h: number, m: number): Date {
  // 2026-07-23 是周四(交易日)
  return new Date(2026, 6, 23, h, m, 0);
}

describe("parseHHMM", () => {
  it("解析 HH:MM 为分钟数", () => {
    expect(parseHHMM("11:00")).toBe(11 * 60);
    expect(parseHHMM("14:30")).toBe(14 * 60 + 30);
    expect(parseHHMM("15:00")).toBe(15 * 60);
  });
  it("解析 H:MM(单位小时)也为分钟数", () => {
    expect(parseHHMM("9:05")).toBe(9 * 60 + 5);
  });
  it("非法格式返回 null", () => {
    expect(parseHHMM("abc")).toBeNull();
    expect(parseHHMM("25:00")).toBeNull();
    expect(parseHHMM("12:60")).toBeNull();
  });
});

describe("getAlertWindow", () => {
  const s: Settings = { ...DEFAULT_SETTINGS };

  beforeEach(() => setMockNow(mkDate(11, 0)));
  afterEach(() => setMockNow(null));

  it("11:00:00 命中上午窗口", () => {
    setMockNow(mkDate(11, 0));
    expect(getAlertWindow(s)).toBe("morning");
  });
  it("11:00:59 仍在上午窗口(同一分钟)", () => {
    setMockNow(new Date(2026, 6, 23, 11, 0, 59));
    expect(getAlertWindow(s)).toBe("morning");
  });
  it("11:01 离开上午窗口 → none", () => {
    setMockNow(mkDate(11, 1));
    expect(getAlertWindow(s)).toBe("none");
  });
  it("10:59 早于上午点 → none", () => {
    setMockNow(mkDate(10, 59));
    expect(getAlertWindow(s)).toBe("none");
  });
  it("14:30 命中下午窗口", () => {
    setMockNow(mkDate(14, 30));
    expect(getAlertWindow(s)).toBe("afternoon");
  });
  it("14:59 仍在下午窗口", () => {
    setMockNow(mkDate(14, 59));
    expect(getAlertWindow(s)).toBe("afternoon");
  });
  it("15:00 收盘 → none(闭开区间 [start,15:00))", () => {
    setMockNow(mkDate(15, 0));
    expect(getAlertWindow(s)).toBe("none");
  });
  it("12:00 午休 → none", () => {
    setMockNow(mkDate(12, 0));
    expect(getAlertWindow(s)).toBe("none");
  });
  it("可调时间生效", () => {
    const s2: Settings = {
      ...DEFAULT_SETTINGS,
      alertMorningTime: "10:45",
      alertAfternoonStart: "14:15",
    };
    setMockNow(mkDate(10, 45));
    expect(getAlertWindow(s2)).toBe("morning");
    setMockNow(mkDate(14, 15));
    expect(getAlertWindow(s2)).toBe("afternoon");
  });
});

describe("resolveThresholds", () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, alertUp: 3, alertDown: -2 };

  it("非 override 基金用全局", () => {
    const f: FundItem = { code: "A", name: "A", addedAt: 0 };
    expect(resolveThresholds(f, settings)).toEqual({ up: 3, down: -2 });
  });
  it("override 基金用自己的值", () => {
    const f: FundItem = {
      code: "A", name: "A", addedAt: 0,
      alertOverride: true, alertUp: 5, alertDown: -3,
    };
    expect(resolveThresholds(f, settings)).toEqual({ up: 5, down: -3 });
  });
  it("override 基金单方向为 null → 该方向不报", () => {
    const f: FundItem = {
      code: "A", name: "A", addedAt: 0,
      alertOverride: true, alertUp: null, alertDown: -3,
    };
    expect(resolveThresholds(f, settings)).toEqual({ up: null, down: -3 });
  });
  it("override 基金未设 up/down(undefined) → 当作 null", () => {
    const f: FundItem = { code: "A", name: "A", addedAt: 0, alertOverride: true };
    expect(resolveThresholds(f, settings)).toEqual({ up: null, down: null });
  });
});

describe("checkThresholdHit", () => {
  it("达到涨超阈值 → up", () => {
    expect(checkThresholdHit(3.0, 3, -2)).toBe("up");
    expect(checkThresholdHit(5.0, 3, -2)).toBe("up");
  });
  it("达到跌超阈值 → down", () => {
    expect(checkThresholdHit(-2.0, 3, -2)).toBe("down");
    expect(checkThresholdHit(-5.0, 3, -2)).toBe("down");
  });
  it("区间内未命中 → null", () => {
    expect(checkThresholdHit(2.99, 3, -2)).toBeNull();
    expect(checkThresholdHit(-1.99, 3, -2)).toBeNull();
    expect(checkThresholdHit(0, 3, -2)).toBeNull();
  });
  it("up 优先:pct 同时 ≥up 且 ≤down(阈值交叉异常)时返回 up", () => {
    expect(checkThresholdHit(0, -1, 3)).toBe("up");
  });
});

describe("checkThresholdHit null 方向", () => {
  it("up=null 时只看 down", () => {
    expect(checkThresholdHit(100, null, -2)).toBeNull();
    expect(checkThresholdHit(-2, null, -2)).toBe("down");
    expect(checkThresholdHit(-5, null, -2)).toBe("down");
  });
  it("down=null 时只看 up", () => {
    expect(checkThresholdHit(3, 3, null)).toBe("up");
    expect(checkThresholdHit(5, 3, null)).toBe("up");
    expect(checkThresholdHit(-5, 3, null)).toBeNull();
  });
  it("都为 null → 永不命中", () => {
    expect(checkThresholdHit(100, null, null)).toBeNull();
    expect(checkThresholdHit(-100, null, null)).toBeNull();
  });
});
