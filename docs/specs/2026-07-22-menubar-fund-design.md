# 设计文档:状态栏基金(Menubar Fund Tracker)

- **状态**:已通过方案评审,待实现
- **日期**:2026-07-22
- **背景来源**:fishing-funds (github.com/1zilc/fishing-funds) 因数据源失效无法使用,从零重写

---

## 1. 背景与目标

### 1.1 起因

fishing-funds 添加自选基金功能失效。经系统性排查,根因是天天基金(东方财富)服务端下线了实时估值接口 `fundgz.1234567.com.cn/js/<code>.js`(返回 404)。该 App "添加自选"时必须调用此接口校验基金并取估值,接口失效后 App 静默吞错(`catch { return {} }`),用户只看到无意义的"添加基金失败"。

进一步排查发现:fishing-funds 的核心数据层(所有 `Services.Fund.*` 网络请求逻辑)位于私有子模块 `fishing-funds-enh` 中,而该子模块在 GitHub 上已被作者删除(仓库不可访问,`ls-remote` 返回 Repository not found)。因此无法基于原项目修复——即使编译,也缺少最核心的数据层代码。

### 1.2 目标

从零重写一个 Mac 状态栏基金 App,吸收 fishing-funds 的核心体验:

- 状态栏标题直接显示基金净值与日涨幅
- 点击状态栏图标弹出悬浮窗,查看自选列表
- 添加/删除自选基金
- 基金详情页(净值走势、收益率、持仓、经理)

### 1.3 MVP 范围

- 基金自选管理(添加/删除/排序)
- 状态栏净值显示
- 基金详情页(净值走势图、收益率、持仓、经理)
- 后台定时刷新

**不在 MVP 范围**(留待后续迭代):

- 盘中实时估值推算(原 fundgz 接口已死,推算逻辑复杂,见 §3.2)
- 大盘指数(上证/深证/创业板)
- 个股行情
- 跨平台(先 Mac,Tauri 架构允许后续扩展)

### 1.4 成功标准

1. 能稳定添加/删除自选基金,添加时正确校验基金有效性
2. 状态栏标题显示选中基金的净值与日涨幅,涨绿跌红
3. 详情页展示净值走势折线图(可切换时间区间)
4. 断网时不崩溃,显示上次缓存数据并标注时间

---

## 2. 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 应用框架 | Tauri 2.x | 系统 WebView,包体 ~10MB(Electron ~150MB);状态栏 Tray + setTitle 能力与 Electron 等价 |
| 前端框架 | React 19 + TypeScript | 熟悉的技术栈,与原项目一致 |
| 构建 | Vite | Tauri 默认搭配 |
| 状态管理 | Zustand | 轻量,替代原项目 Redux |
| 持久化 | Tauri Store plugin | JSON 落盘到用户配置目录 |
| 图表 | ECharts | 净值折线图,与原项目体验一致 |
| HTTP | Tauri http plugin | 主进程发请求,绕过浏览器 CORS |

**Tauri 主进程需用的 Rust API**:`tauri::tray::TrayBuilder`(状态栏)、`tray.setTitle()`(动态标题)、隐藏窗口 + `show/hide`(点击图标弹出)。

---

## 3. 数据源

### 3.1 已验证可用的接口

| 数据用途 | 接口 URL | 状态 | 说明 |
|----------|----------|------|------|
| 基金搜索(代码表) | `https://fund.eastmoney.com/js/fundcode_search.js` | ✅ 活 | 约 3MB,定义 `var r = [["000001","HXCZHH","华夏成长混合","混合型-灵活","HUAXIACHENGZHANGHUNHE"], ...]`,前端过滤 |
| 净值/走势/持仓/经理 | `https://fund.eastmoney.com/pingzhongdata/<code>.js` | ✅ 活 | JS 文件,定义多个 `var`。最新净值到昨日(实测 2026-07-21),含 5967 历史净值点 |

**pingzhongdata 提供的字段**(经实测):

- `fS_name` / `fS_code`:基金名称/代码
- `fund_sourceRate` / `fund_minsg`:原费率 / 起购金额
- `ishb`:是否货币基金
- `Data_netWorthTrend`:`[{x:时间戳, y:单位净值, equityReturn:日收益率, unitMoney}]`
- `Data_grandTotal`:累计收益趋势
- `Data_currentFundManager`:基金经理信息
- `Data_assetAllocation`:资产配置
- `stockCodesNew`:持仓股代码(含市场前缀,如 `0.300308`)
- `syl_1n` / `syl_1y` / `syl_3y` / `syl_6y`:近1年/1月/3年/6月收益率

### 3.2 已失效接口(不使用)

| 接口 | 状态 | 说明 |
|------|------|------|
| `fundgz.1234567.com.cn/js/<code>.js` | ❌ 已下线(404) | 原 fishing-funds 的盘中实时估值来源,这是其功能失效根因 |
| `fundgz.eastmoney.com/js/<code>.js` | ❌ 302 跳转到无效页 | fundgz 的备用域名同样失效 |
| `fundmobapi.eastmoney.com/FundMNewApi/*` | ❌ 风控 | 返回"网络繁忙 ErrCode 61136",移动端 API 对部分请求头/IP 拦截 |

### 3.3 盘中实时估值处理(降级策略)

MVP 阶段**不提供盘中实时估值**,改为显示:

- 最新单位净值(`Data_netWorthTrend` 末尾点)
- 最近交易日日涨幅(`equityReturn`)

盘中实时估值理论上可用持仓股实时行情推算:`push2.eastmoney.com/api/qt/ulist.np` 批量取持仓股实时涨跌幅(已验证可用),乘以上期持仓比例求加权涨幅。但该方案逻辑复杂、数据有时效性误差(持仓季报延迟),留作 v2。

---

## 4. 架构

```
┌──────────────────────────────────────────────────┐
│  Tauri 主进程 (Rust)                               │
│  - Tray:状态栏图标 + setTitle(动态显示净值)        │
│  - 隐藏窗口:点击图标 toggle show/hide              │
│  - http plugin:发请求(绕 CORS)                     │
│  - store plugin:自选列表持久化                      │
└────────────────┬─────────────────────────────────┘
                 │  IPC (tauri invoke / event)
┌────────────────┴─────────────────────────────────┐
│  前端 (React + TypeScript + Vite)                  │
│                                                    │
│  ┌──────────────┐      ┌───────────────────────┐  │
│  │ 数据层        │      │ UI 层                  │  │
│  │ services/     │ ←→  │  WatchList(自选列表)   │  │
│  │  fundApi.ts   │      │  AddFund(添加/搜索)    │  │
│  │  parse.ts     │      │  Detail(详情+图表)    │  │
│  └──────────────┘      │  TrayTitle(状态栏数据) │  │
│         ↕               └───────────────────────┘  │
│  ┌──────────────┐                                 │
│  │ store/        │  Zustand:                      │
│  │  fundStore.ts │  - funds: 自选列表             │  │
│  │  setting.ts   │  - activeCode: 状态栏显示基金   │  │
│  └──────────────┘  - settings: 偏好               │  │
└────────────────────────────────────────────────────┘
```

---

## 5. 核心组件

### 5.1 Tray 状态栏(Rust 侧)

- `TrayBuilder` 创建状态栏图标
- `tray.setTitle()` 动态设置标题文字
- 标题格式:`1.445 ↑10.64%`(净值 + 日涨幅)
  - 上涨:绿色前缀 / `↑` 符号
  - 下跌:红色前缀 / `↓` 符号
  - 平/无数据:中性显示
- 点击图标 → toggle 悬浮窗 show/hide

**注**:macOS 状态栏标题颜色由系统控制,`setTitle` 只能设文字。涨跌方向通过 `↑/↓` 符号区分;若需颜色需用 `NSStatusItem` 的 attributedTitle(Tauri 2 是否支持需开发首晚 spike 验证,见 §11 风险)。

### 5.2 悬浮窗(自选列表)

- 点状态栏图标弹出,贴近图标位置
- 列出所有自选基金,每行:代码 / 名称 / 最新净值 / 日涨幅 / 操作
- 日涨幅涨绿跌红
- 每行可点击设为"状态栏显示基金"(单选,radio)
- 每行可删除(带二次确认)
- 支持拖拽排序

### 5.3 添加基金

- 输入框,支持按代码或名称模糊搜索
- 前端过滤 `fundcode_search.js` 内存缓存(启动时加载一次,约 3MB)
- 选中候选即触发添加
- **添加即校验**:取一次 `pingzhongdata` 确认基金有效并取得初始数据
  - 原 fishing-funds 死在这一步(用 fundgz 校验),本方案改用 pingzhongdata

### 5.4 基金详情页

点列表项展开,展示:

- **头部**:代码、名称、最新净值、日涨幅、近1月/1年/3年收益率
- **净值走势图**:ECharts 折线图,可切换 近1月 / 近3月 / 近1年 / 全部
- **十大持仓**:`stockCodesNew` 解析出的持仓股
- **基金经理**:`Data_currentFundManager`(姓名、任职时间、回报)

### 5.5 后台刷新

- 定时器(默认每 60 秒)拉取所有自选的 `pingzhongdata`
- 更新列表净值、状态栏标题
- 刷新间隔可在设置中调整(30s / 60s / 5min)

---

## 6. 数据流

### 6.1 添加自选基金

```
用户输入 "000001"
  → 前端从内存 searchIndex 过滤 → 显示候选"华夏成长混合"
  → 用户点添加
  → services.fetchFundDetail('000001')
       [Tauri http → GET pingzhongdata/000001.js]
       ├─ 成功:parse.ts 正则解析 → 得到 FundDetail{name, dwjz, equityReturn, ...}
       │         → store.add(fund) → Tauri store 落盘 → 刷新列表 + 状态栏标题
       └─ 失败:UI 显示明确错误(见 §7)
```

### 6.2 状态栏标题更新

```
定时器触发 / 自选变化 / activeCode 变化
  → 取 activeCode 对应基金的最新净值
  → 格式化 "1.445 ↑10.64%"
  → invoke('set_tray_title', { title })
  → Rust 侧 tray.setTitle(title)
```

### 6.3 启动加载

```
App 启动
  → 读 Tauri store 恢复自选列表 + activeCode + settings
  → 后台拉取 fundcode_search.js 填充搜索索引(若缓存过期)
  → 触发一次刷新
```

---

## 7. 错误处理(关键设计)

原 fishing-funds 的核心缺陷:**所有 HTTP 错误被静默吞掉**(`httpClient.ts: catch { return {} }`),导致用户只看到无意义的"添加失败"。

本方案的原则:**数据层不吞错,UI 层展示明确语义**。

### 7.1 数据层:有语义的错误类型

定义三个错误类,各自携带可读 message(下方为类型签名示意,具体字段实现时定):

```typescript
class NetworkError extends Error {}        // 请求失败/超时,可携带 statusCode
class FundNotFoundError extends Error {}   // 基金代码不存在,携带 code
class ParseError extends Error {}          // 响应解析失败(字段缺失),携带 raw 摘要
```

service 方法抛出具体错误类型,不返回空对象。

### 7.2 UI 层:根据错误类型给提示

| 错误类型 | 提示 |
|----------|------|
| NetworkError | "网络异常,请检查连接" |
| FundNotFoundError | "未找到该基金,请检查代码" |
| ParseError | "数据异常(接口可能变更)" |
| 成功 | 无提示 / 静默添加 |

### 7.3 解析容错

`pingzhongdata` 是 JS 文件(`var x = ...` 格式),解析方式:

- **用正则提取,绝不 eval**(原项目用 eval,有安全与健壮性问题)
- 每个字段独立 try/catch,缺失时该字段为 `undefined`,不影响其他字段
- 整体解析失败 → 抛 ParseError

---

## 8. 持久化

使用 Tauri Store plugin,数据落盘到 `~/.config/menubar-fund/`(macOS 实际路径遵循 Tauri 规范)。

存储结构:

```jsonc
{
  "funds": [
    { "code": "000001", "name": "华夏成长混合", "addedAt": 1234567890 }
  ],
  "activeCode": "000001",
  "settings": {
    "refreshInterval": 60,
    "searchIndexUrl": "https://fund.eastmoney.com/js/fundcode_search.js"
  }
}
```

---

## 9. 测试策略

### 9.1 数据层(单元测试)

- `parse.ts`:用固定的 `pingzhongdata` JS 样本作为输入,验证各字段正则提取正确
  - 正常样本
  - 字段缺失样本(验证容错不崩溃)
  - 空响应样本
- `services/fundApi.ts`:mock HTTP 响应,验证错误类型映射

### 9.2 关键路径(手动验证)

- 添加基金(有效代码 / 无效代码 / 断网)
- 删除基金(确认 / 取消)
- 状态栏标题随 activeCode 切换变化
- 刷新定时器工作
- 断网时显示缓存 + 时间标注

### 9.3 离线降级

- 每次成功刷新后,把净值快照存入 store
- 断网时显示最后一次成功的数据,UI 标注"数据更新于 HH:MM"
- 恢复网络后自动重新刷新

---

## 10. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 东方财富再下线 `pingzhongdata` | 核心数据来源失效 | 数据层抽象为接口(基金数据 Provider),预留可替换实现;启动时做健康检查,失效时明确告警 |
| 盘中无实时估值,体验打折 | 与 fishing-funds 全盛期体验有差距 | MVP 接受降级;v2 用 push2 持仓股实时行情推算(已验证 push2 可用) |
| Tauri 2 状态栏 setTitle / 颜色支持与预期不符 | 状态栏标题无法按预期显示 | 开发首晚先做 Tray + setTitle 的 spike 验证;若不支持颜色则退化为纯文字 + ↑/↓ 符号(纯文字方案在 §5.1 已保证可行) |
| Tauri http plugin 对 .js 请求头的处理 | 接口可能要求特定 Referer | 实测 pingzhongdata/fundcode_search 不强校验 Referer;若遇拦截在 Rust 侧补 Referer 头 |

---

## 11. 开发里程碑(供 writing-plans 参考)

1. **Spike**:Tauri Tray + setTitle + 点击弹窗最小验证(降风险)
2. **数据层**:`pingzhongdata` / `fundcode_search.js` 解析 + service + 单元测试
3. **状态管理 + 持久化**:Zustand store + Tauri store
4. **UI - 自选列表 + 添加**:悬浮窗、搜索、添加/删除
5. **状态栏标题联动**:activeCode → tray.setTitle
6. **UI - 详情页**:ECharts 净值走势 + 持仓 + 经理
7. **后台刷新 + 离线降级**:定时器 + 缓存
8. **打磨**:打包、图标、开机启动
