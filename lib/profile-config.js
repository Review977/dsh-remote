/**
 * 把隧道/端口这些配置写回 profile 的 patch 层。
 *
 * 门控页上改配置 -> 写这一段受管块 -> App 监听到 patch 变化会自动重组 ->
 * 门控和隧道按新配置重启。全程不用手改 YAML。
 *
 * 只用「标记块」替换，块外的其它配置行原样保留。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './devices.js'

const BEGIN = '# >>> dsh-remote managed block >>>'
const END = '# <<< dsh-remote managed block <<<'

/** 本包的包名，用来在 profile 里认出「哪个 profile 装了我」。 */
export const PACKAGE_NAME = '@local/dsh-remote'

/**
 * 找出装了这个插件的 profile 目录。
 *
 * 注意不能「扫到第一个就返回」：本机同时装着 desktop 和 remotedev 时，
 * 在 remotedev 里改配置会写到 desktop 上去（真实事故：一次测试把线上端口改成了 1234）。
 * 所以先信 profileContext 给的名字，其次按「patch 里声明的端口 == 当前门控端口」认，
 * 最后才回落到第一个匹配。
 * @param options.name - 当前 profile 名（来自 profileContext）。
 * @param options.port - 当前门控端口，用来消歧。
 * @returns 目录绝对路径，或 undefined。
 */
export function findProfileDir(options = {}) {
  const home = options.home ?? dshHome()
  const wantedName = typeof options.name === 'string' && options.name.length > 0 ? options.name : undefined
  const wantedPort = Number.isInteger(options.port) ? options.port : undefined
  if (wantedName !== undefined) {
    const named = join(home, 'profiles', wantedName)
    if (existsSync(join(named, 'package.json'))) return named
  }
  const root = join(home, 'profiles')
  let names
  try {
    names = readdirSync(root)
  } catch {
    return undefined
  }
  const matches = []
  for (const name of names) {
    const dir = join(root, name)
    const file = join(dir, 'package.json')
    if (!existsSync(file)) continue
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      const deps = pkg?.dependencies ?? {}
      const bundles = pkg?.dsh?.profile?.bundles ?? []
      if (PACKAGE_NAME in deps || bundles.includes(PACKAGE_NAME)) matches.push({ dir, name })
    } catch {
      /* 坏掉的 profile 跳过 */
    }
  }
  if (matches.length === 0) return undefined
  // 按「自己 patch 里写的端口」认领，避免动到别的 profile
  if (wantedPort !== undefined) {
    for (const match of matches) {
      try {
        const patch = readFileSync(join(match.dir, 'cordis.patch.yml'), 'utf8')
        if (new RegExp(`^\\s*port:\\s*${String(wantedPort)}\\s*$`, 'm').test(patch)) return match.dir
      } catch {
        /* 没 patch 就跳过 */
      }
    }
  }
  return matches[0].dir
}

/** 生成受管块文本。 */
function renderBlock(fields) {
  const lines = [BEGIN, '- id: dsh-remote', `  name: '${PACKAGE_NAME}'`, '  config:', '    enabled: true']
  lines.push(`    bind: ${fields.bind}`)
  lines.push(`    port: ${fields.port}`)
  lines.push(`    tunnel: ${fields.tunnel}`)
  if (fields.tunnel === 'named') {
    if (fields.tunnelConfig) lines.push(`    tunnelConfig: ${fields.tunnelConfig}`)
    if (fields.publicHostname) lines.push(`    publicHostname: ${fields.publicHostname}`)
    if (!fields.tunnelConfig && fields.tunnelToken) lines.push(`    tunnelToken: ${fields.tunnelToken}`)
  }
  lines.push(`    requirePairing: ${fields.requirePairing ? 'true' : 'false'}`)
  if (fields.deviceTtlDays) lines.push(`    deviceTtlDays: ${fields.deviceTtlDays}`)
  lines.push(END)
  return `${lines.join('\n')}\n`
}

/**
 * 删掉旧的受管块（有标记按标记，没有标记按 `- id: dsh-remote` 吃到下一个顶层条目）。
 * @returns 去掉块之后的内容。
 */
export function stripBlock(text) {
  const byMarker = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g')
  if (byMarker.test(text)) return text.replace(byMarker, '')

  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('- id: dsh-remote')) {
      i += 1
      while (i < lines.length && !lines[i].startsWith('- ') && !lines[i].startsWith('# >>>')) i += 1
      i -= 1
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

/**
 * 写入配置（整块替换）。
 * @param profileDir - profile 目录。
 * @param fields - { bind, port, tunnel, publicHostname, tunnelConfig, tunnelToken, requirePairing, deviceTtlDays }
 * @returns { file, text } 写入后的文件路径与内容。
 */
export function writeManagedBlock(profileDir, fields) {
  const file = join(profileDir, 'cordis.patch.yml')
  let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const stripped = stripBlock(text).trimEnd()
  const next = `${stripped.length > 0 ? `${stripped}\n` : ''}\n${renderBlock(fields)}`
  // 文件可能还不存在（新 profile）：那时 statSync 会抛，直接给 600。
  const mode = existsSync(file) ? statSync(file).mode : 0o600
  writeFileSync(file, next, { mode })
  return { file, text: next }
}

/** 已知的 cloudflared 配置目录（给「named 模式」填默认值用）。 */
export function defaultTunnelConfigPath(home = process.env.HOME ?? '') {
  return join(home, '.cloudflared', 'dsh-remote.yml')
}
