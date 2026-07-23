# 基金涨跌阈值提醒 — 设计文档

- **日期**: 2026-07-23
- **状态**: 已批准（待实现）
- **范围**: 为 menubar-fund 新增"涨跌阈值提醒"功能，含全局统一阈值与单基金覆盖阈值

---

## 1. 背景与目标

menubar-fund 是一个 macOS 菜单栏基金净值/估值查看器（Tauri 2 + React 19）。用户当前只能"被动看"状态栏轮播的估值涨跌，缺少"主动提醒"能力。

本功能让用户为基金设置涨跌阈值，在交易日的关键时点检查并推送提醒，实现"达到阈值主动通知"。

### 核心诉求
- **统一阈值**：一组全局默认涨/跌阈值，套用到所有自选基金
- **单基金覆盖**：个别基金可单独设置阈值，覆盖全局
- **收盘前预判**：盯盘中估算涨幅，在收盘前提醒，辅助操作决策（基金按收盘价成交，盘中实时提醒无意义）

### 非目标（YAGNI）
- 不做后台保活/到点唤起（错过不补报）
- 不做迟滞区间（每点只检查一次，无边界抖动问题）
- 不做通知 action button（系统默认点击跳转即可）
- 不做声音提示

---

## 2. 关键决策汇总

| 决策项 | 最终选择 | 理由 |
|--------|---------|------|
| 主提示方式 | macOS 系统通知（新增 `tauri-plugin-notification`） | 锁屏/后台可见，最符合"提醒"语义 |
| 辅助提示 | 菜单栏图标角标/变色 + 悬浮窗列表行高亮 | 无需权限，一眼可见 |
| 盯的涨跌值 | 盘中估算涨幅 `estGszl` | 收盘前预判，基金类 App 标准做法 |
| 上午检查点 | 定点，默认 11:00，可调（09:30-11:29） | 到点首次刷新检查一次 |
| 下午窗口 | `[alertAfternoonStart, 15:00)`，默认起点 14:30，可调（13:00-14:59） | 14:30 起持续检查突破 |
| 错过处理 | 不补报 | 简化，符合"盘中预判"语义 |
| 去重粒度 | 每基金每日上限 2 次（上午 1 + 下午 1）；下午窗口反复横跳只报首次 | 对应上午盘/下午盘两个决策窗口 |
| 阈值方向 | 涨超 + 跌超都支持，各自可独立开关（值为 null=该方向不报） | 兼容盯涨止盈、盯跌止损 |
| 单基金覆盖 | up/down 独立，`alertOverride` 开关控制 | 灵活，符合"跟随全局/单独设置"心智 |
| 节假日判断 | 第三方 API（timor.tech）按需单日拉 + 本地持久化缓存 + 失败降级判周末 | 零硬编码维护；任何失败降级安全 |
| 时间精度 | 分钟级 | 与设置页填写语义一致 |
| UI 方案 | A：全局进设置页 ⚙️，单基金进详情页分区 | 层级清晰，复用现有模态形态 |
| 默认值 | `alertEnabled=false`, `alertUp=3`, `alertDown=-2` | 老用户/新用户不被默认骚扰 |
| 验证机制 | Dev Mock 面板（`import.meta.env.DEV` 守卫），含 loop demo | 自造数据端到端验证业务 |

---

## 3. 触发与调度逻辑（§1）

### 3.1 调度方式：挂载于现有刷新机制

不引入后台调度/保活。阈值检查挂钩在现有 `App.tsx` 的 `setInterval(settings.refreshInterval)` 刷新流程上：

```
每次刷新 refresh() → fetchFundDetails(codes) → 拿到 Map<code, FundDetail|Error>
                                                      │
                                            新增：checkAlerts(map)
```

`checkAlerts` 每次刷新都跑，但内部用**时间窗口 + 内存集合**双重过滤决定是否真正发通知。

### 3.2 窗口判断

```typescript
type AlertWindow = 'morning' | 'afternoon' | 'none'

function getAlertWindow(now: Date, settings: Settings): AlertWindow {
  // 解析 alertMorningTime / alertAfternoonStart 为今天的时分
  // 上午窗口判定：now 的 "HH:MM" 严格 === alertMorningTime（如 11:00:00-11:00:59）
  //   —— 即只有到点那一分钟命中；11:01 起不再返回 'morning'
  // 下午窗口判定：alertAfternoonStart 的 "HH:MM" ≤ now 的 "HH:MM" < "15:00"
  //   —— 15:00 为 A 股收盘固定，[start, 15:00) 闭开区间
  // 都不命中返回 'none'
}
```

**关键规则**：
- **上午窗口**：`now` 的 "HH:MM" 严格等于 `alertMorningTime` 时返回 `'morning'`。用 `morningChecked: Set<code>` 标记"今天上午已检查过"（命中即加入，避免同一分钟多次刷新重复报）。下一分钟起 `getAlertWindow` 不再返回 `'morning'`，上午不再查。
- **下午窗口**：`alertAfternoonStart ≤ now < 15:00` 时返回 `'afternoon'`，每次刷新都检查（突破检测）。用 `afternoonNotified: Set<code>` 去重，每只基金整个下午窗口只报 1 次。
- **`'none'` 时的副作用**：当窗口从 `'afternoon'` 进入 `'none'`（即 15:00 后），`checkAlerts` return 前恢复菜单栏图标（`set_tray_alert(false)`）并清空 `alertedCodes`（让悬浮窗行高亮当日收盘后复位）。
- **跨日重置**：`rollOverDayIfNeeded` 检测到 `alertToday`（记录的日期）≠ 今天时，清空 `morningChecked` / `afternoonNotified` / `alertedCodes` / 重置 `alertToday`、恢复菜单栏图标。

### 3.3 跨日与会话边界
- 所有去重/状态集合存在 Zustand 的**非持久化**运行时状态（同 `details`/`refreshing`）。
- 应用启动时：`alertToday` 初始化为今天，集合为空。若启动时已错过上午窗口（如 11:05 启动），上午不补检查——符合"错过不补报"。
- 15:00 后到次日窗口前，`getAlertWindow` 返回 `'none'`，`checkAlerts` 直接 return。

### 3.4 checkAlerts 主逻辑（伪代码）

```typescript
async function checkAlerts(map: Map<string, FundDetail | Error>) {
  if (!settings.alertEnabled) return
  const now = clock.now()
  rollOverDayIfNeeded(now)                       // 跨日清集合
  const win = getAlertWindow(now, settings)
  if (win === 'none') {
    // 进入 'none'（如 15:00 后）时复位当日辅助提示
    if (wasInAfternoonWindow) {
      await invoke('set_tray_alert', { active: false })
      alertedCodes.clear()
    }
    return
  }
  if (!isTradingDay(now)) return                 // 非交易日不检查（节假日/周末）
                                                  // 注：isTradingDay 同步读缓存；缓存未命中时
                                                  //   先返回 false 并后台拉取，下轮刷新生效（§4.5）

  for (const fund of funds) {
    if (win === 'morning' && morningChecked.has(fund.code)) continue
    if (win === 'afternoon' && afternoonNotified.has(fund.code)) continue

    const detail = map.get(fund.code)
    if (!detail || detail instanceof Error) continue
    const pct = detail.estimate?.estGszl
    if (pct == null) continue                     // 没估算值不报

    const { up, down } = resolveThresholds(fund, settings)
    const hitUp = up != null && pct >= up
    const hitDown = down != null && pct <= down
    if (!hitUp && !hitDown) continue

    const direction = hitUp ? 'up' : 'down'
    await notifyAlert(fund, pct, direction)       // 系统通知
    alertedCodes.add(fund.code)                    // 供辅助提示消费
    await invoke('set_tray_alert', { active: true })  // 菜单栏图标变触发态

    if (win === 'morning') morningChecked.add(fund.code)
    else afternoonNotified.add(fund.code)
  }
}
```

### 3.5 阈值取值规则

```typescript
function resolveThresholds(fund: FundItem, settings: Settings) {
  const up = fund.alertOverride ? fund.alertUp : settings.alertUp
  const down = fund.alertOverride ? fund.alertDown : settings.alertDown
  return { up, down }   // 各自可为 null（该方向不报）
}
```

---

## 4. 节假日判断（§1 续）

### 4.1 策略：按需单日拉 + 本地持久化缓存 + 失败降级

```
checkAlerts 需判断"今天是否交易日":
  1. holidayCache[今日] 命中 → 直接用
  2. 未命中 → 拉 1 次 timor.tech（仅查今日，1 个请求）
     ├─ 成功 → 写入持久化缓存 holidayCache，用结果
     └─ 失败 → 降级判周末（周六日不检查）
```

### 4.2 数据源
- API：`http://timor.tech/api/holiday/info/{date}`，返回含 `type`（0 工作日 / 1 周末 / 2 节假日 / 3 调休）、`name`。
- 判断交易日：`type === 0 || type === 3`（工作日 + 调休补班）为交易日。

### 4.3 缓存
- 持久化到 `PersistedState.holidayCache: Record<dateStr, HolidayEntry>`，跨会话保留。
- 历史日期永久命中，越用越快，请求越来越少（一年约 250 个交易日 = 250 次请求，累积）。
- 需在 capabilities/default.json 加 `timor.tech` 的 http 域名权限。

### 4.4 安全保证
任何失败（超时/API 挂/无网络）降级判周末。而周末/节假日无盘中估值数据（`estGszl` 为 null），`pct == null` 自动跳过——**永远不会因 API 问题误报**。

### 4.5 缓存未命中时的行为（非阻塞）
`isTradingDay(now)` 同步读取 `holidayCache`：命中则返回结果；未命中则返回 `false`（不阻塞当前检查）并**后台异步拉取**写入缓存。这意味着首次进入某交易日的窗口时可能"本轮不报、下一轮刷新才报"——在 `refreshInterval`（默认 60s）下，窗口内还有多次刷新机会，API 通常 1 秒内返回缓存，正常会在窗口内补上。若 API 失败降级为只判周末，周末/节假日无估值数据自然跳过，无副作用。

---

## 5. 通知能力接入（§2）

### 5.1 接入改动清单（4 处）

**① `src-tauri/Cargo.toml`** — 加依赖
```toml
tauri-plugin-notification = "2"
```

**② `src-tauri/src/lib.rs`** — 注册插件（现有 builder 链加一行）
```rust
.plugin(tauri_plugin_notification::init())
```

**③ `src-tauri/capabilities/default.json`** — 加权限
```json
"notification:default",
"notification:allow-notify",
"notification:allow-is-permission-granted",
"notification:allow-request-permission"
```
同时加 `timor.tech` 的 http 域名权限。

**④ 前端** — 装 npm 包
```
npm install @tauri-apps/plugin-notification
```

### 5.2 通知封装（新建 `src/services/notification.ts`）

```typescript
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

export async function ensureNotificationPermission(): Promise<boolean> {
  let granted = await isPermissionGranted()
  if (!granted) {
    const perm = await requestPermission()
    granted = perm === 'granted'
  }
  return granted
}

export async function notifyAlert(fund: FundItem, pct: number, direction: 'up' | 'down') {
  const up = direction === 'up'
  const title = `${fund.name} ${up ? '涨超' : '跌超'}阈值`
  const body = `当前估算涨幅 ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%，已${up ? '涨超' : '跌破'}你设置的阈值`
  await sendNotification({ title, body })
}
```

### 5.3 授权时机（关键交互）
macOS 通知必须用户授权，**绝不能应用启动时请求**。授权请求绑定到用户**首次打开 `alertEnabled` 开关**：
```
用户点"开启提醒" → ensureNotificationPermission() → 系统弹授权框
  ├─ granted → 开关保持开，alertEnabled=true
  └─ denied  → 开关弹回关闭 + 提示"需要通知权限才能提醒"
```

### 5.4 通知内容
```
┌─────────────────────────────────┐
│ 🔔 易方达蓝筹 涨超阈值           │  title
│ 当前估算涨幅 +3.45%，已涨超你    │
│ 设置的阈值 +3%                  │  body
└─────────────────────────────────┘
```
title 带 🔔，含基金简称 + 方向；body 带具体数值 + 阈值。不带自定义 action button。

### 5.5 辅助提示 1 — 菜单栏图标
- 新增 Rust 命令 `set_tray_alert(active: bool)`：切换正常态图标 ↔ 触发态图标（红色圆点角标）。
- 触发任一基金阈值 → `active: true`；当日 15:00 后或跨日重置 → `active: false` 恢复。
- 图标资源：准备两套（正常 template 图标 + 触发态带红点）。

### 5.6 辅助提示 2 — 悬浮窗列表行高亮
- `FundRow` 读取运行时 `alertedCodes: Set<code>`。
- 命中行：📊 前显示 🔔（红底圆点），行背景轻微标红。
- `alertedCodes` 由 `checkAlerts` 维护，15:00 / 跨日清空。

---

## 6. 数据结构与持久化（§3）

### 6.1 持久化结构扩展（`state.json`，不新增文件）

```typescript
// src/store/fundStore.ts — PersistedState 扩展
interface PersistedState {
  funds: FundItem[]
  activeCode: string | null
  settings: Settings
  estimateHistory: Record<string, EstimateSnapshot[]>
  holidayCache: Record<string, HolidayEntry>   // 新增
}

// Settings 扩展（加 5 个字段）
interface Settings {
  refreshInterval: number      // 原有，默认 60
  carousel: boolean            // 原有，默认 true
  carouselInterval: number     // 原有，默认 5
  // 新增
  alertEnabled: boolean        // 默认 false
  alertUp: number | null       // 默认 3
  alertDown: number | null     // 默认 -2
  alertMorningTime: string     // 默认 "11:00"
  alertAfternoonStart: string  // 默认 "14:30"
}

// FundItem 扩展（加 3 个可选字段）
interface FundItem {
  code: string
  name: string
  addedAt: number
  // 新增（可选）
  alertUp?: number | null
  alertDown?: number | null
  alertOverride?: boolean
}

// 新增类型
interface HolidayEntry {
  isWorkday: boolean
  type: number        // timor.tech: 0工作日 1周末 2节假日 3调休
  name?: string
  cachedAt: number
}
```

### 6.2 运行时（非持久化）状态

```typescript
alertToday: string               // 'YYYY-MM-DD'，用于跨日重置检测
morningChecked: Set<string>      // 今天上午已检查的 code
afternoonNotified: Set<string>   // 今天下午已通知的 code
alertedCodes: Set<string>        // 今天触发过阈值的 code（辅助提示消费）
```

### 6.3 持久化兼容（向后兼容老 state.json）
`hydrate` 反序列化时对老数据补全默认值：
```typescript
hydrate(persisted) {
  return {
    ...persisted,
    settings: {
      refreshInterval: 60, carousel: true, carouselInterval: 5,
      alertEnabled: false, alertUp: 3, alertDown: -2,
      alertMorningTime: '11:00', alertAfternoonStart: '14:30',
      ...persisted.settings,   // 老字段覆盖默认，新字段用默认
    },
    holidayCache: persisted.holidayCache ?? {},
  }
}
```
老用户升级后 `alertEnabled=false`，不会被默认骚扰；老基金无 override 字段，自然跟随全局。

---

## 7. UI 设计（§4）

### 7.1 整体导航结构
```
悬浮窗主界面
  ├─ header: [自选基金]  🔄刷新  ➕添加  ⚙️设置(新增)  [dev:🧪]
  ├─ FundRow 列表（触发基金行末加 🔔）
  └─ 模态层（同时只显示一个）:
       ├─ AddFund（原有）
       ├─ DetailPanel（原有 + 新增"涨跌提醒"分区）
       ├─ SettingsPanel（新增）
       └─ [dev] MockPanel（新增）
```

### 7.2 设置面板 SettingsPanel（新增组件，点 ⚙️ 打开）

```
┌──────────────────────────────────────┐
│  ← 返回                       设置    │
├──────────────────────────────────────┤
│  涨跌提醒                            │
│  ┌────────────────────────────┐      │
│  │ 开启提醒          [ 开关 ]  │      │  alertEnabled，开启触发授权
│  └────────────────────────────┘      │
│                                      │
│  涨超提醒 (%)  ┌──────────┐          │
│                │   3      │          │  alertUp，可清空=关闭
│                └──────────┘          │
│  跌超提醒 (%)  ┌──────────┐          │
│                │  -2      │          │  alertDown
│                └──────────┘          │
│  上午检查点    ┌──────────┐          │
│                │  11:00   │          │  alertMorningTime
│                └──────────┘          │
│  下午检查起点  ┌──────────┐          │
│                │  14:30   │          │  alertAfternoonStart
│                └──────────┘          │
│  ┌──────────────────────────────┐    │
│  │ℹ️ 每个交易日，按盘中估算涨幅  │    │
│  │  在上午、下午收盘前各检查。  │    │
│  │  收盘固定 15:00。盯的是估值  │    │
│  │  涨幅，是收盘前的预判。      │    │
│  └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

**交互**：
- 开启提醒开关：关→开时调 `ensureNotificationPermission()`，授权失败弹回关闭 + 提示。
- 涨超/跌超：数字输入，可清空（=该方向不报）。校验：涨超≥0、跌超≤0。
- 时间：原生 `<input type="time">`，限制范围（上午 09:30-11:29，下午 13:00-14:59）。
- `alertEnabled=false` 时下方输入框置灰禁用，但保留值不清空。

### 7.3 详情面板 DetailPanel（扩展，加"涨跌提醒"分区）

```
┌──────────────────────────────────────┐
│  ← 返回              易方达蓝筹       │
├──────────────────────────────────────┤
│  …（走势图、持仓表 原有内容）…       │
├──────────────────────────────────────┤
│  涨跌提醒                            │
│  ┌────────────────────────────┐      │
│  │ 单独设置    [ 开关 ]        │      │  alertOverride
│  │ （关闭=跟随全局设置）       │      │
│  └────────────────────────────┘      │
│       （开关打开后展开 ↓）           │
│  涨超 (%)  ┌─────┐                   │
│            │  5  │                   │  fund.alertUp
│            └─────┘                   │
│  跌超 (%)  ┌─────┐                   │
│            │ -3  │                   │  fund.alertDown
│            └─────┘                   │
└──────────────────────────────────────┘
```

**交互**：
- 单独设置开关默认关，显示"跟随全局设置"，输入框隐藏；开时展开。
- 关闭 override 时 `alertUp`/`alertDown` 值保留不清空，仅不生效。

### 7.4 基金行 FundRow（扩展，加触发角标）
```
正常：○ 易方达蓝筹   +1.23%   📊   🗑
触发：○ 易方达蓝筹   +1.23%   🔔📊  🗑   ← 当天触发，加 🔔
```
读 `alertedCodes`，命中则 📊 前显示 🔔 + 行背景轻微标红。

### 7.5 菜单栏图标状态
- 新增 Rust 命令 `set_tray_alert(active: bool)`。
- 触发 → 切红点图标；当日 15:00 后 / 跨日重置 → 恢复正常。

---

## 8. 验证与模拟模式（§5）

### 8.1 目标
用注入的模拟数据 + 模拟时钟，主动触发阈值，端到端验证 `checkAlerts` 生命周期，并循环执行。

### 8.2 两个注入点（关键设计）
为让逻辑可测，把"时间来源""数据来源"两个外部依赖抽象成可替换接口：

```typescript
// src/services/clock.ts —— 时钟抽象
let mockedNow: Date | null = null
export function now(): Date { return mockedNow ?? new Date() }
export function setMockNow(d: Date | null) { mockedNow = d }   // dev-only

// checkAlerts 签名扩展 —— 数据注入
function checkAlerts(
  map: Map<code, FundDetail | Error>,
  overrides?: Map<code, number>   // dev-only：强制某基金 estGszl
)
```
生产里 `now()`=真实时间、`overrides` 不传；dev 两者都可控。**逻辑代码本身完全不变**。

### 8.3 Dev Mock 面板（仅 `import.meta.env.DEV` 可见）
header 在 dev 模式多一个 🧪 按钮，打开后：

```
┌────────────────────────────────────┐
│ ← 返回        模拟测试 (仅开发)    │
├────────────────────────────────────┤
│ 模拟当前时间                       │
│ (•) 真实时间                       │
│ ( ) 自定义  ┌────────┐             │
│             │ 11:00  │             │
│             └────────┘             │
│                                    │
│ 模拟基金估算涨幅 (estGszl)         │
│ 易方达蓝筹      ┌─────┐            │
│ (阈值3%)        │ 5.0 │ %   ← 触发 │
│                 └─────┘            │
│ 兴全合润        ┌──────┐           │
│ (阈值-2%)       │ -3.5 │ %  ← 触发 │
│                 └──────┘           │
│                                    │
│ [ ▶ 单次运行 checkAlerts ]         │
│ [ 🔁 循环演示 (loop demo) ]        │
│                                    │
│ 运行日志 ──────────────────────    │
│ 11:00:01 [上午窗口] 检查…          │
│ 11:00:01 ✅ 易方达蓝筹 涨超 +5%≥3% │
│ 11:00:01 ✅ 兴全合润 跌超 -3.5%≤-2%│
│ 11:00:01 🔔 发送 2 条通知          │
│ 11:00:01 🔴 菜单栏图标 → 触发态    │
└────────────────────────────────────┘
```

### 8.4 循环演示 (loop demo) —— looper
点一下自动按交易日时间线快进跑一遍，每步停 1-2 秒观察：

```
t=0s   模拟时间→11:00，注入触发数据 → checkAlerts → 验证上午定点触发
t=2s   模拟时间→14:25，注入"未达阈值"数据 → checkAlerts → 应不报
t=4s   模拟时间→14:48，注入"突破阈值"数据 → checkAlerts → 验证下午窗口突破触发
t=6s   模拟时间→15:05 → checkAlerts → 验证窗口结束、集合清空、图标恢复
循环
```

looper 一次性验证所有业务路径：上午定点 / 下午首次突破 / 反复横跳只报一次 / 15:00 清空 / 图标状态切换 / 列表标红。

### 8.5 范围限制
Mock 面板**仅在 Vite dev 模式**（`npm run dev` / `tauri dev`）可见，生产构建被 `import.meta.env.DEV` 守卫摇除，用户看不到、不影响包体。

---

## 9. 文件改动清单（实现时参考）

### 前端
- `package.json` — 加 `@tauri-apps/plugin-notification`
- `src/types/fund.ts` — `FundItem` 加 3 字段、`Settings` 新增类型
- `src/store/fundStore.ts` — `PersistedState` 加 `holidayCache`；`settings` 默认值；运行时状态集合；`hydrate` 兼容；新增 setter（`setAlertEnabled`/`setAlertUp`/...）；新增 fund override 更新方法
- `src/services/clock.ts` — **新建**，时钟抽象
- `src/services/notification.ts` — **新建**，通知封装
- `src/services/holiday.ts` — **新建**，节假日 API + 缓存
- `src/services/alerts.ts` — **新建**，`checkAlerts` + `getAlertWindow` + `resolveThresholds` + `isTradingDay`
- `src/App.tsx` — `refresh()` 内调 `checkAlerts`；header 加 ⚙️（dev 加 🧪）；菜单栏图标状态恢复逻辑
- `src/components/SettingsPanel.tsx` — **新建**
- `src/components/DetailPanel.tsx` — 加"涨跌提醒"分区
- `src/components/FundRow.tsx` — 读 `alertedCodes` 显示 🔔
- `src/components/MockPanel.tsx` — **新建**（dev only）
- `src/utils/format.ts` — （如需）通知文案格式化

### Rust
- `src-tauri/Cargo.toml` — 加 `tauri-plugin-notification`
- `src-tauri/src/lib.rs` — 注册 notification plugin；新增 `set_tray_alert` 命令；准备触发态图标资源
- `src-tauri/capabilities/default.json` — 加 notification 权限 + `timor.tech` http 域名

---

## 10. 测试与验收

### 10.1 Dev Mock loop demo 必须验证通过的路径
1. 上午定点：模拟 11:00 + 触发数据 → 收到通知、图标变红、列表标红
2. 上午去重：模拟 11:00:30 再次刷新 → 不重复报
3. 下午首次突破：模拟 14:48 从未达到达到 → 收到通知
4. 下午反复横跳：14:50 跌回、14:52 再达 → 第二次不报
5. 15:00 清空：模拟 15:05 → 窗口结束、集合清空、图标恢复
6. 跨日重置：模拟次日 → 集合重置、当日可重新触发
7. alertEnabled 关闭 → 全程不报
8. 单基金 override：override 基金用自己的阈值，非 override 基金用全局
9. null 阈值方向：alertUp=null → 涨超不报，跌超仍报
10. 节假日：模拟周末/节假日（mock isTradingDay=false）→ 不报
11. 无估值数据：pct==null → 跳过不报

### 10.2 生产验收
- 真实交易日 11:00 / 14:30 观察是否按预期触发（视行情而定）
- 首次开启提醒正确弹出系统授权框
- 老用户升级后默认关闭，无意外骚扰
