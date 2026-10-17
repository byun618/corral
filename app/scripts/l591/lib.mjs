// LIFE-591 사본(l590 → l591 루트만 바꿈)
// LIFE-590 측정 공용(l589/lib.mjs 사본, 루트만 /tmp/l591g-*) — 격리 개발 Electron(`l577/g-up.sh` 가 /tmp/l591g-* 에 띄운 것)에 붙는다. 설치본·사용자 herdr 무접촉.
// - 앱: 제어 소켓 `<ROOT>/ctl/ctl.sock` (l577 `g-lib.mjs` 의 ctl 재사용)
// - herdr: g-up 이 띄운 이름 세션 `l577g-l589g-*` 의 소켓만 — 그 밖의 세션 이름이면 거부한다
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ctl, evalJs, sleep, until } from '../l577/g-lib.mjs'

export { ctl, evalJs, sleep, until }

export function checkRoot(root) {
  if (!/^\/tmp\/l591g-[^/]+$/.test(root ?? '')) throw new Error(`ROOT 는 /tmp/l591g-* 여야 한다: ${root}`)
}

export function herdrSession(root) {
  return `l577g-${path.basename(root).replace(/^l577g-/, '')}`
}

export function herdr(root, method, params = {}, timeoutMs = 10_000) {
  const session = herdrSession(root)
  if (!session.startsWith('l577g-l591g-')) throw new Error(`거부: 격리 세션이 아니다 (${session})`)
  const socketPath = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l591', method, params }) + '\n'))
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
 * 빌드 산출물의 monaco 청크를 렌더러에서 동적 import 해 `window.l591Monaco` 로 둔다(앱은 Monaco 를 `window` 에 내놓지 않는다 — 시험 전용, 제품 무변경).
 * 부르는 곳은 app/ 이 cwd 여야 한다(out/renderer/assets 를 읽는다).
 */
export async function exposeMonaco(root) {
  const chunk = fs.readdirSync(path.join(process.cwd(), 'out/renderer/assets')).find((file) => /^monaco-.*\.js$/.test(file))
  return evalJs(root, `(async () => { window.l591Monaco = (await import('./assets/${chunk}')).monaco; return true })()`)
}

/**
 * 파일 뷰 `rel` 의 편집기 상태(수정 r3 E1ⓔ 오라클) — 모델 글·scrollTop·view state(첫 위치·커서). 탭 왕복 판정은 「첫 화면 줄」 이 아니라 이것이 떠나기 전과 같은지로 본다
 * (첫 화면 줄은 떠나기 전부터 스크롤이 있던 회차를 실패로 셌다 — 리뷰어 r3 판별: 36/36 모델·스크롤 보존).
 */
export function editorState(root, rel) {
  return evalJs(
    root,
    `(() => { const host = document.querySelector('[data-file-view="${rel}"] [data-file-editor]'); const e = window.l591Monaco.editor.getEditors().find((x) => host !== null && host.contains(x.getContainerDomNode())); if (e === undefined) return null; const v = e.saveViewState(); return { model: e.getModel()?.getValue() ?? null, scrollTop: e.getScrollTop(), view: v === null ? null : { first: v.viewState.firstPosition, delta: v.viewState.firstPositionDeltaTop, cursor: v.cursorState.map((c) => c.position) } } })()`,
  )
}
