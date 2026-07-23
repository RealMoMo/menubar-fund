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
