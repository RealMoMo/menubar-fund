// 节假日判断服务(spec §4)
// 数据源:timor.tech/api/holiday/info/{date}
// 策略:按需单日拉 + 持久化缓存 + 失败降级判周末

import { fetch } from "@tauri-apps/plugin-http";
import type { HolidayEntry } from "../types/holiday";
import { useFundStore } from "../store/fundStore";
import { todayStr, now } from "./clock";

const HOLIDAY_API = (date: string) => `https://timor.tech/api/holiday/info/${date}`;
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
}
