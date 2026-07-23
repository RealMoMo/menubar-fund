// 基金自选状态管理 (Zustand)
// 职责:自选列表、选中基金、最新数据缓存、刷新状态、估算历史采集
// 持久化:手动 hydrate 到 Tauri store(spec §8)

import { create } from "zustand";
import type { FundDetail, FundItem } from "../types/fund";
import type { Settings } from "../types/settings";
import type { HolidayEntry } from "../types/holiday";
import { DEFAULT_SETTINGS } from "../types/settings";
// 复用 clock 的 todayStr(mock 感知),避免两套时间体系(spec §8.2)
import { todayStr } from "../services/clock";

/** 单日估算快照(方案B:采集数据用于日后校准分析) */
export interface EstimateSnapshot {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 当日盘中估算涨幅 (%) */
  estGszl: number;
  /** 估算净值 */
  estGsz: number;
  /** 收盘实际涨幅 (%) —— 收盘后回填 */
  actualReturn?: number;
  /** 收盘实际单位净值 —— 收盘后回填 */
  actualDwjz?: number;
  /** 覆盖率 */
  coverage?: number;
}

export interface PersistedState {
  funds: FundItem[];
  activeCode: string | null;
  settings: Settings;
  /** 估算历史快照:code -> 快照数组(方案B采集,供日后校准) */
  estimateHistory: Record<string, EstimateSnapshot[]>;
  /** 节假日缓存:dateStr(YYYY-MM-DD) -> entry。跨会话持久化(spec §6.1) */
  holidayCache: Record<string, HolidayEntry>;
}

const DEFAULT_STATE: PersistedState = {
  funds: [],
  activeCode: null,
  settings: { ...DEFAULT_SETTINGS },
  estimateHistory: {},
  holidayCache: {},
};

interface FundStore extends PersistedState {
  /** 各基金最新详情缓存(code -> detail) */
  details: Map<string, FundDetail>;
  /** 最后成功刷新时间(ms) */
  lastRefreshAt: number;
  /** 是否正在刷新 */
  refreshing: boolean;
  /** 各基金上次刷新错误(code -> message),用于离线降级展示 */
  errors: Map<string, string>;
  /** 阈值提醒运行时状态(非持久化) */
  /** 记录的当天日期 YYYY-MM-DD,用于跨日重置检测 */
  alertToday: string;
  /** 今天上午已检查过的 code 集合 */
  morningChecked: Set<string>;
  /** 今天下午已通知的 code 集合(去重) */
  afternoonNotified: Set<string>;
  /** 今天触发过阈值的 code 集合(供辅助提示消费:菜单栏图标/列表行高亮) */
  alertedCodes: Set<string>;

  // 动作
  addFund: (item: FundItem) => void;
  removeFund: (code: string) => void;
  setActiveCode: (code: string | null) => void;
  setDetails: (map: Map<string, FundDetail | Error>) => void;
  setRefreshing: (v: boolean) => void;
  setRefreshInterval: (sec: number) => void;
  setCarousel: (enabled: boolean) => void;
  setCarouselInterval: (sec: number) => void;
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
  reorderFunds: (from: number, to: number) => void;
  /** 采集估算快照 + 回填前一日实际净值(方案B) */
  recordEstimate: (code: string, detail: FundDetail) => void;

  /** 从持久化数据恢复(不含 details) */
  hydrate: (state: PersistedState) => void;
  /** 导出可持久化部分 */
  exportPersisted: () => PersistedState;
}

/** 净值日期(时间戳)转 YYYY-MM-DD */
function dateStrFromTs(ts: number): string {
  const d = new Date(ts);
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
  alertToday: todayStr(),
  morningChecked: new Set(),
  afternoonNotified: new Set(),
  alertedCodes: new Set(),

  addFund: (item) =>
    set((s) => {
      // 去重
      if (s.funds.some((f) => f.code === item.code)) return s;
      const funds = [...s.funds, item];
      // 若无 activeCode,自动选第一个
      const activeCode = s.activeCode ?? item.code;
      return { funds, activeCode };
    }),

  removeFund: (code) =>
    set((s) => {
      const funds = s.funds.filter((f) => f.code !== code);
      const details = new Map(s.details);
      details.delete(code);
      const errors = new Map(s.errors);
      errors.delete(code);
      let activeCode = s.activeCode;
      if (activeCode === code) {
        activeCode = funds.length > 0 ? funds[0].code : null;
      }
      return { funds, details, errors, activeCode };
    }),

  setActiveCode: (code) => set({ activeCode: code }),

  setDetails: (map) =>
    set(() => {
      const details = new Map<string, FundDetail>();
      const errors = new Map<string, string>();
      for (const [code, val] of map) {
        if (val instanceof Error) {
          errors.set(code, val.message);
        } else {
          details.set(code, val);
        }
      }
      return {
        details,
        errors,
        lastRefreshAt: Date.now(),
      };
    }),

  setRefreshing: (v) => set({ refreshing: v }),

  setRefreshInterval: (sec) =>
    set((s) => ({ settings: { ...s.settings, refreshInterval: sec } })),

  setCarousel: (enabled) =>
    set((s) => ({ settings: { ...s.settings, carousel: enabled } })),

  setCarouselInterval: (sec) =>
    set((s) => ({ settings: { ...s.settings, carouselInterval: sec } })),

  setAlertEnabled: (v) => set((s) => ({ settings: { ...s.settings, alertEnabled: v } })),

  setAlertUp: (v) => set((s) => ({ settings: { ...s.settings, alertUp: v } })),

  setAlertDown: (v) => set((s) => ({ settings: { ...s.settings, alertDown: v } })),

  setAlertMorningTime: (v) =>
    set((s) => ({ settings: { ...s.settings, alertMorningTime: v } })),

  setAlertAfternoonStart: (v) =>
    set((s) => ({ settings: { ...s.settings, alertAfternoonStart: v } })),

  setFundAlert: (code, patch) =>
    set((s) => ({
      funds: s.funds.map((f) => (f.code === code ? { ...f, ...patch } : f)),
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

  reorderFunds: (from, to) =>
    set((s) => {
      const funds = [...s.funds];
      const [moved] = funds.splice(from, 1);
      funds.splice(to, 0, moved);
      return { funds };
    }),

  recordEstimate: (code, detail) =>
    set((s) => {
      const history = { ...(s.estimateHistory ?? {}) };
      const list: EstimateSnapshot[] = history[code] ? [...history[code]] : [];
      const today = todayStr();

      // 1) 若有估算值,更新/新建今日快照
      if (detail.estimate) {
        const est = detail.estimate;
        const todaySnap = list.find((x) => x.date === today);
        if (todaySnap) {
          // 盘中多次刷新,只更新估算值(取最新)
          todaySnap.estGszl = est.estGszl;
          todaySnap.estGsz = est.estGsz;
          todaySnap.coverage = est.coverage;
        } else {
          list.push({
            date: today,
            estGszl: est.estGszl,
            estGsz: est.estGsz,
            coverage: est.coverage,
          });
        }
      }

      // 2) 回填前一交易日的实际净值(收盘后,新净值出现时)
      //    detail.dwjzDate 是最新净值的日期;若它对应的快照还没填实际值,则回填
      const latestDate = dateStrFromTs(detail.dwjzDate);
      const prevSnap = list.find((x) => x.date === latestDate && x.actualDwjz === undefined);
      if (prevSnap) {
        prevSnap.actualDwjz = detail.dwjz;
        prevSnap.actualReturn = detail.equityReturn;
      }

      // 只保留最近 60 天,避免无限增长
      const trimmed = list.slice(-60);
      history[code] = trimmed;
      return { estimateHistory: history };
    }),

  hydrate: (state) =>
    set((s) => ({
      funds: state.funds ?? [],
      activeCode: state.activeCode ?? null,
      // 老数据可能缺 alert* 字段:用默认值兜底,再用老数据覆盖已有字段
      settings: { ...DEFAULT_SETTINGS, ...s.settings, ...state.settings },
      estimateHistory: state.estimateHistory ?? {},
      holidayCache: state.holidayCache ?? {},
      // 运行时状态重置为今天
      alertToday: todayStr(),
      morningChecked: new Set(),
      afternoonNotified: new Set(),
      alertedCodes: new Set(),
    })),

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
}));
