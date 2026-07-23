// Dev 模拟面板(仅 import.meta.env.DEV 可见,spec §8)
// 注入模拟时钟 + 模拟估值涨幅,端到端验证 checkAlerts 生命周期

import { useState, useRef } from "react";
import { useFundStore } from "../store/fundStore";

interface MockPanelProps {
  onClose: () => void;
  /** 由 App 提供:用真实详情 + mock 时间/涨幅跑一次 checkAlerts,并同步图标 */
  onRun: (mockTime: Date | null, overrides: Map<string, number>) => Promise<void>;
}

interface LogEntry {
  ts: string;
  msg: string;
}

function mkDate(h: number, m: number): Date {
  // 固定周四 2026-07-23(交易日)
  return new Date(2026, 6, 23, h, m, 0);
}

/** 生成触发阈值的 mock 涨幅(涨超阈值 +2) */
function triggerValues(): Record<string, string> {
  const settings = useFundStore.getState().settings;
  const funds = useFundStore.getState().funds;
  const out: Record<string, string> = {};
  for (const f of funds) {
    const up = f.alertOverride ? f.alertUp : settings.alertUp;
    if (up != null) out[f.code] = String(up + 2); // 涨超阈值 +2 触发
  }
  return out;
}

export function MockPanel({ onClose, onRun }: MockPanelProps) {
  const funds = useFundStore((s) => s.funds);
  const settings = useFundStore((s) => s.settings);
  const alertedCodes = useFundStore((s) => s.alertedCodes);
  const morningChecked = useFundStore((s) => s.morningChecked);
  const afternoonNotified = useFundStore((s) => s.afternoonNotified);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [timeMode, setTimeMode] = useState<"real" | "custom">("custom");
  const [customTime, setCustomTime] = useState("11:00");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [looping, setLooping] = useState(false);
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
      `运行 checkAlerts | 时间=${mockTime ? customTime : "实时"} | mock涨幅=${
        [...ov.entries()].map(([c, v]) => `${c}=${v}`).join(",") || "无"
      }`
    );
    await onRun(mockTime, ov);
    const st = useFundStore.getState();
    log(
      `结果 | alerted=[${[...st.alertedCodes].join(",")}] morningChecked=${
        st.morningChecked.size
      } afternoonNotified=${st.afternoonNotified.size}`
    );
  };

  /** loop demo:按交易日时间线快进,验证全部路径(spec §8.4) */
  const runLoop = () => {
    // 二次点击 = 停止
    if (looping) {
      stopLoop();
      return;
    }
    setLooping(true);
    log("▶ 开始 loop demo");
    const steps: Array<{ t: string; label: string; ov: Record<string, string> }> = [
      { t: "11:00", label: "上午定点(应触发)", ov: triggerValues() },
      { t: "11:00", label: "上午同点再跑(去重,应不报)", ov: triggerValues() },
      { t: "14:25", label: "下午未达(应不报)", ov: {} },
      { t: "14:48", label: "下午突破(应触发,首次)", ov: triggerValues() },
      { t: "14:55", label: "下午反复横跳(去重,应不报)", ov: triggerValues() },
      { t: "15:05", label: "收盘后(窗口none)", ov: triggerValues() },
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
      const st = useFundStore.getState();
      log(
        `  → alerted=[${[...st.alertedCodes].join(
          ","
        )}] morning=${st.morningChecked.size} afternoon=${st.afternoonNotified.size}`
      );
      i++;
      if (looping) loopTimer.current = setTimeout(tick, 1500);
    };
    tick();
  };

  const stopLoop = () => {
    if (loopTimer.current) {
      clearTimeout(loopTimer.current);
      loopTimer.current = null;
    }
    setLooping(false);
    log(`⏹ 停止 loop`);
  };

  const resetTime = () => {
    stopLoop();
    log("已重置为真实时间");
  };

  const close = () => {
    stopLoop();
    onClose();
  };

  return (
    <div className="detail-overlay" onClick={close}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <span className="detail-name">🧪 模拟测试(仅开发)</span>
          <button className="icon-btn" onClick={close}>
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
                      setOverrides((o) => ({ ...o, [f.code]: e.target.value }))
                    }
                    placeholder="留空=用真实值"
                  />
                </div>
              );
            })}
          </div>

          <div className="detail-section">
            <h4>当前状态</h4>
            <div className="setting-hint">
              alertEnabled={String(settings.alertEnabled)} | alertedCodes=
              [{[...alertedCodes].join(",")}] | morningChecked=
              {morningChecked.size} | afternoonNotified={afternoonNotified.size}
            </div>
          </div>

          <div className="setting-row">
            <button className="range-btn" onClick={runOnce}>
              ▶ 单次运行 checkAlerts
            </button>
            <button className="range-btn" onClick={runLoop}>
              {looping ? "⏹ 停止 loop" : "🔁 循环演示 (loop demo)"}
            </button>
            <button className="range-btn" onClick={resetTime}>
              ↺ 重置时间
            </button>
          </div>

          <div className="detail-section">
            <h4>运行日志</h4>
            <div className="mock-log">
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
