'use strict';
/**
 * 最小 ZIP 读取器（零依赖）
 * 只支持 store / deflate 两种压缩方式，不支持加密与 zip64。
 * 读中央目录而不是顺序扫 local header —— 更稳，能正确处理 data descriptor。
 */

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_LOC = 0x07064b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf
 * @returns {{ name:string, dir:boolean, data:Buffer, method:number, crc:number }[]}
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip：内容太短');
  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error('不是有效的 zip：找不到目录结束标记');

  // zip64 检测
  for (let i = eocd - 20; i >= Math.max(0, eocd - 200); i--) {
    if (i >= 0 && buf.readUInt32LE(i) === ZIP64_EOCD_LOC) {
      throw new Error('暂不支持 zip64 格式的插件包（请用普通 zip 重新打包，不要勾选 zip64）');
    }
  }

  const total = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cenSize === 0xffffffff || cenOff === 0xffffffff) {
    throw new Error('暂不支持 zip64 格式的插件包');
  }
  if (cenOff + cenSize > buf.length) throw new Error('zip 目录越界，文件可能被截断');

  const out = [];
  let p = cenOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('zip 中央目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const locOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error(`插件包含加密文件：${name}`);
    if (name.endsWith('/')) { out.push({ name, dir: true, data: Buffer.alloc(0), method, crc }); continue; }

    if (locOff + 30 > buf.length || buf.readUInt32LE(locOff) !== LOC_SIG) throw new Error(`zip 条目损坏：${name}`);
    const lNameLen = buf.readUInt16LE(locOff + 26);
    const lExtraLen = buf.readUInt16LE(locOff + 28);
    const start = locOff + 30 + lNameLen + lExtraLen;
    const end = start + compSize;
    if (end > buf.length) throw new Error(`zip 条目越界：${name}`);
    const raw = buf.subarray(start, end);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw); }
      catch (e) { throw new Error(`解压失败：${name}（${e.message}）`); }
    } else throw new Error(`不支持的压缩方式 ${method}：${name}`);

    if (rawSize && data.length !== rawSize) {
      // 允许 CRC 缺失但大小不符基本就是损坏
      throw new Error(`解压后大小不符：${name}（${data.length} != ${rawSize}）`);
    }
    out.push({ name, dir: false, data, method, crc });
  }
  return out;
}

/** 把 zip 条目转成「相对路径 -> Buffer」的扁平表，顺手做路径安全校验 */
function toFileMap(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.dir) continue;
    const name = e.name.replace(/\\/g, '/');
    if (name.startsWith('/') || name.includes('../') || /^[A-Za-z]:/.test(name)) {
      throw new Error(`插件包含非法路径：${e.name}`);
    }
    map.set(name, e.data);
  }
  return map;
}

module.exports = { readZip, toFileMap };
