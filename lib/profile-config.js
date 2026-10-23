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
 * 优先看依赖，再看 bundles 列表——两条都试，避免漏判。
 * @returns 目录绝对路径，或 undefined。
 */
export function findProfileDir(home = dshHome()) {
  const root = join(home, 'profiles')
  let names
  try {
    names = readdirSync(root)
  } catch {
    return undefined
  }
  for (const name of names) {
    const dir = join(root, name)
    const file = join(dir, 'package.json')
    if (!existsSync(file)) continue
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      const deps = pkg?.dependencies ?? {}
      const bundles = pkg?.dsh?.profile?.bundles ?? []
      if (PACKAGE_NAME in deps || bundles.includes(PACKAGE_NAME)) return dir
    } catch {
      /* 坏掉的 profile 跳过 */
    }
  }
  return undefined
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
  writeFileSync(file, next, { mode: statSync(file).mode || 0o600 })
  return { file, text: next }
}

/** 已知的 cloudflared 配置目录（给「named 模式」填默认值用）。 */
export function defaultTunnelConfigPath(home = process.env.HOME ?? '') {
  return join(home, '.cloudflared', 'dsh-remote.yml')
}
