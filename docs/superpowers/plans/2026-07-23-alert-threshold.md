# 基金涨跌阈值提醒 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 menubar-fund 新增基金涨跌阈值提醒（全局统一 + 单基金覆盖），交易日 11:00 / 14:30 起按盘中估算涨幅检查，超阈值发系统通知 + 菜单栏图标角标 + 列表行高亮。

**Architecture:** 阈值检查挂载于现有 `refresh()` 刷新流程（`App.tsx`），用内存集合做每日去重；通知走新增的 `tauri-plugin-notification`；节假日走第三方 API + 持久化缓存 + 降级判周末；Dev Mock 面板（`import.meta.env.DEV`）注入模拟时钟+数据做端到端验证。

**Tech Stack:** Tauri 2（Rust 主进程）、React 19、TypeScript、Zustand、Vitest、`tauri-plugin-notification`、`@tauri-apps/plugin-notification`

**对应 Spec:** `docs/superpowers/specs/2026-07-23-alert-threshold-design.md`

---

## 文件结构总览

### 新建文件（10 个）
| 文件 | 职责 |
|------|------|
| `src/types/settings.ts` | `Settings` 类型 + `ALERT` 默认常量 |
| `src/types/holiday.ts` | `HolidayEntry` 类型 |
| `src/services/clock.ts` | 时钟抽象（可注入 mock） |
| `src/services/holiday.ts` | 节假日 API + 缓存 + 降级 |
| `src/services/notification.ts` | 通知权限 + 发送封装 |
| `src/services/alerts.ts` | `checkAlerts` / `getAlertWindow` / `resolveThresholds` / `isTradingDay` |
| `src/services/alerts.test.ts` | alerts 逻辑单测（TDD 核心） |
| `src/components/SettingsPanel.tsx` | 全局阈值设置面板 |
| `src/components/MockPanel.tsx` | Dev 模拟面板（dev only） |
| `src-tauri/icons/icon-alert.png` | 触发态菜单栏图标（红点） |

### 修改文件（8 个）
| 文件 | 改动 |
|------|------|
| `src/types/fund.ts:23-27` | `FundItem` 加 `alertUp?`/`alertDown?`/`alertOverride?` |
| `src/store/fundStore.ts:24-47,94-221` | `PersistedState` 加 `holidayCache`；settings 默认值；运行时状态集合；setter；hydrate 兼容 |
| `src/App.tsx:73-92,158-179` | `refresh` 内调 `checkAlerts`；header 加 ⚙️/🧪 |
| `src/components/DetailPanel.tsx:173` | 加"涨跌提醒"分区（单基金 override） |
| `src/components/FundRow.tsx:14` | 读 `alertedCodes` 显示 🔔 |
| `src-tauri/Cargo.toml:18-26` | 加 `tauri-plugin-notification` |
| `src-tauri/src/lib.rs:11-16,59-62` | 注册 notification plugin；新增 `set_tray_alert` 命令 |
| `src-tauri/capabilities/default.json:6-17` | 加 notification 权限 + timor.tech http 域名 |
| `package.json:14-22` | 加 `@tauri-apps/plugin-notification` |

### 任务依赖顺序
```
Task 1 (类型层) → Task 2 (store 扩展)
                → Task 3 (clock 抽象) → Task 5 (alerts 逻辑 + 单测)
Task 4 (节假日) ↗
Task 6 (通知封装) → Task 7 (Rust 通知/图标)
Task 8 (App 接入 checkAlerts) ← 依赖 2,5,6,7
Task 9 (SettingsPanel UI) ← 依赖 2
Task 10 (DetailPanel 单基金分区) ← 依赖 2
Task 11 (FundRow 角标) ← 依赖 2
Task 12 (MockPanel + loop demo) ← 依赖 3,5,8
Task 13 (端到端验证)
```

---

## Task 1: 类型层扩展（FundItem + Settings + Holiday）

**Files:**
- Create: `src/types/settings.ts`
- Create: `src/types/holiday.ts`
- Modify: `src/types/fund.ts:23-27`

- [ ] **Step 1: 创建 Settings 类型与默认常量**

Create `src/types/settings.ts`:
```typescript
// 全局设置类型 + 默认值
// 阈值提醒相关字段见 spec §6.1

export interface Settings {
  /** 刷新间隔(秒) */
  refreshInterval: number;
  /** 状态栏轮播开关 */
  carousel: boolean;
  /** 轮播间隔(秒) */
  carouselInterval: number;
  /** 阈值提醒总开关,默认 false(需用户主动开启+授权通知) */
  alertEnabled: boolean;
  /** 涨超提醒阈值(%),如 3 表示 +3%。null=该方向不报。默认 3 */
  alertUp: number | null;
  /** 跌超提醒阈值(%),如 -2 表示 -2%。null=该方向不报。默认 -2 */
  alertDown: number | null;
  /** 上午检查点 "HH:MM",默认 "11:00" */
  alertMorningTime: string;
  /** 下午窗口起点 "HH:MM",默认 "14:30"(15:00 为 A 股收盘固定) */
  alertAfternoonStart: string;
}

export const DEFAULT_SETTINGS: Settings = {
  refreshInterval: 60,
  carousel: true,
  carouselInterval: 5,
  alertEnabled: false,
  alertUp: 3,
  alertDown: -2,
  alertMorningTime: "11:00",
  alertAfternoonStart: "14:30",
};
```

- [ ] **Step 2: 创建 HolidayEntry 类型**

Create `src/types/holiday.ts`:
```typescript
// 节假日缓存条目(spec §6.1)
// 数据源:timor.tech/api/holiday/info/{date}

export interface HolidayEntry {
  /** 是否为工作日(含调休补班) */
  isWorkday: boolean;
  /** timor.tech 类型码:0=工作日 1=周末 2=节假日 3=调休 */
  type: number;
  /** 节假日名称(如 "国庆节"),工作日无 */
  name?: string;
  /** 缓存时间戳(ms) */
  cachedAt: number;
}
```

- [ ] **Step 3: 扩展 FundItem 加 override 字段**

Modify `src/types/fund.ts`,把 `FundItem`（当前第 23-27 行）改为:
```typescript
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
```

- [ ] **Step 4: 类型检查通过**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: 暂时可能有 fundStore.ts 报 settings 类型不匹配(因为还没改 store),那是下一个 Task 处理。**仅确认 types/ 下三个文件自身无语法错误**(用 `npx tsc --noEmit src/types/settings.ts src/types/holiday.ts 2>&1 | grep -c "error" || echo 0`,输出 0 或仅 fundStore 相关错误)。

- [ ] **Step 5: Commit**

```bash
git add src/types/settings.ts src/types/holiday.ts src/types/fund.ts
git commit -m "feat(alert): 类型层扩展 - Settings/FundItem/HolidayEntry"
```

---

## Task 2: Store 扩展（settings + holidayCache + 运行时状态 + setter）

**Files:**
- Modify: `src/store/fundStore.ts:24-221`

- [ ] **Step 1: 改 import 引入 Settings 类型,删除内联 settings 定义**

Modify `src/store/fundStore.ts` 第 1-6 行的 import 块,把:
```typescript
import { create } from "zustand";
import type { FundDetail, FundItem } from "../types/fund";
```
改为:
```typescript
import { create } from "zustand";
import type { FundDetail, FundItem } from "../types/fund";
import type { Settings } from "../types/settings";
import type { HolidayEntry } from "../types/holiday";
import { DEFAULT_SETTINGS } from "../types/settings";
```

- [ ] **Step 2: 把 PersistedState 的内联 settings 类型替换为 Settings,加 holidayCache**

Modify `src/store/fundStore.ts:24-36`(把整个 `PersistedState` 接口体替换):
```typescript
export interface PersistedState {
  funds: FundItem[];
  activeCode: string | null;
  settings: Settings;
  /** 估算历史快照:code -> 快照数组(方案B采集,供日后校准) */
  estimateHistory: Record<string, EstimateSnapshot[]>;
  /** 节假日缓存:dateStr(YYYY-MM-DD) -> entry。跨会话持久化(spec §6.1) */
  holidayCache: Record<string, HolidayEntry>;
}
```

- [ ] **Step 3: DEFAULT_STATE 用 DEFAULT_SETTINGS,加 holidayCache**

Modify `src/store/fundStore.ts:38-47`(把 `DEFAULT_STATE` 替换):
```typescript
const DEFAULT_STATE: PersistedState = {
  funds: [],
  activeCode: null,
  settings: { ...DEFAULT_SETTINGS },
  estimateHistory: {},
  holidayCache: {},
};
```

- [ ] **Step 4: FundStore 接口加运行时状态字段 + 新 setter**

Modify `src/store/fundStore.ts:49-76`(在 `errors` 字段后、`addFund` 前,加运行时字段;在 setter 区加新方法)。在 `errors: Map<string, string>;` 之后插入:
```typescript
  /** 阈值提醒运行时状态(非持久化) */
  /** 记录的当天日期 YYYY-MM-DD,用于跨日重置检测 */
  alertToday: string;
  /** 今天上午已检查过的 code 集合 */
  morningChecked: Set<string>;
  /** 今天下午已通知的 code 集合(去重) */
  afternoonNotified: Set<string>;
  /** 今天触发过阈值的 code 集合(供辅助提示消费:菜单栏图标/列表行高亮) */
  alertedCodes: Set<string>;
```

在 `setCarouselInterval` (约 153-154 行)之后,`reorderFunds` 之前,加 setter:
```typescript
  setAlertEnabled: (v: boolean) => void;
  setAlertUp: (v: number | null) => void;
  setAlertDown: (v: number | null) => void;
  setAlertMorningTime: (v: string) => void;
  setAlertAfternoonStart: (v: string) => void;
  /** 更新单基金 override 配置 */
  setFundAlert: (code: string, patch: Partial<Pick<FundItem, "alertUp" | "alertDown" | "alertOverride">>) => void;
  /** 设置节假日缓存 */
  setHoliday: (dateStr: string, entry: HolidayEntry) => void;
  /** 跨日/收盘重置提醒运行时状态(alertToday 改为今日,清空三个集合) */
  resetAlertState: (today: string) => void;
  /** 把 code 加入对应窗口的去重集合 */
  markChecked: (code: string, win: "morning" | "afternoon") => void;
  /** 把 code 加入 alertedCodes */
  markAlerted: (code: string) => void;
  /** 清空 alertedCodes(15:00 后复位列表高亮) */
  clearAlerted: () => void;
```

- [ ] **Step 5: 实现 store 初始运行时状态**

Modify `src/store/fundStore.ts:94-99`(在 `...DEFAULT_STATE` 之后,`details: new Map(),` 之前),加运行时状态初始值。把:
```typescript
export const useFundStore = create<FundStore>((set, get) => ({
  ...DEFAULT_STATE,
  details: new Map(),
  lastRefreshAt: 0,
  refreshing: false,
  errors: new Map(),
```
改为:
```typescript
function todayStrLocal(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export const useFundStore = create<FundStore>((set, get) => ({
  ...DEFAULT_STATE,
  details: new Map(),
  lastRefreshAt: 0,
  refreshing: false,
  errors: new Map(),
  alertToday: todayStrLocal(),
  morningChecked: new Set(),
  afternoonNotified: new Set(),
  alertedCodes: new Set(),
```

> 注意:原 `todayStr()` 函数(第 79-84 行)仍被 `recordEstimate` 使用,**保留不动**。新增的 `todayStrLocal` 仅为初始化用,避免重复。或者直接复用——若保留原 `todayStr`,初始化处改用 `todayStr()` 即可,二选一。**推荐:删除新加的 `todayStrLocal`,初始化直接 `alertToday: todayStr()`。**

- [ ] **Step 6: 实现 setter 方法**

在 `setCarouselInterval` 实现(约 153-154 行)之后插入:
```typescript
  setAlertEnabled: (v) => set((s) => ({ settings: { ...s.settings, alertEnabled: v } })),

  setAlertUp: (v) => set((s) => ({ settings: { ...s.settings, alertUp: v } })),

  setAlertDown: (v) => set((s) => ({ settings: { ...s.settings, alertDown: v } })),

  setAlertMorningTime: (v) =>
    set((s) => ({ settings: { ...s.settings, alertMorningTime: v } })),

  setAlertAfternoonStart: (v) =>
    set((s) => ({ settings: { ...s.settings, alertAfternoonStart: v } })),

  setFundAlert: (code, patch) =>
    set((s) => ({
      funds: s.funds.map((f) =>
        f.code === code ? { ...f, ...patch } : f
      ),
    })),

  setHoliday: (dateStr, entry) =>
    set((s) => ({
      holidayCache: { ...s.holidayCache, [dateStr]: entry },
    })),

  resetAlertState: (today) =>
    set(() => ({
      alertToday: today,
      morningChecked: new Set(),
      afternoonNotified: new Set(),
      alertedCodes: new Set(),
    })),

  markChecked: (code, win) =>
    set((s) => {
      if (win === "morning") {
        const next = new Set(s.morningChecked);
        next.add(code);
        return { morningChecked: next };
      }
      const next = new Set(s.afternoonNotified);
      next.add(code);
      return { afternoonNotified: next };
    }),

  markAlerted: (code) =>
    set((s) => {
      const next = new Set(s.alertedCodes);
      next.add(code);
      return { alertedCodes: next };
    }),

  clearAlerted: () => set({ alertedCodes: new Set() }),
```

- [ ] **Step 7: hydrate / exportPersisted 兼容新字段**

Modify `src/store/fundStore.ts:204-210`(`hydrate` 实现体)替换为:
```typescript
  hydrate: (state) =>
    set((s) => ({
      funds: state.funds ?? [],
      activeCode: state.activeCode ?? null,
      // 老数据可能缺 alert* 字段:用默认值兜底,再用老数据覆盖已有字段
      settings: { ...DEFAULT_SETTINGS, ...s.settings, ...state.settings },
      estimateHistory: state.estimateHistory ?? {},
      holidayCache: state.holidayCache ?? {},
      // 运行时状态重置为今天
      alertToday: todayStrLocal(),
      morningChecked: new Set(),
      afternoonNotified: new Set(),
      alertedCodes: new Set(),
    })),
```

Modify `src/store/fundStore.ts:212-220`(`exportPersisted`)替换为:
```typescript
  exportPersisted: () => {
    const s = get();
    return {
      funds: s.funds,
      activeCode: s.activeCode,
      settings: s.settings,
      estimateHistory: s.estimateHistory,
      holidayCache: s.holidayCache,
    };
  },
```

- [ ] **Step 8: 类型检查通过**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: PASS(0 errors)。若有错误,核对 setter 名称与接口声明一致。

- [ ] **Step 9: 现有测试不被破坏**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm test -- --run`
Expected: 所有现有测试 PASS(`estimate.test.ts`/`parse.test.ts`/`loop.test.ts`)。store 结构变更不应影响它们。

- [ ] **Step 10: Commit**

```bash
git add src/store/fundStore.ts
git commit -m "feat(alert): store 扩展 - settings/holidayCache/运行时状态/setter"
```

---

## Task 3: 时钟抽象（clock.ts）

**Files:**
- Create: `src/services/clock.ts`

- [ ] **Step 1: 创建 clock 抽象**

Create `src/services/clock.ts`:
```typescript
// 时钟抽象层:所有提醒逻辑统一用 now(),而非 new Date()
// 生产环境 now()=真实时间;dev Mock 面板可注入 setMockNow() 控制时间
// spec §8.2

let mockedNow: Date | null = null;

/** 获取当前时间(mock 优先) */
export function now(): Date {
  return mockedNow ?? new Date();
}

/** 当天日期 YYYY-MM-DD(基于 now()) */
export function todayStr(d: Date = now()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** "HH:MM" 格式 */
export function hhmm(d: Date = now()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

/** dev-only:注入模拟时间。传 null 恢复真实时间 */
export function setMockNow(d: Date | null): void {
  mockedNow = d;
}

/** dev-only:是否处于 mock 状态 */
export function isMocked(): boolean {
  return mockedNow !== null;
}
```

- [ ] **Step 2: 类型检查**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/clock.ts
git commit -m "feat(alert): 时钟抽象层 clock.ts(支持 mock 注入)"
```

---

## Task 4: 节假日服务（holiday.ts）

**Files:**
- Create: `src/services/holiday.ts`

- [ ] **Step 1: 创建节假日服务**

Create `src/services/holiday.ts`:
```typescript
// 节假日判断服务(spec §4)
// 数据源:timor.tech/api/holiday/info/{date}
// 策略:按需单日拉 + 持久化缓存 + 失败降级判周末

import { fetch } from "@tauri-apps/plugin-http";
import type { HolidayEntry } from "../types/holiday";
import { useFundStore } from "../store/fundStore";
import { todayStr, now } from "./clock";

const HOLIDAY_API = (date: string) =>
  `http://timor.tech/api/holiday/info/${date}`;
const REQUEST_TIMEOUT = 5000;

/** timor.tech 响应结构(只取关心字段) */
interface TimorResponse {
  code: number;
  type?: {
    type: number; // 0工作日 1周末 2节假日 3调休
    name: string;
    weekday?: string;
  };
}

/**
 * 判断给定日期是否为交易日(工作日 + 调休补班)
 *
 * 同步读缓存:
 *   - 命中 → 返回结果
 *   - 未命中 → 返回 false,并后台异步拉取写缓存(下一轮刷新生效)
 *
 * 任何失败降级为"只判周末":周末非交易日,工作日按交易日
 * 安全保证:周末/节假日无估值数据,即使误判也不会误报(spec §4.4)
 */
export function isTradingDay(date: Date = now()): boolean {
  const ds = todayStr(date);
  const cache = useFundStore.getState().holidayCache;
  const entry = cache[ds];

  if (entry) {
    return entry.isWorkday;
  }

  // 缓存未命中:后台异步拉取(不阻塞)
  void fetchAndCacheHoliday(ds).catch((e) => {
    console.warn(`[holiday] 拉取 ${ds} 失败,降级判周末:`, e);
  });

  // 降级:判周末(day 0=周日 6=周六)
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

/** 拉取单日节假日数据并写入缓存 */
async function fetchAndCacheHoliday(dateStr: string): Promise<void> {
  try {
    const resp = await fetch(HOLIDAY_API(dateStr), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = (await resp.json()) as TimorResponse;
    if (data.code !== 0 || !data.type) throw new Error("invalid response");

    const type = data.type.type;
    const entry: HolidayEntry = {
      isWorkday: type === 0 || type === 3, // 工作日 + 调休补班
      type,
      name: data.type.name,
      cachedAt: Date.now(),
    };
    useFundStore.getState().setHoliday(dateStr, entry);
  } catch (e) {
    // 失败不写缓存,下次重试。降级判周末已在 isTradingDay 处理
    throw e;
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/holiday.ts
git commit -m "feat(alert): 节假日服务 - timor.tech 按需拉取+缓存+降级"
```

---

## Task 5: 阈值检查核心逻辑 + 单元测试（alerts.ts）—— TDD 核心

**Files:**
- Create: `src/services/alerts.ts`
- Create: `src/services/alerts.test.ts`

这是整个功能的纯逻辑核心,用 TDD 先写测试。

- [ ] **Step 1: 先写 getAlertWindow 测试**

Create `src/services/alerts.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
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
  it("非法格式返回 null", () => {
    expect(parseHHMM("9:5")).toBe(9 * 60 + 5);
    expect(parseHHMM("abc")).toBeNull();
  });
});

describe("getAlertWindow", () => {
  const s: Settings = { ...DEFAULT_SETTINGS };

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

  afterEach(() => setMockNow(null));
});
```

- [ ] **Step 2: 运行测试确认失败(模块不存在)**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm test -- --run alerts`
Expected: FAIL — `Cannot find module './alerts'`

- [ ] **Step 3: 实现 parseHHMM + getAlertWindow**

Create `src/services/alerts.ts`:
```typescript
// 阈值检查核心逻辑(spec §3)
// 纯函数为主,便于单测;checkAlerts 编排副作用

import type { FundDetail, FundItem } from "../types/fund";
import type { Settings } from "../types/settings";
import { now, hhmm } from "./clock";
import { isTradingDay } from "./holiday";

/** 把 "HH:MM" 解析为当日分钟数(0-1439)。非法返回 null */
export function parseHHMM(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export type AlertWindow = "morning" | "afternoon" | "none";

/**
 * 判断当前时间处于哪个检查窗口(spec §3.2)
 * 上午窗口:now 的 "HH:MM" 严格 === alertMorningTime(仅到点那一分钟)
 * 下午窗口:alertAfternoonStart ≤ now < "15:00"(闭开区间)
 */
export function getAlertWindow(
  settings: Settings,
  d: Date = now()
): AlertWindow {
  const cur = hhmm(d);
  const afternoonEnd = "15:00";

  // 下午窗口优先判断(范围更大)
  const afStart = settings.alertAfternoonStart;
  if (cur >= afStart && cur < afternoonEnd) return "afternoon";

  // 上午窗口:严格等于
  if (cur === settings.alertMorningTime) return "morning";

  return "none";
}

/** 阈值取值:单基金 override 时用基金值,否则用全局(spec §3.5) */
export function resolveThresholds(
  fund: FundItem,
  settings: Settings
): { up: number | null; down: number | null } {
  if (fund.alertOverride) {
    return { up: fund.alertUp ?? null, down: fund.alertDown ?? null };
  }
  return { up: settings.alertUp, down: settings.alertDown };
}

/**
 * 判断某涨幅是否命中阈值
 * @returns 'up' | 'down' | null(未命中)
 */
export function checkThresholdHit(
  pct: number,
  up: number | null,
  down: number | null
): "up" | "down" | null {
  if (up != null && pct >= up) return "up";
  if (down != null && pct <= down) return "down";
  return null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm test -- --run alerts`
Expected: PASS(parseHHMM 2 个、getAlertWindow 9 个全过)

- [ ] **Step 5: 补充 resolveThresholds + checkThresholdHit 测试**

追加到 `src/services/alerts.test.ts` 末尾:
```typescript
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
    // 例 up=-1, down=3(用户填反),pct=0 同时满足,按代码 up 优先
    expect(checkThresholdHit(0, -1, 3)).toBe("up");
  });
});

describe("checkThresholdHit null 方向", () => {
  it("up=null 时只看 down", () => {
    expect(checkThresholdHit(100, null, -2)).toBeNull(); // 100 > 0,不 ≤ -2
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
```

- [ ] **Step 6: 运行全部 alerts 测试通过**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm test -- --run alerts`
Expected: PASS(全部)

- [ ] **Step 7: 补充 checkAlerts 编排逻辑(集成 store + 去重)**

在 `src/services/alerts.ts` 末尾追加(注意:这里依赖 store + notification,需 Task 6 notification 就绪后完整测试,此处先写代码):
```typescript
import { useFundStore } from "../store/fundStore";
import { todayStr } from "./clock";
import { notifyAlert } from "./notification";

/** alerts.test 中 checkAlerts 的可测试子集 */

/** 跨日重置:若 alertToday ≠ 今天,清空集合 */
export function rollOverDayIfNeeded(today = todayStr()): boolean {
  const store = useFundStore.getState();
  if (store.alertToday !== today) {
    store.resetAlertState(today);
    return true;
  }
  return false;
}

/**
 * 阈值检查主流程(spec §3.4)
 * 挂载于 refresh() 之后,遍历基金详情,超阈值发通知 + 标记
 * @param map 刷新拿到的基金详情
 * @param overrides dev-only:强制某基金 estGszl(测试用)
 */
export async function checkAlerts(
  map: Map<string, FundDetail | Error>,
  overrides?: Map<string, number>
): Promise<void> {
  const store = useFundStore.getState();
  if (!store.settings.alertEnabled) return;

  rollOverDayIfNeeded();

  const win = getAlertWindow(store.settings);
  if (win === "none") return;

  if (!isTradingDay()) return; // 非交易日不检查

  const funds = store.funds;
  for (const fund of funds) {
    // 去重:同一窗口已处理过的跳过
    if (win === "morning" && store.morningChecked.has(fund.code)) continue;
    if (win === "afternoon" && store.afternoonNotified.has(fund.code))
      continue;

    const val = map.get(fund.code);
    if (!val || val instanceof Error) continue;

    // 取估算涨幅(支持 dev override)
    let pct = overrides?.get(fund.code);
    if (pct == null) pct = val.estimate?.estGszl;
    if (pct == null) continue; // 无估算值不报

    const { up, down } = resolveThresholds(fund, store.settings);
    const hit = checkThresholdHit(pct, up, down);
    if (!hit) continue;

    // 发通知 + 标记
    await notifyAlert(fund, pct, hit);
    store.markAlerted(fund.code);
    store.markChecked(fund.code, win);
  }
}
```

- [ ] **Step 8: 类型检查(checkAlerts 依赖 notification,notification 还没建,先 mock)**

由于 `checkAlerts` import 了 `./notification`(Task 6 才创建),此步 tsc 会报找不到模块。**两个选择**:
- (A) 把 Task 6 的 notification.ts 先建出来(推荐,顺序上 Task 6 可前置)
- (B) 暂时注释 `import { notifyAlert }`,用 `const notifyAlert = async () => {}` 占位

**推荐 (A):先做 Task 6 再回此步验证。** 暂时跳过此步类型检查,标记 pending。

- [ ] **Step 9: Commit(暂不含 checkAlerts,先提交纯函数)**

```bash
git add src/services/alerts.ts src/services/alerts.test.ts
git commit -m "feat(alert): 阈值检查纯函数 getAlertWindow/resolveThresholds/checkThresholdHit + 单测"
```

> 注:checkAlerts 编排函数会在 Task 6 notification 就绪后补提交,或在此 commit 一起提交(若已前置 Task 6)。

---

## Task 6: 通知封装（notification.ts）

**Files:**
- Create: `src/services/notification.ts`
- Modify: `package.json:14-22`

- [ ] **Step 1: 安装前端通知包**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm install @tauri-apps/plugin-notification`
Expected: package.json dependencies 多出 `@tauri-apps/plugin-notification`。

- [ ] **Step 2: 创建通知封装**

Create `src/services/notification.ts`:
```typescript
// 通知服务封装(spec §5.2)
// 职责:权限请求 + 发送阈值通知

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { FundItem } from "../types/fund";

/**
 * 确保通知权限已授予(spec §5.3)
 * 首次调用会触发系统授权弹窗。
 * 绑定到用户"开启提醒"开关的明确意图上,不在启动时调用。
 * @returns true=已授权(含之前已授权),false=被拒
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) {
    const perm = await requestPermission();
    granted = perm === "granted";
  }
  return granted;
}

/** 当前是否有通知权限(不发请求) */
export async function hasNotificationPermission(): Promise<boolean> {
  return await isPermissionGranted();
}

/**
 * 发送阈值触发通知(spec §5.4)
 * @param fund 基金
 * @param pct 当前估算涨幅(%)
 * @param direction 'up'=涨超 'down'=跌超
 */
export async function notifyAlert(
  fund: FundItem,
  pct: number,
  direction: "up" | "down"
): Promise<void> {
  const up = direction === "up";
  const title = `🔔 ${fund.name} ${up ? "涨超" : "跌超"}阈值`;
  const sign = pct > 0 ? "+" : "";
  const body = `当前估算涨幅 ${sign}${pct.toFixed(2)}%，已${
    up ? "涨超" : "跌破"
  }你设置的阈值`;
  try {
    await sendNotification({ title, body });
  } catch (e) {
    console.error("[notification] 发送失败:", e);
  }
}
```

- [ ] **Step 3: 类型检查通过(含 alerts.ts 的 checkAlerts)**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: PASS。此时 alerts.ts 的 `import { notifyAlert }` 可解析。

- [ ] **Step 4: Commit**

```bash
git add src/services/notification.ts package.json package-lock.json
git commit -m "feat(alert): 通知封装 notification.ts - 权限请求+发送阈值通知"
```

---

## Task 7: Rust 侧 — 通知插件 + 菜单栏触发态图标

**Files:**
- Modify: `src-tauri/Cargo.toml:18-26`
- Modify: `src-tauri/src/lib.rs:11-16,57-101`
- Modify: `src-tauri/capabilities/default.json:6-17`
- Create: `src-tauri/icons/icon-alert.png`

- [ ] **Step 1: Cargo.toml 加通知插件依赖**

Modify `src-tauri/Cargo.toml`,在 `[dependencies]` 末尾(`tauri-plugin-store = "2"` 之后)加:
```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: 准备触发态图标**

触发态图标 = 正常态图标 + 红色圆点角标。由于现有图标是 PNG,需生成一个带红点的版本。

Run(用 ImageMagick,若无则用 Node 生成):
```bash
cd /Users/mo/ZCodeProject/menubar-fund/src-tauri/icons
# 若有 ImageMagick:
if command -v magick &>/dev/null; then
  magick icon.png -fill red -draw "circle 96,32 96,72" icon-alert.png
else
  # 无 magick:复制一个占位,后续手动替换(需用户在 PS/preview 加红点)
  cp icon.png icon-alert.png
  echo "WARN: 已复制 icon.png 为占位,请手动给 icon-alert.png 加红点角标"
fi
ls -la icon-alert.png
```
Expected: 生成 `icon-alert.png`。若用占位,记录待用户手动美化。

- [ ] **Step 3: lib.rs 加 set_tray_alert 命令**

Modify `src-tauri/src/lib.rs`,在 `set_tray_title` 命令(第 11-16 行)之后插入新命令:
```rust
/// 前端调用:切换状态栏图标为触发态(红点)/正常态
/// spec §5.5 辅助提示
#[tauri::command]
fn set_tray_alert(app: tauri::AppHandle, active: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if active {
            // 触发态:用带红点的图标
            if let Ok(alert_icon) = tauri::image::Image::from_path("icons/icon-alert.png") {
                let _ = tray.set_icon(Some(alert_icon));
            }
        } else {
            // 恢复默认图标
            let _ = tray.set_icon(app.default_window_icon().cloned());
        }
    }
}
```

> 注:`from_path` 路径相对于 CWD。更稳妥的做法是用 `include_bytes!` 编译期嵌入。若运行期路径有问题,改用:
```rust
fn set_tray_alert(app: tauri::AppHandle, active: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if active {
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon-alert.png"))
                .expect("icon-alert.png missing");
            let _ = tray.set_icon(Some(icon));
            let _ = tray.set_icon_as_template(false); // 彩色图标不用 template
        } else {
            let _ = tray.set_icon(app.default_window_icon().cloned());
            let _ = tray.set_icon_as_template(true);
        }
    }
}
```
**推荐用 `include_bytes!` 版本**(编译期嵌入,无运行期路径问题)。lib.rs 顶部无需额外 import,`tauri::image::Image` 已在 tauri crate。

- [ ] **Step 4: lib.rs 注册 notification plugin + set_tray_alert 命令**

Modify `src-tauri/src/lib.rs:59-62`,把:
```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![set_tray_title])
```
改为:
```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![set_tray_title, set_tray_alert])
```

- [ ] **Step 5: capabilities 加权限**

Modify `src-tauri/capabilities/default.json`,把 `permissions` 数组替换为:
```json
  "permissions": [
    "core:default",
    "store:default",
    "notification:default",
    "notification:allow-notify",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    {
      "identifier": "http:default",
      "allow": [
        { "url": "https://fund.eastmoney.com/*" },
        { "url": "https://*.eastmoney.com/*" },
        { "url": "https://push2.eastmoney.com/*" },
        { "url": "http://timor.tech/*" },
        { "url": "https://timor.tech/*" }
      ]
    }
  ]
```

- [ ] **Step 6: Rust 编译通过**

Run: `cd /Users/mo/ZCodeProject/menubar-fund/src-tauri && cargo check`
Expected: PASS(可能首次会下载 notification crate,稍慢)。若有错误,核对 `tauri-plugin-notification` 版本与 tauri 主版本一致(都 "2")。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json src-tauri/icons/icon-alert.png
git commit -m "feat(alert): Rust 侧 - notification 插件 + set_tray_alert 触发态图标"
```

---

## Task 8: App.tsx 接入 checkAlerts + 设置入口

**Files:**
- Modify: `src/App.tsx:1-11,73-92,158-179`

- [ ] **Step 1: import checkAlerts + setTrayAlert**

Modify `src/App.tsx` 第 1-10 行 import 区,在 `import { formatTrayTitleNamed, ... }` 之后加:
```typescript
import { checkAlerts, rollOverDayIfNeeded } from "./services/alerts";
import { setMockNow } from "./services/clock";
import { useFundStore } from "./store/fundStore"; // 已有,确认
```
> 实际只需新增 `import { checkAlerts } from "./services/alerts";` 一行(`useFundStore` 已 import)。

- [ ] **Step 2: refresh 内调用 checkAlerts**

Modify `src/App.tsx:73-92`(`refresh` 的 try 块),把:
```typescript
    try {
      const map = await fetchFundDetails(codes);
      store.setDetails(map);
      // 采集估算快照(方案B:存历史估算与实际净值,供日后校准分析)
      const st = useFundStore.getState();
      for (const [code, val] of map) {
        if (!(val instanceof Error)) {
          st.recordEstimate(code, val);
        }
      }
    } catch (e) {
```
改为:
```typescript
    try {
      const map = await fetchFundDetails(codes);
      store.setDetails(map);
      // 采集估算快照(方案B:存历史估算与实际净值,供日后校准分析)
      const st = useFundStore.getState();
      for (const [code, val] of map) {
        if (!(val instanceof Error)) {
          st.recordEstimate(code, val);
        }
      }
      // 阈值检查(spec §3.1:挂载于刷新流程)
      await checkAlerts(map);
      // 触发态图标管理:有 alerted 则亮,窗口结束则灭
      await syncTrayAlert();
    } catch (e) {
```

- [ ] **Step 3: 添加 syncTrayAlert 辅助函数**

在 `src/App.tsx` 的 `refresh` 定义(约 92 行 `}, [store]);`)之后插入:
```typescript
  /** 同步菜单栏触发态图标:有未查看的 alerted 就亮,否则灭 */
  const syncTrayAlert = useCallback(async () => {
    const st = useFundStore.getState();
    if (st.alertedCodes.size > 0) {
      await invoke("set_tray_alert", { active: true });
    } else {
      await invoke("set_tray_alert", { active: false });
    }
  }, []);
```

- [ ] **Step 4: header 加设置齿轮按钮 + dev Mock 按钮**

Modify `src/App.tsx`,先在组件顶部(约 16 行 `const [detailCode, ...]` 附近)加状态:
```typescript
  const [showSettings, setShowSettings] = useState(false);
  const [showMock, setShowMock] = useState(false);
```

Modify `src/App.tsx:162-178`(header 的 `<div className="header-actions">` 块),把:
```tsx
        <div className="header-actions">
          <button
            className="icon-btn"
            onClick={() => refresh()}
            disabled={refreshing}
            title="刷新"
          >
            {refreshing ? "⟳" : "↻"}
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowAdd((v) => !v)}
            title={showAdd ? "收起添加" : "添加基金"}
          >
            {showAdd ? "✕" : "+"}
          </button>
        </div>
```
改为:
```tsx
        <div className="header-actions">
          <button
            className="icon-btn"
            onClick={() => refresh()}
            disabled={refreshing}
            title="刷新"
          >
            {refreshing ? "⟳" : "↻"}
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowAdd((v) => !v)}
            title={showAdd ? "收起添加" : "添加基金"}
          >
            {showAdd ? "✕" : "+"}
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowSettings(true)}
            title="设置"
          >
            ⚙
          </button>
          {import.meta.env.DEV && (
            <button
              className="icon-btn"
              onClick={() => setShowMock(true)}
              title="模拟测试(仅开发)"
            >
              🧪
            </button>
          )}
        </div>
```

- [ ] **Step 5: 渲染 SettingsPanel + MockPanel(动态 import 避免 dev 代码进生产)**

Modify `src/App.tsx`,在文件顶部 import 区加(条件 import MockPanel,生产构建摇除):
```typescript
import { SettingsPanel } from "./components/SettingsPanel";
```

在组件 return 的末尾(`{detailCode && <DetailPanel .../>}` 之后、`</div>` 闭合之前),加:
```tsx
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}

      {import.meta.env.DEV && showMock && (
        <MockPanel onClose={() => setShowMock(false)} onRun={runMockCheck} />
      )}
```

并在文件顶部 import(MockPanel 仅 dev,用动态 import 或直接 import + DEV 守卫):
```typescript
import { MockPanel } from "./components/MockPanel";
```
> 注:MockPanel 文件本身用 `import.meta.env.DEV` 守卫其内容,生产构建会被 tree-shake。`runMockCheck` 定义见 Task 12。

- [ ] **Step 6: 类型检查(MockPanel/SettingsPanel 还没建,此步会报错,先跳过)**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: FAIL(找不到 SettingsPanel/MockPanel 组件)。**这是预期的,Task 9/12 完成后会通过。** 记录 pending。

- [ ] **Step 7: 暂不 commit(等 Task 9 组件就绪一并提交,或先提交 App 改动用占位)**

> 建议先做 Task 9(SettingsPanel),再回头让此步通过后一起 commit。

---

## Task 9: SettingsPanel（全局阈值设置面板）

**Files:**
- Create: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: 创建 SettingsPanel 组件**

Create `src/components/SettingsPanel.tsx`:
```tsx
import { useState } from "react";
import { useFundStore } from "../store/fundStore";
import { ensureNotificationPermission } from "../services/notification";

interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const settings = useFundStore((s) => s.settings);
  const setAlertEnabled = useFundStore((s) => s.setAlertEnabled);
  const setAlertUp = useFundStore((s) => s.setAlertUp);
  const setAlertDown = useFundStore((s) => s.setAlertDown);
  const setAlertMorningTime = useFundStore((s) => s.setAlertMorningTime);
  const setAlertAfternoonStart = useFundStore((s) => s.setAlertAfternoonStart);
  const [permError, setPermError] = useState<string | null>(null);

  /** 开启提醒:触发系统授权弹窗,失败则弹回关闭 */
  const handleToggleEnabled = async (v: boolean) => {
    setPermError(null);
    if (v) {
      const granted = await ensureNotificationPermission();
      if (!granted) {
        setPermError("需要通知权限才能提醒,请在系统设置中授权");
        return; // 不开启
      }
    }
    setAlertEnabled(v);
  };

  const disabled = !settings.alertEnabled;

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <span className="detail-name">设置</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="detail-body">
          <div className="detail-section">
            <h4>涨跌提醒</h4>

            <div className="setting-row">
              <label className="setting-label">开启提醒</label>
              <input
                type="checkbox"
                checked={settings.alertEnabled}
                onChange={(e) => handleToggleEnabled(e.target.checked)}
              />
            </div>
            {permError && <div className="setting-error">{permError}</div>}

            <div className="setting-row">
              <label className="setting-label">涨超提醒 (%)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={settings.alertUp ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const v = e.target.value;
                  setAlertUp(v === "" ? null : Math.max(0, Number(v)));
                }}
                placeholder="留空=不报涨超"
              />
            </div>

            <div className="setting-row">
              <label className="setting-label">跌超提醒 (%)</label>
              <input
                type="number"
                step="0.1"
                max="0"
                value={settings.alertDown ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const v = e.target.value;
                  setAlertDown(v === "" ? null : Math.min(0, Number(v)));
                }}
                placeholder="留空=不报跌超"
              />
            </div>

            <div className="setting-row">
              <label className="setting-label">上午检查点</label>
              <input
                type="time"
                min="09:30"
                max="11:29"
                value={settings.alertMorningTime}
                disabled={disabled}
                onChange={(e) => setAlertMorningTime(e.target.value)}
              />
            </div>

            <div className="setting-row">
              <label className="setting-label">下午检查起点</label>
              <input
                type="time"
                min="13:00"
                max="14:59"
                value={settings.alertAfternoonStart}
                disabled={disabled}
                onChange={(e) => setAlertAfternoonStart(e.target.value)}
              />
            </div>

            <div className="setting-hint">
              ℹ️ 每个交易日,按盘中估算涨幅在上午、下午收盘前各检查一次。
              下午检查起点到 15:00 收盘前持续监控。盯的是估值涨幅,是收盘前的预判。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查通过**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: SettingsPanel 自身 PASS(MockPanel 仍报错,见 Task 12)。若只想验证本组件,可临时注释 App.tsx 里 MockPanel 相关行。

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(alert): SettingsPanel 全局阈值设置面板"
```

---

## Task 10: DetailPanel 加单基金 override 分区

**Files:**
- Modify: `src/components/DetailPanel.tsx:28,173`

- [ ] **Step 1: DetailPanel 读取该基金的 override 配置 + setter**

Modify `src/components/DetailPanel.tsx:28-34`(在 `const detail = ...` 之后加读取),在:
```tsx
  const detail = useFundStore((s) => s.details.get(code)) as FundDetail | undefined;
  const errorMsg = useFundStore((s) => s.errors.get(code));
```
之后插入:
```tsx
  // 单基金阈值 override 配置(spec §7.3)
  const fundItem = useFundStore((s) => s.funds.find((f) => f.code === code));
  const setFundAlert = useFundStore((s) => s.setFundAlert);
```

- [ ] **Step 2: 在详情底部加"涨跌提醒"分区**

Modify `src/components/DetailPanel.tsx`,在 `detail-body` 内最后一个 `detail-section`(基金经理,约 279-297 行 `)}` 之后、`</div>` (detail-body 闭合) 之前,插入:
```tsx
          {/* 单基金涨跌提醒 override 分区 (spec §7.3) */}
          <div className="detail-section">
            <h4>涨跌提醒</h4>
            <div className="setting-row">
              <label className="setting-label">单独设置</label>
              <input
                type="checkbox"
                checked={fundItem?.alertOverride ?? false}
                onChange={(e) =>
                  setFundAlert(code, { alertOverride: e.target.checked })
                }
              />
              <span className="setting-sublabel">
                {fundItem?.alertOverride ? "（使用本基金阈值）" : "（关闭=跟随全局）"}
              </span>
            </div>
            {fundItem?.alertOverride && (
              <>
                <div className="setting-row">
                  <label className="setting-label">涨超 (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={fundItem.alertUp ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setFundAlert(code, {
                        alertUp: v === "" ? null : Math.max(0, Number(v)),
                      });
                    }}
                    placeholder="留空=不报"
                  />
                </div>
                <div className="setting-row">
                  <label className="setting-label">跌超 (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    max="0"
                    value={fundItem.alertDown ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setFundAlert(code, {
                        alertDown: v === "" ? null : Math.min(0, Number(v)),
                      });
                    }}
                    placeholder="留空=不报"
                  />
                </div>
              </>
            )}
          </div>
```

- [ ] **Step 3: 类型检查**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: DetailPanel PASS。

- [ ] **Step 4: Commit**

```bash
git add src/components/DetailPanel.tsx
git commit -m "feat(alert): DetailPanel 加单基金阈值 override 分区"
```

---

## Task 11: FundRow 显示触发角标 🔔

**Files:**
- Modify: `src/components/FundRow.tsx:1-2,14,48-69`

- [ ] **Step 1: FundRow 接收 alertedCodes 状态**

Modify `src/components/FundRow.tsx:1-2` import,加:
```typescript
import { useFundStore } from "../store/fundStore";
```

Modify `src/components/FundRow.tsx:14-22`(组件函数体开头),在 `const est = detail?.estimate;` 之前加:
```tsx
  // 当天是否触发过阈值(辅助提示,spec §5.6)
  const alerted = useFundStore((s) => s.alertedCodes.has(item.code));
```

- [ ] **Step 2: 在行内显示 🔔 + 行背景标红**

Modify `src/components/FundRow.tsx:35`(`<div className={...fund-row...}>`),把:
```tsx
    <div className={`fund-row ${active ? "fund-row-active" : ""}`}>
```
改为:
```tsx
    <div
      className={`fund-row ${active ? "fund-row-active" : ""} ${
        alerted ? "fund-row-alerted" : ""
      }`}
    >
```

Modify `src/components/FundRow.tsx:48-69`(`<div className="fund-main" onClick={onOpenDetail}>` 内,在 fund-name-line 之后、value-line 之前),在基金名后加 🔔。找到:
```tsx
          <span className="fund-code">{item.code}</span>
        </div>
```
在其后(value-line 那个 div 内,est-badge 之前)插入铃铛。找到:
```tsx
            {showEstimate && <span className="est-badge">估</span>}
```
在其前面加:
```tsx
            {alerted && <span className="alert-badge" title="今日触发过阈值">🔔</span>}
```

- [ ] **Step 3: 类型检查**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/components/FundRow.tsx
git commit -m "feat(alert): FundRow 显示触发角标 🔔 + 行高亮"
```

---

## Task 12: MockPanel + loop demo（dev 端到端验证）

**Files:**
- Create: `src/components/MockPanel.tsx`
- Modify: `src/App.tsx`（补 `runMockCheck` 定义）

- [ ] **Step 1: 创建 MockPanel 组件**

Create `src/components/MockPanel.tsx`:
```tsx
// Dev 模拟面板(仅 import.meta.env.DEV 可见,spec §8)
// 注入模拟时钟 + 模拟估值涨幅,端到端验证 checkAlerts 生命周期

import { useState, useRef } from "react";
import { useFundStore } from "../store/fundStore";
import { setMockNow } from "../services/clock";
import { checkAlerts } from "../services/alerts";
import type { FundDetail } from "../types/fund";

interface MockPanelProps {
  onClose: () => void;
  /** 由 App 提供:用真实详情 + mock 涨幅跑一次 checkAlerts */
  onRun: (
    mockTime: Date | null,
    overrides: Map<string, number>
  ) => Promise<void>;
}

interface LogEntry {
  ts: string;
  msg: string;
}

function mkDate(h: number, m: number): Date {
  // 固定周四 2026-07-23(交易日)
  return new Date(2026, 6, 23, h, m, 0);
}

export function MockPanel({ onClose, onRun }: MockPanelProps) {
  const funds = useFundStore((s) => s.funds);
  const settings = useFundStore((s) => s.settings);
  const alertedCodes = useFundStore((s) => s.alertedCodes);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [timeMode, setTimeMode] = useState<"real" | "custom">("real");
  const [customTime, setCustomTime] = useState("11:00");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const log = (msg: string) => {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setLogs((l) => [...l.slice(-30), { ts, msg }]); // 保留最近 30 条
    // eslint-disable-next-line no-console
    console.log(`[mock] ${msg}`);
  };

  const parseTime = (t: string): Date | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) return null;
    return mkDate(Number(m[1]), Number(m[2]));
  };

  const buildOverrides = (): Map<string, number> => {
    const map = new Map<string, number>();
    for (const [code, val] of Object.entries(overrides)) {
      const n = Number(val);
      if (!Number.isNaN(n)) map.set(code, n);
    }
    return map;
  };

  const runOnce = async () => {
    const mockTime = timeMode === "custom" ? parseTime(customTime) : null;
    const ov = buildOverrides();
    log(
      `运行 checkAlerts | 时间=${
        mockTime ? customTime : "实时"
      } | mock涨幅=${[...ov.entries()].map(([c, v]) => `${c}=${v}`).join(",") || "无"}`
    );
    await onRun(mockTime, ov);
    log(
      `完成 | alertedCodes=[${[...alertedCodes].join(",")}]`
    );
  };

  /** loop demo:按交易日时间线快进,验证全部路径(spec §8.4) */
  const runLoop = () => {
    if (loopTimer.current) {
      clearTimeout(loopTimer.current);
      loopTimer.current = null;
      log("停止 loop demo");
      return;
    }
    log("▶ 开始 loop demo");
    const steps: Array<{ t: string; label: string; ov: Record<string, string> }> = [
      { t: "11:00", label: "上午定点(应触发)", ov: triggerValues(funds) },
      { t: "14:25", label: "下午未达(应不报)", ov: {} },
      { t: "14:48", label: "下午突破(应触发,首次)", ov: triggerValues(funds) },
      { t: "15:05", label: "收盘后(应清空)", ov: triggerValues(funds) },
    ];
    let i = 0;
    const tick = async () => {
      if (i >= steps.length) {
        log("✓ loop demo 一轮完成,重新开始");
        i = 0;
      }
      const step = steps[i];
      log(`--- 步骤 ${i + 1}: ${step.t} ${step.label} ---`);
      setCustomTime(step.t);
      setTimeMode("custom");
      setOverrides(step.ov);
      const mockTime = parseTime(step.t);
      const ov = new Map<string, number>();
      for (const [c, v] of Object.entries(step.ov)) ov.set(c, Number(v));
      await onRun(mockTime, ov);
      i++;
      loopTimer.current = setTimeout(tick, 1500);
    };
    tick();
  };

  const stopLoop = () => {
    if (loopTimer.current) {
      clearTimeout(loopTimer.current);
      loopTimer.current = null;
    }
    setMockNow(null);
    log("已重置为真实时间");
  };

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <span className="detail-name">🧪 模拟测试(仅开发)</span>
          <button
            className="icon-btn"
            onClick={() => {
              stopLoop();
              onClose();
            }}
          >
            ✕
          </button>
        </div>

        <div className="detail-body">
          <div className="detail-section">
            <h4>模拟当前时间</h4>
            <div className="setting-row">
              <label>
                <input
                  type="radio"
                  checked={timeMode === "real"}
                  onChange={() => setTimeMode("real")}
                />{" "}
                真实时间
              </label>
              <label>
                <input
                  type="radio"
                  checked={timeMode === "custom"}
                  onChange={() => setTimeMode("custom")}
                />{" "}
                自定义
              </label>
              <input
                type="time"
                value={customTime}
                disabled={timeMode !== "custom"}
                onChange={(e) => setCustomTime(e.target.value)}
              />
            </div>
          </div>

          <div className="detail-section">
            <h4>模拟基金估算涨幅 estGszl (%)</h4>
            {funds.length === 0 && <div>请先添加基金</div>}
            {funds.map((f) => {
              const { up, down } = f.alertOverride
                ? { up: f.alertUp, down: f.alertDown }
                : { up: settings.alertUp, down: settings.alertDown };
              return (
                <div key={f.code} className="setting-row">
                  <label className="setting-label">
                    {f.name}
                    <span className="setting-sublabel">
                      (阈值 {up ?? "—"} / {down ?? "—"})
                    </span>
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={overrides[f.code] ?? ""}
                    onChange={(e) =>
                      setOverrides((o) => ({
                        ...o,
                        [f.code]: e.target.value,
                      }))
                    }
                    placeholder="留空=用真实值"
                  />
                </div>
              );
            })}
          </div>

          <div className="setting-row">
            <button className="range-btn" onClick={runOnce}>
              ▶ 单次运行 checkAlerts
            </button>
            <button className="range-btn" onClick={runLoop}>
              🔁 循环演示 (loop demo)
            </button>
            <button className="range-btn" onClick={stopLoop}>
              ⏹ 停止 + 重置时间
            </button>
          </div>

          <div className="detail-section">
            <h4>运行日志</h4>
            <div
              className="mock-log"
              style={{
                background: "#f5f5f7",
                padding: 8,
                borderRadius: 6,
                fontSize: 11,
                fontFamily: "monospace",
                maxHeight: 200,
                overflow: "auto",
                color: "#1d1d1f",
              }}
            >
              {logs.length === 0 ? (
                <div style={{ color: "#86868b" }}>暂无日志</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i}>
                    {l.ts} {l.msg}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 生成触发阈值的 mock 涨幅(涨超阈值 +2) */
function triggerValues(
  funds: Array<{ code: string; alertOverride?: boolean; alertUp?: number | null }>
): Record<string, string> {
  const settings = useFundStore.getState().settings;
  const out: Record<string, string> = {};
  for (const f of funds) {
    const up = f.alertOverride ? f.alertUp : settings.alertUp;
    if (up != null) out[f.code] = String(up + 2); // 涨超阈值 +2 触发
  }
  return out;
}
```

- [ ] **Step 2: App.tsx 补 runMockCheck 定义**

Modify `src/App.tsx`,在 `syncTrayAlert`(Task 8 Step 3 加的)之后插入:
```typescript
  /** dev Mock 面板用:注入模拟时间 + 涨幅跑 checkAlerts */
  const runMockCheck = useCallback(
    async (mockTime: Date | null, overrides: Map<string, number>) => {
      setMockNow(mockTime);
      // 用当前 store 里的真实详情构造 map(若无则空)
      const st = useFundStore.getState();
      const map = new Map<string, import("./types/fund").FundDetail | Error>();
      for (const [code, val] of st.details) {
        map.set(code, val);
      }
      await checkAlerts(map, overrides);
      await syncTrayAlert();
    },
    [syncTrayAlert]
  );
```

- [ ] **Step 3: 类型检查全部通过**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npx tsc -b --noEmit`
Expected: PASS(此时所有组件就绪,App.tsx Task 8 的错误也消除)。

- [ ] **Step 4: 单元测试仍全绿**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm test -- --run`
Expected: PASS(alerts + 原有 estimate/parse/loop)。

- [ ] **Step 5: Commit**

```bash
git add src/components/MockPanel.tsx src/App.tsx
git commit -m "feat(alert): MockPanel + loop demo 端到端验证模式(dev only)"
```

---

## Task 13: 端到端手动验证 + 样式补全

**Files:**
- Modify: `src/styles.css` 或 `App.css`(找到现有样式文件补类)
- Verify: 全流程

- [ ] **Step 1: 找到样式文件并补全新增的 CSS 类**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && ls src/*.css src/**/*.css 2>/dev/null`

在主样式文件(很可能是 `src/App.css` 或 `src/styles.css`)末尾追加:
```css
/* === 阈值提醒相关样式 (spec §7) === */

/* 设置行(复用于 SettingsPanel/DetailPanel/MockPanel) */
.setting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  flex-wrap: wrap;
}
.setting-label {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary, #1d1d1f);
}
.setting-sublabel {
  font-size: 11px;
  color: #86868b;
  margin-left: 4px;
}
.setting-error {
  color: #ff3b30;
  font-size: 12px;
  padding: 4px 0;
}
.setting-hint {
  font-size: 11px;
  color: #86868b;
  line-height: 1.5;
  padding: 8px;
  background: rgba(0, 113, 227, 0.06);
  border-radius: 6px;
  margin-top: 8px;
}
.setting-row input[type="number"],
.setting-row input[type="time"] {
  width: 90px;
  padding: 4px 6px;
  border: 1px solid #d2d2d7;
  border-radius: 4px;
  font-size: 13px;
}

/* FundRow 触发态 */
.fund-row-alerted {
  background: rgba(255, 59, 48, 0.08);
}
.alert-badge {
  color: #ff3b30;
  font-size: 11px;
  margin-right: 2px;
}

/* MockPanel 日志区在深色模式下 */
@media (prefers-color-scheme: dark) {
  .setting-row input[type="number"],
  .setting-row input[type="time"] {
    background: #2c2c2e;
    border-color: #3a3a3c;
    color: #fff;
  }
}
```

- [ ] **Step 2: 启动 dev 应用**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm run tauri dev`
Expected: 应用启动,菜单栏出现图标,点击弹出悬浮窗,header 多出 ⚙️ 和 🧪(dev)按钮。

- [ ] **Step 3: 验证 loop demo 全路径(spec §8.1 / §10.1)**

点击 🧪 打开 MockPanel → 点"🔁 循环演示",按日志核验:

| 步骤 | 时间 | 预期 |
|------|------|------|
| 1 | 11:00 | 上午定点触发,收通知(若已授权)、🔔图标亮、列表行标红 |
| 2 | 14:25 | 未达阈值(空 override),不报 |
| 3 | 14:48 | 下午突破,首次触发,收通知 |
| 4 | 15:05 | 收盘后,窗口 none,alertedCodes 清空、图标恢复 |

记录每步实际表现。若某步不符,回查对应 Task 的实现。

- [ ] **Step 4: 验证去重(spec §3.4 / §10.1 路径 2,4)**

在 MockPanel 设自定义时间 11:00,连续点"单次运行"两次:
- 第一次:触发(若数据达阈值)
- 第二次:不重复报(morningChecked 已含该 code)

- [ ] **Step 5: 验证 alertEnabled 关闭 / override / null 方向**

- 关闭 SettingsPanel 的"开启提醒"开关 → 再跑 → 全程不报
- 给某基金开 override,设不同阈值 → 跑 → 该基金按自己的阈值,其他按全局
- 设全局 alertUp=null → 跑 → 涨超不报,跌超仍报

- [ ] **Step 6: 生产构建验证(DEV 代码被摇除)**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm run build && grep -c "MockPanel" dist/assets/*.js || echo "0 matches (good)"`
Expected: 构建成功;MockPanel 在生产 bundle 中应为 0 匹配(被 `import.meta.env.DEV` 守卫摇除)。

- [ ] **Step 7: 最终提交**

```bash
git add src/App.css  # 或实际样式文件
git commit -m "style(alert): 阈值提醒相关样式(设置行/触发态/日志区)"
```

- [ ] **Step 8: 全部测试最终回归**

Run: `cd /Users/mo/ZCodeProject/menubar-fund && npm test -- --run && npx tsc -b --noEmit`
Expected: 全绿,0 错误。

---

## 完成标志
- [ ] 所有 Task 1-13 的 checkbox 打勾
- [ ] `npm test -- --run` 全绿
- [ ] `npx tsc -b --noEmit` 0 错误
- [ ] `cargo check`(src-tauri)通过
- [ ] dev 模式 loop demo 验证 11 条路径(§10.1)全部符合预期
- [ ] 生产构建 MockPanel 被摇除
- [ ] 设计文档 spec 的所有决策点都有对应实现

