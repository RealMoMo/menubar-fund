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
 * @param threshold 命中的阈值(%),用于通知正文展示
 */
export async function notifyAlert(
  fund: FundItem,
  pct: number,
  direction: "up" | "down",
  threshold: number
): Promise<void> {
  const up = direction === "up";
  const title = `🔔 ${fund.name} ${up ? "涨超" : "跌超"}阈值`;
  const sign = pct > 0 ? "+" : "";
  const thSign = threshold > 0 ? "+" : "";
  const body = `当前估算涨幅 ${sign}${pct.toFixed(2)}%，已${up ? "涨超" : "跌破"}阈值 ${thSign}${threshold}%`;
  try {
    await sendNotification({ title, body });
  } catch (e) {
    console.error("[notification] 发送失败:", e);
  }
}
