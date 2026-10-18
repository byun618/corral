/* global fetch, WebSocket */
// LIFE-636 최종 관문 격리 회차 CDP 운전 — iso-up.sh 가 띄운 숨긴 창에 붙어 DOM·캡처·IPC 를 본다. 입력은 CDP(렌더러 안)로만 — OS 입력 없음.
//   node scripts/l636/iso-cdp.mjs <port> <run1|narrow|run2> <out 디렉터리> <root>
// run1(실제 자격 증명): ⓐ E1 상태바 DOM · ⓑ 900px·400px 캡처·폭 · ⓕ 새로고침 키보드(R2-6) · ⓒ 설정에서 Claude 끄기
// run2(재시작 · CODEX_HOME·GROK_HOME 빈 폴더): ⓒ 끈 설정 유지 · ⓓ 칩 없음·「로그인 정보 없음」 · ⓔ exposedMethods·푸시·잘못된 입력
// 출력: <out>/<run>.json (판정 근거 값) · PNG. 토큰·계정 값은 DOM 에 없다(칩 문구는 사용률뿐).
import fs from 'node:fs'
import path from 'node:path'

const [port, run, out, root] = process.argv.slice(2)
if (!port || !run || !out || !root) { console.error('usage: <port> <run1|run2> <out> <root>'); process.exit(2) }
fs.mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 제어 소켓이 CDP 포트보다 먼저 열린다(f18) — 페이지 대상이 보일 때까지 기다린다
let targets = []
for (let i = 0; i < 100 && !targets.some((t) => t.type === 'page' && t.url.includes('index.html')); i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch { await sleep(200) }
  if (!targets.some((t) => t.type === 'page' && t.url.includes('index.html'))) await sleep(200)
}
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
if (!page) { console.error('page target 없음', JSON.stringify(targets.map((t) => t.url))); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
const consoleLog = []
ws.onmessage = (message) => {
  const data = JSON.parse(message.data)
  if (data.id !== undefined) { const p = pending.get(data.id); pending.delete(data.id); if (data.error) p.reject(new Error(JSON.stringify(data.error))); else p.resolve(data.result) }
  else if (data.method === 'Runtime.consoleAPICalled') consoleLog.push({ type: data.params.type, text: data.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) })
  else if (data.method === 'Log.entryAdded') consoleLog.push({ type: `log.${data.params.entry.level}`, text: String(data.params.entry.text).slice(0, 300) })
  else if (data.method === 'Runtime.exceptionThrown') consoleLog.push({ type: 'exception', text: String(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text).slice(0, 300) })
}
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
const js = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(`eval: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  return result.result.value
}
const until = async (expression, label, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expression)) return; await sleep(150) } throw new Error(`timeout ${label}`) }
const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64')) }
const key = async (keyName, code, windowsVirtualKeyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode, text: keyName === 'Enter' ? '\r' : undefined })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode })
}
const usageLog = () => fs.existsSync(path.join(root, 'corral.ndjson'))
  ? fs.readFileSync(path.join(root, 'corral.ndjson'), 'utf8').split('\n').filter((line) => /"usage\./.test(line)).map((line) => { try { const e = JSON.parse(line); return { ts: e.ts, tag: e.tag, provider: e.provider ?? null, reason: e.reason ?? null, status: e.status ?? null } } catch { return { raw: line.slice(0, 200) } } })
  : []

const GEOMETRY = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), height: Math.round(b.height), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } }
  const bar = document.querySelector('[data-statusbar]')
  return { innerWidth, statusbar: r(bar), usage: r(document.querySelector('[data-statusbar-usage]')), segments: r(document.querySelector('[data-statusbar-segments]')),
    segmentsText: document.querySelector('[data-statusbar-segments]')?.textContent ?? null,
    chips: [...document.querySelectorAll('[data-statusbar-usage-chip]')].map((el) => ({ id: el.dataset.statusbarUsageChip, status: el.dataset.statusbarUsageStatus, text: el.textContent, rect: r(el) })) }
})()`
const result = { run, at: new Date().toISOString(), steps: {} }
let failed = false
try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until(`!!document.querySelector('[data-statusbar]')`, 'statusbar')
  if (run === 'run1') {
    await until(`(() => { const c = [...document.querySelectorAll('[data-statusbar-usage-chip]')]; return c.length > 0 && c.every((el) => el.dataset.statusbarUsageStatus !== 'loading') })()`, 'chips settled', 30_000)
    // ⓐ E1 — 지운 항목 없음·data-statusbar·높이·배경
    result.steps.e1 = await js(`(() => {
      const bar = document.querySelector('[data-statusbar]'); const text = bar.innerText
      return { present: true, height: getComputedStyle(bar).height, background: getComputedStyle(bar).backgroundColor, text,
        children: [...bar.children].map((el) => ({ tag: el.tagName.toLowerCase(), cls: el.className, data: Object.keys(el.dataset) })),
        removed: { statusbarRepo: bar.querySelectorAll('.statusbar-repo').length, xtermSize: /xterm \\d+\\s*[×x]\\s*\\d+/.test(text), dirtyAheadBehind: /dirty|ahead|behind|[↑↓]\\d/.test(text),
          paneCount: /\\d+\\s*(pane|panes)/i.test(text), agentCount: /\\d+\\s*(agent|agents)/i.test(text), branchIcon: bar.querySelectorAll('[data-statusbar-branch], .statusbar-branch, .statusbar-git').length } }
    })()`)
    // ⓑ 900px · 400px
    for (const width of [900, 400]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false })
      await sleep(400)
      result.steps[`width${width}`] = await js(GEOMETRY)
      await shot(`w${width}`)
    }
    await send('Emulation.clearDeviceMetricsOverride'); await sleep(300)
    // ⓕ R2-6 — 새로고침 키보드: 포커스가 버튼에 남는가
    await js(`document.querySelector('[data-statusbar-usage-chip="claude"]').click()`)
    await until(`!!document.querySelector('[data-statusbar-usage-refresh]')`, 'refresh button')
    await js(`document.querySelector('[data-statusbar-usage-refresh]').focus()`)
    const before = await js(`({ active: document.activeElement?.hasAttribute('data-statusbar-usage-refresh') ?? false, ariaDisabled: document.querySelector('[data-statusbar-usage-refresh]').getAttribute('aria-disabled'), disabledProp: document.querySelector('[data-statusbar-usage-refresh]').disabled })`)
    await key('Enter', 'Enter', 13)
    const samples = []
    for (let i = 0; i < 20; i++) {
      samples.push(await js(`(() => { const b = document.querySelector('[data-statusbar-usage-refresh]'); const a = document.activeElement; return { ms: ${i * 100}, button: !!b, ariaDisabled: b?.getAttribute('aria-disabled') ?? null, disabledProp: b?.disabled ?? null, activeIsRefresh: a?.hasAttribute('data-statusbar-usage-refresh') ?? false, active: a ? a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ')[0] : '') : null } })()`))
      await sleep(100)
    }
    result.steps.refreshKeyboard = { before, samples, sawRefreshing: samples.some((s) => s.ariaDisabled === 'true'), focusKeptAll: samples.every((s) => s.activeIsRefresh) }
    await key('Escape', 'Escape', 27); await sleep(200)
    // ⓒ 설정 › 외관 에서 Claude 끄기
    await js(`document.querySelector('[data-settings-open]').click()`)
    await until(`!!document.querySelector('[data-settings-nav-item="appearance"]')`, 'settings nav')
    await js(`document.querySelector('[data-settings-nav-item="appearance"]').click()`)
    await until(`!!document.querySelector('[data-statusbar-usage-setting="claude"] [data-settings-switch]')`, 'claude switch')
    result.steps.settingsBefore = await js(`[...document.querySelectorAll('[data-statusbar-usage-setting]')].map((el) => ({ id: el.dataset.statusbarUsageSetting, checked: el.querySelector('[data-settings-switch]').getAttribute('aria-checked'), signedOut: !!el.querySelector('[data-statusbar-usage-signed-out]') }))`)
    await js(`document.querySelector('[data-statusbar-usage-setting="claude"] [data-settings-switch]').click()`)
    await until(`document.querySelector('[data-statusbar-usage-setting="claude"] [data-settings-switch]').getAttribute('aria-checked') === 'false'`, 'claude off')
    await until(`!document.querySelector('[data-statusbar-usage-chip="claude"]')`, 'claude chip gone')
    await sleep(800)
    await shot('settings-claude-off')
    result.steps.claudeOff = { chipsAfter: await js(`[...document.querySelectorAll('[data-statusbar-usage-chip]')].map((el) => el.dataset.statusbarUsageChip)`) }
  } else if (run === 'narrow') {
    // ⓑ 보강 — 400px 에선 다 들어가 줄어들 일이 없었다(run1). 넘치는 폭에서 사용량 슬롯이 먼저 줄고 메모리는 그대로인가
    await until(`document.querySelectorAll('[data-statusbar-usage-chip]').length > 0`, 'chips')
    for (const width of [200, 160, 120]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 400, deviceScaleFactor: 2, mobile: false })
      await sleep(400)
      result.steps[`width${width}`] = await js(GEOMETRY)
      await shot(`w${width}`)
    }
    await send('Emulation.clearDeviceMetricsOverride')
  } else {
    await sleep(3000)
    // ⓒ 유지 · ⓓ 빈 폴더
    const settingsFile = path.join(root, 'ud', 'settings.json')
    const saved = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null
    result.steps.persisted = { file: settingsFile.replace(root, '<root>'), statusBarUsageClaude: saved?.statusBarUsageClaude ?? null, statusBarUsageCodex: saved?.statusBarUsageCodex ?? null, statusBarUsageGrok: saved?.statusBarUsageGrok ?? null }
    result.steps.chips = await js(`[...document.querySelectorAll('[data-statusbar-usage-chip]')].map((el) => ({ id: el.dataset.statusbarUsageChip, status: el.dataset.statusbarUsageStatus }))`)
    // ⓔ exposedMethods · 푸시 · 잘못된 입력
    result.steps.exposed = await js(`(() => { const m = window.corral?.preloadEnv?.exposedMethods ?? null; return { sandboxed: window.corral?.preloadEnv?.sandboxed ?? null, contextIsolated: window.corral?.preloadEnv?.contextIsolated ?? null, hasList: Array.isArray(m), getUsage: m?.includes('getUsage') ?? false, refreshUsage: m?.includes('refreshUsage') ?? false, onUsage: m?.includes('onUsage') ?? false, types: { getUsage: typeof window.corral?.getUsage, refreshUsage: typeof window.corral?.refreshUsage, onUsage: typeof window.corral?.onUsage } } })()`)
    await js(`(() => { window.__l636pushes = []; window.__l636off = window.corral.onUsage((snapshot) => window.__l636pushes.push(snapshot.providers.map((p) => p.id + ':' + p.usage.status).join(','))); return true })()`)
    const summarize = `(s) => s === null || s === undefined ? s : s.providers.map((p) => p.id + ':' + p.usage.status + (p.usage.reason ? '(' + p.usage.reason + ')' : ''))`
    const invalid = {}
    for (const [name, arg] of [['valid-null', '{ id: null }'], ['number', '42'], ['id-number', '{ id: 7 }'], ['id-unknown', "{ id: 'nope' }"], ['string', "'claude'"], ['undefined', 'undefined']]) {
      invalid[name] = await js(`window.corral.refreshUsage(${arg}).then((s) => ({ ok: true, value: (${summarize})(s) }), (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 200) }))`)
      await sleep(300)
    }
    result.steps.invalidInput = invalid
    await sleep(500)
    result.steps.pushes = await js(`window.__l636pushes.slice()`)
    await js(`(() => { window.__l636off?.(); return true })()`)
    const getUsage = await js(`window.corral.getUsage().then((s) => (${summarize})(s))`)
    result.steps.getUsage = getUsage
    // ⓓ 설정 카드
    await js(`document.querySelector('[data-settings-open]').click()`)
    await until(`!!document.querySelector('[data-settings-nav-item="appearance"]')`, 'settings nav')
    await js(`document.querySelector('[data-settings-nav-item="appearance"]').click()`)
    await until(`!!document.querySelector('[data-statusbar-usage-setting="claude"] [data-settings-switch]')`, 'switches')
    await sleep(500)
    result.steps.settingsCard = await js(`[...document.querySelectorAll('[data-statusbar-usage-setting]')].map((el) => ({ id: el.dataset.statusbarUsageSetting, checked: el.querySelector('[data-settings-switch]').getAttribute('aria-checked'), signedOut: el.querySelector('[data-statusbar-usage-signed-out]')?.textContent ?? null }))`)
    await shot('settings-run2')
  }
} catch (error) {
  result.error = String(error)
  failed = true
}
result.usageLog = usageLog()
result.console = consoleLog
result.consoleErrors = consoleLog.filter((entry) => /error|exception/.test(entry.type)).length
fs.writeFileSync(path.join(out, `${run}.json`), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ run, failed, error: result.error ?? null, consoleErrors: result.consoleErrors }))
ws.close()
process.exit(failed ? 1 : 0)
