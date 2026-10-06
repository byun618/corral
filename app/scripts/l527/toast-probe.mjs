// LIFE-527 K4 — 토스트를 두 앱에서 띄워 잰다(격리). Orca = 198 개발 인스턴스(/tmp/l443/orca-198, 버리는 HOME), corral = 격리 인스턴스.
/* global document, getComputedStyle, innerWidth, innerHeight */
//
// 띄우는 길:
//   (경로 ③ 닫기 건너뛰기 저장 실패도 corral 에서 일으킨다 — 아래 본문 주석)
//   Orca  — 앱이 쓰는 sonner 모듈(vite dev 가 내준 같은 URL)을 import 해 `toast(문구)` — 앱의 <Toaster> 가 그린다. Orca 에 토스트를
//           일으키는 무해한 UI 경로가 측정 fixture 에 없어서다(사유). 모양·위치·시간을 재는 것이지 경로를 재는 것이 아니다.
//   corral — **제품 경로**: ① 레포 추가 결과(사이드바 「+」 → 모달 「폴더 찾아보기」 실제 마우스, OS 대화상자는 제어 소켓 `browse-stub`)
//           ④ worktree 생성 결과(레포 행 「+」 → 브랜치 입력 → 「만들기」 실제 마우스).
// 잰다: 토스터(ol)·토스트(li)·제목·닫기 버튼 박스와 계산 스타일, 자동 사라짐 시간(나타남 → DOM 에서 빠짐, 100ms 간격),
//       여러 개 쌓임(3개 연달아 — li 박스·data-front·data-index·data-expanded), 닫기 버튼 실제 마우스 → 사라짐.
// 격리 가드: 504(같은 --work·herdr 세션 프로세스) · F18(~/.orca/keybindings.json 지문 전후). 띄운 pid 는 끝에 프로세스 그룹째 끈다.
// F18 은 성공·예외 경로 모두 finally 에서 잰다 — false 거나 못 쟀으면 exit 1(fix1 F3).
//
// 사용: node app/scripts/l527/toast-probe.mjs --out <폴더> [--work /tmp/l527w] [--keybindings-file <파일>]
//   --keybindings-file 은 음성 대조 전용(기본 ~/.orca/keybindings.json). 사용자 파일을 바꾸지 않고 F18 실패 전파를 본다.
//   --stop-after orca 면 Orca 측정 뒤 corral 을 띄우지 않고 정상으로 끝낸다 · orca-throw 면 그 자리에서 예외(예외 경로 대조).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchOrca, seedOrcaRepo } from '../gui-diff/lib/orca.mjs'
import { launchCorral, seedCorralRepo, rpc } from '../gui-diff/lib/corral.mjs'
import { ensureFixtureRepo } from '../gui-diff/lib/fixture.mjs'
import { setViewport, pause, until } from '../gui-diff/lib/cdp.mjs'
import { fileFingerprint, keybindingsLeakVerdict, probe504 } from '../gui-diff/lib/guards.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '../..')
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const outDir = path.resolve(arg('--out', ''))
const work = arg('--work', '/tmp/l527w')
if (!arg('--out', null)) { console.error('--out 필요'); process.exit(2) }
fs.mkdirSync(outDir, { recursive: true })
const write = (name, value) => fs.writeFileSync(path.join(outDir, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
const log = (...parts) => console.log('[l527 toast]', ...parts)

const guard = probe504({ work })
write('guard-504.json', guard)
if (!guard.pass) { log('504 가드 걸림 — 멈춘다', JSON.stringify(guard.hits)); process.exit(1) }
const keybindingsFile = arg('--keybindings-file', null) ?? path.join(process.env.HOME, '.orca/keybindings.json')
const stopAfter = arg('--stop-after', null)
const f18Before = fileFingerprint(keybindingsFile)

const owned = []
const own = (entry) => { if (entry.pid) owned.push(entry) }
let exitCode = 0
const STOP = Symbol('stop-after')
const result = { at: new Date().toISOString(), orca: null, corral: null, verdicts: {} }

/** 페이지 안 — 토스트 관측. */
function observeToastsPage() {
  const pick = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      box: { x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100, w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 },
      style: Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'borderTopLeftRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'boxShadow', 'gap', 'webkitAppRegion', 'transform', 'opacity'].map((p) => [p, cs[p]])),
      attrs: Object.fromEntries([...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])),
      text: (el.textContent ?? '').trim().slice(0, 120),
    }
  }
  const toaster = document.querySelector('[data-sonner-toaster]')
  const toasts = [...document.querySelectorAll('[data-sonner-toast]')]
  return {
    viewport: { w: innerWidth, h: innerHeight },
    toaster: pick(toaster),
    toasts: toasts.map((li) => ({ ...pick(li), title: pick(li.querySelector('[data-title]')), close: pick(li.querySelector('[data-close-button]')), closeIcon: pick(li.querySelector('[data-close-button] svg')) })),
  }
}
const observe = (handle) => handle.cdp.evaluate(observeToastsPage)

async function mouseClick({ handle, selector, index = 0 }) {
  const point = await handle.cdp.evaluate(({ selector, index }) => {
    const el = document.querySelectorAll(selector)[index]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, { selector, index })
  if (!point) throw new Error(`없음: ${selector}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await handle.cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
  }
  return point
}
const pointerAway = (handle) => handle.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 300, buttons: 0 })

/** 자동 사라짐 — 첫 토스트가 보인 때부터 DOM 에서 빠질 때까지(ms). */
async function measureLifetime({ handle, startedAt }) {
  const appearedAt = Date.now()
  await until(async () => (await handle.cdp.evaluate(() => document.querySelectorAll('[data-sonner-toast]').length)) === 0, '토스트 사라짐', 20_000, 100)
  return { fromTrigger: Date.now() - startedAt, fromSeen: Date.now() - appearedAt }
}

async function screenshot({ handle, name }) {
  const shot = await handle.cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 900, y: 650, width: 540, height: 250, scale: 1 } })
  fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, 'base64'))
}

async function probeApp({ name, handle, fire }) {
  const out = { name }
  await setViewport(handle.cdp, { width: 1440, height: 900 })
  await handle.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => null)
  await pointerAway(handle)
  // 1) 하나 — 모양·위치
  let started = Date.now()
  out.single = await fire(1)
  await until(async () => (await observe(handle)).toasts.length === 1, `${name} 토스트 1개`, 15_000, 50)
  await pause(800) // 들어오는 애니메이션이 끝난 뒤 잰다
  out.singleObserved = await observe(handle)
  await screenshot({ handle, name: `${name}-toast-single.png` })
  out.lifetime = await measureLifetime({ handle, startedAt: started })
  // 2) 셋 연달아 — 쌓임
  await pause(500)
  started = Date.now()
  out.stack = await fire(3)
  await until(async () => (await observe(handle)).toasts.length === 3, `${name} 토스트 3개`, 20_000, 50)
  await pause(800)
  out.stackObserved = await observe(handle)
  await screenshot({ handle, name: `${name}-toast-stack.png` })
  // 3) 닫기 버튼(맨 앞 토스트) 실제 마우스 — 쌓인 것은 hover 로 펼쳐진 뒤 닫기가 보인다
  const front = await handle.cdp.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]')].findIndex((li) => li.getAttribute('data-front') === 'true'))
  await mouseClick({ handle, selector: '[data-sonner-toast] [data-close-button]', index: Math.max(0, front) })
  await pause(700)
  out.afterClose = await observe(handle)
  await pointerAway(handle)
  await until(async () => (await observe(handle)).toasts.length === 0, `${name} 남은 토스트 사라짐`, 20_000, 100).catch(() => null)
  return out
}

try {
  // 매 회차 새 격리 프로필(측정 도구 `--fresh` 와 같다) — 504 가드가 그 경로를 쓰는 프로세스 0 을 확인한 뒤다.
  for (const name of ['orca-dev-userdata', 'corral-userdata', 'corral-herdr']) fs.rmSync(path.join(work, name), { recursive: true, force: true })
  const fixture = ensureFixtureRepo(work)
  log('Orca 개발 인스턴스 기동…')
  const orca = await launchOrca({ repoRoot: '/tmp/l443/orca-198', workDir: work, port: 9444, logPath: path.join(outDir, 'orca-dev.log'), onSpawn: own })
  await seedOrcaRepo(orca, fixture.root)
  // 앱이 쓰는 sonner 모듈 — vite dev 가 내준 URL 그대로(같은 모듈 인스턴스여야 앱의 <Toaster> 가 그린다).
  const sonnerUrl = await orca.cdp.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => /\/node_modules\/\.vite\/deps\/sonner\.js/.test(name)) ?? null)
  if (!sonnerUrl) throw new Error('Orca 의 sonner 모듈 URL 을 못 찾았다')
  result.orcaSonnerUrl = sonnerUrl
  result.orca = await probeApp({
    name: 'orca',
    handle: orca,
    fire: async (count) => orca.cdp.evaluate(async ({ url, count }) => {
      const mod = await import(url)
      for (let i = 0; i < count; i += 1) mod.toast(`L527 toast probe ${i + 1}`)
      return { fired: count }
    }, { url: sonnerUrl, count }),
  })
  if (stopAfter === 'orca') throw STOP
  if (stopAfter === 'orca-throw') throw new Error('--stop-after orca-throw — 예외 경로 음성 대조')
  log('corral 격리 인스턴스 기동…')
  const corral = await launchCorral({ appRoot, workDir: work, port: 9445, logDir: outDir, onSpawn: own })
  await seedCorralRepo(corral, fixture.root)
  // 경로 ① 레포 추가 결과 — 같은 레포를 다시 고른다(「이미 등록」 결과 문구). 모달은 결과가 있으면 닫힌다(App.browse).
  const addRepoPath = async () => {
    await rpc(corral.control, { cmd: 'browse-stub', path: fixture.root })
    await mouseClick({ handle: corral, selector: '[data-add-repo]' })
    await until(() => corral.cdp.evaluate(() => document.querySelector('[data-browse-folder]') !== null), '레포 추가 모달', 5_000, 50)
    await mouseClick({ handle: corral, selector: '[data-browse-folder]' })
    await until(() => corral.cdp.evaluate(() => document.querySelector('[data-add-repo-modal]') === null), '모달 닫힘', 10_000, 50)
    await pointerAway(corral)
  }
  result.corral = await probeApp({
    name: 'corral',
    handle: corral,
    fire: async (count) => {
      for (let i = 0; i < count; i += 1) await addRepoPath()
      return { fired: count, path: '① 레포 추가 결과(사이드바 + → 폴더 찾아보기, browse-stub)' }
    },
  })
  // 경로 ④ worktree 생성 결과 — 레포 행 hover(액션 묶음은 hover 때만 눌린다) → 「+」 → 브랜치 → 만들기
  const head = await corral.cdp.evaluate(() => { const r = document.querySelector('[data-repo-head]').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })
  await corral.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: head.x, y: head.y, buttons: 0 })
  await pause(300)
  await mouseClick({ handle: corral, selector: '[data-create-worktree]' })
  await until(() => corral.cdp.evaluate(() => document.querySelector('[data-worktree-branch-input]') !== null), 'worktree 모달', 5_000, 50)
  await mouseClick({ handle: corral, selector: '[data-worktree-branch-input]' })
  await corral.cdp.send('Input.insertText', { text: `l527-toast-${Date.now()}` })
  await mouseClick({ handle: corral, selector: '[data-worktree-create-submit]' })
  await until(async () => (await observe(corral)).toasts.length >= 1, 'worktree 생성 토스트', 30_000, 100)
  await pause(800)
  result.corralWorktreePath = await observe(corral)
  await screenshot({ handle: corral, name: 'corral-toast-worktree.png' })
  // 경로 ③ 닫기 건너뛰기 저장 실패 — 터미널에서 sleep 을 돌리는 탭을 ⌘W(제어 소켓 키 = sendInputEvent, main before-input-event 경로) →
  // 확인 대화상자 「다시 묻지 않기」 체크 + 확인(실제 마우스). 그 순간 **격리** userData 폴더를 쓰기 금지로 둬서 설정 저장이 실패하게 한다.
  // 사용자 userData 가 아니다(work 아래 corral-userdata). 끝나면 권한을 되돌린다.
  const userData = path.join(work, 'corral-userdata')
  result.corralClosePath = { userData }
  try {
    await mouseClick({ handle: corral, selector: '[data-term-pane-box]' })
    await pause(400)
    await rpc(corral.control, { cmd: 'type', text: 'sleep 600\r' })
    await pause(2500)
    await rpc(corral.control, { cmd: 'key', keyCode: 'W', modifiers: ['meta'] })
    await until(() => corral.cdp.evaluate(() => document.querySelector('[data-confirm-close-modal]') !== null), '닫기 확인 대화상자', 10_000, 100)
    fs.chmodSync(userData, 0o500)
    result.corralClosePath.chmod = '0500'
    await mouseClick({ handle: corral, selector: '[data-dont-ask-again-input]' })
    await pause(200)
    await mouseClick({ handle: corral, selector: '[data-close-confirm-ok]' })
    await until(async () => (await observe(corral)).toasts.some((toast) => toast.text.includes('설정을 저장하지 못해')), '닫기 건너뛰기 실패 토스트', 15_000, 100)
    result.corralClosePath.observed = await observe(corral)
    await screenshot({ handle: corral, name: 'corral-toast-close-skip-failed.png' })
  } finally {
    fs.chmodSync(userData, 0o700)
    result.corralClosePath.restored = (fs.statSync(userData).mode & 0o777).toString(8)
  }
} catch (error) {
  if (error === STOP) {
    result.stoppedAfter = stopAfter
  } else {
    exitCode = 1
    result.error = String(error?.stack ?? error)
    log('실패:', result.error)
  }
} finally {
  // 띄운 것만 끈다 — 프로세스 그룹(Orca dev 런너)·pid. 남은 것은 호출자가 ps 로 확인한다.
  for (const entry of owned.reverse()) {
    try { process.kill(entry.group ? -entry.pid : entry.pid, 'SIGTERM') } catch { /* 이미 없다 */ }
  }
  await pause(2000)
  result.owned = owned
  // F18 — 성공·예외 경로 모두. 지문을 못 쟀거나(예외) 바뀌었으면 실패로 끝낸다.
  try {
    result.verdicts.f18 = keybindingsLeakVerdict({ before: f18Before, after: fileFingerprint(keybindingsFile) })
  } catch (error) {
    result.verdicts.f18 = { pass: false, why: `F18 수집 실패 ${String(error)}` }
  }
  if (result.verdicts.f18.pass !== true) { exitCode = 1; log('F18 실패:', result.verdicts.f18.why) }
  write('toast-probe.json', result)
  log(exitCode === 0 ? '끝' : '실패로 끝', outDir)
  process.exit(exitCode)
}
