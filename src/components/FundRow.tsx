import type { FundDetail, FundItem } from "../types/fund";
import { formatNetValue, formatPercent, trend, formatDate, formatTime } from "../utils/format";
import { useFundStore } from "../store/fundStore";

interface FundRowProps {
  item: FundItem;
  detail?: FundDetail;
  errorMsg?: string;
  active: boolean;
  onSelect: () => void;
  onOpenDetail: () => void;
  onRemove: () => void;
}

export function FundRow({
  item,
  detail,
  errorMsg,
  active,
  onSelect,
  onOpenDetail,
  onRemove,
}: FundRowProps) {
  // 当天是否触发过阈值(辅助提示,spec §5.6)
  const alerted = useFundStore((s) => s.alertedCodes.has(item.code));
  // 交易时段有估算值时,优先显示估算;否则显示历史净值
  const est = detail?.estimate;
  const showEstimate = !!est;
  const value = showEstimate ? est!.estGsz : detail?.dwjz ?? 0;
  const ret = showEstimate ? est!.estGszl : detail?.equityReturn ?? 0;
  const tr = trend(ret);

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove();
  };

  return (
    <div
      className={`fund-row ${active ? "fund-row-active" : ""} ${
        alerted ? "fund-row-alerted" : ""
      }`}
    >
      <button
        className="fund-radio"
        title={active ? "状态栏显示中" : "设为状态栏显示"}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        {active ? "●" : "○"}
      </button>

      <div className="fund-main" onClick={onOpenDetail}>
        <div className="fund-name-line">
          <span className="fund-name">{detail?.name ?? item.name}</span>
          <span className="fund-code">{item.code}</span>
        </div>
        {errorMsg ? (
          <span className="fund-error">{errorMsg}</span>
        ) : detail ? (
          <div className="fund-value-line">
            {showEstimate && <span className="est-badge">估</span>}
            {alerted && (
              <span className="alert-badge" title="今日触发过阈值">
                🔔
              </span>
            )}
            <span className="fund-value">{formatNetValue(value)}</span>
            <span className={`fund-return fund-return-${tr}`}>
              {formatPercent(ret)}
            </span>
            <span className="fund-date">
              {showEstimate ? formatTime(est!.estGztime) : formatDate(detail.dwjzDate)}
            </span>
          </div>
        ) : (
          <span className="fund-loading">加载中…</span>
        )}
      </div>

      <button
        className="fund-remove"
        title="删除"
        onClick={handleRemoveClick}
      >
        ×
      </button>
    </div>
  );
}
