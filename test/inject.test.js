/**
 * 注入片段的语法断言。
 *
 * 为什么值得单测：这些脚本是模板字符串拼出来的 JS，任何转义失误（反斜杠被吞、
 * 正则字面量退化成注释）都会让整段脚本 SyntaxError 且**静默失效**——手机上只是
 * 复制按钮没反应 / 样式没生效，控制台里才有痕迹。别人踩过（模板字符串里的
 * /\/auth\/?$/ 被折叠成 //auth 注释），这里用 new Function 兜住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

test('webserver/index-inject 注入的脚本与样式片段都合法', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-inject-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const cleanups = []
  const rows = []
  const taps = []
  const ctx = {
    webServer: {
      port: 0,
      getOrigin: () => 'http://127.0.0.1:0/',
      register: () => () => {},
      tapIndex: (transform) => {
        taps.push(transform)
        return () => {}
      },
    },
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    on: (event, handler) => {
      if (event === 'webserver/index-inject') {
        const table = []
        handler(table)
        rows.push(...table)
      }
      return () => {}
    },
    get: () => undefined,
  }

  try {
    apply(ctx, { enabled: true, bind: '127.0.0.1', port: 0, tunnel: 'off' })
    // 让门控的 listen 完成，避免清理时留一个悬挂的监听。
    await new Promise((resolve) => setTimeout(resolve, 100))

    const scripts = rows.filter((row) => row.kind === 'script').map((row) => row.text)
    assert.ok(scripts.length >= 3, 'expected at least three injected scripts')
    for (const text of scripts) {
      assert.doesNotThrow(() => new Function(text), `injected script does not parse: ${text.slice(0, 60)}`)
    }

    const mobile = scripts.find((text) => text.includes('dsh-remote-mobile'))
    assert.ok(mobile !== undefined, 'mobile style script missing')
    assert.match(mobile, /data-dsh-mobile/)
    assert.match(mobile, /viewport-fit=cover/)
    assert.ok(scripts.some((text) => text.includes("execCommand('copy')")), 'clipboard polyfill missing')
    assert.ok(scripts.some((text) => text.includes('randomUUID')), 'uuid polyfill missing')

    // 图标：只认 <head> 里的 <link>，所以走 tapIndex（结构化行进不了 head）。
    assert.equal(taps.length, 1, 'expected exactly one index tap')
    const html = '<!doctype html><html><head><base href="./"><title>x</title></head><body></body></html>'
    const injected = taps[0](html)
    assert.match(injected, /<head[^>]*><link rel="icon"[^>]*icon-192\.png">/)
    assert.match(injected, /rel="apple-touch-icon" sizes="180x180" href="\/__dsh-remote-assets\/icon-180\.png"/)
    assert.match(injected, /rel="manifest"/)
    // 幂等：同一份 HTML 过两遍不会重复插入。
    assert.equal(taps[0](injected), injected)
  } finally {
    for (const cleanup of cleanups) cleanup()
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
