import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FundCandidate } from "./types/fund";
import { fetchFundCandidates, fetchFundDetails } from "./services/fundApi";
import { useFundStore } from "./store/fundStore";
import { loadState, saveState } from "./store/persistence";
import { AddFund } from "./components/AddFund";
import { FundRow } from "./components/FundRow";
import { DetailPanel } from "./components/DetailPanel";
import { formatTrayTitleNamed, shortenName, formatTime } from "./utils/format";

export default function App() {
  const [candidates, setCandidates] = useState<FundCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [detailCode, setDetailCode] = useState<string | null>(null);

  // 截图模式:?shot=1 时自动打开第一只基金详情
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("shot") === "1") {
      const t = setTimeout(() => {
        const first = useFundStore.getState().funds[0];
        if (first) setDetailCode(first.code);
      }, 2500);
      return () => clearTimeout(t);
    }
  }, []);

  const store = useFundStore();
  const { funds, activeCode, details, errors, refreshing, lastRefreshAt, settings } =
    store;

  // 订阅 store 变化用于持久化(用 ref 避免重复)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 标记持久化数据是否已加载完成,避免初始化前用空状态覆盖磁盘
  const hydrated = useRef(false);

  // ---- 初始化:加载持久化数据 + 搜索候选 + 首次刷新 ----
  useEffect(() => {
    (async () => {
      const persisted = await loadState();
      if (persisted) store.hydrate(persisted);
      hydrated.current = true; // 标记完成,允许后续持久化

      // 加载搜索候选(失败不阻塞,搜索功能降级)
      try {
        const list = await fetchFundCandidates();
        setCandidates(list);
      } catch (e) {
        console.error("[init] 加载基金候选失败:", e);
      } finally {
        setCandidatesLoading(false);
      }

      // 首次刷新
      refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 持久化:store 变化时防抖保存 ----
  const estimateHistory = useFundStore((s) => s.estimateHistory);
  useEffect(() => {
    // 初始化完成前不持久化,避免空状态覆盖磁盘上的预置数据
    if (!hydrated.current) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      saveState(store.exportPersisted());
    }, 500);
  }, [funds, activeCode, settings, estimateHistory]);

  // ---- 刷新逻辑 ----
  const refresh = useCallback(async () => {
    const codes = useFundStore.getState().funds.map((f) => f.code);
    if (codes.length === 0) return;
    store.setRefreshing(true);
    try {
      const map = await fetchFundDetails(codes);
      store.setDetails(map);
      // 采集估算快照(方案B:存历史估算与实际净值,供日后校准分析)
      const st = useFundStore.getState();
      for (const [code, val] of map) {
        if (!(val instanceof Error)) {
          st.recordEstimate(code, val);
        }
      }
    } catch (e) {
      console.error("[refresh] 刷新失败:", e);
    } finally {
      store.setRefreshing(false);
    }
  }, [store]);

  // ---- 后台定时刷新 ----
  useEffect(() => {
    const interval = setInterval(() => {
      refresh();
    }, settings.refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [settings.refreshInterval, refresh]);

  // ---- 状态栏标题:轮播所有自选基金(带名称) ----
  const carouselIdx = useRef(0);
  useEffect(() => {
    // 单个基金标题更新函数
    const updateTitle = (code: string) => {
      const d = details.get(code);
      if (!d) {
        invoke("set_tray_title", { title: `${shortenName(code)} ···` });
        return;
      }
      if (d.estimate) {
        invoke("set_tray_title", {
          title: formatTrayTitleNamed(
            d.name,
            d.estimate.estGsz,
            d.estimate.estGszl,
            true
          ),
        });
      } else {
        invoke("set_tray_title", {
          title: formatTrayTitleNamed(d.name, d.dwjz, d.equityReturn),
        });
      }
    };

    // 无基金或只有一只
    if (funds.length === 0) {
      invoke("set_tray_title", { title: "¥--" });
      return;
    }
    if (!settings.carousel || funds.length === 1) {
      // 不轮播:显示 activeCode(或第一只)
      const code = activeCode ?? funds[0].code;
      updateTitle(code);
      return;
    }

    // 轮播:每隔 carouselInterval 秒切换
    updateTitle(funds[carouselIdx.current % funds.length].code);
    const timer = setInterval(() => {
      carouselIdx.current = (carouselIdx.current + 1) % funds.length;
      updateTitle(funds[carouselIdx.current].code);
    }, settings.carouselInterval * 1000);
    return () => clearInterval(timer);
  }, [funds, activeCode, details, settings.carousel, settings.carouselInterval]);

  // ---- 删除(确认逻辑已移入 FundRow 内联,这里只执行) ----
  const handleRemove = useCallback(
    (code: string) => {
      store.removeFund(code);
      if (detailCode === code) setDetailCode(null);
    },
    [store, detailCode]
  );

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">自选基金</span>
        <div className="header-actions">
          <button
            className="icon-btn"
            onClick={() => refresh()}
            disabled={refreshing}
            title="刷新"
          >
            {refreshing ? "⟳" : "↻"}
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowAdd((v) => !v)}
            title={showAdd ? "收起添加" : "添加基金"}
          >
            {showAdd ? "✕" : "+"}
          </button>
        </div>
      </header>

      {showAdd && (
        <AddFund
          candidates={candidates}
          onAdded={() => {
            setShowAdd(false);
            refresh();
          }}
        />
      )}

      {candidatesLoading && funds.length === 0 && (
        <div className="empty-hint">正在加载基金数据…</div>
      )}

      {!candidatesLoading && funds.length === 0 && (
        <div className="empty-hint">
          还没有自选基金
          <br />
          点击右上角 + 添加
        </div>
      )}

      <div className="fund-list">
        {funds.map((item) => (
          <FundRow
            key={item.code}
            item={item}
            detail={details.get(item.code)}
            errorMsg={errors.get(item.code)}
            active={activeCode === item.code}
            onSelect={() => store.setActiveCode(item.code)}
            onOpenDetail={() => setDetailCode(item.code)}
            onRemove={() => handleRemove(item.code)}
          />
        ))}
      </div>

      {lastRefreshAt > 0 && (
        <footer className="app-footer">
          更新于 {formatTime(lastRefreshAt)}
        </footer>
      )}

      {detailCode && (
        <DetailPanel
          code={detailCode}
          onClose={() => setDetailCode(null)}
        />
      )}
    </div>
  );
}
