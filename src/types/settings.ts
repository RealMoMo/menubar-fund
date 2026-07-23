// 全局设置类型 + 默认值
// 阈值提醒相关字段见 spec §6.1

export interface Settings {
  /** 刷新间隔(秒) */
  refreshInterval: number;
  /** 状态栏轮播开关 */
  carousel: boolean;
  /** 轮播间隔(秒) */
  carouselInterval: number;
  /** 阈值提醒总开关,默认 false(需用户主动开启+授权通知) */
  alertEnabled: boolean;
  /** 涨超提醒阈值(%),如 3 表示 +3%。null=该方向不报。默认 3 */
  alertUp: number | null;
  /** 跌超提醒阈值(%),如 -2 表示 -2%。null=该方向不报。默认 -2 */
  alertDown: number | null;
  /** 上午检查点 "HH:MM",默认 "11:00" */
  alertMorningTime: string;
  /** 下午窗口起点 "HH:MM",默认 "14:30"(15:00 为 A 股收盘固定) */
  alertAfternoonStart: string;
}

export const DEFAULT_SETTINGS: Settings = {
  refreshInterval: 60,
  carousel: true,
  carouselInterval: 5,
  alertEnabled: false,
  alertUp: 3,
  alertDown: -2,
  alertMorningTime: "11:00",
  alertAfternoonStart: "14:30",
};
