// 格式化工具

/** 格式化净值,保留 4 位 */
export function formatNetValue(v: number): string {
  return v.toFixed(4);
}

/** 格式化涨跌幅,带正负号,保留 2 位 */
export function formatPercent(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/** 涨跌方向:"up" | "down" | "flat" */
export function trend(v: number): "up" | "down" | "flat" {
  if (v > 0.001) return "up";
  if (v < -0.001) return "down";
  return "flat";
}

/** 时间戳 → 简短日期 MM-DD */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 时间戳 → 时分 HH:MM */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** 格式化状态栏标题:净值 + 涨跌符号 */
export function formatTrayTitle(netValue: number, equityReturn: number): string {
  const arrow = equityReturn > 0.001 ? "↑" : equityReturn < -0.001 ? "↓" : "—";
  const pct = Math.abs(equityReturn).toFixed(2);
  return `${formatNetValue(netValue)} ${arrow}${pct}%`;
}

/** 格式化状态栏标题(估算值,带"估"标记) */
export function formatTrayTitleEstimate(netValue: number, equityReturn: number): string {
  const arrow = equityReturn > 0.001 ? "↑" : equityReturn < -0.001 ? "↓" : "—";
  const pct = Math.abs(equityReturn).toFixed(2);
  return `${formatNetValue(netValue)}${arrow}${pct}%`;
}

/** 缩短基金名称用于状态栏(状态栏宽度有限,中文太长会被截) */
export function shortenName(name: string, maxLen = 6): string {
  if (name.length <= maxLen) return name;
  // 去掉常见后缀再截断
  const cleaned = name
    .replace(/\(.*?\)|（.*?）/g, "") // 去括号
    .replace(/(混合|指数|债券|股票|联接|LOF|ETF|QDII|A|C|联接A|联接C)+$/g, "")
    .replace(/[A-Z]+$/g, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned || name.slice(0, maxLen);
}

/** 格式化带名称的状态栏标题:名称 + 净值 + 涨跌(轮播用) */
export function formatTrayTitleNamed(
  name: string,
  netValue: number,
  equityReturn: number,
  isEstimate = false
): string {
  const short = shortenName(name);
  const arrow = equityReturn > 0.001 ? "↑" : equityReturn < -0.001 ? "↓" : "—";
  const pct = Math.abs(equityReturn).toFixed(2);
  const estMark = isEstimate ? "估" : "";
  return `${short} ${estMark}${netValue.toFixed(3)}${arrow}${pct}%`;
}
