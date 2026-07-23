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
                onChange={(e) => {
                  const v = e.target.value;
                  // clamp 到上午交易时段 09:30-11:29,避免越界导致窗口永不命中
                  if (v >= "09:30" && v <= "11:29") setAlertMorningTime(v);
                }}
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
                onChange={(e) => {
                  const v = e.target.value;
                  // clamp 到下午交易时段 13:00-14:59
                  if (v >= "13:00" && v <= "14:59") setAlertAfternoonStart(v);
                }}
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
