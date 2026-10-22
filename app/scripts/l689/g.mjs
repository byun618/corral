// LIFE-689 최종 관문 g1 — K5 격리 GUI 회차(S1·S2·S3 · K5ⓐ–ⓓ). l691/g.mjs 의 기동·입력·덤프 방식을 줄여 옮겼다.
//
// 격리: l689/up.sh(= l691/up.sh 사본) — userData·제어 소켓·ui-prefs·레지스트리 전부 ROOT(/tmp/l689g-*) 아래, herdr 는 레포 guard 바이너리의 이름 세션 `l689g-<꼬리>`.
//   설치본·사용자 userData·사용자 herdr·실제 LA 무접촉. 앱은 빌드 산출물 사본(l689/fixture-app.sh — 창 showInactive)으로 띄운다.
// 입력: 제어 소켓(click·dblclick·key = webContents.sendInputEvent) — OS 키 입력 없음.
// 관측: 장면마다 캡처 PNG + DOM 덤프(탭별 라벨·설명 텍스트 · clientWidth/scrollWidth · computed font-style/text-decoration-line/flex/margin).
// 판정: 항목마다 통과/미달. 기대값과 다르거나 타임아웃·예외면 미달 → exit 1.
// 사용(app/ 에서): node scripts/l689/g.mjs --root /tmp/l689g-<x> --out <raw txt>
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const root = args.root
if (!/^\/tmp\/l689g-[a-z0-9-]+$/.test(root ?? '')) throw new Error(`--root 는 /tmp/l689g-*: ${root}`)
const out = path.resolve(args.out)
const shotDir = out.replace(/\.txt$/, '-shots')
const dumpDir = out.replace(/\.txt$/, '-dumps')
const log = recorder(out)
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
}
const repo = path.join(root, 'repo')
const session = `l689g-${path.basename(root).replace(/^l689g-/, '')}`
const herdrSock = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
const appDir = `${root}-app`

const LONG_A = 'src/averyveryverylongfoldernamethatkeepsgoingandgoing'
const LONG_B = 'src/anotherextremelylongfoldernamethatkeepsgoingandgoing'
const LONG_NAME = 'averyveryverylongfilenamethatwillnotfitinthetabwidth.service.ts'
const FILES = [
  'src/app/app.service.ts', 'src/push/app.service.ts', 'src/main.ts',
  'README.md', 'docs/README.md',
  `${LONG_A}/x.ts`, `${LONG_B}/x.ts`,
  `${LONG_A}/${LONG_NAME}`, `${LONG_B}/${LONG_NAME}`,
  'lib/util.ts', 'src/util.ts',
]

// --- 바깥 도구 -----------------------------------------------------------------
const sh = (argv, env = {}) => {
  const run = spawnSync('sh', argv, { cwd: APP, encoding: 'utf8', env: { ...process.env, ...env } })
  log(`$ sh ${argv.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(os.homedir(), '~'))
  if (run.status !== 0) throw new Error(`${argv[0]} 실패`)
}
function herdr(method, params = {}, timeoutMs = 10_000) {
  if (!session.startsWith('l689g-')) throw new Error(`거부: 격리 세션이 아니다 (${session})`)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(herdrSock)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l689', method, params }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.destroy()
      const message = JSON.parse(buffer.slice(0, index))
      if (message.error) reject(new Error(`${method}: ${message.error.code} ${message.error.message}`))
      else resolve(message.result)
    })
  })
}
const js = (code) => evalJs(root, code)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
async function click(selector, cmd = 'click') {
  let last = null
  await until(async () => { last = await ctl(root, { cmd, selector }); return last.ok }, { timeoutMs: 10_000, everyMs: 250, label: `${cmd} ${selector}` }).catch(() => null)
  if (!last?.ok) throw new Error(`${cmd} 실패 ${selector} ${JSON.stringify(last)}`)
}
async function shot(name) {
  const result = await ctl(root, { cmd: 'shot', name }).catch((error) => ({ error: String(error) }))
  if (!result.file) throw new Error(`shot 실패 ${JSON.stringify(result)}`)
  fs.mkdirSync(shotDir, { recursive: true })
  const target = path.join(shotDir, `${name}.png`)
  fs.copyFileSync(result.file, target)
  log('shot', { file: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size })
}

// --- 덤프 ----------------------------------------------------------------------
const DUMP_JS = `(() => {
  const box = (el) => {
    if (el === null) return null
    const style = getComputedStyle(el)
    return { text: el.textContent, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, fontStyle: style.fontStyle, textDecorationLine: style.textDecorationLine, flex: style.getPropertyValue('flex'), margin: style.margin, fontSize: style.fontSize, opacity: style.opacity }
  }
  const groups = [...document.querySelectorAll('.tab-group[data-tab-group]')].map((g) => ({
    groupId: g.dataset.tabGroup,
    tabs: [...g.querySelectorAll('[data-main-tab]')].map((t) => ({
      tabId: t.dataset.mainTab,
      file: t.dataset.fileTab ?? null,
      cls: t.className.split(/\\s+/).filter(Boolean),
      tabWidth: t.getBoundingClientRect().width,
      label: box(t.querySelector('.main-tab-label')),
      desc: box(t.querySelector('.main-tab-file-desc')),
    })),
  }))
  return { windowWidth: window.innerWidth, tabW: getComputedStyle(document.documentElement).getPropertyValue('--tab-w').trim(), groups }
})()`
async function dump(label) {
  const dom = await js(DUMP_JS)
  fs.mkdirSync(dumpDir, { recursive: true })
  fs.writeFileSync(path.join(dumpDir, `${label}.json`), JSON.stringify(dom, null, 2) + '\n')
  log(`[덤프] ${label}`, { windowWidth: dom.windowWidth, tabW: dom.tabW, groups: dom.groups.map((g) => ({ groupId: g.groupId, tabs: g.tabs.map((t) => [t.file ?? t.tabId, t.label?.text ?? null, t.desc?.text ?? null]) })) })
  await shot(label)
  return dom
}
const fileTabs = (dom) => dom.groups.flatMap((g) => g.tabs.filter((t) => t.file !== null).map((t) => ({ ...t, groupId: g.groupId })))
const tabOf = (dom, rel) => {
  const tab = fileTabs(dom).find((t) => t.file === rel)
  if (tab === undefined) throw new Error(`덤프에 파일 탭 없음 ${rel}`)
  return tab
}
const descOf = (dom, rel) => tabOf(dom, rel).desc?.text ?? null

// --- 준비 ----------------------------------------------------------------------
function makeRepo(dir, files) {
  for (const rel of files) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), `// ${rel}\n`)
  }
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=l689', '-c', 'user.email=l689@example.invalid', 'commit', '-q', '-m', 'fixture'])
}
async function boot() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  makeRepo(repo, FILES)
  sh(['scripts/l689/fixture-app.sh', APP, appDir])
  log(`[포커스] 격리 창 기동 시작 ${new Date().toISOString()}`)
  sh(['scripts/l689/up.sh', root, 'L689_EXTRA_ARGS=--disable-backgrounding-occluded-windows'], { L689_APP_DIR: appDir })
  await until(() => js(`!!document.querySelector('[data-sidebar]')`), { timeoutMs: 30_000, label: '렌더러(사이드바)' })
  // 1280px 미만 — `--tab-w` 180px (styles.css ≥1280px 220px)
  log('resize', await ctl(root, { cmd: 'resize-window', width: 1200, height: 800 }))
  const added = await ctl(root, { cmd: 'add-repo', root: repo })
  if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
  log('workspace.create', await herdr('workspace.create', { cwd: repo, focus: false }))
  await until(() => js(`document.querySelectorAll('[data-main-tab]').length >= 1`), { timeoutMs: 30_000, label: '첫 탭' })
  await sleep(1000)
}
async function expandTo(rel) {
  const panelOpen = async () => (await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { timeoutMs: 5_000, label: '탐색기' })
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    const sel = `[data-explorer-row="${dir}"]`
    await until(() => js(`!!document.querySelector('${sel}')`), { timeoutMs: 10_000, label: `탐색기 폴더 ${dir}` })
    if ((await js(`document.querySelector('${sel}').getAttribute('aria-expanded')`)) !== 'true') await click(sel)
    await until(async () => (await js(`document.querySelector('${sel}').getAttribute('aria-expanded')`)) === 'true', { timeoutMs: 5_000, label: `펼침 ${dir}` })
  }
  await until(() => js(`!!document.querySelector('[data-explorer-row="${rel}"]')`), { timeoutMs: 10_000, label: `탐색기 행 ${rel}` })
}
/** 고정으로 연다(더블클릭). `preview: true` 면 단일 클릭(미리보기). */
async function openFile(rel, { preview = false } = {}) {
  await expandTo(rel)
  await click(`[data-explorer-row="${rel}"]`, preview ? 'click' : 'dblclick')
  await until(() => js(`document.querySelector('[data-file-tab="${rel}"]')?.dataset.active === 'true'`), { timeoutMs: 8_000, label: `파일 탭 ${rel}` })
  if (preview) await until(() => js(`document.querySelector('[data-file-tab="${rel}"]')?.dataset.tabPreview === 'true'`), { timeoutMs: 5_000, label: `미리보기 ${rel}` })
  await sleep(300)
}
async function closeFile(rel) {
  // 닫기 단추는 탭 hover 전엔 히트테스트에 안 잡힌다(g1-k5-1 하네스 미달) — 탭 위로 마우스를 먼저 옮긴다(sendInputEvent mouseMove).
  const at = await js(`(() => { const r = document.querySelector('[data-file-tab="${rel}"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`)
  if (at === null) throw new Error(`탭 없음 ${rel}`)
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: at.x, y: at.y })
  await sleep(200)
  await click(`[data-main-tab-close="file:${rel}"]`)
  await until(() => js(`document.querySelector('[data-file-tab="${rel}"]') === null`), { timeoutMs: 10_000, label: `닫힘 ${rel}` })
  await sleep(300)
}
const allFileRels = async () => js(`[...document.querySelectorAll('[data-file-tab]')].map((t) => t.dataset.fileTab)`)
async function closeAllFiles() {
  for (const rel of await allFileRels()) await closeFile(rel)
}

// --- 장면 ----------------------------------------------------------------------
async function run() {
  await boot()

  // S1 한 영역에 같은 이름 둘 + 다른 이름 하나
  await openFile('src/app/app.service.ts')
  await openFile('src/push/app.service.ts')
  await openFile('src/main.ts')
  const s1 = await dump('S1-one-area')
  judge('창 폭 < 1280 · --tab-w 180px', s1.windowWidth < 1280 && s1.tabW === '180px', { windowWidth: s1.windowWidth, tabW: s1.tabW })
  judge('S1 같은 이름 둘 → …/app · …/push, main.ts 설명 없음', s1.groups.length === 1 && descOf(s1, 'src/app/app.service.ts') === '…/app' && descOf(s1, 'src/push/app.service.ts') === '…/push' && descOf(s1, 'src/main.ts') === null, {})

  // K5ⓒ 터미널 탭 · 설명 없는 파일 탭 · 설명 있는 파일 탭의 .main-tab-label computed flex·margin
  const terminal = s1.groups.flatMap((g) => g.tabs).find((t) => t.file === null)
  const plain = tabOf(s1, 'src/main.ts')
  const described = tabOf(s1, 'src/app/app.service.ts')
  const row = (what, tab) => ({ what, flex: tab?.label?.flex ?? null, margin: tab?.label?.margin ?? null })
  const rows = [row('터미널 탭', terminal), row('설명 없는 파일 탭', plain), row('설명 있는 파일 탭', described)]
  for (const r of rows) log(`[K5ⓒ] ${r.what} .main-tab-label flex=${r.flex} margin=${r.margin}`)
  judge('K5ⓒ 터미널·설명 없는 파일 탭 라벨 = 기존 값(flex 1 1 auto · margin 0 4px 0 0), 설명 있는 탭 = flex 0 1 auto · margin 0',
    terminal !== undefined && rows[0].flex === '1 1 auto' && rows[0].margin === '0px 4px 0px 0px' && rows[1].flex === rows[0].flex && rows[1].margin === rows[0].margin && rows[2].flex === '0 1 auto' && rows[2].margin === '0px', rows)

  // S2 그중 하나(src/push)를 다른 영역으로 — ⌘⌥D(오른쪽 새 영역으로)
  await click('[data-file-tab="src/push/app.service.ts"]')
  await until(() => js(`document.querySelector('[data-file-tab="src/push/app.service.ts"]')?.dataset.active === 'true'`), { timeoutMs: 5_000, label: '활성 src/push' })
  await key('D', ['meta', 'alt'])
  await until(async () => (await js(`document.querySelectorAll('.tab-group[data-tab-group]').length`)) === 2, { timeoutMs: 5_000, label: '새 영역' })
  await sleep(500)
  const s2 = await dump('S2-split-areas')
  const appTab = tabOf(s2, 'src/app/app.service.ts')
  const pushTab = tabOf(s2, 'src/push/app.service.ts')
  judge('S2 다른 영역으로 옮김 → 두 영역 모두 설명 없음', s2.groups.length === 2 && appTab.groupId !== pushTab.groupId && fileTabs(s2).every((t) => t.desc === null), { app: appTab.groupId, push: pushTab.groupId })
  await closeAllFiles()
  await until(async () => (await js(`document.querySelectorAll('.tab-group[data-tab-group]').length`)) === 1, { timeoutMs: 5_000, label: '영역 하나로' })

  // S3 루트 README.md · docs/README.md
  await openFile('README.md')
  await openFile('docs/README.md')
  const s3 = await dump('S3-root-readme')
  judge('S3 README.md → ./ · docs/README.md → docs', descOf(s3, 'README.md') === './' && descOf(s3, 'docs/README.md') === 'docs', {})
  await closeAllFiles()

  // K5ⓐ 짧은 파일명 · 긴 설명
  await openFile(`${LONG_A}/x.ts`)
  await openFile(`${LONG_B}/x.ts`)
  const a = await dump('K5a-short-name-long-desc')
  const aTabs = [tabOf(a, `${LONG_A}/x.ts`), tabOf(a, `${LONG_B}/x.ts`)]
  judge('K5ⓐ 파일명 clientWidth >= scrollWidth · 설명 clientWidth < scrollWidth', aTabs.every((t) => t.label.clientWidth >= t.label.scrollWidth && t.desc !== null && t.desc.clientWidth < t.desc.scrollWidth),
    aTabs.map((t) => ({ file: t.file, tabWidth: t.tabWidth, label: [t.label.clientWidth, t.label.scrollWidth], desc: t.desc && [t.desc.text, t.desc.clientWidth, t.desc.scrollWidth] })))
  await closeAllFiles()

  // K5ⓑ 파일명 · 설명 둘 다 김
  await openFile(`${LONG_A}/${LONG_NAME}`)
  await openFile(`${LONG_B}/${LONG_NAME}`)
  const b = await dump('K5b-long-name-long-desc')
  const bTabs = [tabOf(b, `${LONG_A}/${LONG_NAME}`), tabOf(b, `${LONG_B}/${LONG_NAME}`)]
  judge('K5ⓑ 설명 clientWidth ≈ 0(≤ 1) · 파일명 clientWidth < scrollWidth', bTabs.every((t) => t.desc !== null && t.desc.clientWidth <= 1 && t.label.clientWidth < t.label.scrollWidth),
    bTabs.map((t) => ({ file: t.file, tabWidth: t.tabWidth, label: [t.label.clientWidth, t.label.scrollWidth], desc: t.desc && [t.desc.text, t.desc.clientWidth, t.desc.scrollWidth] })))
  await closeAllFiles()

  // K5ⓓ 미리보기(단일 클릭) · 삭제된 파일(외부에서 지움) — 파일명·설명 둘 다 이탤릭/취소선
  await openFile('lib/util.ts')
  await openFile('src/util.ts', { preview: true })
  fs.rmSync(path.join(repo, 'lib/util.ts'))
  log('외부 삭제', { file: 'lib/util.ts', at: new Date().toISOString() })
  await until(() => js(`document.querySelector('[data-file-tab="lib/util.ts"]')?.classList.contains('is-deleted') === true`), { timeoutMs: 15_000, label: '삭제 표시 lib/util.ts' })
  await sleep(300)
  const d = await dump('K5d-preview-deleted')
  const previewTab = tabOf(d, 'src/util.ts')
  const deletedTab = tabOf(d, 'lib/util.ts')
  judge('K5ⓓ 미리보기 탭 파일명·설명 이탤릭', previewTab.cls.includes('is-preview') && previewTab.label.fontStyle === 'italic' && previewTab.desc?.fontStyle === 'italic',
    { cls: previewTab.cls, label: previewTab.label.fontStyle, desc: previewTab.desc && [previewTab.desc.text, previewTab.desc.fontStyle] })
  judge('K5ⓓ 삭제 탭 파일명·설명 취소선', deletedTab.cls.includes('is-deleted') && deletedTab.label.textDecorationLine === 'line-through' && deletedTab.desc?.textDecorationLine === 'line-through',
    { cls: deletedTab.cls, label: deletedTab.label.textDecorationLine, desc: deletedTab.desc && [deletedTab.desc.text, deletedTab.desc.textDecorationLine] })
}

// --- 실행 ----------------------------------------------------------------------
let exitCode = 1
const head = execFileSync('git', ['-C', APP, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const porcelain = execFileSync('git', ['-C', APP, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean).length
log(`# ${path.basename(out)} ${new Date().toISOString()} ROOT=${root} app=${APP} HEAD ${head} porcelain ${porcelain}줄`)
try {
  await run()
  const failed = verdicts.filter((v) => !v.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 && verdicts.length > 0 ? 0 : 1
} catch (error) {
  log('오류(미달로 센다)', String(error?.stack ?? error).replaceAll(os.homedir(), '~'))
  try { await dump('error-state') } catch (e) { log('오류 덤프 실패', String(e)) }
} finally {
  try { sh(['scripts/l689/down.sh', root, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`[포커스] 격리 창 종료 ${new Date().toISOString()}`)
  const left = spawnSync('sh', ['-c', `pgrep -f -- '${root}' || true`], { encoding: 'utf8' }).stdout.trim()
  log(`잔존 프로세스(ROOT 경로 포함): [${left.split('\n').filter(Boolean).join(' ')}]`)
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
