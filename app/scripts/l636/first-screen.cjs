/* eslint-disable @typescript-eslint/no-require-imports -- Electron CJS 진입점(main·preload)이라 require 를 쓴다 */
/* global require, process, __dirname, setTimeout */
// LIFE-636 E10 첫 화면 캡처 — **화면에 뜨지 않는** Electron(show:false · dock 숨김 · accessory)으로 실제 렌더러 번들을 열고
// 사용량 칩·팝오버를 capturePage 로 찍는다. OS 포커스를 뺏지 않는다(LIFE-603 K1). 제품 main 은 돌리지 않는다 — 사용량 값은
// `usage-probe.ts` 가 실제 자격 증명으로 받은 결과 JSON(인자 --probe)이고, stale·error 장면은 그 값에서 만든 합성 상태다(설명 파일에 표시).
// 사용(app/ 에서, 빌드 뒤): npx electron scripts/l636/first-screen.cjs --probe <probe.json> --out <dir>
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const arg = (name) => { const index = process.argv.indexOf(name); return index === -1 ? null : process.argv[index + 1] }
const probe = JSON.parse(fs.readFileSync(arg('--probe'), 'utf8'))
const out = arg('--out')
fs.mkdirSync(out, { recursive: true })
const NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }
const entry = (result) => {
  const outcome = result.outcome
  const usage = outcome.kind === 'ok' ? { status: 'ok', windows: outcome.windows, updatedAt: Date.parse(result.finishedAt) }
    : outcome.kind === 'unavailable' ? { status: 'unavailable', reason: outcome.reason } : { status: 'error', error: outcome.error, checkedAt: Date.parse(result.finishedAt) }
  return { id: result.provider, name: NAMES[result.provider] ?? result.provider, usage, refreshing: false }
}
const real = { providers: probe.results.map(entry) }
ipcMain.on('l636:snapshot', (event) => { event.returnValue = real })

app.setActivationPolicy?.('accessory')
app.dock?.hide()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600, paintWhenInitiallyHidden: true, backgroundColor: '#12141a',
    webPreferences: { preload: path.join(__dirname, 'first-screen-preload.cjs'), contextIsolation: false, sandbox: false, nodeIntegration: false } })
  const log = []
  win.webContents.on('console-message', (_e, level, message) => log.push({ level, message: String(message).slice(0, 300) }))
  await win.loadFile(path.join(__dirname, '../../out/renderer/index.html'))
  const js = (code) => win.webContents.executeJavaScript(code)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (code, label) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(100) } throw new Error(`timeout ${label}`) }
  const geometry = () => js(`(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), width: Math.round(b.width), height: Math.round(b.height) } }
    const bar = document.querySelector('[data-statusbar]')
    return { innerWidth, statusbar: r(bar), statusbarHeight: bar && getComputedStyle(bar).height, statusbarBg: bar && getComputedStyle(bar).backgroundColor,
      usage: r(document.querySelector('[data-statusbar-usage]')), segments: r(document.querySelector('[data-statusbar-segments]')),
      segmentsText: document.querySelector('[data-statusbar-segments]')?.textContent ?? null,
      chips: [...document.querySelectorAll('[data-statusbar-usage-chip]')].map((el) => ({ id: el.dataset.statusbarUsageChip, status: el.dataset.statusbarUsageStatus, text: el.textContent, title: el.title, rect: r(el) })),
      popover: r(document.querySelector('[data-statusbar-usage-popover]')), popoverText: document.querySelector('[data-statusbar-usage-popover]')?.innerText ?? null,
      statusbarText: bar?.innerText ?? null }
  })()`)
  const shots = []
  const shot = async (name) => {
    await sleep(350)
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG())
    // 상태바 줄만 확대(2x)한 사본 — 칩이 작아서
    const g = await geometry()
    if (g.statusbar) {
      const crop = image.crop({ x: 0, y: Math.max(0, g.statusbar.top - (g.popover ? g.popover.height + 12 : 0)), width: g.innerWidth, height: g.statusbar.height + (g.popover ? g.popover.height + 12 : 0) })
      fs.writeFileSync(path.join(out, `${name}-statusbar.png`), crop.resize({ width: crop.getSize().width * 2 }).toPNG())
    }
    shots.push({ name, geometry: g })
  }
  try {
    await until(`document.querySelectorAll('[data-statusbar-usage-chip]').length > 0`, 'chips')
    await shot('01-chips-real')
    await js(`document.querySelector('[data-statusbar-usage-chip="claude"]').click()`)
    await until(`!!document.querySelector('[data-statusbar-usage-popover]')`, 'popover')
    await shot('02-popover-claude-real')
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    // 합성: Claude stale(실값 + 429) · Codex 만료(error) · Grok 첫 로딩
    const claude = real.providers.find((p) => p.id === 'claude')
    const synthetic = { providers: [
      claude && claude.usage.status === 'ok' ? { ...claude, usage: { status: 'stale', windows: claude.usage.windows, updatedAt: claude.usage.updatedAt - 7 * 60_000, error: { kind: 'rate_limited', message: '요청 제한 (HTTP 429) — 3분 뒤 다시' } } } : claude,
      { id: 'codex', name: 'Codex', usage: { status: 'error', error: { kind: 'expired', message: '로그인 만료 — codex 실행 시 갱신' }, checkedAt: Date.now() }, refreshing: false },
      { id: 'grok', name: 'Grok', usage: { status: 'loading' }, refreshing: true },
    ].filter(Boolean) }
    await js(`window.__l636push(${JSON.stringify(synthetic)})`)
    await shot('03-stale-error-loading-synthetic')
    await js(`document.querySelector('[data-statusbar-usage-chip="claude"]').click()`)
    await until(`!!document.querySelector('[data-statusbar-usage-popover]')`, 'popover stale')
    await shot('04-popover-stale-synthetic')
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await js(`document.querySelector('[data-statusbar-usage-chip="codex"]').click()`)
    await until(`!!document.querySelector('[data-statusbar-usage-popover]')`, 'popover error')
    await shot('05-popover-error-synthetic')
  } catch (error) {
    shots.push({ error: String(error) })
  }
  fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ at: new Date().toISOString(), probedAt: probe.at, pid: process.pid, window: { width: 900, height: 600, shown: win.isVisible() }, shots, console: log }, null, 2) + '\n')
  win.destroy()
  // 장면 하나라도 오류면 실패로 끝낸다(r1 R1-8) — 종료코드만 보고도 통과를 가를 수 있게. 콘솔 경고·오류도 실패로 센다.
  const failed = shots.some((entry) => 'error' in entry) || log.some((entry) => entry.level >= 2)
  app.exit(failed ? 1 : 0)
})
