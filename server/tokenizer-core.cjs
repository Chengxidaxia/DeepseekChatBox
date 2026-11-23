/* DeepSeek V4.1-Flash 分词器（byte-level BPE，纯本地、零依赖）
 * 词表来自官方 deepseek-ai/DeepSeek-V4.1-Flash 的 tokenizer.json。
 * V3 / R1 / V4-Pro / V4.1-Flash 共用同一份 128000 基础词表，
 * 仅特殊 token 数量不同；这里按 V4.1-Flash（API 名 deepseek-flash）为准。
 *
 * 实现 HuggingFace tokenizers 的 BPE 流程：
 *   1) 三条 Split 正则做预分词（数字分组 / CJK 连串 / 词与标点）
 *   2) ByteLevel 把 UTF-8 字节映射成可见字符（Ġ 表示空格等）
 *   3) 按 merges 的优先级两两合并，直到不能再合并
 *   4) 统计 token 数（可选返回 token id 与片段）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let cached = null;
let injectedJson = null;

/** 允许外部注入 tokenizer.json 对象（SEA 单文件场景，无真实文件系统） */
function setTokenizerJson(obj) {
  injectedJson = obj;
  cached = null;
}

/** ByteLevel 字节 ↔ 字符映射（HuggingFace 标准 256 项） */
function byteLevelChars() {
  const out = new Array(256);
  let p = 0;
  for (let i = 33; i <= 126; i++) out[i] = String.fromCharCode(i);
  for (let i = 161; i <= 172; i++) out[i] = String.fromCharCode(i);
  for (let i = 174; i <= 255; i++) out[i] = String.fromCharCode(i);
  const rest = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 127, 128, 129, 130, 131, 132, 133, 134,
    135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159, 160, 173];
  for (const b of rest) {
    out[b] = String.fromCodePoint(256 + p);
    p++;
  }
  return out;
}

function loadTokenizer() {
  if (cached) return cached;
  const candidates = [
    path.join(__dirname, '..', 'public', 'vendor', 'tokenizer', 'tokenizer.json'),
    path.join(process.cwd(), 'public', 'vendor', 'tokenizer', 'tokenizer.json'),
  ];
  let t;
  if (injectedJson) {
    t = injectedJson;
  } else {
    let file = '';
    for (const p of candidates) if (fs.existsSync(p)) { file = p; break; }
    if (!file) throw new Error('找不到 tokenizer.json（public/vendor/tokenizer/tokenizer.json），或未注入词表');
    t = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const vocab = t.model.vocab;
  const ranks = new Map();
  t.model.merges.forEach((m, i) => {
    const parts = Array.isArray(m) ? m : String(m).split(' ');
    ranks.set(parts[0] + '\u0000' + parts[1], i);
  });
  const b2c = byteLevelChars();
  const c2b = new Map();
  b2c.forEach((c, b) => c2b.set(c, b));
  // added tokens：特殊符号直接切出，不参与 BPE
  const added = new Map();
  for (const a of t.added_tokens || []) added.set(a.content, a.id);
  cached = { vocab, ranks, b2c, c2b, added, bytesToText: t.model.byte_fallback ? null : null };
  return cached;
}

/** UTF-8 字符串 → ByteLevel 可见字符串 */
function bytesToLevel(text, b2c) {
  const buf = Buffer.from(text, 'utf8');
  let out = '';
  for (const b of buf) out += b2c[b];
  return out;
}

const RE_DIGITS = /\p{N}{1,3}/gu;
const RE_CJK = /[一-龥぀-ゟ゠-ヿ]+/gu;
const RE_WORD = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

/** 三段 Split（Isolated）：把文本切成互不相交的片段，保持顺序 */
function preSplit(text) {
  // 先按数字、CJK 切出区间
  const marks = new Array(text.length).fill(false);
  const mark = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      for (let i = m.index; i < m.index + m[0].length; i++) marks[i] = true;
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  mark(RE_DIGITS);
  mark(RE_CJK);
  // 收集连续标记段与未标记段；未标记段再按 RE_WORD 切
  const pieces = [];
  let i = 0;
  while (i < text.length) {
    if (marks[i]) {
      let j = i + 1;
      while (j < text.length && marks[j]) j++;
      pieces.push({ text: text.slice(i, j), isolated: true });
      i = j;
    } else {
      let j = i + 1;
      while (j < text.length && !marks[j]) j++;
      const seg = text.slice(i, j);
      RE_WORD.lastIndex = 0;
      let m, last = 0;
      while ((m = RE_WORD.exec(seg))) {
        if (m.index > last) pieces.push({ text: seg.slice(last, m.index), isolated: false });
        pieces.push({ text: m[0], isolated: false });
        last = m.index + m[0].length;
        if (m[0].length === 0) RE_WORD.lastIndex++;
      }
      if (last < seg.length) pieces.push({ text: seg.slice(last), isolated: false });
      i = j;
    }
  }
  return pieces;
}

/** 对单个 ByteLevel 片段做 BPE 合并 */
function bpe(fragment, ranks) {
  if (!fragment) return [];
  let word = Array.from(fragment);
  while (word.length > 1) {
    let best = Infinity, bestIdx = -1;
    for (let i = 0; i < word.length - 1; i++) {
      const r = ranks.get(word[i] + '\u0000' + word[i + 1]);
      if (r !== undefined && r < best) { best = r; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    word.splice(bestIdx, 2, word[bestIdx] + word[bestIdx + 1]);
  }
  return word;
}

/** 内置 added token 的前缀匹配（按长度降序，避免 <｜X｜> 被拆开） */
function splitAdded(text, added) {
  if (!added.size) return null;
  const keys = [...added.keys()].sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  let changed = false;
  while (i < text.length) {
    let hit = null;
    for (const k of keys) {
      if (text.startsWith(k, i)) { hit = k; break; }
    }
    if (hit) { out.push({ text: hit, special: true }); i += hit.length; changed = true; }
    else { out.push({ text: text[i], special: false }); i++; }
  }
  return changed ? out : null;
}

/** 主入口：返回 { count, tokens, ids, model } */
function tokenize(text, { detail = false } = {}) {
  const { vocab, ranks, b2c, c2b, added } = loadTokenizer();
  const raw = String(text ?? '');
  // added token 先切
  const addedParts = splitAdded(raw, added) || [{ text: raw, special: false }];
  const tokens = [], ids = [];

  for (const part of addedParts) {
    if (part.special) {
      const id = added.get(part.text);
      tokens.push(part.text); ids.push(id === undefined ? -1 : id);
      continue;
    }
    for (const piece of preSplit(part.text)) {
      if (!piece.text) continue;
      const level = bytesToLevel(piece.text, b2c);
      for (const pieceToken of bpe(level, ranks)) {
        const id = vocab[pieceToken];
        if (id === undefined) continue;
        tokens.push(pieceToken); ids.push(id);
      }
    }
  }
  const result = { count: tokens.length, model: 'deepseek-v4.1-flash', vocabSize: Object.keys(vocab).length };
  if (detail) {
    result.tokens = tokens;
    result.ids = ids;
  }
  return result;
}

module.exports = { tokenize, loadTokenizer, bytesToLevel, preSplit, bpe, setTokenizerJson };
