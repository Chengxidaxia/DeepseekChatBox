#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepSeek ChatBox 一键发版

流程：升版本号 → 重建便携 exe → 打两个 zip → 提交 & 打 tag → 推送 → 建 GitHub Release

用法：
    python release.py 1.12.2
    python release.py 1.12.2 --title "v1.12.2 — 说明" --notes .build/notes-1.12.2.md
    python release.py 1.12.2 --no-build        # 复用已构建的 exe，只重打 zip
    python release.py 1.12.2 --yes             # 跳过确认

不传 --notes 时，自动用「上个 tag..HEAD」的提交信息生成发布说明。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
GREEN = os.path.join(ROOT, '.build', 'green', 'DeepSeekChatBox')
PORTABLE_EXE = os.path.join(ROOT, 'portable', 'dist', 'DeepSeekChatBox.exe')
PORTABLE_MANUAL = os.path.join(ROOT, 'portable', 'dist', '使用说明.txt')
GREEN_MANUAL = os.path.join(GREEN, '使用说明.txt')
ZIP_PORTABLE = os.path.join(ROOT, 'DeepSeekChatBox-portable.zip')
ZIP_GREEN = os.path.join(ROOT, 'DeepSeekChatBox-green.zip')

OK = '  ✓'
WARN = '  !'


def sh(cmd: list[str], check=True, quiet=True) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if check and r.returncode != 0:
        print(f'\n✗ 命令失败：{" ".join(cmd)}')
        print((r.stdout or '')[-3000:])
        print((r.stderr or '')[-3000:])
        sys.exit(1)
    if not quiet:
        print((r.stdout or '').strip())
    return r


def read(p: str) -> str:
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p: str, s: str) -> None:
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)


def node_bin() -> str:
    return shutil.which('node') or 'node'


# --------------------------------------------------------------------------- #
# 1. 版本号
# --------------------------------------------------------------------------- #
def bump(ver: str) -> None:
    print('1. 版本号')
    pkg = os.path.join(ROOT, 'package.json')
    s = read(pkg)
    n = re.sub(r'"version":\s*"[^"]*"', f'"version": "{ver}"', s, count=1)
    if n != s:
        write(pkg, n)
        print(OK, 'package.json')

    sea = os.path.join(ROOT, 'portable', 'sea-main.cjs')
    if os.path.exists(sea):
        s = read(sea)
        n = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{ver}';", s, count=1)
        if n != s:
            write(sea, n)
            print(OK, 'portable/sea-main.cjs')

    if os.path.exists(PORTABLE_MANUAL):
        s = read(PORTABLE_MANUAL)
        n = re.sub(r'版本 \d+\.\d+\.\d+', f'版本 {ver}', s)
        if n != s:
            write(PORTABLE_MANUAL, n)
            print(OK, '便携版使用说明')

    if os.path.exists(GREEN_MANUAL):
        with open(GREEN_MANUAL, encoding='utf-8-sig') as f:
            s = f.read()
        n = re.sub(r'(绿色版 v)\d+\.\d+\.\d+', rf'\g<1>{ver}', s, count=1)
        if n != s:
            with open(GREEN_MANUAL, 'w', encoding='utf-8-sig', newline='') as f:
                f.write(n)
            print(OK, '绿色版使用说明')
    else:
        print(WARN, '绿色版使用说明不存在，稍后会用便携版说明代替')


# --------------------------------------------------------------------------- #
# 2. 构建 exe + 打 zip
# --------------------------------------------------------------------------- #
def build_exe() -> None:
    print('2. 重建便携版 exe（约 40 秒）')
    t = time.time()
    r = sh([node_bin(), 'portable/build.mjs'])
    tail = [l for l in (r.stdout or '').splitlines() if l.startswith(('assets:', 'DONE', 'size:'))]
    for l in tail:
        print(OK, l)
    print(f'{OK} 耗时 {time.time() - t:.0f}s')
    if not os.path.exists(PORTABLE_EXE):
        print('✗ 没找到 exe：', PORTABLE_EXE)
        sys.exit(1)


def sync_green() -> None:
    print('3. 同步绿色版目录 + 打两个 zip')
    if not os.path.isdir(GREEN):
        print('✗ 绿色版目录不存在：', GREEN)
        sys.exit(1)
    for name in ('public', 'server'):
        dst = os.path.join(GREEN, name)
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        shutil.copytree(os.path.join(ROOT, name), dst)
    for f in ('server.mjs', 'package.json', '启动.bat'):
        src = os.path.join(ROOT, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(GREEN, f))
    if not os.path.exists(GREEN_MANUAL) and os.path.exists(PORTABLE_MANUAL):
        shutil.copy2(PORTABLE_MANUAL, GREEN_MANUAL)
        print(WARN, '绿色版说明取自便携版（内容会提到 exe，注意）')

    with zipfile.ZipFile(ZIP_PORTABLE, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.write(PORTABLE_EXE, 'DeepSeekChatBox.exe')
        if os.path.exists(PORTABLE_MANUAL):
            zf.write(PORTABLE_MANUAL, '使用说明.txt')

    order = ['node.exe', 'package.json', 'server.mjs', '使用说明.txt', '启动.bat', 'README.md']
    files = [f for f in order if os.path.exists(os.path.join(GREEN, f))]
    for dirpath, dirnames, filenames in os.walk(GREEN):
        dirnames.sort()
        filenames.sort()
        for n in filenames:
            rel = os.path.relpath(os.path.join(dirpath, n), GREEN).replace(os.sep, '/')
            if rel not in files:
                files.append(rel)
    with zipfile.ZipFile(ZIP_GREEN, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for rel in files:
            zf.write(os.path.join(GREEN, rel), 'DeepSeekChatBox/' + rel)

    for z, n in ((ZIP_PORTABLE, len(zipfile.ZipFile(ZIP_PORTABLE).namelist())),
                 (ZIP_GREEN, len(zipfile.ZipFile(ZIP_GREEN).namelist()))):
        print(OK, f'{os.path.basename(z)}  {n} 条目  {os.path.getsize(z) / 1048576:.1f} MB')


# --------------------------------------------------------------------------- #
# 4. git
# --------------------------------------------------------------------------- #
def git_release(ver: str, title: str, message: str) -> str:
    print('4. 提交 & 打 tag')
    tags = sh(['git', 'tag', '-l', f'v{ver}']).stdout.strip()
    if tags:
        print(f'✗ tag v{ver} 已存在，换一个版本号')
        sys.exit(1)

    sh(['git', 'add', '-A'])
    status = sh(['git', 'status', '--porcelain']).stdout.strip()
    if status:
        for line in status.splitlines()[:12]:
            print(OK, line.strip())
        sh(['git', 'commit', '-q', '-m', message])
        print(OK, '已提交')
    else:
        print(WARN, '没有待提交的改动，只打 tag')

    tag = f'v{ver}'
    sh(['git', 'tag', '-a', tag, '-m', title])
    print(OK, f'tag {tag}')
    sh(['git', 'push', '-q', 'origin', 'HEAD', '--tags'])
    print(OK, '已推送')
    return tag


# --------------------------------------------------------------------------- #
# 5. Release
# --------------------------------------------------------------------------- #
def default_notes(ver: str) -> str:
    prev = sh(['git', 'describe', '--tags', '--abbrev=0', f'v{ver}^'], check=False).stdout.strip()
    rng = f'{prev}..HEAD' if prev else 'HEAD'
    log = sh(['git', 'log', '--no-merges', '--pretty=- %s', rng], check=False).stdout.strip()
    if not log:
        log = '- （本次改动）'
    return (f'## DeepSeek ChatBox v{ver}\n\n### 本次改动\n\n{log}\n\n'
            '### 升级\n\n覆盖程序即可，`data/` 目录向后兼容。\n')


def create_release(ver: str, title: str, notes_file: str | None) -> str:
    print('5. 建 GitHub Release')
    tag = f'v{ver}'
    if notes_file and os.path.exists(notes_file):
        path = os.path.abspath(notes_file)
        print(OK, '说明文件：', os.path.basename(path))
    else:
        path = os.path.join(ROOT, '.build', f'notes-{ver}.md')
        write(path, default_notes(ver))
        print(OK, '说明自动生成：提交信息汇总')

    exists = sh(['gh', 'release', 'view', tag, '--json', 'tagName'], check=False).returncode == 0
    assets = [ZIP_PORTABLE, ZIP_GREEN]
    if exists:
        sh(['gh', 'release', 'edit', tag, '--title', title, '--notes-file', path])
        sh(['gh', 'release', 'upload', tag, *assets, '--clobber'])
        print(OK, '已更新既有 Release（覆盖资产）')
    else:
        sh(['gh', 'release', 'create', tag, '--title', title, '--notes-file', path, *assets])
        print(OK, '已创建 Release')

    url = sh(['gh', 'release', 'view', tag, '--json', 'url', '-q', '.url'], check=False).stdout.strip()
    info = sh(['gh', 'release', 'view', tag, '--json', 'assets', '-q',
               '[.assets[] | "\\(.name) \\(.size)"] | join(" | ")'], check=False).stdout.strip()
    if info:
        print(OK, '资产：', info)
    return url


def main() -> None:
    ap = argparse.ArgumentParser(description='一键发版')
    ap.add_argument('version', help='版本号，例如 1.12.2')
    ap.add_argument('--title', default=None, help='Release 标题，默认 v{版本} — 自动取提交摘要')
    ap.add_argument('--notes', default=None, help='发布说明 markdown 文件；不传则自动生成')
    ap.add_argument('--message', default=None, help='git 提交信息，默认 chore(release): v{版本}')
    ap.add_argument('--no-build', action='store_true', help='跳过 exe 构建，直接用已有 exe 重打 zip')
    ap.add_argument('--yes', action='store_true', help='跳过确认')
    a = ap.parse_args()

    ver = a.version.lstrip('v')
    if not re.fullmatch(r'\d+\.\d+\.\d+', ver):
        print('✗ 版本号格式应为 x.y.z')
        sys.exit(1)

    if sh(['git', 'tag', '-l', f'v{ver}']).stdout.strip():
        print(f'✗ tag v{ver} 已存在')
        sys.exit(1)

    title = a.title or f'v{ver}'
    message = a.message or f'chore(release): v{ver}'

    print(f'\n=== 发版 v{ver} ===')
    print(f'  标题：{title}')
    if not a.yes:
        if input('  继续？(y/N) ').strip().lower() not in ('y', 'yes'):
            print('已取消')
            return

    bump(ver)
    if a.no_build:
        print('2. 跳过 exe 构建')
    else:
        build_exe()
    sync_green()
    tag = git_release(ver, title, message)
    url = create_release(ver, title, a.notes)

    print(f'\n=== 完成 ===\n  {tag}\n  {url}\n')


if __name__ == '__main__':
    main()
