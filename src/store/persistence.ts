// 持久化层:封装 Tauri store plugin
// 存储路径:~/.config/menubar-fund/ (macOS Tauri 规范)

import type { PersistedState } from "./fundStore";

const STORE_FILE = "state.json";

async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return await load(STORE_FILE, { autoSave: false });
}

/** 读取持久化状态 */
export async function loadState(): Promise<PersistedState | null> {
  try {
    const store = await getStore();
    const raw = await store.get<PersistedState>("state");
    await store.close();
    return raw ?? null;
  } catch (e) {
    console.error("[persistence] loadState failed:", e);
    return null;
  }
}

/** 写入持久化状态(防抖) */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export async function saveState(state: PersistedState): Promise<void> {
  // 防抖:短时间内多次调用只保留最后一次
  if (saveTimer) clearTimeout(saveTimer);
  return new Promise((resolve) => {
    saveTimer = setTimeout(async () => {
      try {
        const store = await getStore();
        await store.set("state", state);
        await store.save();
        await store.close();
      } catch (e) {
        console.error("[persistence] saveState failed:", e);
      }
      resolve();
    }, 300);
  });
}
