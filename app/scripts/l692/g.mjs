// LIFE-692 최종 관문 — 격리 GUI 회차(K1 ⓐ–ⓜ · 양성 대조 · K2 · K3 ⓐ–ⓗ). 회차 하나 = 새 ROOT(/tmp/l692q-*) · 새 herdr 이름 세션 · 새 fixture 레포.
//
// 격리: l692/up.sh(= l691/up.sh 사본) — userData·제어 소켓·ui-prefs·레지스트리 전부 ROOT 아래, herdr 는 레포 guard 바이너리의 이름 세션 `l692q-<꼬리>`.
//   설치본·사용자 userData·사용자 herdr·실제 LA 무접촉. 앱 = 빌드 산출물 사본(fixture-app.sh — 창 showInactive).
//   `L692_EXE` 가 있으면 그 실행 파일(설치본 등)을 같은 격리 ROOT 로 띄운다(K5).
// 입력: **판정 키는 CDP `Input.dispatchKeyEvent`**(cdp.mjs). 준비 걸음(레포 등록·파일 열기·탭 클릭)은 제어 소켓·CDP 마우스. 편집기 텍스트·선택 놓기는 준비(Monaco API) — 판정 대상 아님.
// 관측: 매 걸음 전후 모델 텍스트·선택·편집기 포커스·영역별 Markdown 모드·document.activeElement·마지막 keydown 의 defaultPrevented(디스패치 뒤 값) + 캡처.
// 판정: 항목마다 통과/미달. 예외는 미달로 남기고 다음 항목으로 간다(실패 회차 원자료 보존). 미달이 하나라도 있으면 exit 1.
// 사용(app/ 에서): node scripts/l692/g.mjs --suite impl|base|native --root /tmp/l692q-<x> --out <raw txt> [--port 9341]
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { clickAt, connect, dumpExpr, INSTALL_PROBE, LAST_KEY, press, screenshot, setupExpr, sleep, typeText, until } from './cdp.mjs'

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const BASE_APP = '/tmp/l692w/base-a8016179f/app'
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const suite = args.suite
const root = args.root
const port = Number(args.port ?? 9341)
if (!/^\/tmp\/l692q-[a-z0-9-]+$/.test(root ?? '')) throw new Error(`--root 는 /tmp/l692q-*: ${root}`)
if (!['impl', 'base', 'native'].includes(suite)) throw new Error('--suite impl|base|native')
const out = path.resolve(args.out)
const shotDir = out.replace(/\.txt$/, '-shots')
fs.mkdirSync(shotDir, { recursive: true })
const lines = []
const log = (head, detail) => {
  const line = `${new Date().toISOString()} ${head}${detail === undefined ? '' : ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`
  lines.push(line)
  fs.writeFileSync(out, lines.join('\n') + '\n')
  console.log(line.slice(0, 300))
}
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
}
const session = `l692q-${path.basename(root).replace(/^l692q-/, '')}`
const herdrSock = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
const repo = path.join(root, 'repo')
const appDir = `${root}-app`

// --- 바깥 도구 -----------------------------------------------------------------
const sh = (argv, env = {}) => {
  const run = spawnSync('sh', argv, { cwd: APP, encoding: 'utf8', env: { ...process.env, ...env } })
  log(`$ sh ${argv.join(' ')} → exit ${run.status}`, (run.stdout + run.stderr).trim().replaceAll(os.homedir(), '~'))
  if (run.status !== 0) throw new Error(`${argv[0]} 실패`)
}
function ctl(request, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(root, 'ctl/ctl.sock'))
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('ctl 시간 초과')) }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk) => { buffer += chunk; const i = buffer.indexOf('\n'); if (i === -1) return; clearTimeout(timer); socket.end(); resolve(JSON.parse(buffer.slice(0, i))) })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}
function herdr(method, params = {}) {
  if (!session.startsWith('l692q-')) throw new Error('격리 세션이 아니다')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(herdrSock)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, 10_000)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l692', method, params }) + '\n'))
    socket.on('data', (chunk) => { buffer += chunk; const i = buffer.indexOf('\n'); if (i === -1) return; clearTimeout(timer); socket.destroy(); const m = JSON.parse(buffer.slice(0, i)); if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result) })
  })
}

let cdp = null
/** 하네스가 보낸 키(뗌 1회 = 1) — 격리 corral.ndjson 의 input.raw keyUp 수와 대조해 사용자 입력 혼입을 본다. */
const sentKeys = []
const pressK = async (combo) => { sentKeys.push(combo); await press(cdp, combo) }
const typeK = async (text) => { sentKeys.push('Shift'); for (const ch of text) sentKeys.push(`char:${ch}`); await typeText(cdp, text) }
const ctlKey = async (keyCode, modifiers) => { sentKeys.push(`ctl:${modifiers.join('+')}+${keyCode}`); return ctl({ cmd: 'key', keyCode, modifiers }) }
const js = (expr) => cdp.evaluate(expr)
let shotNo = 0
async function shot(name) {
  shotNo += 1
  const file = path.join(shotDir, `${String(shotNo).padStart(2, '0')}-${name.replace(/[^a-zA-Z0-9가-힣_-]/g, '_')}.png`)
  const bytes = await screenshot(cdp, file).catch((error) => { log('shot 실패', String(error)); return null })
  if (bytes !== null) log('shot', { file: path.relative(path.resolve(APP, '..'), file), bytes })
}
const dump = (file) => js(dumpExpr(file))

// --- 준비 ----------------------------------------------------------------------
const T0 = 'const alphaValue = 1\nfunction betaGamma() {\n  return alphaValue\n}\nconst deltaEpsilon = 2\nconst zetaEta = 3\n'
const lineOf = (text, n) => text.split('\n')[n - 1]
const withLine = (text, n, value) => text.split('\n').map((line, i) => (i === n - 1 ? value : line)).join('\n')
const dropLine = (text, n) => text.split('\n').filter((_, i) => i !== n - 1).join('\n')
const insertLine = (text, n, value) => { const rows = text.split('\n'); rows.splice(n - 1, 0, value); return rows.join('\n') }
const swapLines = (text, a, b) => { const rows = text.split('\n'); [rows[a - 1], rows[b - 1]] = [rows[b - 1], rows[a - 1]]; return rows.join('\n') }
const MD_A = '# 제목\n\nl692 a\n'
const MD_B = '# 둘째\n\nl692 b\n'
const RO = 'const readOnlyValue = 1\nconst other = 2\n'

function makeRepo() {
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(repo, 'k1.ts'), T0)
  fs.writeFileSync(path.join(repo, 'a.md'), MD_A)
  fs.writeFileSync(path.join(repo, 'b.md'), MD_B)
  fs.writeFileSync(path.join(repo, 'ro.ts'), RO)
  // 하드링크 = 편집 불가 사유(`readOnlyReasonOf` → hardlink) — K1 ⓜ
  fs.linkSync(path.join(repo, 'ro.ts'), path.join(repo, 'ro-twin.ts'))
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=l692', '-c', 'user.email=l692@example.invalid', 'commit', '-q', '-m', 'fixture'])
}
async function up() {
  const extra = `--disable-backgrounding-occluded-windows --remote-debugging-port=${port}`
  sh(['scripts/l692/up.sh', root, `L692_EXTRA_ARGS=${extra}`], process.env.L692_EXE ? { L692_EXE: process.env.L692_EXE } : { L692_APP_DIR: appDir })
  cdp = await connect(port)
  log('cdp', { url: cdp.url.replace(os.homedir(), '~') })
  await until(() => js(`!!document.querySelector('[data-sidebar]')`), { timeoutMs: 30_000, label: '렌더러(사이드바)' })
  log('probe', await js(INSTALL_PROBE))
}
const down = (withHerdr = false) => { cdp?.close(); cdp = null; sh(['scripts/l692/down.sh', root, ...(withHerdr ? ['herdr'] : [])]) }
async function workspaceOf() {
  const real = fs.realpathSync(repo)
  const st = (await ctl({ cmd: 'state' })).state
  for (const r of st.repos) for (const wt of r.worktrees) if (wt.workspace !== null && (wt.path === repo || wt.path === real)) return wt.workspace
  return null
}
async function boot() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  makeRepo()
  if (!process.env.L692_EXE) sh(['scripts/l692/fixture-app.sh', suite === 'base' ? BASE_APP : APP, appDir])
  await up()
  await ctl({ cmd: 'resize-window', width: 1500, height: 900 }).catch(() => null)
  const added = await ctl({ cmd: 'add-repo', root: repo })
  if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
  await herdr('workspace.create', { cwd: repo, focus: false })
  const ws = await until(async () => (await workspaceOf())?.tabs.length === 1 ? await workspaceOf() : null, { timeoutMs: 15_000, label: '워크스페이스·터미널 탭' })
  await until(() => js(`document.querySelectorAll('[data-main-tab]').length >= 1`), { timeoutMs: 15_000, label: '화면 탭' })
  await sleep(1500)
  log('boot', { workspaceId: ws.workspaceId, terminal: ws.tabs[0].tabId })
  return ws.tabs[0].tabId
}
async function ctlClick(selector, cmd = 'click') {
  let last = null
  await until(async () => { last = await ctl({ cmd, selector }); return last.ok }, { timeoutMs: 10_000, everyMs: 250, label: `${cmd} ${selector}` }).catch(() => null)
  if (!last?.ok) throw new Error(`${cmd} 실패 ${selector}`)
}
async function openFile(rel) {
  const panelOpen = async () => (await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
  if (!(await panelOpen())) await ctlKey('L', ['meta'])
  await until(panelOpen, { timeoutMs: 5_000, label: '탐색기' })
  await until(() => js(`!!document.querySelector('[data-explorer-row="${rel}"]')`), { timeoutMs: 10_000, label: `탐색기 행 ${rel}` })
  await ctlClick(`[data-explorer-row="${rel}"]`, 'dblclick')
  await until(() => js(`document.querySelector('[data-file-tab="${rel}"][data-active="true"]') !== null`), { timeoutMs: 8_000, label: `파일 탭 ${rel}` })
  await sleep(300)
}
const editorReady = (rel) => until(() => js(`!!document.querySelector('.file-group[data-file-view="${rel}"] [data-editor-ready]')`), { timeoutMs: 15_000, label: `편집기 ${rel}` })
const fileTabSel = (rel) => `[data-file-tab="${rel}"]`

/** 키 걸음 하나 — 전후 덤프·마지막 keydown·캡처. */
async function step(label, combo, file) {
  const before = await dump(file)
  await pressK(combo)
  await sleep(350)
  const after = await dump(file)
  const key = await js(LAST_KEY)
  log(`[걸음] ${label} · ${combo}`, { before: { text: before.text, selection: before.selection, active: before.active, groups: before.groups }, after: { text: after.text, selection: after.selection, editorFocus: after.editorFocus, active: after.active, groups: after.groups, palette: after.palette, quickOpen: after.quickOpen }, key })
  await shot(label)
  return { before, after, key }
}
async function setup(file, text, sel) {
  const r = await js(setupExpr(file, text, sel))
  await sleep(150)
  return r
}
/** 예외는 그 항목 미달로 남기고 계속. */
async function item(name, fn) {
  try { await fn() } catch (error) { judge(name, false, { error: String(error?.stack ?? error).slice(0, 600) }); await shot(`error-${name}`).catch(() => null) }
}

// --- K1 ------------------------------------------------------------------------
async function k1(cases) {
  await openFile('k1.ts')
  await editorReady('k1.ts')
  const run = async (name, sel, combo, expected, extra) => item(name, async () => {
    await setup('k1.ts', T0, sel)
    const r = await step(name, combo, 'k1.ts')
    if (suite === 'base') {
      // 양성 대조(기준 a8016179f) — 기여가 없어 키가 텍스트를 바꾸지 않아야(= 692 의 실패 상태) 통과로 센다.
      judge(`양성 대조 ${name} — 기준 빌드에서 텍스트 불변`, r.after.text === T0, { got: r.after.text, defaultPrevented: r.key?.defaultPrevented })
      return r
    }
    const textOk = typeof expected === 'function' ? expected(r.after.text) : r.after.text === expected
    const extraOk = extra === undefined ? true : extra(r.after)
    judge(name, textOk && extraOk, { expected: typeof expected === 'function' ? String(expected) : expected, got: r.after.text, selection: r.after.selection, defaultPrevented: r.key?.defaultPrevented })
    return r
  })
  const all = {
    a: () => run('K1ⓐ ⌘⌫ 줄 앞 삭제', { sl: 2, sc: 10 }, 'Meta+Backspace', withLine(T0, 2, 'betaGamma() {')),
    b: () => run('K1ⓑ ⌘⇧K 줄 삭제', { sl: 2, sc: 1 }, 'Meta+Shift+K', dropLine(T0, 2)),
    c: async () => {
      await run('K1ⓒ ⌥↑ 줄 위로', { sl: 6, sc: 1 }, 'Alt+ArrowUp', swapLines(T0, 5, 6))
      await item('K1ⓒ ⌥↓ 줄 아래로', async () => {
        await setup('k1.ts', swapLines(T0, 5, 6), { sl: 5, sc: 1 })
        const r = await step('K1ⓒ ⌥↓', 'Alt+ArrowDown', 'k1.ts')
        judge('K1ⓒ ⌥↓ 줄 아래로', r.after.text === T0, { got: r.after.text })
      })
    },
    d: async () => {
      await run('K1ⓓ ⌥⇧↓ 줄 아래 복제', { sl: 6, sc: 1 }, 'Alt+Shift+ArrowDown', insertLine(T0, 7, lineOf(T0, 6)), (a) => a.selection?.sl === 7)
      await run('K1ⓓ ⌥⇧↑ 줄 위 복제', { sl: 1, sc: 1 }, 'Alt+Shift+ArrowUp', insertLine(T0, 1, lineOf(T0, 1)), (a) => a.selection?.sl === 1)
    },
    e: async () => {
      await run('K1ⓔ ⌘] 들여쓰기', { sl: 5, sc: 1 }, 'Meta+]', withLine(T0, 5, '  ' + lineOf(T0, 5)))
      await item('K1ⓔ ⌘[ 내어쓰기', async () => {
        await setup('k1.ts', withLine(T0, 5, '  ' + lineOf(T0, 5)), { sl: 5, sc: 3 })
        const r = await step('K1ⓔ ⌘[', 'Meta+[', 'k1.ts')
        judge('K1ⓔ ⌘[ 내어쓰기', r.after.text === T0, { got: r.after.text })
      })
    },
    f: async () => {
      await run('K1ⓕ ⌘/ 줄 주석', { sl: 5, sc: 1 }, 'Meta+/', withLine(T0, 5, '// ' + lineOf(T0, 5)))
      if (suite === 'base') return
      await item('K1ⓕ ⌘/ 두 번째 → 원상', async () => {
        const r = await step('K1ⓕ ⌘/ 두 번째', 'Meta+/', 'k1.ts')
        judge('K1ⓕ ⌘/ 두 번째 → 원상', r.after.text === T0, { got: r.after.text })
      })
    },
    fmd: async () => item('K1ⓕ .md ⌘/ → <!-- -->', async () => {
      await openFile('a.md')
      await editorReady('a.md')
      await setup('a.md', MD_A, { sl: 3, sc: 1 })
      const r1 = await step('K1ⓕ md ⌘/', 'Meta+/', 'a.md')
      const r2 = await step('K1ⓕ md ⌘/ 두 번째', 'Meta+/', 'a.md')
      judge('K1ⓕ .md ⌘/ → <!-- --> · 두 번 → 원상', r1.after.text === withLine(MD_A, 3, '<!-- l692 a -->') && r2.after.text === MD_A, { first: r1.after.text, second: r2.after.text })
      await ctlClick(fileTabSel('k1.ts'))
      await editorReady('k1.ts')
    }),
    g: () => run('K1ⓖ ⌥⇧A 블록 주석', { sl: 5, sc: 22, ec: 23 }, 'Alt+Shift+A', withLine(T0, 5, 'const deltaEpsilon = /* 2 */')),
    h: async () => {
      await run('K1ⓗ ⌘↵ 아래 줄 삽입', { sl: 1, sc: 5 }, 'Meta+Enter', insertLine(T0, 2, ''), (a) => a.selection?.sl === 2)
      await run('K1ⓗ ⌘⇧↵ 위 줄 삽입', { sl: 3, sc: 5 }, 'Meta+Shift+Enter', (text) => text !== null && text.split('\n').length === T0.split('\n').length + 1 && lineOf(text, 3).trim() === '' && lineOf(text, 4) === lineOf(T0, 3), (a) => a.selection?.sl === 3)
    },
    i: () => run('K1ⓘ ⌃J 줄 합치기', { sl: 5, sc: 1 }, 'Control+J', dropLine(withLine(T0, 5, `${lineOf(T0, 5)} ${lineOf(T0, 6)}`), 6)),
    j: () => run('K1ⓙ ⌃T 글자 바꾸기', { sl: 5, sc: 3 }, 'Control+T', withLine(T0, 5, 'cnost deltaEpsilon = 2')),
    k: () => run('K1ⓚ ⌃⌥→ 단어 부분 이동', { sl: 5, sc: 7 }, 'Control+Alt+ArrowRight', T0, (a) => a.selection?.sl === 5 && a.selection?.sc === 12 && a.selection?.ec === 12),
    l: async () => {
      await run('K1ⓛ ⌃K 줄 끝까지 삭제', { sl: 5, sc: 7 }, 'Control+K', withLine(T0, 5, 'const '))
      await run('K1ⓛ ⌘⌦ 줄 끝까지 삭제', { sl: 5, sc: 7 }, 'Meta+Delete', withLine(T0, 5, 'const '))
      await run('K1ⓛ ⌃⌥⌫ 단어 부분 왼쪽 삭제', { sl: 5, sc: 12 }, 'Control+Alt+Backspace', withLine(T0, 5, 'const Epsilon = 2'))
      await run('K1ⓛ ⌃⌥⌦ 단어 부분 오른쪽 삭제', { sl: 5, sc: 12 }, 'Control+Alt+Delete', withLine(T0, 5, 'const delta = 2'))
      await run('K1ⓛ ⌃⌥⇧→ 단어 부분 선택', { sl: 5, sc: 7 }, 'Control+Alt+Shift+ArrowRight', T0, (a) => a.selection?.sl === 5 && a.selection?.sc === 7 && a.selection?.ec === 12)
    },
    m: async () => item('K1ⓜ 읽기 전용(하드링크) 파일 — 새 키가 텍스트를 바꾸지 않는다', async () => {
      await openFile('ro.ts')
      await editorReady('ro.ts')
      const first = await dump('ro.ts')
      log('[기록] ro.ts 읽기 전용', { readOnly: first.readOnly, banner: await js(`document.querySelector('[data-file-notice^="readonly-"]')?.dataset.fileNotice ?? null`) })
      const results = []
      for (const combo of ['Meta+Backspace', 'Meta+Shift+K', 'Alt+ArrowUp', 'Meta+/']) {
        await setup('ro.ts', null, { sl: 2, sc: 5 })
        const r = await step(`K1ⓜ ${combo}`, combo, 'ro.ts')
        results.push({ combo, unchanged: r.after.text === RO })
      }
      judge('K1ⓜ 읽기 전용(하드링크) 파일 — ⌘⌫·⌘⇧K·⌥↑·⌘/ 텍스트 불변', first.readOnly === true && results.every((r) => r.unchanged), { readOnly: first.readOnly, results })
      await ctlClick(fileTabSel('k1.ts'))
      await editorReady('k1.ts')
    }),
  }
  for (const name of cases) await all[name]()
}

// --- K2 ------------------------------------------------------------------------
async function k2(terminalTab) {
  await ctlClick(fileTabSel('k1.ts'))
  await editorReady('k1.ts')
  await item('K2 ⌘K 팔레트', async () => {
    await setup('k1.ts', T0, { sl: 1, sc: 1 })
    const r = await step('K2 ⌘K', 'Meta+K', 'k1.ts')
    judge('K2 편집기 포커스 ⌘K → 커맨드 팔레트(텍스트 불변)', r.after.palette && r.after.text === T0 && r.key?.defaultPrevented === true, { palette: r.after.palette, defaultPrevented: r.key?.defaultPrevented })
    await pressK('Escape'); await sleep(300)
  })
  await item('K2 ⌘K 화음 기록', async () => {
    await setup('k1.ts', T0, { sl: 5, sc: 1 })
    await step('K2 ⌘K ⌘C (화음 첫 키)', 'Meta+K', 'k1.ts')
    const r = await step('K2 ⌘K ⌘C (둘째 키)', 'Meta+C', 'k1.ts')
    log('[기록] K2 ⌘K 화음 — 앱 팔레트가 첫 키를 가져가 ⌘K ⌘C 주석은 동작하지 않는다(기본안)', { textUnchanged: r.after.text === T0, palette: r.after.palette })
    await pressK('Escape'); await sleep(300)
  })
  await item('K2 ⌘P 빠른 열기', async () => {
    await setup('k1.ts', T0, { sl: 1, sc: 1 })
    const r = await step('K2 ⌘P', 'Meta+P', 'k1.ts')
    judge('K2 편집기 포커스 ⌘P → 빠른 열기(텍스트 불변)', r.after.quickOpen && r.after.text === T0, { quickOpen: r.after.quickOpen })
    await pressK('Escape'); await sleep(300)
  })
  await item('K2 ⌘S 저장', async () => {
    const edited = T0 + '// saved by l692\n'
    await setup('k1.ts', edited, { sl: 1, sc: 1 })
    const dirtyBefore = await js(`document.querySelector('.file-group[data-file-view="k1.ts"]')?.dataset.fileDirty`)
    await step('K2 ⌘S', 'Meta+S', 'k1.ts')
    await until(async () => (await js(`document.querySelector('.file-group[data-file-view="k1.ts"]')?.dataset.fileDirty`)) === 'false', { timeoutMs: 5_000, label: '저장' }).catch(() => null)
    const disk = fs.readFileSync(path.join(repo, 'k1.ts'), 'utf8')
    const dirtyAfter = await js(`document.querySelector('.file-group[data-file-view="k1.ts"]')?.dataset.fileDirty`)
    judge('K2 편집기 포커스 ⌘S → 저장(디스크 = 편집 내용)', dirtyBefore === 'true' && dirtyAfter === 'false' && disk === edited, { dirtyBefore, dirtyAfter, diskEqual: disk === edited })
    // 디스크를 T0 로 되돌린다(준비 — 다음 항목)
    await setup('k1.ts', T0, { sl: 1, sc: 1 })
    await pressK('Meta+S'); await sleep(800)
  })
  await item('K2 ⌘⇧] 다음 탭', async () => {
    await setup('k1.ts', T0, { sl: 1, sc: 1 })
    const r = await step('K2 ⌘⇧]', 'Meta+Shift+]', 'k1.ts')
    const beforeTab = r.before.groups.find((g) => g.active)?.activeTab
    const afterTab = r.after.groups.find((g) => g.active)?.activeTab
    judge('K2 편집기 포커스 ⌘⇧] → 다음 탭(텍스트 불변)', beforeTab !== afterTab && r.after.text === T0, { beforeTab, afterTab })
    await ctlClick(fileTabSel('k1.ts')); await editorReady('k1.ts')
  })
  await item('K2 탐색기 트리 ⌘⌫', async () => {
    await ctl({ cmd: 'file-dialog-stub', answers: ['cancel'] })
    await clickAt(cdp, '[data-explorer-row="b.md"]')
    await sleep(300)
    const focusedTree = await js(`document.activeElement?.matches('[data-explorer-tree]') ?? false`)
    const r = await step('K2 트리 ⌘⌫', 'Meta+Backspace', 'k1.ts')
    await sleep(500)
    const stub = await ctl({ cmd: 'file-dialog-stub', answers: [] })
    judge('K2 탐색기 트리 포커스 ⌘⌫ → 휴지통 확인 흐름(취소 → 파일 유지) · 편집기 텍스트 불변', focusedTree && stub.asked.includes('trash') && fs.existsSync(path.join(repo, 'b.md')) && r.after.text === T0, { focusedTree, asked: stub.asked, exists: fs.existsSync(path.join(repo, 'b.md')), defaultPrevented: r.key?.defaultPrevented })
  })
  await item('K2 터미널 ⌥↑', async () => {
    await ctlClick(`[data-main-tab="${terminalTab}"]`)
    await sleep(500)
    await clickAt(cdp, '[data-term-pane]')
    await sleep(300)
    const r = await step('K2 터미널 ⌥↑', 'Alt+ArrowUp', 'k1.ts')
    judge('K2 터미널 포커스 ⌥↑ → 편집기(k1.ts 모델) 텍스트 불변', r.after.active?.inTerm === true && r.after.text === T0, { active: r.after.active, text: r.after.text })
  })
}

// --- K3 ------------------------------------------------------------------------
const modeOf = (d, rel) => d.groups.find((g) => g.view === rel)?.markdownView ?? null
async function k3(terminalTab) {
  await openFile('a.md')
  await editorReady('a.md')
  await item('K3ⓐ ⓑ', async () => {
    await setup('a.md', MD_A, { sl: 3, sc: 1 })
    const ra = await step('K3ⓐ ⇧⌘V 원문→미리보기', 'Meta+Shift+V', 'a.md')
    judge('K3ⓐ 원문 편집기 포커스 ⇧⌘V → 미리보기', modeOf(ra.after, 'a.md') === 'preview' && ra.key?.defaultPrevented === true, { mode: modeOf(ra.after, 'a.md'), defaultPrevented: ra.key?.defaultPrevented })
    await until(async () => (await dump('a.md')).active?.inMarkdownView === 'a.md', { timeoutMs: 3_000, label: '미리보기 포커스' }).catch(() => null)
    const rb = await step('K3ⓑ ⇧⌘V 미리보기→원문(마우스 없이)', 'Meta+Shift+V', 'a.md')
    const focused = await until(async () => (await dump('a.md')).editorFocus === true, { timeoutMs: 3_000, label: '편집기 포커스 복귀' }).then(() => true, () => false)
    await typeK('Q')
    await sleep(300)
    const typed = await dump('a.md')
    judge('K3ⓑ 이어서 ⇧⌘V → 원문 · 편집기 포커스 복귀 · 바로 타이핑이 원문에', modeOf(rb.after, 'a.md') === 'source' && focused && typed.text?.includes('Q'), { mode: modeOf(rb.after, 'a.md'), focused, text: typed.text, selection: typed.selection })
    await shot('K3ⓑ 타이핑 뒤')
    await setup('a.md', MD_A, { sl: 3, sc: 1 })
  })
  await item('K3ⓒ', async () => {
    await pressK('Meta+Shift+V'); await sleep(400)
    await ctlClick(fileTabSel('k1.ts')); await editorReady('k1.ts')
    await ctlClick(fileTabSel('a.md')); await sleep(600)
    const d = await dump('a.md')
    judge('K3ⓒ 탭 전환 후 돌아와도 미리보기 유지', modeOf(d, 'a.md') === 'preview', { mode: modeOf(d, 'a.md') })
    await shot('K3ⓒ 복귀')
    await clickAt(cdp, '.file-group[data-file-view="a.md"]', { dy: 120 }); await sleep(200)
    await pressK('Meta+Shift+V'); await sleep(400)
    await editorReady('a.md')
  })
  await item('K3ⓓ 터미널', async () => {
    await ctlClick(`[data-main-tab="${terminalTab}"]`); await sleep(500)
    await clickAt(cdp, '[data-term-pane]'); await sleep(300)
    const r = await step('K3ⓓ 터미널 ⇧⌘V', 'Meta+Shift+V', 'a.md')
    await ctlClick(fileTabSel('a.md')); await sleep(600)
    const d = await dump('a.md')
    judge('K3ⓓ 터미널 포커스 ⇧⌘V → 삼키지 않음 · a.md 모드 불변(원문)', r.after.active?.inTerm === true && r.key?.defaultPrevented === false && modeOf(d, 'a.md') === 'source', { defaultPrevented: r.key?.defaultPrevented, active: r.after.active, mode: modeOf(d, 'a.md') })
  })
  await item('K3ⓓ .ts 탭', async () => {
    await ctlClick(fileTabSel('k1.ts')); await editorReady('k1.ts')
    await setup('k1.ts', T0, { sl: 1, sc: 1 })
    const r = await step('K3ⓓ .ts ⇧⌘V', 'Meta+Shift+V', 'k1.ts')
    judge('K3ⓓ .ts 파일 탭 편집기 ⇧⌘V → 삼키지 않음 · 텍스트 불변', r.key?.defaultPrevented === false && r.after.text === T0, { defaultPrevented: r.key?.defaultPrevented })
  })
  await item('K3ⓓ 팔레트 입력칸', async () => {
    await ctlClick(fileTabSel('a.md')); await editorReady('a.md')
    await setup('a.md', MD_A, { sl: 1, sc: 1 })
    await pressK('Meta+K'); await sleep(400)
    const r = await step('K3ⓓ 팔레트 입력칸 ⇧⌘V', 'Meta+Shift+V', 'a.md')
    await pressK('Escape'); await sleep(400)
    const d = await dump('a.md')
    judge('K3ⓓ 커맨드 팔레트 입력칸 ⇧⌘V → 삼키지 않음 · a.md 모드 불변', r.before.palette && r.key?.defaultPrevented === false && modeOf(d, 'a.md') === 'source', { palette: r.before.palette, target: r.key?.target, defaultPrevented: r.key?.defaultPrevented, mode: modeOf(d, 'a.md') })
  })
  // ⓕ 영역 둘 — a.md 를 새 영역(g2)으로, 원 영역(g1)에서 b.md 를 연다.
  let groupsReady = false
  await item('K3ⓕ 준비', async () => {
    await ctlClick(fileTabSel('a.md')); await editorReady('a.md')
    await ctlKey('D', ['meta', 'alt'])
    await until(async () => (await dump('a.md')).groups.length === 2, { timeoutMs: 5_000, label: '새 영역' })
    await sleep(600)
    const d0 = await dump('a.md')
    const other = d0.groups.find((g) => g.view !== 'a.md')
    await clickAt(cdp, `.tab-group[data-tab-group="${other.groupId}"] [data-main-tab="${terminalTab}"], .tab-group[data-tab-group="${other.groupId}"] [data-file-tab]`)
    await sleep(400)
    await openFile('b.md')
    await editorReady('b.md')
    const d = await dump('b.md')
    log('[기록] K3ⓕ 준비 — 영역', d.groups)
    groupsReady = d.groups.length === 2 && d.groups.some((g) => g.view === 'a.md') && d.groups.some((g) => g.view === 'b.md')
    judge('K3ⓕ 준비 — 영역 둘(a.md · b.md)', groupsReady, { groups: d.groups })
  })
  if (groupsReady) {
    await item('K3ⓕ 툴바 버튼', async () => {
      const d0 = await dump('a.md')
      const ga = d0.groups.find((g) => g.view === 'a.md')
      const gb = d0.groups.find((g) => g.view === 'b.md')
      // b.md 영역을 활성으로(본문 클릭) → a.md 영역이 비활성
      await clickAt(cdp, `.file-group[data-file-group="${gb.groupId}"] [data-file-editor]`, { dx: 200, dy: 60 }); await sleep(300)
      await clickAt(cdp, `.file-group[data-file-group="${ga.groupId}"] [data-markdown-toggle]`); await sleep(500)
      const afterButton = await dump('a.md')
      log('[기록] K3ⓕ 비활성 영역 a.md 툴바 버튼 클릭 뒤', { groups: afterButton.groups, active: afterButton.active })
      await shot('K3ⓕ 버튼 클릭 뒤')
      const r = await step('K3ⓕ 버튼 포커스 ⇧⌘V', 'Meta+Shift+V', 'a.md')
      const aBefore = modeOf(afterButton, 'a.md'); const aAfter = modeOf(r.after, 'a.md')
      const bBefore = modeOf(afterButton, 'b.md'); const bAfter = modeOf(r.after, 'b.md')
      const aGroupActive = r.after.groups.find((g) => g.view === 'a.md')?.active
      const focusIn = afterButton.active?.inMarkdownView
      const pass = focusIn === 'a.md' ? aBefore !== aAfter && bBefore === bAfter && aGroupActive === true && r.key?.defaultPrevented === true : r.key?.defaultPrevented === (focusIn !== null) && (focusIn === null ? aBefore === aAfter && bBefore === bAfter : true)
      judge('K3ⓕ 비활성 영역 툴바 버튼 클릭 직후 ⇧⌘V → 포커스 보기(a.md) 탭만 전환 · 그 영역 활성 · b.md 불변', pass, { focusIn, a: [aBefore, aAfter], b: [bBefore, bAfter], aGroupActive, defaultPrevented: r.key?.defaultPrevented })
    })
    await item('K3ⓕ 거터', async () => {
      const d0 = await dump('b.md')
      const ga = d0.groups.find((g) => g.view === 'a.md')
      const gb = d0.groups.find((g) => g.view === 'b.md')
      // a.md 영역이 활성인 상태에서 b.md 편집기 거터 클릭
      if (modeOf(d0, 'b.md') !== 'source') throw new Error('b.md 가 원문이 아님')
      await clickAt(cdp, `.file-group[data-file-group="${gb.groupId}"] .margin`, { dx: 10, dy: 30 }); await sleep(400)
      const afterGutter = await dump('b.md')
      log('[기록] K3ⓕ b.md 거터 클릭 뒤', { groups: afterGutter.groups, active: afterGutter.active, editorFocus: afterGutter.editorFocus })
      const r = await step('K3ⓕ 거터 ⇧⌘V', 'Meta+Shift+V', 'b.md')
      const aBefore = modeOf(afterGutter, 'a.md'); const aAfter = modeOf(r.after, 'a.md')
      const bBefore = modeOf(afterGutter, 'b.md'); const bAfter = modeOf(r.after, 'b.md')
      judge('K3ⓕ b.md 거터 클릭 직후 ⇧⌘V → b.md 만 전환 · a.md 불변 · 삼킴', afterGutter.active?.inMarkdownView === 'b.md' && bBefore !== bAfter && aBefore === aAfter && r.key?.defaultPrevented === true && r.after.groups.find((g) => g.view === 'b.md')?.active === true, { focus: afterGutter.active, a: [aBefore, aAfter], b: [bBefore, bAfter], defaultPrevented: r.key?.defaultPrevented, ga: ga.groupId, gb: gb.groupId })
      // b.md 를 원문으로 되돌린다
      await pressK('Meta+Shift+V'); await sleep(500)
    })
    await item('K3ⓖ 탭 막대 글자 클릭', async () => {
      const d0 = await dump('a.md')
      const ga = d0.groups.find((g) => g.view === 'a.md')
      const gb = d0.groups.find((g) => g.view === 'b.md')
      // b.md 영역의 터미널 탭으로 가서 터미널에 포커스 → a.md 탭 글자 클릭(포커스는 옮기지 않는다)
      await ctlClick(`.tab-group[data-tab-group="${gb.groupId}"] [data-main-tab="${terminalTab}"]`); await sleep(500)
      await clickAt(cdp, '[data-term-pane]'); await sleep(300)
      await clickAt(cdp, `.tab-group[data-tab-group="${ga.groupId}"] [data-file-tab="a.md"] .main-tab-title`); await sleep(400)
      const afterLabel = await dump('a.md')
      log('[기록] K3ⓖ 탭 글자 클릭 뒤', { groups: afterLabel.groups, active: afterLabel.active })
      const r = await step('K3ⓖ 탭 글자 클릭 뒤 ⇧⌘V', 'Meta+Shift+V', 'a.md')
      const outside = afterLabel.active?.inMarkdownView === null
      judge('K3ⓖ 탭 막대 .md 탭 글자 클릭 직후 ⇧⌘V → 포커스가 보기 밖이면 토글·삼킴 없음', outside && r.key?.defaultPrevented === false && modeOf(afterLabel, 'a.md') === modeOf(r.after, 'a.md'), { active: afterLabel.active, defaultPrevented: r.key?.defaultPrevented, mode: [modeOf(afterLabel, 'a.md'), modeOf(r.after, 'a.md')] })
    })
    await item('K3ⓗ 팔레트', async () => {
      const d0 = await dump('a.md')
      const ga = d0.groups.find((g) => g.view === 'a.md')
      // a.md 영역 활성(본문 클릭) → ⌘K → 항목 실행
      await clickAt(cdp, `.file-group[data-file-group="${ga.groupId}"] [data-file-editor]`, { dx: 200, dy: 60 }); await sleep(300)
      const before = await dump('a.md')
      await pressK('Meta+K'); await sleep(400)
      await until(() => js(`!!document.querySelector('[data-palette-entry="markdown.togglePreview:0"]')`), { timeoutMs: 3_000, label: '팔레트 항목' })
      await clickAt(cdp, '[data-palette-entry="markdown.togglePreview:0"]'); await sleep(300)
      const focused = await until(async () => (await dump('a.md')).active?.inMarkdownView === 'a.md', { timeoutMs: 3_000, label: '보기 포커스' }).then(() => true, () => false)
      const after = await dump('a.md')
      log('[걸음] K3ⓗ 팔레트 항목(활성 a.md)', { before: before.groups, after: after.groups, active: after.active })
      await shot('K3ⓗ 팔레트 실행 뒤')
      judge('K3ⓗ 팔레트 「Markdown 미리보기 전환」 → 활성 a.md 전환 + 그 보기에 포커스', modeOf(before, 'a.md') !== modeOf(after, 'a.md') && focused, { mode: [modeOf(before, 'a.md'), modeOf(after, 'a.md')], focused, active: after.active })
      // 터미널 활성에서 팔레트 → 무변화
      const gb = after.groups.find((g) => g.view !== 'a.md')
      await ctlClick(`.tab-group[data-tab-group="${gb.groupId}"] [data-main-tab="${terminalTab}"]`); await sleep(500)
      await clickAt(cdp, '[data-term-pane]'); await sleep(300)
      const t0 = await dump('a.md')
      await pressK('Meta+K'); await sleep(400)
      await clickAt(cdp, '[data-palette-entry="markdown.togglePreview:0"]'); await sleep(600)
      const t1 = await dump('a.md')
      log('[걸음] K3ⓗ 팔레트 항목(활성 = 터미널)', { before: t0.groups, after: t1.groups, palette: t1.palette })
      await shot('K3ⓗ 터미널 활성 팔레트 뒤')
      judge('K3ⓗ 활성 탭이 터미널이면 팔레트 항목 → 무변화', JSON.stringify(t0.groups.map((g) => g.markdownView)) === JSON.stringify(t1.groups.map((g) => g.markdownView)), { before: t0.groups, after: t1.groups })
      if (t1.palette) { await pressK('Escape'); await sleep(300) }
    })
  }
  await item('K3ⓔ 설정 행·재정의', async () => {
    await ctlClick('[data-settings-open]')
    await until(() => js(`!!document.querySelector('[data-settings-nav-item="shortcuts"]')`), { timeoutMs: 5_000, label: '설정' })
    await ctlClick('[data-settings-nav-item="shortcuts"]')
    await until(() => js(`!!document.querySelector('[data-shortcut-action="markdown.togglePreview"]')`), { timeoutMs: 5_000, label: '단축키 행' })
    const row = await js(`document.querySelector('[data-shortcut-action="markdown.togglePreview"]').innerText`)
    await js(`document.querySelector('[data-shortcut-action="markdown.togglePreview"]').scrollIntoView({ block: 'center' })`)
    await sleep(300)
    await shot('K3ⓔ 설정 단축키 행')
    log('[기록] K3ⓔ 설정 행', { row })
    // 재정의 저장(설정 화면과 같은 IPC) → 재기동 → ⌘⌥V 가 전환, ⇧⌘V 는 삼키지 않음
    const saved = await js(`window.corral.saveKeybindings({ 'markdown.togglePreview': ['Mod+Alt+V'] }).then((v) => v, (e) => ({ error: String(e) }))`)
    log('[기록] saveKeybindings', saved)
    down()
    await up()
    await until(() => js(`!!document.querySelector('[data-file-tab="a.md"]')`), { timeoutMs: 15_000, label: '재기동 뒤 a.md 탭' })
    await ctlClick(fileTabSel('a.md')); await sleep(600)
    const d = await dump('a.md')
    if (modeOf(d, 'a.md') === 'source') { await editorReady('a.md'); await setup('a.md', null, { sl: 1, sc: 1 }) } else await clickAt(cdp, '.file-group[data-file-view="a.md"]', { dy: 120 })
    await sleep(300)
    const r1 = await step('K3ⓔ 재정의 뒤 ⇧⌘V', 'Meta+Shift+V', 'a.md')
    const r2 = await step('K3ⓔ 재정의 뒤 ⌘⌥V', 'Meta+Alt+V', 'a.md')
    judge('K3ⓔ 설정 단축키 행이 보이고(⇧⌘V) 재정의(⌘⌥V)가 먹는다 · 옛 조합은 삼키지 않음', row.includes('Markdown 미리보기 전환') && r1.key?.defaultPrevented === false && modeOf(r1.before, 'a.md') === modeOf(r1.after, 'a.md') && modeOf(r2.before, 'a.md') !== modeOf(r2.after, 'a.md') && r2.key?.defaultPrevented === true, { row, r1: { dp: r1.key?.defaultPrevented, mode: [modeOf(r1.before, 'a.md'), modeOf(r1.after, 'a.md')] }, r2: { dp: r2.key?.defaultPrevented, mode: [modeOf(r2.before, 'a.md'), modeOf(r2.after, 'a.md')] } })
    await js(`window.corral.saveKeybindings({})`)
  })
}

// --- 네이티브(설치본, K5) — K1 ⓐⓑⓒⓕ + K3 ⓐⓑ --------------------------------------
async function native(terminalTab) {
  await k1(['a', 'b', 'c', 'f'])
  await openFile('a.md')
  await editorReady('a.md')
  await item('K5 K3ⓐ ⓑ', async () => {
    await setup('a.md', MD_A, { sl: 3, sc: 1 })
    const ra = await step('K5 K3ⓐ ⇧⌘V', 'Meta+Shift+V', 'a.md')
    judge('K5 K3ⓐ 원문 ⇧⌘V → 미리보기', modeOf(ra.after, 'a.md') === 'preview' && ra.key?.defaultPrevented === true, { mode: modeOf(ra.after, 'a.md') })
    await until(async () => (await dump('a.md')).active?.inMarkdownView === 'a.md', { timeoutMs: 3_000, label: '미리보기 포커스' }).catch(() => null)
    const rb = await step('K5 K3ⓑ ⇧⌘V', 'Meta+Shift+V', 'a.md')
    const focused = await until(async () => (await dump('a.md')).editorFocus === true, { timeoutMs: 3_000, label: '편집기 포커스' }).then(() => true, () => false)
    await typeK('Q'); await sleep(300)
    const typed = await dump('a.md')
    judge('K5 K3ⓑ ⇧⌘V → 원문 · 편집기 포커스 · 타이핑', modeOf(rb.after, 'a.md') === 'source' && focused && typed.text?.includes('Q'), { focused, text: typed.text })
  })
  void terminalTab
}

// --- 실행 ----------------------------------------------------------------------
const inputRawCount = () => {
  const file = path.join(root, 'ud/corral.ndjson')
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const raw = text.split('\n').filter((line) => line.includes('"input.raw"'))
  fs.writeFileSync(out.replace(/\.txt$/, '-input-raw.ndjson'), raw.join('\n') + '\n')
  const keyUps = raw.filter((line) => line.includes('"keyUp"')).length
  return { harnessKeys: sentKeys.length, inputRawKeyUp: keyUps, extraKeyUps: keyUps - sentKeys.length, inputRaw: text.split('\n').filter((line) => line.includes('"input.raw"')).length, windowFocus: text.split('\n').filter((line) => /window-focus|window\.focus/.test(line)).length }
}
let exitCode = 1
try {
  log('# LIFE-692 최종 관문', { suite, root, port, head: execFileSync('git', ['-C', APP, 'rev-parse', '--short', 'HEAD']).toString().trim(), exe: process.env.L692_EXE ?? null })
  const terminalTab = await boot()
  if (suite === 'base') await k1(['a', 'b', 'f'])
  else if (suite === 'native') await native(terminalTab)
  else {
    await k1(['a', 'b', 'c', 'd', 'e', 'f', 'fmd', 'g', 'h', 'i', 'j', 'k', 'l', 'm'])
    await k2(terminalTab)
    await k3(terminalTab)
  }
  exitCode = verdicts.some((v) => !v.pass) ? 1 : 0
} catch (error) {
  log('[예외]', String(error?.stack ?? error))
  await shot('fatal').catch(() => null)
} finally {
  try { down(true) } catch (error) { log('down 실패', String(error)) }
  log('[기록] 격리 corral.ndjson — 사용자 입력 혼입 지표(input.raw · window-focus 줄 수)', inputRawCount())
  const pass = verdicts.filter((v) => v.pass).length
  log(`# 요약 통과 ${pass} / ${verdicts.length}`, verdicts)
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
