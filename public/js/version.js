/* 应用元信息。
 * 版本号不在前端硬编码：服务端 package.json 是唯一真源，
 * 运行时通过 GET /api/version 读取（见 loadAppVersion）。 */
export const APP_NAME = 'DeepSeek ChatBox';
export const APP_REPO = 'https://github.com/Chengxidaxia/DeepseekChatBox';
export const APP_RELEASES = 'https://github.com/Chengxidaxia/DeepseekChatBox/releases/latest';

let cachedVersion = '';
let inflight = null;

/** 当前已知版本号；未加载完成时返回空串。 */
export function getAppVersion() { return cachedVersion; }

/** 从后端读取版本号（幂等：并发调用复用同一个请求）。返回 Promise<string>。 */
export function loadAppVersion() {
  if (cachedVersion) return Promise.resolve(cachedVersion);
  if (inflight) return inflight;
  inflight = fetch('/api/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      cachedVersion = j && j.version ? String(j.version) : '';
      return cachedVersion;
    })
    .catch(() => { cachedVersion = ''; return ''; })
    .finally(() => { inflight = null; });
  return inflight;
}
