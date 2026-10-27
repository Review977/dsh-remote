#!/usr/bin/env python3
"""
让 cloudflared 的 Cloudflare 边缘连接绕开 Clash 类代理。

为什么需要：代理客户端默认把「非 CN 流量」统统走节点，cloudflared 到
198.41.x:7844 的隧道长连接也会被塞进美国节点——绕一趟太平洋，每几分钟断一次，
手机那条 WebSocket 就跟着掉。这几条规则把它锁成直连。

用法：
    ./scripts/clash-bypass-tunnel.py        # 改配置 + 热加载（配置没变就什么都不做）
    ./scripts/clash-bypass-tunnel.py --dry  # 只看会改什么

改完需要重启 cloudflared 才会换连接（插件会自动把它拉起来）：
    pkill -f 'cloudflared tunnel'
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser('~')
RULES = [
    'PROCESS-NAME,cloudflared,DIRECT',
    'IP-CIDR,198.41.192.0/24,DIRECT,no-resolve',
    'IP-CIDR,198.41.200.0/24,DIRECT,no-resolve',
]
BACKUP_DIR = os.path.join(HOME, '.dsh', 'backups')

# (实时配置, 生成它的 profile, core 目录)
TARGETS = [
    (os.path.join(HOME, 'Library/Application Support/ClashMac/work/config.json'),
     os.path.join(HOME, 'Library/Application Support/ClashMac/profiles/mihomo.yaml'),
     os.path.join(HOME, 'Library/Application Support/ClashMac/core/current'),
     'work'),
    (os.path.join(HOME, 'Library/Application Support/clashbar/config/mihomo.yaml'),
     None,
     os.path.join(HOME, 'Library/Application Support/clashbar/core/mihomo'),
     ''),
    (os.path.join(HOME, '.config/mihomo/config.yaml'), None, None, ''),
]


def log(msg):
    print(msg)


def backup(path, tag):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    dst = os.path.join(BACKUP_DIR, f'{tag}.{time.strftime("%Y%m%d-%H%M%S")}.bak')
    shutil.copy2(path, dst)
    return dst


def patch_json(path, dry):
    data = json.load(open(path, encoding='utf-8'))
    rules = data.get('rules') or []
    if any(str(r).startswith('PROCESS-NAME,cloudflared') for r in rules):
        return False
    log(f'  + {path}')
    if dry:
        return True
    backup(path, 'clashmac-config.json')
    data['rules'] = RULES + list(rules)
    json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    return True


def patch_yaml(path, dry):
    src = open(path, encoding='utf-8').read()
    if 'PROCESS-NAME,cloudflared,DIRECT' in src:
        return False
    lines = src.splitlines(keepends=True)
    out, done = [], False
    for line in lines:
        out.append(line)
        if not done and line.strip() == 'rules:':
            out.extend(f'  - {r}\n' for r in RULES)
            done = True
    if not done:
        log(f'  ! {path} 里没找到 rules:')
        return False
    log(f'  + {path}')
    if not dry:
        backup(path, 'clashmac-profile.yaml')
        open(path, 'w', encoding='utf-8').write(''.join(out))
    return True


def controller():
    """从进程参数里拿 external-controller 与 secret。"""
    out = subprocess.run(['ps', '-axo', 'command='], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if '-ext-ctl' not in line:
            continue
        m = re.search(r'-ext-ctl\s+(\S+)', line)
        secret = re.search(r'-secret\s+(\S+)', line)
        if m:
            return m.group(1), (secret.group(1) if secret else '')
    return None, ''


def validate(core, workdir, config):
    if not core or not os.path.exists(core):
        return True
    args = [core, '-t']
    if workdir:
        args += ['-d', workdir]
    args += ['-f', config]
    proc = subprocess.run(args, capture_output=True, text=True)
    return proc.returncode == 0


def main():
    dry = '--dry' in sys.argv
    changed = False
    for live, profile, core, workdir in TARGETS:
        if not os.path.exists(live):
            continue
        log(f'{live}')
        if live.endswith('.json'):
            changed = patch_json(live, dry) or changed
        else:
            changed = patch_yaml(live, dry) or changed
        if profile and os.path.exists(profile):
            changed = patch_yaml(profile, dry) or changed

        if changed and not dry:
            if not validate(core, os.path.join(os.path.dirname(live), workdir) if workdir else os.path.dirname(live), live):
                log('  ! 新配置校验失败，已放弃，请用备份恢复')
                return 1

    if not changed:
        log('规则已经在位，什么都没改')
        return 0
    if dry:
        log('（dry run，未写入）')
        return 0

    addr, secret = controller()
    if addr:
        cmd = ['curl', '-s', '-X', 'PUT', f'http://{addr}/configs?force=true']
        if secret:
            cmd += ['-H', f'Authorization: Bearer {secret}']
        cmd += ['-H', 'Content-Type: application/json']
        for live, _, _, _ in TARGETS:
            if os.path.exists(live):
                cmd += ['-d', json.dumps({'path': live})]
                break
        out = subprocess.run(cmd, capture_output=True, text=True)
        log(f'  热加载 {addr} rc={out.returncode}')
    log('完成。重启 cloudflared 让它换用新连接： pkill -f "cloudflared tunnel"')
    return 0


if __name__ == '__main__':
    sys.exit(main())
