// LIFE-593 최종 관문 E9ⓑ 무회귀 합성용 사본 — LIFE-592 scripts/l592/ 그대로, 루트만 /tmp/l593g-*(G5) · 앞 앱 돌려주기 L593_RETURN_APP. 제품 판정 줄은 592 원본과 같다.
// LIFE-592 사본(l591 → l592 루트만 바꿈)
// LIFE-590 측정 공용(l589/lib.mjs 사본, 루트만 /tmp/l593g-*) — 격리 개발 Electron(`l577/g-up.sh` 가 /tmp/l593g-* 에 띄운 것)에 붙는다. 설치본·사용자 herdr 무접촉.
// - 앱: 제어 소켓 `<ROOT>/ctl/ctl.sock` (l577 `g-lib.mjs` 의 ctl 재사용)
// - herdr: g-up 이 띄운 이름 세션 `l577g-l589g-*` 의 소켓만 — 그 밖의 세션 이름이면 거부한다
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ctl, evalJs, sleep, until } from '../../l577/g-lib.mjs'

export { ctl, evalJs, sleep, until }

export function checkRoot(root) {
  if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '')) throw new Error(`ROOT 는 /tmp/l593g-* 여야 한다: ${root}`)
}

export function herdrSession(root) {
  return `l577g-${path.basename(root).replace(/^l577g-/, '')}`
}

export function herdr(root, method, params = {}, timeoutMs = 10_000) {
  const session = herdrSession(root)
  if (!session.startsWith('l577g-l593g-')) throw new Error(`거부: 격리 세션이 아니다 (${session})`)
  const socketPath = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l592', method, params }) + '\n'))
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

const safeReal = (p) => { try { return fs.realpathSync(p) } catch { return p } }

/** 레포 경로를 등록하고 그 레포에 pane 하나. `repo` 가 없으면 ROOT 아래 fixture 레포를 만든다. */
export async function repoPane(root, { repo = path.join(root, 'repo') } = {}) {
  if (!fs.existsSync(repo)) {
    fs.mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['-C', repo, '-c', 'user.name=l590', '-c', 'user.email=l590@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
  }
  const added = await ctl(root, { cmd: 'add-repo', root: repo })
  if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
  const real = fs.realpathSync(repo)
  const existing = ((await herdr(root, 'pane.list')).panes ?? []).some((item) => typeof item.cwd === 'string' && safeReal(item.cwd) === real)
  if (!existing) await herdr(root, 'workspace.create', { cwd: repo, focus: false })
  const pane = await until(async () => {
    const panes = (await herdr(root, 'pane.list')).panes ?? []
    return panes.find((item) => typeof item.cwd === 'string' && safeReal(item.cwd) === real)?.pane_id ?? null
  }, { timeoutMs: 15_000, label: '레포 pane' })
  return { repo, paneId: pane.value }
}

export function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

/**
 * close-quit.mjs E3ⓖ 판별식(수정 r1 R1-K) — 다시 연 탭이 수정 아님 **이고** 첫 화면 줄이 디스크 원본 첫 줄과 **같다**.
 * 옛 판별식(`!String(first).startsWith('Q')`)은 null·빈 문자열·틀린 내용도 통과시켰다(리뷰어 oracle-check.mjs). `expectedFirst` 는 원본 첫 줄(공백은 화면 줄처럼 nbsp→space).
 */
export function reopenedMatches(reopened, expectedFirst) {
  return reopened !== null && typeof reopened === 'object' && reopened.tab === 'false' && typeof reopened.first === 'string' && reopened.first.length > 0 && reopened.first === expectedFirst
}

/**
 * 빌드 산출물의 monaco 청크를 렌더러에서 동적 import 해 `window.l592Monaco` 로 둔다(앱은 Monaco 를 `window` 에 내놓지 않는다 — 시험 전용, 제품 무변경).
 * 부르는 곳은 app/ 이 cwd 여야 한다(out/renderer/assets 를 읽는다).
 */
export async function exposeMonaco(root) {
  const chunk = fs.readdirSync(path.join(process.cwd(), 'out/renderer/assets')).find((file) => /^monaco-.*\.js$/.test(file))
  return evalJs(root, `(async () => { window.l592Monaco = (await import('./assets/${chunk}')).monaco; return true })()`)
}

/**
 * 파일 뷰 `rel` 의 편집기 상태(수정 r3 E1ⓔ 오라클) — 모델 글·scrollTop·view state(첫 위치·커서). 탭 왕복 판정은 「첫 화면 줄」 이 아니라 이것이 떠나기 전과 같은지로 본다
 * (첫 화면 줄은 떠나기 전부터 스크롤이 있던 회차를 실패로 셌다 — 리뷰어 r3 판별: 36/36 모델·스크롤 보존).
 */
export function editorState(root, rel) {
  return evalJs(
    root,
    `(() => { const host = document.querySelector('[data-file-view="${rel}"] [data-file-editor]'); const e = window.l592Monaco.editor.getEditors().find((x) => host !== null && host.contains(x.getContainerDomNode())); if (e === undefined) return null; const v = e.saveViewState(); return { model: e.getModel()?.getValue() ?? null, scrollTop: e.getScrollTop(), view: v === null ? null : { first: v.viewState.firstPosition, delta: v.viewState.firstPositionDeltaTop, cursor: v.cursorState.map((c) => c.position) } } })()`,
  )
}

/**
 * LIFE-592 수정 r1 R1-I — 화면 표지 판별식의 **제품 실제 표지**(한 곳). 회차 스크립트의 「0」 판별은 이것만 쓰고, 양성 대조(`r1-ui-probe.mjs`)가 표지가 떠 있을 때 검출함을 보인다.
 *   「삭제됨」 = 탭 `.main-tab.is-deleted`(MainTabBar) · 본문 띠 `[data-file-notice="deleted"]`(FileView)
 *   외부 변경 배너 = `[data-file-notice="external-change"]`(FileView `ExternalBanner`, class `file-view-conflict`)
 */
export const DELETED_SELECTOR = '.main-tab.is-deleted, [data-file-notice="deleted"]'
export const BANNER_SELECTOR = '[data-file-notice="external-change"], .file-view-conflict'
/** 20 ms 간격 표본 — 「삭제됨」·배너가 한 번이라도 보였나. */
export const startNoticeSampler = (root) =>
  evalJs(root, `(() => { window.__l592seen = []; clearInterval(window.__l592timer); window.__l592timer = setInterval(() => { const d = document.querySelector(${JSON.stringify(DELETED_SELECTOR)}); const b = document.querySelector(${JSON.stringify(BANNER_SELECTOR)}); if (d || b) window.__l592seen.push({ at: Date.now(), deleted: !!d, banner: !!b, tab: d?.getAttribute('data-file-tab') ?? null }) }, 20); return true })()`)
export const stopNoticeSampler = (root) => evalJs(root, `(() => { clearInterval(window.__l592timer); return window.__l592seen })()`)

/**
 * 격리 창을 앞에 두지 않는다(R7 — 사용자 실제 키 입력이 격리 창으로 새던 N27·N29). L592_RETURN_APP = 회차 시작 때 앞에 있던 앱의 bundle id.
 * 앱이 뜰 때·오른쪽 클릭(제품 `corral:activateWindow`) 뒤 그 앱을 다시 앞으로(`open -b`) — 입력은 sendInputEvent·CDP 라 창 포커스와 무관. 기록을 돌려준다.
 */
export const giveBackLog = { returnApp: process.env.L592_RETURN_APP ?? '', fronts: [] }
const frontApp = () => { try { return execFileSync('sh', ['-c', 'lsappinfo info -only bundleid "$(lsappinfo front)"'], { encoding: 'utf8' }).trim().replace(/^"CFBundleIdentifier"=/, '').replaceAll('"', '') } catch { return null } }
export async function giveBack() {
  const target = giveBackLog.returnApp
  if (target === '') return
  const before = frontApp()
  let error = null
  try { execFileSync('open', ['-b', target], { encoding: 'utf8', stdio: 'pipe' }) } catch (e) { error = String(e.stderr ?? e.message).slice(0, 200) }
  let after = frontApp()
  for (let i = 0; i < 20 && after !== target; i += 1) {
    await sleep(100)
    after = frontApp()
  }
  giveBackLog.fronts.push({ before, after, error })
}
