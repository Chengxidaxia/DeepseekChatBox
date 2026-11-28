// 局域网访问：口令生成、Cookie 会话、未授权拦截
// 本机（127.0.0.1）访问不校验；其它来源必须持有口令，避免同一 WiFi 下任何人蹭用你的 API Key。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COOKIE = 'dsbox_lan';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 天

function createLan({ dataDir, log }) {
  const file = path.join(dataDir, 'lan.json');
  let state = { token: '', createdAt: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw.token === 'string') state = raw;
  } catch {}

  if (!state.token || state.token.length < 10) {
    state = { token: crypto.randomBytes(6).toString('hex'), createdAt: Date.now() };
    try {
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch (e) {
      log('[lan] 写入 lan.json 失败：' + e.message);
    }
  }
  const TOKEN = state.token;

  /* 口令爆破防护：同一 IP 5 分钟内错 5 次就锁到窗口结束。
   * 局域网里 token 是 12 位十六进制（48 bit），正常爆破不现实，
   * 但 RadminLAN 这类 VPN 常年开着，别给人无限次尝试的机会。 */
  const FAIL_LIMIT = 5;
  const FAIL_WINDOW = 5 * 60 * 1000;
  const fails = new Map();   // ip -> { n, first }
  const ipOf = (req) => String(req.socket.remoteAddress || '');
  const lockLeft = (ip) => {
    const e = fails.get(ip);
    if (!e) return 0;
    const left = FAIL_WINDOW - (Date.now() - e.first);
    if (left <= 0) { fails.delete(ip); return 0; }
    return e.n >= FAIL_LIMIT ? Math.ceil(left / 1000) : 0;
  };
  const noteFail = (ip) => {
    const now = Date.now();
    const e = fails.get(ip);
    if (!e || now - e.first > FAIL_WINDOW) fails.set(ip, { n: 1, first: now });
    else e.n++;
  };

  const isLocal = (req) => {
    const ra = String(req.socket.remoteAddress || '');
    return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  };

  const parseCookie = (header) => {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  };

  const same = (a, b) => {
    const ba = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8192) { reject(new Error('过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const loginPage = (bad) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>需要口令 · DeepSeek Chatbox</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
    background:#f9fafb;color:#1a1a1a;
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    padding:24px;padding-bottom:calc(24px + env(safe-area-inset-bottom))}
  .card{width:100%;max-width:380px;background:#fff;border:1px solid #e8e9ec;border-radius:20px;
    padding:28px 22px;box-shadow:0 10px 40px rgba(0,0,0,.06)}
  h1{margin:0 0 6px;font-size:19px;font-weight:600}
  p{margin:0 0 18px;font-size:13px;line-height:20px;color:#6b7280}
  input{width:100%;height:46px;border:1px solid #e2e4e9;border-radius:12px;padding:0 14px;
    font-size:16px;outline:none;background:#fff;color:#1a1a1a}
  input:focus{border-color:#3964fe}
  button{margin-top:12px;width:100%;height:46px;border:none;border-radius:12px;
    background:#3964fe;color:#fff;font-size:16px;font-weight:500}
  button:disabled{opacity:.6}
  .err{color:#d93026;font-size:13px;min-height:20px;margin-top:10px}
  code{background:#f2f3f5;border-radius:5px;padding:1px 5px;font-size:12px}
</style></head>
<body>
  <div class="card">
    <h1>需要访问口令</h1>
    <p>这台机器上的 DeepSeek Chatbox 只对持有口令的设备开放。<br>
       口令在<strong>电脑端的程序窗口</strong>里，形如 <code>a1b2c3d4e5f6</code>。</p>
    <input id="k" inputmode="latin" autocapitalize="off" autocorrect="off" spellcheck="false"
           placeholder="粘贴或输入 12 位口令" autofocus>
    <button id="go">进入</button>
    <div class="err" id="err">${typeof bad === 'string' ? bad : (bad ? '口令不正确，请重新核对' : '')}</div>
  </div>
<script>
  const k = document.getElementById('k');
  const btn = document.getElementById('go');
  const err = document.getElementById('err');
  async function submit() {
    const v = k.value.trim();
    if (!v) return;
    btn.disabled = true; err.textContent = '';
    try {
      const r = await fetch('/__lan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: v }),
      });
      if (r.ok) { location.replace('/'); return; }
      err.textContent = '口令不正确，请重新核对';
    } catch (e) {
      err.textContent = '连接失败：' + e.message;
    }
    btn.disabled = false;
  }
  btn.addEventListener('click', submit);
  k.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
</script>
</body></html>`;

  return {
    token: TOKEN,
    isLocal,
    /** 返回 true 表示已拦截并写出响应 */
    async guard(req, res, url) {
      if (isLocal(req)) return false;

      const cookie = parseCookie(req.headers.cookie)[COOKIE];
      if (same(cookie, TOKEN)) return false;

      // 带口令的链接：校验通过后种 cookie 并跳转到同一路径（去掉 k，避免留在历史记录里）
      const k = url.searchParams.get('k');
      if (k && same(k, TOKEN)) {
        const rest = new URLSearchParams(url.searchParams);
        rest.delete('k');
        const qs = rest.toString();
        res.writeHead(302, {
          'set-cookie': `${COOKIE}=${TOKEN}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`,
          location: url.pathname + (qs ? '?' + qs : ''),
          'cache-control': 'no-store',
        });
        return res.end(), true;
      }

      // 锁定检查放在 cookie / ?k= 之后：口令本来就是对的就别拦
      const ip = ipOf(req);
      const wait = lockLeft(ip);
      if (wait > 0) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(loginPage(`尝试次数过多，请 ${wait} 秒后再试`));
        return true;
      }

      // 口令提交
      if (url.pathname === '/__lan' && req.method === 'POST') {
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch {}
        if (same(body && body.token, TOKEN)) {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': `${COOKIE}=${TOKEN}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`,
            'cache-control': 'no-store',
          });
          return res.end(JSON.stringify({ ok: true })), true;
        }
        noteFail(ip);
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, error: '口令不正确' })), true;
      }

      res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
      });
      res.end(loginPage(false));
      return true;
    },
  };
}

module.exports = { createLan };
