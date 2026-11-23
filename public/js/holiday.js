/* 中国节假日/调休查询 —— 多免费 API fallback + 按天缓存
 *
 * 用途：峰谷定价 auto 模式判断「今天是否法定节假日」。
 * 官方规则：周一至周五 9-12/14-18 为高峰，周末与法定节假日按空闲价。
 * 调休补班日（周末但要上班）按高峰价处理。
 *
 * 数据源全部实测过（2026-11-23），按可靠性与速度排序。任一个成功即用，
 * 全失败时退回「纯周末判断」——不影响主流程，只是法定节假日可能误判为空闲价。
 * 结果按日期缓存到 localStorage，一天只请求一次。
 */

const CACHE_KEY = 'dsbox.holiday.v1';
const UA_ACCEPT = 'application/json, text/plain, */*';

/** API 列表：parse 把响应转成 {off:boolean, makeup:boolean, name:string} */
const SOURCES = [
  {
    name: 'jiejiariapi',
    url: (d) => `https://api.jiejiariapi.com/v1/is_holiday?date=${d}`,
    parse: (j) => ({ off: Boolean(j?.is_holiday), makeup: false, name: j?.holiday?.name || '' }),
  },
  {
    name: 'xiaoai',
    url: (d) => `https://publicapi.xiaoai.me/holiday/day?date=${d}`,
    parse: (j) => {
      const x = (j?.data || [])[0] || {};
      const daytype = Number(x.daytype);
      return {
        off: daytype === 1 || daytype === 2,   // 1=节假日 2=双休日
        makeup: daytype === 3,                 // 3=调休日（需上班）
        name: x.holiday || '',
      };
    },
  },
  {
    name: 'pinjia',
    url: (d) => `https://pinjia.day/api/v1/isWorkday?date=${d}`,
    parse: (j) => ({ off: j?.isWorkday === false && j?.type !== 'weekend', makeup: j?.type === 'makeup_workday', name: j?.holiday?.name || '' }),
  },
  {
    name: 'nager',
    url: (d) => {
      const [y] = d.split('-');
      return `https://date.nager.at/api/v3/PublicHolidays/${y}/CN`;
    },
    parse: (j, d) => {
      const hit = Array.isArray(j) ? j.find((x) => x.date === d) : null;
      return { off: Boolean(hit), makeup: false, name: hit?.localName || '' };
    },
  },
];

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function writeCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
}

function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 查某天的节假日状态。返回 {off, makeup, name, source, cached} */
export async function getHoliday(date = new Date(), { timeout = 4000 } = {}) {
  const key = dateStr(date);
  const cache = readCache();
  if (cache[key]) return { ...cache[key], cached: true };

  for (const src of SOURCES) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(src.url(key), { signal: ac.signal, headers: { accept: UA_ACCEPT } });
      clearTimeout(timer);
      if (!r.ok) continue;
      const j = await r.json();
      const parsed = src.parse(j, key);
      const result = { ...parsed, source: src.name, cached: false, queriedAt: Date.now() };
      cache[key] = result;
      writeCache(cache);
      return result;
    } catch {
      clearTimeout(timer);
    }
  }
  // 全部失败：只按周末判断，标记为 fallback
  const day = date.getDay();
  return { off: day === 0 || day === 6, makeup: false, name: '', source: 'fallback', cached: false };
}

/** 清空缓存（设置页可调用） */
export function clearHolidayCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}

export { SOURCES as HOLIDAY_SOURCES };
