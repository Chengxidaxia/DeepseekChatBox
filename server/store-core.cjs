/* DeepSeek Chatbox — 服务端存储核心（纯 CJS，无依赖；源码版与便携版共用）
 * 所有数据落在 dataDir 下：
 *   settings.json       设置（API Key 用 Windows DPAPI 加密，绑定当前 Windows 用户）
 *   conversations.json  全部对话
 *   ui.json             界面状态
 *   attachments/        上传的图片等附件
 *   backups/            自动备份（保留最近 10 份）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  thinking: true,
  effort: 'high',
  search: false,
  readUrl: false,
  safety: false,
  jsonMode: false,
  temperature: 1,
  topP: null,
  maxTokens: null,
  stop: '',
  systemPrompt: '',
  userId: '',
  reminder: { enabled: true, location: '', language: '中文' },
  theme: 'system',
  lang: 'zh',
  mock: false,
  docLayout: 'text_recognition',
  ttsVoice: 'stella',
  autoTitle: true,
  stream: true,
  localTools: true,
  // 危险：直接在本机 cmd.exe 执行命令，默认关闭，需在设置里显式打开
  cmdEnabled: false,
  // 工具按需加载：每轮最多检索下发几个本地工具（省 token），默认 8
  toolTopK: 8,
  // local = 本机 web_search / fetch_url（可与其他本地工具共存）；official = DeepSeek 官方服务端工具
  searchMode: 'local',
  // 官方峰谷定价（元 / 百万 tokens）
  prices: {
    currency: 'CNY',
    flash: { hitIdle: 0.02, hitPeak: 0.04, missIdle: 1, missPeak: 2, outIdle: 4, outPeak: 8 },
    pro: { hitIdle: 0.15, hitPeak: 0.3, missIdle: 4.5, missPeak: 9, outIdle: 13.5, outPeak: 27 },
  },
  peakMode: 'auto',
  apiKey: '',
};

/** 旧版单档价格 → 峰谷双档；无旧数据回落官方默认值 */
function migratePrices(p) {
  const d = DEFAULT_SETTINGS.prices;
  const src = p && typeof p === 'object' ? p : {};
  const out = { currency: src.currency || d.currency };
  for (const model of ['flash', 'pro']) {
    const legacyHit = Number(src[model + 'InHit']);
    const legacyMiss = Number(src[model + 'InMiss']);
    const legacyOut = Number(src[model + 'Out']);
    const hasLegacy = legacyHit > 0 || legacyMiss > 0 || legacyOut > 0;
    if (src[model] && typeof src[model] === 'object') {
      out[model] = { ...d[model], ...src[model] };
    } else if (hasLegacy) {
      const half = (n) => Math.round((n / 2) * 10000) / 10000;
      out[model] = {
        hitIdle: half(legacyHit), hitPeak: legacyHit,
        missIdle: half(legacyMiss), missPeak: legacyMiss,
        outIdle: half(legacyOut), outPeak: legacyOut,
      };
    } else {
      out[model] = { ...d[model] };
    }
  }
  return out;
}

/* -------------------- API Key 静态加密（Windows DPAPI） --------------------
 * 通过系统自带 PowerShell 调 System.Security.Cryptography.ProtectedData
 * （底层 CryptProtectData，CurrentUser 范围），纯 Node、零 npm 依赖。
 * 密文只能被同一个 Windows 用户解开：文件被拷到别的机器/别的账户、或误传进
 * 备份与压缩包时，泄漏的只是密文。非 Windows 或调用失败时回退明文并告警。
 */
const KEY_ENC_PREFIX = 'dpapi:';
let _dpapiOk = null;

function dpapiSupported() {
  if (process.platform !== 'win32') return false;
  if (_dpapiOk !== null) return _dpapiOk;
  try {
    const r = require('node:child_process').spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    _dpapiOk = r.status === 0 && /^\d+/.test(String(r.stdout || '').trim());
  } catch { _dpapiOk = false; }
  return _dpapiOk;
}

function dpapiTransform(mode, b64) {
  const body = mode === 'protect'
    ? "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($e))"
    : "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($d))";
  const script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" + body;
  const r = require('node:child_process').spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: b64, encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.status !== 0 || !String(r.stdout || '').trim()) {
    const err = String(r.stderr || 'powershell 返回空').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
    throw new Error(err.slice(0, 300));
  }
  return String(r.stdout).trim();
}

function keyEncrypt(text) {
  return KEY_ENC_PREFIX + dpapiTransform('protect', Buffer.from(text, 'utf8').toString('base64'));
}

function keyDecrypt(stored) {
  return Buffer.from(dpapiTransform('unprotect', String(stored).slice(KEY_ENC_PREFIX.length)), 'base64').toString('utf8');
}

function createStore({ dataDir, log = console.log }) {
  const dir = dataDir;
  const attachmentsDir = path.join(dir, 'attachments');
  const backupsDir = path.join(dir, 'backups');
  const settingsFile = path.join(dir, 'settings.json');
  const convsFile = path.join(dir, 'conversations.json');
  const uiFile = path.join(dir, 'ui.json');
  const groupsFile = path.join(dir, 'groups.json');
  const attIndexFile = path.join(attachmentsDir, 'index.json');

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });

  function readJson(file, fallback) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      if (e.code !== 'ENOENT') log('[store] 读取失败 ' + file + ': ' + e.message);
      return fallback;
    }
  }

  function writeAtomic(file, obj) {
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }

  let settings = Object.assign({}, DEFAULT_SETTINGS, readJson(settingsFile, {}));
  settings.reminder = Object.assign({}, DEFAULT_SETTINGS.reminder, settings.reminder || {});

  /* API Key：启动时解密到内存（apiKeyEnc）；旧版明文自动迁移成 DPAPI 密文。 */
  let apiKeyPlain = '';
  (function initApiKey() {
    const enc = settings.apiKeyEnc;
    if (enc && String(enc).startsWith(KEY_ENC_PREFIX)) {
      try {
        apiKeyPlain = keyDecrypt(String(enc));
      } catch (e) {
        log('[store] API Key 解密失败（换过 Windows 账户/机器？），请在设置里重新填写：' + e.message);
        apiKeyPlain = '';
      }
      return;
    }
    if (settings.apiKey) {
      apiKeyPlain = String(settings.apiKey);
      if (dpapiSupported()) {
        try {
          settings.apiKeyEnc = keyEncrypt(apiKeyPlain);
          delete settings.apiKey;
          writeAtomic(settingsFile, settings);
          log('[store] API Key 已用 Windows DPAPI 加密（绑定当前用户）');
        } catch (e) {
          log('[store] API Key 加密失败，暂以明文保存：' + e.message);
        }
      } else {
        log('[store] 本机不支持 DPAPI，API Key 以明文保存');
      }
    }
  })();
  // 价格结构升级（旧版单档 → 峰谷双档），变了就写回磁盘，避免每次启动重复迁移
  const rawPrices = JSON.stringify(settings.prices || null);
  settings.prices = migratePrices(settings.prices);
  if (rawPrices !== JSON.stringify(settings.prices)) {
    try { writeAtomic(settingsFile, settings); } catch (e) { log('价格结构迁移写盘失败：' + e.message); }
  }
  let conversations = readJson(convsFile, []);
  if (!Array.isArray(conversations)) conversations = [];
  let ui = readJson(uiFile, {});
  let groups = readJson(groupsFile, []);
  if (!Array.isArray(groups)) groups = [];
  let attIndex = readJson(attIndexFile, {});

  /* 首次运行时把默认值落盘，便于用户直接看到/编辑文件 */
  if (!fs.existsSync(settingsFile)) writeAtomic(settingsFile, settings);
  if (!fs.existsSync(uiFile)) writeAtomic(uiFile, ui);
  if (!fs.existsSync(groupsFile)) writeAtomic(groupsFile, groups);

  let lastBackup = 0;
  function backupConversations() {
    const now = Date.now();
    if (now - lastBackup < 5 * 60 * 1000) return;
    lastBackup = now;
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
      if (!fs.existsSync(convsFile)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(convsFile, path.join(backupsDir, 'conversations-' + stamp + '.json'));
      const files = fs.readdirSync(backupsDir).filter((f) => f.startsWith('conversations-')).sort();
      while (files.length > 10) {
        fs.unlinkSync(path.join(backupsDir, files.shift()));
      }
    } catch (e) {
      log('[store] 备份失败: ' + e.message);
    }
  }

  function saveConversations() {
    backupConversations();
    writeAtomic(convsFile, conversations);
  }

  function maskKey(k) {
    if (!k) return '';
    if (k.length <= 10) return '****';
    return k.slice(0, 5) + '…' + k.slice(-4);
  }

  return {
    dir,
    /* ------------------------------ 设置 ------------------------------ */
    /** 给前端的设置：不含明文 Key，只给 hasKey / keyPreview */
    publicSettings() {
      const copy = JSON.parse(JSON.stringify(settings));
      delete copy.apiKey;
      delete copy.apiKeyEnc;
      copy.hasKey = Boolean(apiKeyPlain);
      copy.keyPreview = maskKey(apiKeyPlain);
      return copy;
    },
    rawSettings() {
      return settings;
    },
    patchSettings(patch) {
      if (patch && typeof patch === 'object') {
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'hasKey' || k === 'keyPreview') continue;
          if (k === 'apiKey') {
            const key = String(v || '').trim();
            apiKeyPlain = key;
            delete settings.apiKey;
            delete settings.apiKeyEnc;
            if (key && dpapiSupported()) {
              try { settings.apiKeyEnc = keyEncrypt(key); }
              catch (e) { settings.apiKey = key; log('[store] API Key 加密失败，暂以明文保存：' + e.message); }
            } else if (key) {
              settings.apiKey = key;
            }
            continue;
          }
          if (k === 'reminder' || k === 'prices') {
            settings[k] = Object.assign({}, settings[k], v || {});
          } else {
            settings[k] = v;
          }
        }
      }
      writeAtomic(settingsFile, settings);
      return this.publicSettings();
    },
    getApiKey() {
      return apiKeyPlain || process.env.DEEPSEEK_API_KEY || '';
    },
    getBaseUrl() {
      return settings.baseUrl || 'https://api.deepseek.com';
    },

    /* ------------------------------ UI ------------------------------ */
    getUi() {
      return ui;
    },
    setUi(patch) {
      ui = Object.assign({}, ui, patch || {});
      writeAtomic(uiFile, ui);
      return ui;
    },

    /* ----------------------------- 分组 ----------------------------- */
    listGroups() {
      return groups;
    },
    upsertGroup(group) {
      if (!group || !group.id) throw new Error('group.id 必填');
      const i = groups.findIndex((g) => g.id === group.id);
      if (i >= 0) groups[i] = group;
      else groups.push(group);
      writeAtomic(groupsFile, groups);
      return group;
    },
    deleteGroup(id) {
      const i = groups.findIndex((g) => g.id === id);
      if (i < 0) return false;
      groups.splice(i, 1);
      writeAtomic(groupsFile, groups);
      // 该组下的对话退回未分组
      let touched = 0;
      for (const c of conversations) {
        if (c.groupId === id) { c.groupId = null; touched++; }
      }
      if (touched) saveConversations();
      return true;
    },
    setGroups(list) {
      if (!Array.isArray(list)) throw new Error('groups 必须是数组');
      groups = list.filter((g) => g && g.id);
      writeAtomic(groupsFile, groups);
      return groups.length;
    },

    /* ----------------------------- 对话 ----------------------------- */
    listConversations() {
      return conversations;
    },
    getConversation(id) {
      return conversations.find((c) => c.id === id) || null;
    },
    upsertConversation(conv) {
      if (!conv || !conv.id) throw new Error('conversation.id 必填');
      const i = conversations.findIndex((c) => c.id === conv.id);
      if (i >= 0) conversations[i] = conv;
      else conversations.unshift(conv);
      saveConversations();
      return conv;
    },
    deleteConversation(id) {
      const i = conversations.findIndex((c) => c.id === id);
      if (i < 0) return false;
      conversations.splice(i, 1);
      saveConversations();
      return true;
    },
    replaceConversations(list, mode = 'replace') {
      if (!Array.isArray(list)) throw new Error('conversations 必须是数组');
      if (mode === 'merge') {
        const ids = new Set(conversations.map((c) => c.id));
        for (const c of list) if (c && c.id && !ids.has(c.id)) conversations.push(c);
      } else {
        conversations = list.filter((c) => c && c.id);
      }
      saveConversations();
      return conversations.length;
    },
    clearConversations() {
      conversations = [];
      saveConversations();
      return 0;
    },

    /* ---------------------------- 附件 ---------------------------- */
    saveAttachment(buffer, filename, mime) {
      const ext = (path.extname(filename || '') || guessExt(mime)).slice(0, 10).replace(/[^\w.]/g, '');
      const id = 'att_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
      const stored = id + ext;
      fs.writeFileSync(path.join(attachmentsDir, stored), buffer);
      attIndex[id] = { id, file: stored, name: filename || stored, mime: mime || 'application/octet-stream', size: buffer.length, createdAt: Date.now() };
      writeAtomic(attIndexFile, attIndex);
      return { id, url: '/api/attachments/' + id, name: attIndex[id].name, size: buffer.length, mime: attIndex[id].mime };
    },
    readAttachment(id) {
      const meta = attIndex[id];
      if (!meta) return null;
      const file = path.join(attachmentsDir, meta.file);
      if (!fs.existsSync(file)) return null;
      return { meta, buffer: fs.readFileSync(file) };
    },
    deleteAttachment(id) {
      const meta = attIndex[id];
      if (!meta) return false;
      try { fs.unlinkSync(path.join(attachmentsDir, meta.file)); } catch {}
      delete attIndex[id];
      writeAtomic(attIndexFile, attIndex);
      return true;
    },

    /* ---------------------------- 快照 / 导入 ---------------------------- */
    snapshot() {
      return {
        app: 'deepseek-chatbox',
        version: 2,
        storage: 'server',
        dataDir: dir,
        settings: this.publicSettings(),
        ui,
        groups,
        conversations,
      };
    },
    importSnapshot(data, mode = 'merge') {
      let n = 0;
      if (Array.isArray(data)) {
        n = this.replaceConversations(data, mode);
      } else if (data && typeof data === 'object') {
        if (Array.isArray(data.conversations)) n = this.replaceConversations(data.conversations, mode);
        if (data.settings) this.patchSettings(data.settings);
        if (data.ui) this.setUi(data.ui);
        if (Array.isArray(data.groups)) this.setGroups(data.groups);
      }
      return n;
    },
  };
}

function guessExt(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  };
  return map[mime] || '.bin';
}

module.exports = { createStore, DEFAULT_SETTINGS };
