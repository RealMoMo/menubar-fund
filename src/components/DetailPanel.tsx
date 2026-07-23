import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import type { FundDetail } from "../types/fund";
import { fetchFundDetail } from "../services/fundApi";
import { useFundStore } from "../store/fundStore";
import {
  formatNetValue,
  formatPercent,
  trend,
  formatDate,
  formatTime,
} from "../utils/format";

interface DetailPanelProps {
  code: string;
  onClose: () => void;
}

type Range = "1m" | "3m" | "1y" | "all";

const RANGE_DAYS: Record<Range, number> = {
  "1m": 30,
  "3m": 90,
  "1y": 365,
  all: 99999,
};

export function DetailPanel({ code, onClose }: DetailPanelProps) {
  const detail = useFundStore((s) => s.details.get(code)) as FundDetail | undefined;
  const errorMsg = useFundStore((s) => s.errors.get(code));
  const [localDetail, setLocalDetail] = useState<FundDetail | undefined>(detail);
  const [loading, setLoading] = useState(!detail);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("3m");

  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  const data = localDetail ?? detail;

  // 若 store 里没有完整详情(列表精简数据其实也是完整 FundDetail),主动拉一次
  useEffect(() => {
    if (detail) {
      setLocalDetail(detail);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const d = await fetchFundDetail(code);
        if (!cancelled) {
          setLocalDetail(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, detail]);

  // 绘制净值走势图
  useEffect(() => {
    if (!data || !chartRef.current) return;

    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current);
    }
    const chart = chartInstance.current;

    // 按时间范围过滤
    const cutoff = Date.now() - RANGE_DAYS[range] * 86400000;
    const points = data.netWorthTrend.filter((p) => p.x >= cutoff);

    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    chart.setOption({
      grid: { left: 40, right: 12, top: 16, bottom: 28 },
      xAxis: {
        type: "category",
        data: points.map((p) => formatDate(p.x).slice(5)),
        axisLabel: { color: isDark ? "#98989d" : "#86868b", fontSize: 10 },
        axisLine: { lineStyle: { color: isDark ? "#3a3a3c" : "#d2d2d7" } },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: isDark ? "#98989d" : "#86868b", fontSize: 10 },
        splitLine: { lineStyle: { color: isDark ? "#3a3a3c" : "#e5e5ea" } },
      },
      series: [
        {
          type: "line",
          data: points.map((p) => p.y),
          showSymbol: false,
          smooth: true,
          lineStyle: { width: 1.5, color: "#0071e3" },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(0,113,227,0.2)" },
              { offset: 1, color: "rgba(0,113,227,0)" },
            ]),
          },
        },
      ],
      tooltip: {
        trigger: "axis",
        formatter: (params: any) => {
          const p = points[params[0].dataIndex];
          if (!p) return "";
          return `${formatDate(p.x)}<br/>净值: ${formatNetValue(p.y)}`;
        },
      },
    });

    chart.resize();
  }, [data, range]);

  useEffect(() => {
    const handler = () => chartInstance.current?.resize();
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("resize", handler);
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
  }, []);

  if (loading) {
    return (
      <div className="detail-overlay">
        <div className="detail-panel">
          <div className="detail-loading">加载中…</div>
        </div>
      </div>
    );
  }

  if (error || errorMsg || !data) {
    return (
      <div className="detail-overlay" onClick={onClose}>
        <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
          <div className="detail-header">
            <span>数据加载失败</span>
            <button className="icon-btn" onClick={onClose}>✕</button>
          </div>
          <div className="detail-body">{error || errorMsg}</div>
        </div>
      </div>
    );
  }

  const ret = data.equityReturn;
  const tr = trend(ret);

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <div>
            <span className="detail-name">{data.name}</span>
            <span className="detail-code">{data.code}</span>
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="detail-body">
          <div className="detail-value-row">
            <span className="detail-value">{formatNetValue(data.dwjz)}</span>
            <span className={`fund-return fund-return-${tr}`}>
              {formatPercent(ret)}
            </span>
            <span className="detail-date">{formatDate(data.dwjzDate)}</span>
          </div>

          {data.estimate && (
            <div className={`estimate-bar fund-return-${trend(data.estimate.estGszl)}`}>
              <span className="est-badge">估</span>
              <span>估算净值 {formatNetValue(data.estimate.estGsz)}</span>
              <span>{formatPercent(data.estimate.estGszl)}</span>
              <span className="est-time">截至 {formatTime(data.estimate.estGztime)}</span>
            </div>
          )}

          <div className="detail-value-hint">
            {data.estimate
              ? `收盘净值 ${formatDate(data.dwjzDate)} · 估算基于前十大持仓${
                  data.estimate.coverage !== undefined
                    ? `(覆盖资产 ${Math.round(data.estimate.coverage * 100)}%)`
                    : ""
                }${data.holdingsAsOf ? ` · 持仓截止 ${data.holdingsAsOf}` : ""}`
              : "非交易时段,显示最新收盘净值"}
          </div>

          <div className="detail-syl">
            {[
              ["近1月", data.syl1y],
              ["近6月", data.syl6y],
              ["近1年", data.syl1n],
              ["近3年", data.syl3y],
            ].map(([label, val]) => (
              <div key={label as string} className="syl-item">
                <span className="syl-label">{label as string}</span>
                <span
                  className={`syl-value fund-return-${trend(
                    (val as number) ?? 0
                  )}`}
                >
                  {val !== undefined ? formatPercent(val as number) : "--"}
                </span>
              </div>
            ))}
          </div>

          <div className="detail-chart-toolbar">
            {(["1m", "3m", "1y", "all"] as Range[]).map((r) => (
              <button
                key={r}
                className={`range-btn ${range === r ? "range-btn-active" : ""}`}
                onClick={() => setRange(r)}
              >
                {r === "1m" ? "近1月" : r === "3m" ? "近3月" : r === "1y" ? "近1年" : "全部"}
              </button>
            ))}
          </div>
          <div ref={chartRef} className="detail-chart" />

          {data.holdings.length > 0 && (
            <div className="detail-section">
              <h4>
                十大持仓
                {data.holdingsAsOf && (
                  <span className="holdings-asof">(截止 {data.holdingsAsOf})</span>
                )}
              </h4>
              <table className="holdings-table">
                <thead>
                  <tr>
                    <th className="th-name">股票</th>
                    <th className="th-num">现价</th>
                    <th className="th-num">涨跌</th>
                    <th className="th-num">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {data.holdings.map((h, i) => {
                    const q = data.quotes?.get(h.code);
                    const chg = q?.changePct;
                    const tr = chg !== undefined ? trend(chg) : "flat";
                    return (
                      <tr key={i}>
                        <td className="td-name">
                          <span className="holding-sname">{h.name ?? h.code}</span>
                          <span className="holding-code">{h.code}</span>
                        </td>
                        <td className="td-num">
                          {q ? q.price.toFixed(2) : "—"}
                        </td>
                        <td className={`td-num fund-return-${tr}`}>
                          {chg !== undefined ? formatPercent(chg) : "—"}
                        </td>
                        <td className="td-num td-weight">
                          {h.weight !== undefined ? `${h.weight}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {data.managers.length > 0 && (
            <div className="detail-section">
              <h4>基金经理</h4>
              {data.managers.map((m, i) => (
                <div key={i} className="manager-item">
                  <span className="manager-name">{m.name}</span>
                  {m.workTime && (
                    <span className="manager-info">任职 {m.workTime}</span>
                  )}
                  {m.fundSize && (
                    <span className="manager-info">规模 {m.fundSize}</span>
                  )}
                  {m.star !== undefined && (
                    <span className="manager-info">★ {m.star}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
