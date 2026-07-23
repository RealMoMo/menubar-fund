// 阈值检查核心逻辑(spec §3)
// 纯函数为主,便于单测;checkAlerts 编排副作用

import type { FundDetail, FundItem } from "../types/fund";
import type { Settings } from "../types/settings";
import { now, hhmm, todayStr } from "./clock";
import { isTradingDay } from "./holiday";
import { useFundStore } from "../store/fundStore";
import { notifyAlert } from "./notification";

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
export function getAlertWindow(settings: Settings, d: Date = now()): AlertWindow {
  const cur = hhmm(d);
  const afternoonEnd = "15:00";

  // 下午窗口优先判断(范围更大)
  if (cur >= settings.alertAfternoonStart && cur < afternoonEnd) return "afternoon";

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
 * @returns 'up' | 'down' | null(未命中)。up 优先(涨超阈值时即使同时满足 down 也报 up)
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

/** 跨日重置:若 alertToday ≠ 今天,清空集合。返回是否发生了重置 */
export function rollOverDayIfNeeded(today: string = todayStr()): boolean {
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
    if (win === "afternoon" && store.afternoonNotified.has(fund.code)) continue;

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
