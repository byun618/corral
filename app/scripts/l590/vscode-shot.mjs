/* global fetch */
// LIFE-590 E10·E4ⓒ — 설치본 VS Code 를 **격리 프로필**로 띄워(이 스크립트가 띄우고 끈다) fixture 레포를 연 화면을 CDP 로 찍는다.
// 사용자 VS Code 설정·확장 무접촉: `--user-data-dir <dir>/ud --extensions-dir <dir>/ext`, 작업 영역 신뢰 끔, 환영 탭·업데이트·원격 측정 끔.
// 단계는 corral `first-screen.mjs` 와 같은 순서(탐색기 src 펼침 → sample.ts 한 번 클릭 → README.md 한 번 클릭 → sample.ts 더블클릭 → config/settings.json 한 번 클릭).
// 사용(app/ 에서): node scripts/l590/vscode-shot.mjs --dir /tmp/l590-vscode --repo /tmp/l590g-t/repo --out <dir> [--port 9390]
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'

const { values } = parseArgs({ options: { dir: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, port: { type: 'string', default: '9390' } } })
if (!/^\/tmp\/l590/.test(values.dir ?? '')) throw new Error('--dir 는 /tmp/l590* 여야 한다')
const CODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
fs.rmSync(values.dir, { recursive: true, force: true })
fs.mkdirSync(path.join(values.dir, 'ud/User'), { recursive: true })
fs.mkdirSync(path.join(values.dir, 'ext'), { recursive: true })
fs.mkdirSync(values.out, { recursive: true })
fs.writeFileSync(
  path.join(values.dir, 'ud/User/settings.json'),
  JSON.stringify({ 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'security.workspace.trust.enabled': false, 'workbench.tips.enabled': false, 'chat.disableAIFeatures': true, 'window.restoreWindows': 'none' }, null, 1),
)
const version = execFileSync('defaults', ['read', '/Applications/Visual Studio Code.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()
const child = spawn(CODE, ['--user-data-dir', path.join(values.dir, 'ud'), '--extensions-dir', path.join(values.dir, 'ext'), '--disable-workspace-trust', `--remote-debugging-port=${values.port}`, '--new-window', values.repo], { stdio: 'ignore', detached: false })
const log = { version, pid: child.pid, args: ['--user-data-dir', `${values.dir}/ud`, '--extensions-dir', `${values.dir}/ext`, '--disable-workspace-trust', `--remote-debugging-port=${values.port}`, '--new-window', values.repo], steps: [] }
const stop = async () => {
  child.kill('SIGTERM')
  await sleep(2000)
  log.leftover = execFileSync('sh', ['-c', `pgrep -f -- '${values.dir}/ud' || true`], { encoding: 'utf8' }).trim()
  if (log.leftover.length > 0) execFileSync('sh', ['-c', `pkill -KILL -f -- '${values.dir}/ud' || true`])
  fs.writeFileSync(path.join(values.out, 'vscode-steps.json'), JSON.stringify(log, null, 2) + '\n')
}
try {
  let page
  for (let i = 0; i < 60 && page === undefined; i += 1) {
    await sleep(500)
    const targets = await fetch(`http://127.0.0.1:${values.port}/json/list`).then((response) => response.json()).catch(() => [])
    page = targets.find((target) => target.type === 'page' && target.title.includes('repo'))
  }
  if (page === undefined) throw new Error('VS Code 창 없음')
  const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  let id = 0
  const pending = new Map()
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1
    pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)))
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false }).catch(() => null)
  await sleep(4000)
  const row = (text) => evaluate(`(() => { const el = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find((item) => item.textContent.trim() === ${JSON.stringify(text)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const press = async (text, clickCount = 1) => {
    let box = null
    for (let i = 0; i < 20 && box === null; i += 1) {
      box = await row(text)
      if (box === null) await sleep(250)
    }
    if (box === null) throw new Error(`행 없음 ${text}`)
    for (let count = 1; count <= clickCount; count += 1) {
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: count })
    }
    await sleep(900)
  }
  const tabs = () => evaluate(`[...document.querySelectorAll('.tabs-container .tab')].map((tab) => ({ label: tab.getAttribute('aria-label'), active: tab.classList.contains('active'), italic: tab.querySelector('.monaco-icon-label')?.classList.contains('italic') ?? false, height: Math.round(tab.getBoundingClientRect().height), width: Math.round(tab.getBoundingClientRect().width) }))`)
  const shot = async (name) => {
    const image = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(values.out, `vscode-${name}.png`), Buffer.from(image.data, 'base64'))
    log.steps.push({ name, shot: `vscode-${name}.png`, tabs: await tabs() })
  }
  await press('src')
  await press('sample.ts')
  await sleep(1200)
  log.editor = await evaluate(`(() => { const ed = document.querySelector('.editor-instance .monaco-editor'); const line = ed?.querySelector('.view-line'); return { background: ed && getComputedStyle(ed.querySelector('.monaco-editor-background') ?? ed).backgroundColor, fontFamily: line && getComputedStyle(line).fontFamily, fontSize: line && getComputedStyle(line).fontSize, lineHeight: line && getComputedStyle(line).lineHeight, theme: document.body.className } })()`)
  log.tokenSpans = await evaluate(`[...document.querySelectorAll('.editor-instance .monaco-editor .view-line')].slice(0, 12).map((line) => [...line.querySelectorAll('span > span')].map((span) => [span.textContent, getComputedStyle(span).color, getComputedStyle(span).fontStyle]))`)
  await shot('01-preview-ts')
  await press('README.md')
  await shot('02-preview-replaced')
  await press('sample.ts', 2)
  await press('config')
  await press('settings.json')
  await shot('03-pinned-plus-preview')
  await press('empty.txt')
  await shot('04-empty-file')
  await press('data.bin')
  await sleep(800)
  await shot('05-binary')
  socket.close()
} finally {
  await stop()
}
console.log(JSON.stringify({ version: log.version, steps: log.steps.map((step) => step.name), leftover: log.leftover }))
