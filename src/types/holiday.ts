// 节假日缓存条目(spec §6.1)
// 数据源:timor.tech/api/holiday/info/{date}

export interface HolidayEntry {
  /** 是否为工作日(含调休补班) */
  isWorkday: boolean;
  /** timor.tech 类型码:0=工作日 1=周末 2=节假日 3=调休 */
  type: number;
  /** 节假日名称(如 "国庆节"),工作日无 */
  name?: string;
  /** 缓存时间戳(ms) */
  cachedAt: number;
}
