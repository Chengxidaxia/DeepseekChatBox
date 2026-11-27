'use strict';
/**
 * CPL ID 体系
 *
 * 语法：  [namespace@][版本条件]:id
 *   - id            必填，最右一个 ':' 之后的部分
 *   - namespace     可省；省略时指向 chatbox（cdcp）或插件自身
 *   - 版本条件      与 '@' 成对出现，或两者同时省略
 *                   可用： >=  >  =  <  <=   无符号等价 '='
 *                   也可用区间： [1320,1428] (1320,1428) [1320,1428) (1320,1428]
 *   - 唯一版本号    无符号 long long（用 BigInt 比较，不受 2^53 限制）
 *
 * 例：
 *   function                  → cdcp, 任意版本, function
 *   pluginns:func             → pluginns, 任意版本, func
 *   pluns@13520:func          → pluns, =13520, func
 *   pluns@[13520,14520]:func  → pluns, 区间, func
 *   pluns@>=1320:func         → pluns, >=1320, func
 */

const RESERVED_NS = new Set(['cdcp', 'cpl']);
const NS_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ID_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const ULL_MAX = (1n << 64n) - 1n;

class IdError extends Error {
  constructor(msg, raw) {
    super(msg);
    this.name = 'IdError';
    this.raw = raw;
  }
}

function toUll(v, raw) {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw new IdError(`版本号必须是无符号整数：${s}`, raw);
  const n = BigInt(s);
  if (n > ULL_MAX) throw new IdError(`版本号超出 unsigned long long 范围：${s}`, raw);
  return n;
}

/** 解析版本条件段，返回 { test(v)->bool, text } */
function parseRange(seg, raw) {
  const s = String(seg).trim();
  if (!s) throw new IdError('版本段为空（@ 与版本条件必须成对出现）', raw);

  // 区间：[a,b] (a,b) [a,b) (a,b]
  const m = s.match(/^([[(])\s*(\d+)?\s*,\s*(\d+)?\s*([\])])$/);
  if (m) {
    const openMin = m[1] === '(';
    const openMax = m[4] === ')';
    const min = m[2] === undefined ? null : toUll(m[2], raw);
    const max = m[3] === undefined ? null : toUll(m[3], raw);
    if (min !== null && max !== null && min > max) throw new IdError(`版本区间下限大于上限：${s}`, raw);
    return {
      text: s,
      test(v) {
        const n = toUll(v, raw);
        if (min !== null) {
          if (openMin ? !(n > min) : !(n >= min)) return false;
        }
        if (max !== null) {
          if (openMax ? !(n < max) : !(n <= max)) return false;
        }
        return true;
      },
    };
  }

  // 比较符：多字符优先，避免 '>=' 被当成 '>'
  const cmp = s.match(/^(>=|<=|>|<|=)?\s*(.*)$/);
  if (!cmp || !cmp[2]) throw new IdError(`无法解析版本条件：${s}`, raw);
  const op = cmp[1] || '=';
  const val = toUll(cmp[2], raw);
  const tests = {
    '=': (n) => n === val,
    '>': (n) => n > val,
    '>=': (n) => n >= val,
    '<': (n) => n < val,
    '<=': (n) => n <= val,
  };
  return { text: op + String(val), test: (v) => tests[op](toUll(v, raw)) };
}

/**
 * 解析一个 ID。
 * @param {string} raw
 * @param {{ defaultNs?: string, selfNs?: string }} opt
 *         defaultNs 缺省命名空间（通常 'cdcp'）；selfNs 当前插件命名空间
 * @returns {{ raw:string, ns:string, id:string, range:object|null, full:string }}
 */
function parseId(raw, opt = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new IdError('ID 不能为空', raw);
  const s = raw.trim();

  const cut = s.lastIndexOf(':');
  const head = cut === -1 ? s : s.slice(0, cut);
  const id = cut === -1 ? s : s.slice(cut + 1);

  if (!id) throw new IdError(`ID 缺少方法名：${s}`, raw);
  if (!ID_RE.test(id)) throw new IdError(`方法名含非法字符：${id}`, raw);

  let ns = null;
  let range = null;

  const at = head.indexOf('@');
  if (at !== -1) {
    ns = head.slice(0, at).trim();
    const verSeg = head.slice(at + 1).trim();
    if (!ns) throw new IdError(`@ 前缺少命名空间：${s}`, raw);
    range = parseRange(verSeg, raw);
  } else if (cut !== -1 && head.trim()) {
    ns = head.trim();
  }

  if (ns !== null) {
    if (!NS_RE.test(ns)) throw new IdError(`命名空间含非法字符：${ns}`, raw);
  } else {
    // 省略命名空间：优先当前插件自身，其次 cdcp
    ns = opt.selfNs || opt.defaultNs || 'cdcp';
  }

  return {
    raw: s,
    ns,
    id,
    range,
    full: ns === 'cdcp' ? id : `${ns}:${id}`,
    key: `${ns}@${range ? range.text : '*'}:${id}`,
  };
}

/** 宽松解析：失败返回 null，不抛 */
function tryParseId(raw, opt) {
  try { return parseId(raw, opt); } catch { return null; }
}

/**
 * 解析「实体引用」——只指向插件/命名空间时允许省略方法名。
 *   demo            → ns=demo
 *   demo@>=1000     → ns=demo + 范围
 *   demo:method     → 完整 id（等价 parseId）
 */
function parseRef(raw, opt = {}) {
  const s = String(raw ?? '').trim();
  if (!s) throw new IdError('引用不能为空', raw);
  const cut = s.lastIndexOf(':');
  if (cut !== -1 && s.slice(cut + 1).trim()) return parseId(s, opt);

  const at = s.indexOf('@');
  const ns = (at === -1 ? s : s.slice(0, at)).trim();
  if (!ns) throw new IdError(`@ 前缺少命名空间：${s}`, raw);
  if (!NS_RE.test(ns)) throw new IdError(`命名空间含非法字符：${ns}`, raw);
  const range = at === -1 ? null : parseRange(s.slice(at + 1), raw);
  return { raw: s, ns, id: null, range, full: ns, key: `${ns}@${range ? range.text : '*'}:*` };
}

function tryParseRef(raw, opt) {
  try { return parseRef(raw, opt); } catch { return null; }
}

/** 版本是否满足该 ID 的条件（无条件恒真） */
function matchVersion(parsed, uniqueVersion) {
  if (!parsed || !parsed.range) return true;
  try { return parsed.range.test(uniqueVersion); } catch { return false; }
}

/** 比较两个 ID 引用是否指向同一实体（忽略版本条件） */
function sameTarget(a, b) {
  return a.ns === b.ns && a.id === b.id;
}

/** 生成完整 ID 文本 */
function formatId(ns, uniqueVersion, id) {
  const head = ns === 'cdcp' ? '' : `${ns}@`;
  return uniqueVersion === undefined || uniqueVersion === null
    ? `${head}${id}`
    : `${head}${uniqueVersion}:${id}`;
}

module.exports = {
  IdError, RESERVED_NS, ULL_MAX,
  parseId, tryParseId, parseRef, tryParseRef, parseRange, matchVersion, sameTarget, formatId, toUll,
};
