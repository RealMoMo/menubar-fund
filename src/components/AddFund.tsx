import { useMemo, useState } from "react";
import type { FundCandidate } from "../types/fund";
import { fetchFundDetail } from "../services/fundApi";
import { useFundStore } from "../store/fundStore";
import { NetworkError, FundNotFoundError, ParseError } from "../types/fund";

interface AddFundProps {
  candidates: FundCandidate[];
  onAdded: () => void;
}

// 多分隔符:分号 / 逗号 / 空格 / 换行
const SPLIT_RE = /[\s,;，；、]+/;

interface BatchResult {
  ok: string[];
  failed: { code: string; reason: string }[];
}

export function AddFund({ candidates, onAdded }: AddFundProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "error" | "ok" } | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const addFund = useFundStore((s) => s.addFund);
  const funds = useFundStore((s) => s.funds);

  // 从输入中提取多个基金代码(6位数字)
  const parsedCodes = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return q
      .split(SPLIT_RE)
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s));
  }, [query]);

  // 是否多代码模式(输入含分隔符或多个6位代码)
  const isBatchMode = parsedCodes.length > 1;

  // 单代码模式:前端过滤候选(最多 8 条)
  const filtered = useMemo(() => {
    if (isBatchMode) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return candidates
      .filter(
        (c) =>
          c.code.toLowerCase().startsWith(q) ||
          c.name.toLowerCase().includes(q) ||
          c.pinyin.toLowerCase().startsWith(q) ||
          c.quanpin.toLowerCase().startsWith(q)
      )
      .slice(0, 8);
  }, [query, candidates, isBatchMode]);

  // 错误信息映射
  function errMsg(e: unknown): string {
    if (e instanceof FundNotFoundError) return "基金不存在";
    if (e instanceof NetworkError) return "网络异常";
    if (e instanceof ParseError) return "数据异常";
    return String(e);
  }

  // 批量添加:逐一校验(并发,但限制并发数避免被限流)
  async function handleBatchAdd() {
    const existing = new Set(funds.map((f) => f.code));
    const toAdd = parsedCodes.filter((c) => !existing.has(c));
    if (toAdd.length === 0) {
      setToast({ msg: "没有需要添加的基金(可能已存在)", type: "error" });
      setTimeout(() => setToast(null), 3000);
      return;
    }

    setLoading(true);
    setProgress({ done: 0, total: toAdd.length });
    setToast(null);
    setBatchResult(null);

    const ok: string[] = [];
    const failed: { code: string; reason: string }[] = [];
    const CONCURRENCY = 4;

    let idx = 0;
    async function worker() {
      while (idx < toAdd.length) {
        const myIdx = idx++;
        const code = toAdd[myIdx];
        try {
          const detail = await fetchFundDetail(code);
          addFund({ code, name: detail.name || code, addedAt: Date.now() });
          ok.push(code);
        } catch (e) {
          failed.push({ code, reason: errMsg(e) });
        }
        setProgress({ done: ok.length + failed.length, total: toAdd.length });
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, toAdd.length) }, () => worker())
    );

    setLoading(false);
    setProgress(null);

    // 已存在的也算"跳过"
    const skipped = parsedCodes.filter((c) => existing.has(c));
    setBatchResult({ ok, failed });

    if (ok.length > 0) {
      setQuery("");
      onAdded();
    }

    // 结果汇总提示
    let msg = `成功 ${ok.length} 只`;
    if (failed.length) msg += `,失败 ${failed.length} 只`;
    if (skipped.length) msg += `,已存在 ${skipped.length} 只`;
    setToast({ msg, type: failed.length > 0 && ok.length === 0 ? "error" : "ok" });
  }

  // 单只添加
  async function handleAdd(code: string, name: string) {
    if (funds.some((f) => f.code === code)) {
      setToast({ msg: `${name} 已在自选列表`, type: "error" });
      return;
    }
    setLoading(true);
    setToast(null);
    try {
      const detail = await fetchFundDetail(code);
      addFund({ code, name: detail.name || name, addedAt: Date.now() });
      setQuery("");
      setToast({ msg: `已添加 ${detail.name}`, type: "ok" });
      onAdded();
    } catch (e) {
      setToast({ msg: `添加失败:${errMsg(e)}`, type: "error" });
    } finally {
      setLoading(false);
      setTimeout(() => setToast(null), 3000);
    }
  }

  return (
    <div className="add-fund">
      <input
        className="add-fund-input"
        placeholder={
          "输入基金代码/名称,批量添加用 ; 或 , 分隔"
        }
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setBatchResult(null);
        }}
        disabled={loading}
        autoFocus
      />

      {/* 批量模式:显示识别到的代码 + 添加按钮 */}
      {isBatchMode && (
        <div className="batch-area">
          <div className="batch-codes">
            识别到 {parsedCodes.length} 个代码:
            {parsedCodes.map((c) => (
              <span key={c} className="batch-code-tag">{c}</span>
            ))}
          </div>
          <button
            className="batch-add-btn"
            onClick={handleBatchAdd}
            disabled={loading}
          >
            {loading && progress
              ? `添加中 ${progress.done}/${progress.total}…`
              : `批量添加 ${parsedCodes.length} 只`}
          </button>
        </div>
      )}

      {/* 单代码搜索结果 */}
      {!isBatchMode && filtered.length > 0 && (
        <div className="search-results">
          {filtered.map((c) => (
            <button
              key={c.code}
              className="search-item"
              onClick={() => handleAdd(c.code, c.name)}
              disabled={loading}
            >
              <span className="search-item-code">{c.code}</span>
              <span className="search-item-name">{c.name}</span>
              <span className="search-item-type">{c.type}</span>
            </button>
          ))}
        </div>
      )}

      {/* 批量结果明细 */}
      {batchResult && (batchResult.ok.length > 0 || batchResult.failed.length > 0) && (
        <div className="batch-result">
          {batchResult.ok.length > 0 && (
            <div className="batch-ok">
              成功:{batchResult.ok.join("、")}
            </div>
          )}
          {batchResult.failed.length > 0 && (
            <div className="batch-failed">
              失败:
              {batchResult.failed.map((f) => (
                <span key={f.code} className="batch-fail-item">
                  {f.code}({f.reason})
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
      {loading && !progress && <div className="toast">正在校验基金数据…</div>}
    </div>
  );
}
