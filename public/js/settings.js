/* 设置弹窗 */
import { h, $, download, toast } from './util.js';
import { settings, saveSettings, allConversations, importConversations, exportAllData, importAllData, uploadAttachment, clearAllConversations, meta as storeMeta, saveConversationsNow, flushNow, hasApiKey, migratePrices, isPeakNow } from './store.js';
import { isZipFile, importOfficialZip } from './import-official.js';
import { t } from './i18n.js';
import { APP_NAME, APP_REPO, APP_RELEASES, getAppVersion, loadAppVersion } from './version.js';
import { appConfirm } from './dialog.js';
import { listModels, cachedModels } from './api.js';

let overlay = null;

function field(label, control, help) {
  return h('div', { class: 'field' }, [
    h('label', { text: label }),
    control,
    help ? h('div', { class: 'help', html: help }) : null,
  ]);
}

function input(type, value, attrs = {}) {
  const el = h('input', { type, ...attrs });
  el.value = value ?? '';
  return el;
}

/**
 * 一行开关。传了 note（危险提示 HTML）时，提示排在开关**下方**，
 * 且开关与提示之间不画分隔线（分隔线落到整个块的下沿）。
 */
function switchRow(title, desc, on, onChange, note) {
  const sw = h('button', { class: 'switch' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on) });
  sw.addEventListener('click', () => {
    const next = !sw.classList.contains('on');
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-pressed', String(next));
    onChange(next);
  });
  const row = h('div', { class: 'switch-row' + (note ? ' no-sep' : '') }, [
    h('div', { class: 'txt' }, [h('b', { text: title }), desc ? h('span', { text: desc }) : null]),
    sw,
  ]);
  if (!note) return row;
  return h('div', { class: 'switch-block' }, [
    row,
    h('div', { class: 'help danger set-note', html: note }),
  ]);
}

/** 设置分组：组内各项是轻分隔线，组与组之间是重分隔线 */
function section(title, items) {
  return h('div', { class: 'set-section' }, [
    title ? h('div', { class: 'set-section-title', text: title }) : null,
    ...items.filter(Boolean),
  ]);
}

function aboutTab() {
  const link = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label });
  const row = (k, v) => h('div', { class: 'about-row' }, [
    h('b', { text: k }),
    v && v.nodeType ? v : h('span', { text: v }),
  ]);
  // 版本号从后端读取：先占位，拿到后回填（含缓存命中场景，立即回填）。
  const versionSlot = (cls) => {
    const el = h('span', cls ? { class: cls } : {}, ['…']);
    const fill = (v) => { el.textContent = v ? 'v' + v : '?'; };
    const cached = getAppVersion();
    if (cached) fill(cached);
    else loadAppVersion().then(fill);
    return el;
  };
  return [
    h('div', { class: 'set-section' }, [
      h('div', { class: 'set-section-title', text: t('aboutTitle') }),
      h('div', { class: 'about-brand' }, [
        h('b', { text: APP_NAME }),
        versionSlot('about-version'),
      ]),
      h('div', { class: 'help', text: t('aboutDesc') }),
      h('div', { class: 'about-links' }, [
        link(APP_REPO, t('aboutRepo')),
        link(APP_RELEASES, t('aboutReleases')),
      ]),
    ]),
    h('div', { class: 'set-section' }, [
      h('div', { class: 'set-section-title', text: t('aboutShortcuts') }),
      h('div', { class: 'help', text: t('aboutShortcutsBody') }),
    ]),
    h('div', { class: 'set-section' }, [
      h('div', { class: 'set-section-title', text: t('aboutStorage') }),
      h('div', { class: 'help', text: t('aboutStorageBody') }),
      row(t('aboutVersion'), versionSlot()),
      row(t('aboutBuild'), t('aboutBuildBody')),
    ]),
  ];
}

export function openSettings({ onChange } = {}) {
  if (overlay) return;
  let tab = 'general';

  const body = h('div', { class: 'settings-content' });
  const tabs = h('div', { class: 'settings-nav' });
  const modal = h('div', { class: 'modal settings-dialog' });
  const dialogMain = h('div', { class: 'settings-main' }, [tabs, body]);
  const head = h('div', { class: 'modal-head' }, [
    h('span', { text: t('settings') }),
    h('button', { class: 'icon-btn sm', type: 'button', onclick: () => close() }, [icon('i-x')]),
  ]);

  // 设置页不跟「点背景关闭」：里面有正在编辑的表单，误触会白填。只能按 ✕ 或 Esc 退出。
  overlay = h('div', { class: 'overlay settings-overlay' }, [modal]);
  modal.append(head, dialogMain);

  function close() {
    overlay?.remove();
    overlay = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  function tabBtn(id, label, iconId) {
    const b = h('button', { type: 'button', class: 'settings-nav-item' + (id === tab ? ' on' : '') }, [
      icon(iconId),
      h('span', { text: label }),
    ]);
    b.addEventListener('click', () => { tab = id; render(); });
    return b;
  }

  function render() {
    tabs.replaceChildren(
      tabBtn('general', t('tabGeneral'), 'i-settings'),
      tabBtn('model', t('tabModel'), 'i-brain'),
      tabBtn('gen', t('tabGen'), 'i-wrench'),
      tabBtn('data', t('tabData'), 'i-folder'),
      tabBtn('about', t('tabAbout'), 'i-globe'),
    );
    body.replaceChildren();
    if (tab === 'general') body.append(...generalTab());
    if (tab === 'model') body.append(...modelTab());
    if (tab === 'gen') body.append(...genTab());
    if (tab === 'data') body.append(...dataTab());
    if (tab === 'about') body.append(...aboutTab());
  }

  function generalTab() {
    const key = input('password', '', {
      placeholder: hasApiKey() ? `已保存在服务端（${settings.keyPreview || '****'}）· 留空不修改` : 'sk-...',
      autocomplete: 'off', spellcheck: 'false',
    });
    const keyWrap = h('div', { style: { display: 'flex', gap: '8px' } }, [key]);
    keyWrap.firstChild.style.flex = '1';
    key.addEventListener('change', () => {
      const v = key.value.trim();
      if (!v) return;
      saveSettings({ apiKey: v });
      key.value = '';
      key.placeholder = `已保存（更新中…）`;
      onChange?.({ apiKey: true });
      toast('已写入服务端 data/settings.json');
    });
    const clearKey = h('button', { class: 'btn sm', type: 'button', text: '清除' });
    clearKey.addEventListener('click', () => {
      saveSettings({ apiKey: '' });
      key.placeholder = 'sk-...';
      onChange?.({ apiKey: true });
      toast('已清除服务端保存的 Key');
      render();
    });
    keyWrap.append(clearKey);

    const base = input('text', settings.baseUrl, { placeholder: 'https://api.deepseek.com' });
    base.addEventListener('change', () => {
      let v = base.value.trim().replace(/\/+$/, '');
      if (!v) v = 'https://api.deepseek.com';
      base.value = v;
      saveSettings({ baseUrl: v });
    });

    const themeSeg = h('div', { class: 'seg' });
    for (const [val, label] of [['system', t('themeSystem')], ['light', t('themeLight')], ['dark', t('themeDark')]]) {
      const b = h('button', { type: 'button', class: settings.theme === val ? 'on' : '', text: label });
      b.addEventListener('click', () => {
        saveSettings({ theme: val });
        onChange?.({ theme: true });
        render();
      });
      themeSeg.append(b);
    }

    const langSeg = h('div', { class: 'seg' });
    for (const [val, label] of [['zh', '简体中文'], ['en', 'English']]) {
      const b = h('button', { type: 'button', class: settings.lang === val ? 'on' : '', text: label });
      b.addEventListener('click', () => {
        saveSettings({ lang: val });
        onChange?.({ lang: true });
        render();
      });
      langSeg.append(b);
    }

    const voiceSel = h('select', {}, [
      h('option', { value: 'stella', text: t('voiceStella') }),
      h('option', { value: 'tide', text: t('voiceTide') }),
    ]);
    voiceSel.value = settings.ttsVoice;
    voiceSel.addEventListener('change', () => saveSettings({ ttsVoice: voiceSel.value }));

    return [
      section('接口与密钥', [
        field(t('apiKey'), keyWrap, '保存在服务端 <code>data/settings.json</code>（明文，仅本机可读）；浏览器不再保存，也不会随请求发送。'),
        field(t('baseUrl'), base, '兼容代理地址，例如 <code>https://api.deepseek.com</code>。'),
      ]),
      section('外观与语言', [
        h('div', { class: 'field' }, [h('label', { text: t('theme') }), themeSeg]),
        h('div', { class: 'field' }, [h('label', { text: t('language') }), langSeg]),
        field(t('ttsVoice'), voiceSel),
      ]),
      section('其它', [
        switchRow(t('mock'), t('mockHelp'), settings.mock, (v) => {
          saveSettings({ mock: v });
          onChange?.({ mock: true });
        }),
        h('div', { class: 'field' }, [
          h('div', { class: 'help', text: t('shortcuts') }),
        ]),
      ]),
    ];
  }

  function modelTab() {
    const modelSel = h('select', {}, cachedModels().map((m) => h('option', { value: m.id, text: m.name })));
    modelSel.value = settings.model;
    modelSel.addEventListener('change', () => { saveSettings({ model: modelSel.value }); onChange?.({ model: true }); });

    const effortSeg = h('div', { class: 'seg' });
    for (const [val, label] of [['low', t('effortLow') + ' · low'], ['high', t('effortHigh') + ' · high'], ['max', t('effortMax') + ' · max']]) {
      const b = h('button', { type: 'button', class: settings.effort === val ? 'on' : '', text: label });
      b.addEventListener('click', () => { saveSettings({ effort: val }); onChange?.({ effort: true }); render(); });
      effortSeg.append(b);
    }

    const temp = input('number', settings.temperature, { min: '0', max: '2', step: '0.1' });
    temp.addEventListener('change', () => saveSettings({ temperature: temp.value === '' ? '' : Math.min(2, Math.max(0, Number(temp.value))) }));

    const topP = input('number', settings.topP ?? '', { min: '0', max: '1', step: '0.05', placeholder: '留空用默认' });
    topP.addEventListener('change', () => saveSettings({ topP: topP.value === '' ? null : Math.min(1, Math.max(0.01, Number(topP.value))) }));

    const maxTok = input('number', settings.maxTokens ?? '', { min: '1', max: '393216', step: '1', placeholder: '默认 8K / 思考 64K' });
    maxTok.addEventListener('change', () => saveSettings({ maxTokens: maxTok.value === '' ? null : Math.max(1, Math.min(393216, Math.round(Number(maxTok.value)))) }));

    const stop = h('textarea', { rows: '3', placeholder: '每行一个停止序列' });
    stop.value = settings.stop || '';
    stop.addEventListener('change', () => saveSettings({ stop: stop.value }));

    const sys = h('textarea', { rows: '4', placeholder: '你是一个乐于助人的助手。' });
    sys.value = settings.systemPrompt || '';
    sys.addEventListener('change', () => saveSettings({ systemPrompt: sys.value }));

    const uid = input('text', settings.userId, { placeholder: '可选，用于 KVCache / 调度隔离' });
    uid.addEventListener('change', () => saveSettings({ userId: uid.value.trim() }));

    const loc = input('text', settings.reminder.location, { placeholder: '例如：北京 / Singapore' });
    loc.addEventListener('change', () => saveSettings({ reminder: { ...settings.reminder, location: loc.value } }));

    const langSel = h('select', {}, ['中文', '中文繁體', 'English', '日本語', '한국어'].map((l) => h('option', { value: l, text: l })));
    langSel.value = settings.reminder.language;
    langSel.addEventListener('change', () => saveSettings({ reminder: { ...settings.reminder, language: langSel.value } }));

    return [
      section('模型与思考', [
        field(t('model'), modelSel, 'deepseek-flash 支持文本 + 图片；deepseek-v4-pro 仅文本。'),
        h('div', { class: 'field' }, [h('label', { text: t('reasoningEffort') }), effortSeg,
          h('div', { class: 'help', text: '仅思考模式生效；思考模式下 temperature / top_p 由服务端决定。' })]),
      ]),
      section('生成参数', [
        field(t('systemPrompt'), sys),
        h('div', { class: 'field-row' }, [
          field(t('temperature'), temp),
          field(t('topP'), topP),
        ]),
        field(t('maxTokens'), maxTok, '范围 1–393216；输入与输出总长受上下文窗口限制。'),
        field(t('stop'), stop),
      ]),
      section('请求标识', [
        field('user_id', uid, '仅英文字母、数字、下划线、连字符，UTF-8 不超过 512 字节。'),
      ]),
      section('时间提醒', [
        h('div', { class: 'field' }, [
          switchRow('latest_reminder', t('reminderHelp'), settings.reminder.enabled, (v) => {
            saveSettings({ reminder: { ...settings.reminder, enabled: v } });
            onChange?.({ reminder: true });
          }),
          h('div', { class: 'field-row', style: { marginTop: '10px' } }, [
            field(t('location'), loc),
            field(t('modelLang'), langSel),
          ]),
        ]),
      ]),
    ];
  }

  function genTab() {
    const layoutSeg = h('div', { class: 'seg' });
    for (const [val, label] of [['text_recognition', t('docText')], ['rich_layout_recognition', t('docRich')]]) {
      const b = h('button', { type: 'button', class: settings.docLayout === val ? 'on' : '', text: label });
      b.addEventListener('click', () => { saveSettings({ docLayout: val }); render(); });
      layoutSeg.append(b);
    }

    // ---- 峰谷定价：2 个模型 × 3 类用量 × (空闲/高峰) ----
    const p = migratePrices(settings.prices);

    const setPrice = (model, field, raw) => {
      const base = migratePrices(settings.prices);
      base[model] = { ...base[model], [field]: Number(raw || 0) };
      saveSettings({ prices: base });
      onChange?.({ prices: true });
    };

    const cell = (model, field, val) => {
      const el = input('number', val, { min: '0', step: '0.001' });
      el.style.textAlign = 'right';
      el.addEventListener('change', () => setPrice(model, field, el.value));
      return el;
    };

    const priceRows = [];
    const addModel = (model, title) => {
      priceRows.push(h('div', { class: 'price-model', text: title }));
      for (const [field, label] of [['hit', t('priceInHit')], ['miss', t('priceInMiss')], ['out', t('priceOut')]]) {
        priceRows.push(h('span', { class: 'price-label', text: label }));
        priceRows.push(cell(model, field + 'Idle', p[model][field + 'Idle']));
        priceRows.push(cell(model, field + 'Peak', p[model][field + 'Peak']));
      }
    };
    addModel('flash', 'deepseek-flash');
    addModel('pro', 'deepseek-v4-pro');

    const priceGrid = h('div', { class: 'price-grid' }, [
      h('span', { class: 'price-corner' }),
      h('span', { class: 'price-th', text: '空闲时段' }),
      h('span', { class: 'price-th', text: '高峰时段' }),
      ...priceRows,
    ]);

    const peakSeg = h('div', { class: 'seg', style: { marginTop: '10px' } });
    for (const [val, label] of [['auto', '自动识别'], ['idle', '按空闲价'], ['peak', '按高峰价']]) {
      const b = h('button', { type: 'button', class: (settings.peakMode || 'auto') === val ? 'on' : '', text: label });
      b.addEventListener('click', () => {
        saveSettings({ peakMode: val });
        onChange?.({ peakMode: true });
        render();
      });
      peakSeg.append(b);
    }
    const nowPeak = isPeakNow();
    const modeNow = settings.peakMode || 'auto';
    const peakHint = modeNow === 'idle' ? t('idleNow')
      : modeNow === 'peak' ? t('peakNow')
        : (nowPeak ? t('peakNow') : t('idleNow'));

    // ---- 联网搜索方式 ----
    const webMode = settings.searchMode === 'official' ? 'official' : 'local';
    const webSeg = h('div', { class: 'seg' });
    for (const [val, label] of [['local', '本地联网'], ['official', '官方服务端']]) {
      const b = h('button', { type: 'button', class: webMode === val ? 'on' : '', text: label });
      b.addEventListener('click', () => {
        saveSettings({ searchMode: val });
        onChange?.({ searchMode: true });
        render();
      });
      webSeg.append(b);
    }

    return [
      section('联网搜索', [
        h('div', { class: 'field' }, [
          h('label', { text: '联网搜索方式' }),
          webSeg,
          h('div', { class: 'help', html:
            webMode === 'local'
              ? '<strong>本地联网</strong>：由本机直接搜索（Bing，失败自动换备用引擎）并抓取网页正文，'
                + '不依赖官方工具，所以能和余额、时间等本地工具一起用，也不限定模型。搜索质量取决于公网可达性。'
              : '<strong>官方服务端</strong>：调用 <code>deepseek_web_search</code> / <code>deepseek_read_url</code>，'
                + '结果带有官方引用，但接口限制下<strong>无法同时使用本地工具</strong>，且仅 deepseek-flash 支持。' }),
        ]),
      ]),
      section('本地工具', [
        switchRow('本地工具（function calling）',
          '让模型可以调用本机工具：余额、模型、时间、历史、用量、联网搜索/抓取，以及计算、哈希、编解码、JSON、统计、UUID、随机数等小工具。密钥留在服务端。',
          settings.localTools, (v) => { saveSettings({ localTools: v }); onChange?.({ localTools: true }); }),
        (() => {
          const seg = h('div', { class: 'seg' });
          for (const n of [4, 8, 16, 999]) {
            const label = n === 999 ? '全部' : String(n);
            const b = h('button', { type: 'button', class: (Number(settings.toolTopK) || 8) === n ? 'on' : '', text: label });
            b.addEventListener('click', () => {
              saveSettings({ toolTopK: n });
              onChange?.({ toolTopK: true });
              render();
            });
            seg.append(b);
          }
          return h('div', { class: 'field', style: { marginTop: '10px' } }, [
            h('label', { text: '工具按需加载（省 token）' }),
            seg,
            h('div', { class: 'help', html:
              '每次请求只把与当前问题相关的工具声明给模型（BM25 检索：工具名 + 关键词 + 描述），'
              + '已调用过的工具会自动保留，多轮工具循环不会断。<strong>关闭/全部</strong>则退回一次声明所有工具（约 5000 tokens）。' }),
          ]);
        })(),
      ]),
      section('子智能体（sub_agent）', [
        switchRow('启用子智能体',
          '把独立任务交给子智能体：cloud 用你的 API Key 调官方接口（消耗额度、能力强）；local 用本机 Ollama（免费离线）。子智能体沿用当前会话的系统提示与工具链。',
          settings.subAgentEnabled !== false, (v) => {
            saveSettings({ subAgentEnabled: v });
            onChange?.({ subAgentEnabled: true });
          }),
        (() => {
          const sa = settings.subAgent || {};
          const setSa = (patch) => saveSettings({ subAgent: { ...(settings.subAgent || {}), ...patch } });
          const num = (key, label, ph, min, max, step) => {
            const el = input('number', sa[key] ?? '', {
              placeholder: ph || '', min: String(min ?? ''), max: String(max ?? ''), step: String(step || '1'),
            });
            el.addEventListener('change', () => setSa({ [key]: el.value === '' ? null : Number(el.value) }));
            return field(label, el);
          };
          const toggle = (label, key, def = false) => {
            const box = input('checkbox', '', { type: 'checkbox' });
            box.checked = sa[key] ?? def;
            box.addEventListener('change', () => setSa({ [key]: box.checked }));
            return h('label', { class: 'check-inline' }, [box, h('span', { text: label })]);
          };
          const sel = (key, options, def = '') => {
            const el = h('select');
            for (const [v, text] of options) {
              const o = h('option', { value: String(v), text });
              el.append(o);
            }
            el.value = String(sa[key] ?? def);
            el.addEventListener('change', () => setSa({ [key]: el.value }));
            return el;
          };
          const effortOptions = [['', '自动（使用请求层默认值）'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '超高'], ['max', '极致']];
          const ctxOptions = [[0, '使用提供商默认值'], [32768, '32K'], [65536, '64K'], [131072, '128K'], [262144, '256K']];
          const outOptions = [[0, '使用提供商默认值'], [8192, '8K'], [16384, '16K'], [32768, '32K'], [65536, '64K']];

          // 协议切换：Ollama 原生 / OpenAI 兼容自定义接口
          const proto = h('div', { class: 'seg' });
          for (const [v, label] of [['ollama', 'Ollama 原生'], ['openai', 'OpenAI 兼容 / 自定义']]) {
            const b = h('button', { type: 'button', class: (sa.protocol || 'ollama') === v ? 'on' : '', text: label });
            b.addEventListener('click', () => {
              for (const x of proto.children) x.classList.remove('on');
              b.classList.add('on');
              setSa({ protocol: v });
              render();
            });
            proto.append(b);
          }
          const isOpenAI = (sa.protocol || 'ollama') === 'openai';

          const apiBase = input('text', sa.apiBase || '', { placeholder: 'https://api.example.com/v1/chat/completions' });
          apiBase.addEventListener('change', () => setSa({ apiBase: apiBase.value.trim() }));
          const apiKey = input('password', sa.apiKey || '', { placeholder: '输入你的 API Key（仅保存在本机/本人云端设置）' });
          apiKey.addEventListener('change', () => setSa({ apiKey: apiKey.value.trim() }));
          const eye = h('button', { class: 'btn sm ghost', type: 'button', text: '显示' });
          eye.addEventListener('click', () => {
            const show = apiKey.type === 'password';
            apiKey.type = show ? 'text' : 'password';
            eye.textContent = show ? '隐藏' : '显示';
          });
          const testBtn = h('button', { class: 'btn sm', type: 'button', text: '测试连接' });
          const testMsg = h('div', { class: 'help' });
          testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            testMsg.textContent = '正在测试…';
            try {
              const { callTool } = await import('./api.js');
              const cfgNow = { ...(settings.subAgent || {}), apiBase: apiBase.value.trim(), apiKey: apiKey.value.trim() };
              flushNow();
              await new Promise((r) => setTimeout(r, 350));
              const out = await callTool('sub_agent', { target: 'local', action: 'test', config: cfgNow });
              testMsg.innerHTML = (out.ok === false ? '<span style="color:var(--state-error)">✗ ' : '✓ ') + String(out.text || '').replace(/</g, '&lt;') + '</span>';
            } catch (e) {
              testMsg.textContent = '测试失败：' + e.message;
            } finally {
              testBtn.disabled = false;
            }
          });
          const ollama = input('text', sa.ollamaUrl || '', { placeholder: 'http://127.0.0.1:11434' });
          ollama.addEventListener('change', () => setSa({ ollamaUrl: ollama.value.trim() || 'http://127.0.0.1:11434' }));
          const model = input('text', sa.defaultModel || '', { placeholder: '输入模型名称，例如 qwen3:8b 或 openai/gpt-4o' });
          model.addEventListener('change', () => setSa({ defaultModel: model.value.trim() }));

          const swAuto = h('button', { class: 'switch' + (sa.autoStart !== false ? ' on' : ''), type: 'button' });
          swAuto.addEventListener('click', () => {
            const n = !swAuto.classList.contains('on');
            swAuto.classList.toggle('on', n);
            setSa({ autoStart: n });
          });

          const efforts = h('div', { class: 'check-grid' });
          const defaultEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
          const currentEfforts = () => (Array.isArray(sa.effortLevels) && sa.effortLevels.length ? sa.effortLevels : defaultEfforts);
          for (const [v, label] of effortOptions.filter(([v]) => v)) {
            const box = input('checkbox', '', { type: 'checkbox' });
            box.checked = currentEfforts().includes(v);
            box.addEventListener('change', () => {
              const set = new Set(currentEfforts());
              if (box.checked) set.add(v); else set.delete(v);
              setSa({ effortLevels: [...set] });
            });
            efforts.append(h('label', { class: 'check-inline' }, [box, h('span', { text: label })]));
          }

          return h('div', { class: 'field' }, [
            h('div', { class: 'field' }, [h('label', { text: '本地协议' }), proto,
              h('div', { class: 'help', html: '<code>ollama</code> 走原生 <code>/api/chat</code>；<code>OpenAI 兼容 / 自定义</code> 走 <code>/chat/completions</code>，可接任意兼容服务（含 LM Studio、vLLM、Ollama OpenAI 端口）。' })]),
            isOpenAI ? h('div', { class: 'field' }, [
              field('接口地址', apiBase, '填写完整的 chat/completions 地址，或填到 <code>/v1</code> 由程序自动补全；勾选下方「自定义协议」则原样使用。'),
              field('API Key', h('div', { class: 'input-row' }, [apiKey, eye, testBtn]), '空 Key 也允许（本地服务通常不需要）；Key 只保存在本机/本人云端设置，测试时不写入日志。'),
              testMsg,
            ]) : field('Ollama 服务地址', ollama, '默认 <code>http://127.0.0.1:11434</code>；任何兼容 Ollama 协议的服务都可以。'),
            isOpenAI ? null : h('div', { class: 'switch-row' }, [
              h('div', { class: 'txt' }, [
                h('b', { text: '自动启动 Ollama' }),
                h('span', { text: '连接失败时自动执行 ollama serve（仅本机地址；远程地址不会自动启动）' }),
              ]),
              swAuto,
            ]),
            field('模型名称', model, isOpenAI ? '必填：OpenAI 兼容接口的模型 ID，例如 <code>qwen3:8b</code> / <code>openai/gpt-4o</code>。' : '留空则自动使用 Ollama 列表里的第一个模型。'),
            h('div', { class: 'check-grid' }, [
              toggle('工具调用', 'toolsEnabled', true),
              toggle('图片输入', 'capImage'),
              toggle('自定义协议', 'customProtocol'),
              toggle('仅思考模式', 'thinkingOnly'),
              toggle('仅非思考模式', 'nonThinkingOnly'),
              toggle('思考模式', 'thinkingMode', true),
            ]),
            h('div', { class: 'help', html: '「自定义协议」开启后直接使用填写的接口地址，不再自动补全 <code>/chat/completions</code> 路径，适用于代理层或服务端已自行处理协议的场景。' }),
            h('div', { class: 'field-row' }, [
              field('默认思考强度', sel('defaultEffort', effortOptions)),
              h('div', { class: 'field' }, [h('label', { text: '支持的思考强度' }), efforts]),
            ]),
            h('div', { class: 'field-row' }, [
              field('输入上下文', sel('contextIn', ctxOptions)),
              field('输出上限', sel('contextOut', outOptions)),
            ]),
            h('div', { class: 'field-row' }, [
              num('temperature', '本地温度', '0.7', 0, 2, 0.1),
              num('numCtx', 'Ollama num_ctx', '8192', 512, 131072, 512),
            ]),
            h('div', { class: 'field-row' }, [
              num('maxTurns', 'local 工具轮数', '4', 1, 12, 1),
              num('cloudMaxTurns', 'cloud 工具轮数', '6', 1, 12, 1),
            ]),
            h('div', { class: 'help', html:
              '更多参数（<code>top_p</code> / <code>top_k</code> / <code>num_predict</code> / <code>repeat_penalty</code> /'
              + ' <code>seed</code> / <code>stop</code> / <code>keep_alive</code> / <code>think</code> / <code>format</code> /'
              + ' <code>cloudModel</code> / <code>timeoutMs</code> 等）可让模型调用'
              + ' <code>sub_agent({target:"local", action:"config"})</code> 读写。' }),
          ]);
        })(),
      ]),
      section('危险工具（默认关闭）', [
      switchRow('开启命令执行 cmd_run',
        '关闭时即使模型想调用也会被服务端拒绝。',
        settings.cmdEnabled === true, (v) => {
          saveSettings({ cmdEnabled: v });
          onChange?.({ cmdEnabled: true });
        },
        '<strong>命令执行（危险，默认关闭）</strong>：开启后模型可调用 <code>cmd_run</code> 在<strong>本机 cmd.exe 直接执行任意命令</strong>，'
        + '不经过沙箱，能读写文件、访问网络。仅在你明确需要本机自动化时打开，用完建议关掉。'
        + '执行有 30 秒默认超时与 2 万字符输出上限。'),
      switchRow('开启浏览器代码执行 eval',
        '关闭时模型看不到该工具，也无法执行。',
        settings.evalEnabled === true, (v) => {
          saveSettings({ evalEnabled: v });
          onChange?.({ evalEnabled: true });
        },
        '<strong>浏览器代码执行 eval（危险，默认关闭）</strong>：开启后模型可调用 <code>eval</code> 在<strong>当前标签页执行任意 JavaScript</strong>（支持 await）。'
        + '代码只运行在你的浏览器里，碰不到服务器，但<strong>能读取本页的 API Key 与登录态</strong>——只执行你信任的内容。'
        + '输出上限 2 万字符；<strong>同步死循环会卡住页面，关掉标签页重开即可</strong>。'),
      ]),
      section('输出与安全', [
        switchRow(t('jsonMode'), t('jsonModeHelp'), settings.jsonMode, (v) => { saveSettings({ jsonMode: v }); onChange?.({ jsonMode: true }); }),
        switchRow(t('safety'), t('safetyHelp'), settings.safety, (v) => { saveSettings({ safety: v }); onChange?.({ safety: true }); }),
        switchRow(t('autoTitle'), t('autoTitleHelp'), settings.autoTitle, (v) => { saveSettings({ autoTitle: v }); onChange?.({ autoTitle: true }); }),
        h('div', { class: 'field' }, [h('label', { text: t('docLayout') }), layoutSeg,
          h('div', { class: 'help', text: '仅上传 PDF / Word / PPT 时生效。图文混排会把文档中的图一起交给模型。' })]),
      ]),
      section('计费估算', [
        h('div', { class: 'field' }, [
          h('label', { text: t('prices') }),
          h('div', { class: 'help', html:
            'DeepSeek 采用<strong>峰谷定价</strong>：周一至周五 9:00-12:00、14:00-18:00（北京时间）为高峰，'
            + '其余时段与周末为<span>空闲</span>，空闲价是高峰价的一半。法定节假日按官方口径算空闲，'
            + '自动模式会查询公开节假日 API（jiejiariapi / xiaoai / pinjia / Nager 多源兜底，按天缓存）来判断节假日与调休补班。'
            + '<br>这里只用于本地估算，实际扣费以官方账单为准。' }),
          priceGrid,
          h('div', { class: 'peak-row' }, [
            h('span', { class: 'peak-now', text: peakHint }),
            peakSeg,
          ]),
        ]),
      ]),
    ];
  }

  function dataTab() {
    // 导入/导出进度：一条进度条 + 当前正在做的事，几千条消息 / 上万个附件时不让界面看着像卡死
    const ipText = h('div', { class: 'ip-text', text: '' });
    const ipFill = h('i');
    const ipBox = h('div', { class: 'import-progress hidden' }, [ipText, h('div', { class: 'ip-bar' }, [ipFill])]);
    const ipSet = (pct, text) => {
      ipBox.classList.remove('hidden');
      ipText.textContent = text || '';
      ipFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    };
    const ipHide = () => ipBox.classList.add('hidden');

    const importInput = h('input', { type: 'file', accept: 'application/json,.json,.zip,application/zip', hidden: true });
    importInput.addEventListener('change', async () => {
      const f = importInput.files?.[0];
      if (!f) return;
      try {
        let n = 0;
        ipSet(2, '读取文件…');
        if (/\.zip$/i.test(f.name) || await isZipFile(f)) {
          // 官方版导出包：chat_session_index.json + chat_sessions/*.json + 附件
          const r = await importOfficialZip(f, {
            uploadAttachment,
            onProgress: (p) => {
              if (p.phase === 'parse') return ipSet(4, p.label);
              if (p.phase === 'sessions') {
                return ipSet(4 + (p.done / Math.max(1, p.total)) * 40,
                  `${p.label || '解析会话…'}${p.total ? '' : ''}`);
              }
              if (p.phase === 'attachments') {
                return ipSet(45 + (p.total ? (p.done / p.total) * 45 : 20),
                  `上传附件 ${p.done}${p.total ? '/' + p.total : ''}（成功 ${p.imported ?? 0}，跳过 ${p.skipped ?? 0}）…`);
              }
            },
          });
          ipSet(93, `写入 ${r.conversations.length} 个对话…`);
          n = await importAllData({ conversations: r.conversations }, 'merge');
          ipSet(100, `完成：${n} 个对话、${r.attachmentsImported} 个附件`);
          toast(`已从官方导出包导入 ${n} 个对话、${r.attachmentsImported} 个附件`
            + (r.attachmentsSkipped ? `（${r.attachmentsSkipped} 个跳过）` : ''));
        } else {
          ipSet(8, '解析 JSON…');
          const data = JSON.parse(await f.text());
          n = await importAllData(data, 'merge', {
            onProgress: (p) => ipSet(
              p.total ? 10 + (p.done / p.total) * 80 : 45,
              p.label || '写入中…',
            ),
          });
          ipSet(100, `完成：${n} 个对话`);
          toast(`已导入 ${n} 个对话（含分组、各组设置与内联附件）`);
        }
        saveConversationsNow();
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        ipHide();
        toast('导入失败：' + e.message);
      }
      importInput.value = '';
    });

    const exportBtn = h('button', { class: 'btn', type: 'button', text: t('exportData') });
    exportBtn.addEventListener('click', async () => {
      try {
        ipSet(3, '读取全部数据…');
        const snap = await exportAllData({
          withAttachments: true,
          onProgress: (p) => ipSet(
            p.total ? 3 + (p.done / p.total) * 82 : 20,
            p.label || '打包中…',
          ),
        });
        ipSet(92, '生成导出文件…');
        download(`deepseek-chatbox-${new Date().toISOString().slice(0, 10)}.json`,
          JSON.stringify(snap, null, 2));
        const nAtt = Object.keys(snap.attachmentData || {}).length;
        const mb = ((snap.attachmentBytes || 0) / 1048576).toFixed(1);
        ipSet(100, `完成：${snap.conversations.length} 个对话、${nAtt} 个附件（${mb} MB）`);
        toast(`已导出 ${snap.conversations.length} 个对话、${nAtt} 个附件（${mb} MB）`);
      } catch (e) {
        ipHide();
        toast('导出失败：' + e.message);
      }
    });

    const importBtn = h('button', { class: 'btn', type: 'button', text: t('importData') });
    importBtn.addEventListener('click', () => importInput.click());

    const clearBtn = h('button', { class: 'btn danger', type: 'button', text: t('clearData') });
    clearBtn.addEventListener('click', async () => {
      const ok = await appConfirm({
        title: t('clearData'),
        message: t('clearConfirm'),
        okText: t('clearData'),
        danger: true,
      });
      if (!ok) return;
      try {
        await fetch('/api/conversations', { method: 'DELETE' });
        clearAllConversations();
        toast(t('cleared'));
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        toast('清空失败：' + e.message);
      }
    });

    const modelBtn = h('button', { class: 'btn', type: 'button', text: '刷新模型列表' });
    modelBtn.addEventListener('click', async () => {
      try {
        const list = await listModels();
        toast('已获取 ' + list.length + ' 个模型');
        render();
      } catch (e) {
        toast(e.message);
      }
    });

    const convs = allConversations();
    const msgCount = convs.reduce((n, c) => n + (c.messages?.length || 0), 0);

    return [
      section('存储位置', [
        h('div', { class: 'field' }, [
          h('label', { text: '数据存放位置' }),
          h('div', { class: 'help', html: `全部数据保存在服务端目录：<br><code>${storeMeta.dataDir || '（未知）'}</code><br>` +
            `含 <code>settings.json</code>（设置与 Key）、<code>conversations.json</code>（对话）、<code>attachments/</code>（图片）、<code>backups/</code>（自动备份）。<br>` +
            '浏览器不保存任何内容，换浏览器/清缓存都不会丢数据。' }),
        ]),
      ]),
      section('导入与导出', [
        h('div', { class: 'field' }, [
          h('label', { text: '对话数据' }),
          h('div', { class: 'help', text: `共 ${convs.length} 个对话、${msgCount} 条消息。` }),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } }, [exportBtn, importBtn, clearBtn, modelBtn]),
          importInput,
          ipBox,
        ]),
      ]),
    ];
  }

  // 官方 chat-demo 的设置弹窗只有右上角关闭按钮，没有底部操作栏
  render();
  document.body.append(overlay);
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}
