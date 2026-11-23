/* 设置弹窗 */
import { h, $, download, toast } from './util.js';
import { settings, saveSettings, allConversations, importConversations, clearAllConversations, meta as storeMeta, saveConversationsNow, hasApiKey, migratePrices, isPeakNow } from './store.js';
import { t } from './i18n.js';
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

function switchRow(title, desc, on, onChange) {
  const sw = h('button', { class: 'switch' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on) });
  sw.addEventListener('click', () => {
    const next = !sw.classList.contains('on');
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-pressed', String(next));
    onChange(next);
  });
  return h('div', { class: 'switch-row' }, [
    h('div', { class: 'txt' }, [h('b', { text: title }), desc ? h('span', { text: desc }) : null]),
    sw,
  ]);
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

  overlay = h('div', { class: 'overlay settings-overlay', onclick: (e) => { if (e.target === overlay) close(); } }, [modal]);
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
    );
    body.replaceChildren();
    if (tab === 'general') body.append(...generalTab());
    if (tab === 'model') body.append(...modelTab());
    if (tab === 'gen') body.append(...genTab());
    if (tab === 'data') body.append(...dataTab());
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
      field(t('apiKey'), keyWrap, '保存在服务端 <code>data/settings.json</code>（明文，仅本机可读）；浏览器不再保存，也不会随请求发送。'),
      field(t('baseUrl'), base, '兼容代理地址，例如 <code>https://api.deepseek.com</code>。'),
      h('div', { class: 'field' }, [h('label', { text: t('theme') }), themeSeg]),
      h('div', { class: 'field' }, [h('label', { text: t('language') }), langSeg]),
      field(t('ttsVoice'), voiceSel),
      switchRow(t('mock'), t('mockHelp'), settings.mock, (v) => {
        saveSettings({ mock: v });
        onChange?.({ mock: true });
      }),
      h('div', { class: 'field', style: { marginTop: '14px' } }, [
        h('div', { class: 'help', text: t('shortcuts') }),
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
      field(t('model'), modelSel, 'deepseek-flash 支持文本 + 图片；deepseek-v4-pro 仅文本。'),
      h('div', { class: 'field' }, [h('label', { text: t('reasoningEffort') }), effortSeg,
        h('div', { class: 'help', text: '仅思考模式生效；思考模式下 temperature / top_p 由服务端决定。' })]),
      field(t('systemPrompt'), sys),
      h('div', { class: 'field-row' }, [
        field(t('temperature'), temp),
        field(t('topP'), topP),
      ]),
      field(t('maxTokens'), maxTok, '范围 1–393216；输入与输出总长受上下文窗口限制。'),
      field(t('stop'), stop),
      field('user_id', uid, '仅英文字母、数字、下划线、连字符，UTF-8 不超过 512 字节。'),
      h('div', { class: 'field' }, [
        h('label', { text: t('reminder') }),
        switchRow('latest_reminder', t('reminderHelp'), settings.reminder.enabled, (v) => {
          saveSettings({ reminder: { ...settings.reminder, enabled: v } });
        }),
        h('div', { class: 'field-row', style: { marginTop: '10px' } }, [
          field(t('location'), loc),
          field(t('modelLang'), langSel),
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
      switchRow('本地工具（function calling）',
        '让模型可以调用本机工具：余额、模型、时间、历史、用量、联网搜索/抓取，以及计算、哈希、编解码、JSON、统计、UUID、随机数等小工具。密钥留在服务端。',
        settings.localTools, (v) => saveSettings({ localTools: v })),
      h('div', { class: 'field', style: { marginTop: '10px' } }, [
        h('div', { class: 'help danger', html:
          '<strong>命令执行（危险，默认关闭）</strong>：开启后模型可调用 <code>cmd_run</code> 在<strong>本机 cmd.exe 直接执行任意命令</strong>，'
          + '不经过沙箱，能读写文件、访问网络。仅在你明确需要本机自动化时打开，用完建议关掉。'
          + '执行有 30 秒默认超时与 2 万字符输出上限。' }),
        switchRow('开启命令执行 cmd_run',
          '关闭时即使模型想调用也会被服务端拒绝。',
          settings.cmdEnabled === true, (v) => {
            saveSettings({ cmdEnabled: v });
            onChange?.({ cmdEnabled: true });
          }),
      ]),
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
      switchRow(t('jsonMode'), t('jsonModeHelp'), settings.jsonMode, (v) => saveSettings({ jsonMode: v })),
      switchRow(t('safety'), t('safetyHelp'), settings.safety, (v) => saveSettings({ safety: v })),
      switchRow(t('autoTitle'), t('autoTitleHelp'), settings.autoTitle, (v) => saveSettings({ autoTitle: v })),
      h('div', { class: 'field', style: { marginTop: '14px' } }, [h('label', { text: t('docLayout') }), layoutSeg,
        h('div', { class: 'help', text: '仅上传 PDF / Word / PPT 时生效。图文混排会把文档中的图一起交给模型。' })]),
      h('div', { class: 'field', style: { marginTop: '18px' } }, [
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
    ];
  }

  function dataTab() {
    const importInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    importInput.addEventListener('change', async () => {
      const f = importInput.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const list = Array.isArray(data) ? data : data.conversations || [];
        const n = await importConversations(list, 'merge');
        saveConversationsNow();
        toast(`已导入 ${n} 个对话，刷新页面后生效`);
        setTimeout(() => location.reload(), 900);
      } catch (e) {
        toast('导入失败：' + e.message);
      }
      importInput.value = '';
    });

    const exportBtn = h('button', { class: 'btn', type: 'button', text: t('exportData') });
    exportBtn.addEventListener('click', async () => {
      try {
        const snap = await fetch('/api/store').then((r) => r.json());
        download(`deepseek-chatbox-${new Date().toISOString().slice(0, 10)}.json`,
          JSON.stringify({ app: 'deepseek-chatbox', version: 2, exportedAt: Date.now(), conversations: snap.conversations, settings: snap.settings }, null, 2));
      } catch (e) {
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
      h('div', { class: 'field' }, [
        h('label', { text: '数据存放位置' }),
        h('div', { class: 'help', html: `全部数据保存在服务端目录：<br><code>${storeMeta.dataDir || '（未知）'}</code><br>` +
          `含 <code>settings.json</code>（设置与 Key）、<code>conversations.json</code>（对话）、<code>attachments/</code>（图片）、<code>backups/</code>（自动备份）。<br>` +
          '浏览器不保存任何内容，换浏览器/清缓存都不会丢数据。' }),
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '对话数据' }),
        h('div', { class: 'help', text: `共 ${convs.length} 个对话、${msgCount} 条消息。` }),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } }, [exportBtn, importBtn, clearBtn, modelBtn]),
        importInput,
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
