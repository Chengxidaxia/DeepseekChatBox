/* 官方版聊天记录（deepseek_data-YYYY-MM-DD.zip）导入器
 *
 * 官方导出结构：
 *   manifest.json              {"export_format_version":3}
 *   user.json                  账号信息（导入时不使用）
 *   chat_session_index.json    [{id,title,pinned,message_count,inserted_at,updated_at}]
 *   chat_sessions/<id>.json    {id,title,pinned,messages:[{role,fragments,inserted_at}]}
 *   chat_sessions/<id>_files/<file_id>_<原文件名>
 *
 * 消息内容按 fragment 拆：REQUEST=用户文本，THINK=思考，RESPONSE=回答，FILE=附件。
 * 全程在浏览器里解压（DecompressionStream），不依赖服务端，web 与云专版共用。
 */

const MAX_ATTACH_BYTES = 64 * 1024 * 1024;   // 单个附件上限，超过跳过

/** 只看前 4 字节判断 zip（PK\x03\x04） */
export async function isZipFile(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch {
    return false;
  }
}

/** 解析 zip 的中央目录，返回 Map<路径, {method, raw}> */
async function readZipEntries(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // EOCD 在末尾，注释最长 65535
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    entries.set(name, { method, raw: buf.subarray(start, start + compSize) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** store / deflate 两种压缩方式解出字节 */
async function entryBytes(entry) {
  if (!entry) return null;
  if (entry.method === 0) return entry.raw;
  if (entry.method !== 8) throw new Error('不支持的 zip 压缩方式：' + entry.method);
  const stream = new Blob([entry.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 官方 FILE fragment 的 files 字段可能是 JSON，也可能是 Python repr（单引号） */
function parseFileList(field) {
  if (Array.isArray(field)) return field;
  if (typeof field !== 'string' || !field.trim()) return [];
  try {
    const arr = JSON.parse(field);
    if (Array.isArray(arr)) return arr;
  } catch {}
  const ids = [...field.matchAll(/['"]id['"]\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const names = [...field.matchAll(/['"]file_name['"]\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const sizes = [...field.matchAll(/['"]file_size['"]\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  return ids.map((id, i) => ({ id, file_name: names[i] || id, file_size: sizes[i] || 0 }));
}

function mimeOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || 'application/octet-stream';
}

function kindOf(name, mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^text\/|json|csv|markdown/.test(mime)) return 'text';
  return 'doc';
}

/** 官方 zip → {conversations, attachmentsImported, attachmentsSkipped} */
export async function importOfficialZip(file, { uploadAttachment, onProgress } = {}) {
  const entries = await readZipEntries(file);
  const dec = new TextDecoder('utf-8');

  const sessions = [];
  for (const [name, entry] of entries) {
    const m = /^chat_sessions\/([^/]+)\.json$/i.exec(name);
    if (!m) continue;
    try { sessions.push(JSON.parse(dec.decode(await entryBytes(entry)))); } catch {}
  }
  if (!sessions.length) throw new Error('压缩包里没有找到 chat_sessions/*.json');

  const index = new Map();
  if (entries.has('chat_session_index.json')) {
    try {
      for (const it of JSON.parse(dec.decode(await entryBytes(entries.get('chat_session_index.json'))))) {
        index.set(it.id, it);
      }
    } catch {}
  }

  const conversations = [];
  let imported = 0;
  let skipped = 0;
  let total = 0;

  for (const s of sessions) {
    const meta = index.get(s.id) || {};
    const messages = [];
    for (const m of s.messages || []) {
      const role = m.role === 'ASSISTANT' ? 'assistant' : 'user';
      const frags = Array.isArray(m.fragments) ? m.fragments : [];
      const text = frags.filter((f) => f.type === (role === 'user' ? 'REQUEST' : 'RESPONSE'))
        .map((f) => f.content || '').join('\n\n').trim();
      const reasoning = role === 'assistant'
        ? frags.filter((f) => f.type === 'THINK').map((f) => f.content || '').join('\n\n').trim()
        : '';
      const refs = [];
      for (const f of frags) {
        if (f.type !== 'FILE') continue;
        for (const x of parseFileList(f.files)) refs.push(x);
      }
      if (!text && !reasoning && !refs.length) continue;
      messages.push({
        id: m.id || ('m_' + Math.random().toString(36).slice(2, 10)),
        role,
        content: text,
        reasoning,
        attachments: refs.map((x) => {
          const mime = mimeOf(x.file_name || '');
          return {
            kind: kindOf(x.file_name || '', mime),
            name: x.file_name || x.id,
            size: Number(x.file_size) || 0,
            mime,
            _official: x,
          };
        }),
        createdAt: Date.parse(m.inserted_at) || Date.now(),
        model: role === 'assistant' ? 'deepseek-chat' : '',
      });
    }
    if (!messages.length) continue;

    // 附件：从 zip 里找 <session>_files/<file_id>_<name>，上传后换成新 id
    for (const msg of messages) {
      for (const att of msg.attachments) {
        const ref = att._official;
        delete att._official;
        if (!ref || !uploadAttachment) { skipped++; continue; }
        // 官方记录里 export_path 是权威路径（图片有值、未导出的文本为 null）
        let entry = ref.export_path ? entries.get(ref.export_path) : null;
        if (!entry) {
          const exact = `chat_sessions/${s.id}_files/${ref.id}_${ref.file_name}`;
          entry = entries.get(exact);
        }
        if (!entry) {
          const key = [...entries.keys()].find((k) => k.startsWith(`chat_sessions/${s.id}_files/`) && k.includes(ref.id));
          if (key) entry = entries.get(key);
        }
        // 官方不导出文本类附件（export_path=null）：保留文件名与大小，但不产生坏引用
        if (!entry) { skipped++; continue; }
        try {
          const bytes = await entryBytes(entry);
          if (!bytes || bytes.length > MAX_ATTACH_BYTES) { skipped++; continue; }
          if (att.kind === 'text') {
            // 文本附件直接内联进消息，和本应用上传 txt 的行为一致
            att.text = new TextDecoder('utf-8').decode(bytes).slice(0, 400000);
            imported++;
          } else {
            const blob = new Blob([bytes], { type: att.mime });
            const up = await uploadAttachment(blob, att.name);
            if (up?.id) {
              att.id = up.id;
              if (up.url) att.url = up.url;
              if (up.mime) att.mime = up.mime;
              if (up.size) att.size = up.size;
              imported++;
            } else {
              skipped++;
            }
          }
        } catch {
          skipped++;
        }
        total++;
        onProgress?.({ done: total, imported, skipped, name: att.name });
      }
    }

    conversations.push({
      id: s.id || ('c_' + Math.random().toString(36).slice(2, 10)),
      uuid: s.id,
      title: s.title || meta.title || '（无标题）',
      createdAt: Date.parse(s.inserted_at) || Date.parse(meta.inserted_at) || Date.now(),
      updatedAt: Date.parse(s.updated_at) || Date.parse(meta.updated_at) || Date.now(),
      pinned: Boolean(s.pinned ?? meta.pinned),
      messages,
    });
  }

  return { conversations, attachmentsImported: imported, attachmentsSkipped: skipped };
}

/* ------------------------- 附件内联（完整导出用） ------------------------- */

export function bytesToBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 把对话里所有附件下载成 base64，供导出内联。单文件超限则跳过 */
export async function collectAttachmentData(conversations, urlOf, { maxBytes = MAX_ATTACH_BYTES } = {}) {
  const out = {};
  let bytesTotal = 0;
  for (const c of conversations) {
    for (const m of c.messages || []) {
      for (const a of m.attachments || []) {
        if (!a.id || out[a.id]) continue;
        const url = urlOf ? urlOf(a.id) : '';
        if (!url) continue;
        try {
          const r = await fetch(url);
          if (!r.ok) continue;
          const buf = new Uint8Array(await r.arrayBuffer());
          if (buf.length > maxBytes) continue;
          out[a.id] = {
            name: a.name || a.id,
            mime: a.mime || r.headers.get('content-type') || 'application/octet-stream',
            data: bytesToBase64(buf),
          };
          bytesTotal += buf.length;
        } catch {}
      }
    }
  }
  return { data: out, bytes: bytesTotal };
}

/** 导入时把内联附件还原成新附件 id（覆盖原 id） */
export async function restoreAttachmentData(conversations, data, uploadAttachment) {
  if (!data || !uploadAttachment) return 0;
  let n = 0;
  for (const c of conversations) {
    for (const m of c.messages || []) {
      for (const a of m.attachments || []) {
        const rec = a.id && data[a.id];
        if (!rec) continue;
        try {
          const blob = new Blob([base64ToBytes(rec.data)], { type: rec.mime || 'application/octet-stream' });
          const up = await uploadAttachment(blob, rec.name || a.name || 'file');
          if (up?.id) {
            a.id = up.id;
            if (up.url) a.url = up.url;
            a.mime = up.mime || rec.mime;
            n++;
          }
        } catch {}
      }
    }
  }
  return n;
}
