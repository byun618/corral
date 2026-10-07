// LIFE-490 K8 — 네이티브 관문 본 회차(N1 → N2). `native-up.sh` 뒤, `native-down.sh` 앞에 한 번 돈다. 서버 시작(provider 재개)은 이 안에서 **한 번**.
//
// N1: 사용자 userData + 구현 브랜치 빌드로 앱 기동(`native-app.sh`) → 485 확인 카드(재개 claude 1·grok 2) → 「서버 시작」 실제 클릭
//     (코디 위임 승인 `--allow-session-restore` — 재개 pane 에 입력하지 않는다) → fixture 레포를 **앱 UI 로 등록**(`[data-add-repo]` →
//     「폴더 찾아보기」, OS 대화는 제어 채널 `browse-stub` 이 고른 것으로 친다) → detached 카드 2개의 제목·배지·툴팁 DOM 덤프 + 창 캡처.
// N2: 안 연 fixture 링크 워크트리 행을 실제로 클릭 → 5초 안에 활성·5초 유지(K1ⓒ 세 축: 선택 표식 · 탭바 탭 · React activeWorkspaceId).
//     출발 상태: initial(앱이 고른 활성 = 사용자 재개 workspace, fixture 열린 것 0) · ③ fixture main 활성 · ② fixture 다른 링크 활성.
//     ① 「열린 workspace 0」 은 만들 수 없다 — 사용자 재개 workspace 를 닫아야 하는데 그것은 무접촉 대상이다(G7). initial 이 fixture 쪽 부모 없음 경로를 대신 덮는다.
// 누르는 것은 fixture(`<ROOT>/fx/l490fx`) 행뿐이다. 서버·앱은 끄지 않는다 — native-down.sh 가 멈추고 원복한다(server.pid 를 여기서 적는다).
// 사용: node native-run.mjs --root <ROOT=/tmp/l490n*> --app <app 디렉터리> --raw <raw 폴더>
// 종료코드: 0 = 모든 check 통과, 1 = 하나라도 실패(원자료는 남긴다), 2 = 진행 불가.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]]] : pairs), []))
const ROOT = String(args.root)
const APP = path.resolve(String(args.app))
const RAWD = path.resolve(String(args.raw))
if (!/^\/tmp\/l490n[^/]*$/.test(ROOT)) throw new Error(`--root 는 /tmp/l490n*: ${ROOT}`)
fs.mkdirSync(RAWD, { recursive: true })
const HERE = path.dirname(new URL(import.meta.url).pathname)
const HERDR = '/opt/homebrew/bin/herdr'
const sock = path.join(ROOT, 'ctl.sock')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const out = { checks: [], steps: {} }
const check = (name, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  out.checks.push({ name, pass, actual, expected })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} (실측 ${JSON.stringify(actual)}${pass ? '' : ` / 기대 ${JSON.stringify(expected)}`})`)
  return pass
}
const ctl = (request, timeout = 30_000) => rpc(sock, request, timeout)
const state = async () => (await ctl({ cmd: 'state' })).state
const evalJs = async (code) => (await ctl({ cmd: 'eval', code })).result
const until = async (fn, label, timeoutMs = 30_000, stepMs = 200) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null)
    if (value) return value
    await pause(stepMs)
  }
  throw new Error(`timeout: ${label}`)
}
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8' }).trim()
const commit = (cwd, message) => git(cwd, '-c', 'user.email=l490@example.invalid', '-c', 'user.name=l490', 'commit', '-q', '--allow-empty', '-m', message)
const dservers = () => execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => /^\s*\d+ \/opt\/homebrew\/bin\/herdr( --session default)? server$/.test(line)).map((line) => line.trim().split(' ')[0])
/** 캡처는 **선택자 영역만** — 사용자 재개 세션의 터미널 내용·실제 레포 카드를 원자료에 담지 않는다(카드·fixture 레포 묶음). */
const shot = async (name, selector) => {
  const reply = await ctl({ cmd: 'shot', name, selector })
  if (reply.file && fs.existsSync(reply.file)) fs.copyFileSync(reply.file, path.join(RAWD, path.basename(reply.file)))
  return reply.file ? path.basename(reply.file) : null
}

/** 렌더러에서 읽는 세 축 — 선택 표식 경로 · React activeWorkspaceId(Sidebar props, fiber) · 탭바 탭 id. */
const TRIPLE = `(() => {
  const mark = document.querySelector('[data-worktree-card-active="primary"]')?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null
  let active = { found: false }
  const el = document.querySelector('[data-worktree]')
  const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  let f = key ? el[key] : null
  while (f) { const p = f.memoizedProps; if (p && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, 'activeWorkspaceId')) { active = { found: true, id: p.activeWorkspaceId }; break } f = f.return }
  const tabs = [...document.querySelectorAll('[data-main-tab]')].map((t) => t.getAttribute('data-main-tab'))
  return { mark, active, tabs }
})()`
const readMark = () => evalJs(`document.querySelector('[data-worktree-card-active="primary"]')?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null`)
const rowOf = (st, p) => st.repos.flatMap((repo) => repo.worktrees).find((row) => row.path === p) ?? null
const agree = ({ triple, st, p }) => {
  const ws = rowOf(st, p)?.workspace ?? null
  const ids = new Set((ws?.tabs ?? []).map((tab) => tab.tabId))
  return {
    markOk: triple.mark === p,
    activeOk: triple.active.found === true && ws !== null && triple.active.id === ws.workspaceId,
    tabsOk: ws !== null && triple.tabs.length > 0 && triple.tabs.every((id) => ids.has(id)),
    workspaceId: ws?.workspaceId ?? null,
  }
}
const clickTitle = async (p) => {
  await evalJs(`document.querySelector(${JSON.stringify(`[data-worktree="${p}"] [data-worktree-branch]`)})?.scrollIntoView({ block: 'center' })`)
  await pause(150)
  return ctl({ cmd: 'click', selector: `[data-worktree="${p}"] [data-worktree-branch]` })
}
const judge = async (p, t0) => {
  let reachedAt = null
  while (Date.now() - t0 < 5000) {
    if ((await readMark()) === p) {
      reachedAt = Date.now() - t0
      break
    }
    await pause(100)
  }
  if (reachedAt === null) return { reachedAt, held: false }
  const start = Date.now()
  const seen = new Set()
  while (Date.now() - start < 5000) {
    const mark = await readMark()
    seen.add(mark)
    if (mark !== p) return { reachedAt, held: false, leftTo: mark }
    await pause(100)
  }
  return { reachedAt, held: true }
}

async function main() {
  // fixture — ROOT 아래 실제 git. 링크 브랜치 워크트리 nb-0(②의 기준)·nb-1..nb-3(N2 대상, 안 엶) + detached 2개(서로 다른 커밋).
  const fxBase = path.join(ROOT, 'fx')
  const fx = path.join(fxBase, 'l490fx')
  fs.mkdirSync(fx, { recursive: true })
  git(fx, 'init', '-q', '-b', 'main')
  commit(fx, 'c1')
  const c1 = git(fx, 'rev-parse', 'HEAD')
  commit(fx, 'c2')
  const c2 = git(fx, 'rev-parse', 'HEAD')
  commit(fx, 'c3')
  for (const name of ['nb-0', 'nb-1', 'nb-2', 'nb-3']) git(fx, 'worktree', 'add', '-q', '-b', name, path.join(fxBase, 'wt', name))
  git(fx, 'worktree', 'add', '-q', '--detach', path.join(fxBase, 'wt', 'det-a'), c1)
  git(fx, 'worktree', 'add', '-q', '--detach', path.join(fxBase, 'wt', 'det-b'), c2)
  const fxReal = fs.realpathSync(fx)
  const wt = (name) => fs.realpathSync(path.join(fxBase, 'wt', name))
  out.fixture = { root: fxReal, detached: { [wt('det-a')]: git(wt('det-a'), 'rev-parse', 'HEAD'), [wt('det-b')]: git(wt('det-b'), 'rev-parse', 'HEAD') } }

  // ── N1 ──
  const s0 = execFileSync('shasum', ['-a', '256', path.join(process.env.HOME, '.config/herdr/session.json')], { encoding: 'utf8' }).split(' ')[0]
  const up = spawnSync('sh', [path.join(HERE, 'native-app.sh'), ROOT, APP, RAWD, 'n1'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(RAWD, 'n1-app.txt'), `${up.stdout}\n${up.stderr}`)
  if (up.status !== 0) throw new Error(`native-app.sh → ${up.status}`)
  await until(async () => (await state()).backend.kind === 'confirm', 'confirm card', 30_000)
  const card = await state()
  out.steps.n1Card = { backend: card.backend, link: card.link.phase }
  out.steps.n1Shots = [await shot('n1-confirm', '[data-backend-card]')]
  check('N1 카드', `${card.backend.kind}/${card.backend.reason ?? ''}`, 'confirm/stopped')
  check('N1 재개 계수', card.backend.restore, { known: true, total: 3, agents: [{ kind: 'claude', count: 1 }, { kind: 'grok', count: 2 }] })
  check('N1 session.json 해시(클릭 전 불변)', execFileSync('shasum', ['-a', '256', path.join(process.env.HOME, '.config/herdr/session.json')], { encoding: 'utf8' }).split(' ')[0], s0)
  check('N1 설치 default server(클릭 전)', dservers().length, 0)

  // 「서버 시작」 — 코디 위임 승인(--allow-session-restore). 재개 pane 에 입력하지 않는다.
  const start = await ctl({ cmd: 'click', selector: '[data-backend-start]' })
  out.steps.startClick = { ok: start.ok, at: start.at }
  await until(async () => (await state()).link.phase === 'live', 'link live', 60_000)
  await pause(2000)
  const servers = dservers()
  fs.writeFileSync(path.join(ROOT, 'server.pid'), `${servers.join('\n')}\n`)
  check('N1 서버 시작 뒤 link', (await state()).link.phase, 'live')
  check('N1 설치 default server 수', servers.length, 1)
  await pause(6000)
  const agents = spawnSync('sh', [path.join(HERE, 'agent-status.sh')], { encoding: 'utf8' })
  fs.writeFileSync(path.join(RAWD, 'n1-agent-status.json'), agents.stdout)
  const restored = spawnSync(process.execPath, [path.join(HERE, 'restored-agents.mjs'), servers[0] ?? '0', RAWD], { encoding: 'utf8' })
  out.steps.restored = restored.stdout.trim()

  // fixture 등록 — 앱 UI(「프로젝트 추가」 → 「폴더 찾아보기」). OS 대화는 browse-stub 이 고른 것으로 친다.
  const before = (await state()).repos.map((repo) => repo.root)
  out.steps.reposBefore = before.length
  await ctl({ cmd: 'browse-stub', path: fxReal })
  check('N1 프로젝트 추가 클릭', (await ctl({ cmd: 'click', selector: '[data-add-repo]' })).ok, true)
  await until(() => evalJs(`document.querySelector('[data-browse-folder]') !== null`), 'add repo modal', 10_000)
  check('N1 폴더 찾아보기 클릭', (await ctl({ cmd: 'click', selector: '[data-browse-folder]' })).ok, true)
  await until(async () => ((await state()).repos.find((repo) => repo.root === fxReal)?.worktrees.length ?? 0) >= 7, 'fixture registered', 30_000)
  await ctl({ cmd: 'browse-stub' })
  await pause(1500)
  const st1 = await state()
  const fxRepo = st1.repos.find((repo) => repo.root === fxReal)
  out.steps.fixtureRows = fxRepo.worktrees.map((row) => ({ path: row.path, branch: row.branch, head: row.head, repoName: row.repoName, open: row.openWorkspaceId !== null }))
  check('N1 등록 뒤 레포 수', st1.repos.length, before.length + 1)

  // detached 카드 2개 — 제목·배지·툴팁 DOM 덤프 + 창 캡처.
  for (const name of ['det-a', 'det-b']) {
    const p = wt(name)
    const dump = await evalJs(`(() => { const row = document.querySelector(${JSON.stringify(`[data-worktree="${p}"]`)}); if (!row) return null; row.scrollIntoView({ block: 'center' }); const b = row.querySelector('[data-worktree-detached-head]'); return { title: row.querySelector('[data-worktree-title]')?.textContent ?? null, meta: row.querySelector('[data-worktree-card-meta-row]')?.textContent ?? null, badge: b ? { shortHead: b.getAttribute('data-worktree-detached-head'), text: b.textContent, title: b.getAttribute('title') } : null, branchCell: row.querySelector('[data-worktree-meta-branch]')?.textContent ?? null, hasDetachedText: row.outerHTML.includes('(detached)') } })()`)
    out.steps[`n1-${name}`] = dump
    const head = out.fixture.detached[p]
    check(`N1 ${name} 제목 = 레포 이름`, dump?.title, fxRepo.name)
    check(`N1 ${name} 배지`, dump?.badge?.text, `Detached HEAD @ ${head.slice(0, 7)}`)
    check(`N1 ${name} 툴팁`, dump?.badge?.title, `Detached HEAD at ${head.slice(0, 7)}. You are viewing a commit, not a branch.`)
    check(`N1 ${name} state head`, rowOf(st1, p)?.head, head)
    check(`N1 ${name} state branch`, rowOf(st1, p)?.branch, null)
    check(`N1 ${name} (detached) 없음`, dump?.hasDetachedText, false)
  }
  out.steps.n1Shots.push(await shot('n1-detached', `[data-repo="${fxReal}"]`))

  // ── N2 ──
  const trials = []
  const trial = async ({ start, target, setup }) => {
    const setupInfo = await setup()
    const st = await state()
    const before = JSON.parse(JSON.stringify(await evalJs(TRIPLE)))
    const t0 = Date.now()
    const click = await clickTitle(target)
    const verdict = await judge(target, t0)
    const after = await state()
    const triple = await evalJs(TRIPLE)
    const a = agree({ triple, st: after, p: target })
    const row = { start, target, setup: setupInfo, before: { mark: before.mark, active: before.active.id ?? null }, fixtureOpenBefore: st.repos.find((repo) => repo.root === fxReal)?.worktrees.filter((w) => w.openWorkspaceId !== null).map((w) => w.path) ?? [], click: { ok: click.ok }, ...verdict, triple: { ...a, mark: triple.mark, active: triple.active.id ?? null, tabs: triple.tabs } }
    row.pass = click.ok === true && verdict.reachedAt !== null && verdict.held && a.markOk && a.activeOk && a.tabsOk
    trials.push(row)
    console.log(JSON.stringify({ start, target: path.basename(target), before: row.before.mark, reachedAt: row.reachedAt, held: row.held, pass: row.pass }))
    check(`N2 ${start} → ${path.basename(target)}`, row.pass, true)
    await pause(800)
  }
  const ensureOpen = async (p) => {
    if (rowOf(await state(), p)?.openWorkspaceId) return
    await clickTitle(p)
    await until(async () => (rowOf(await state(), p)?.openWorkspaceId ? true : null), `open ${p}`, 20_000)
    await pause(1500)
  }
  const activate = async (p) => {
    await ensureOpen(p)
    await clickTitle(p)
    await until(async () => ((await readMark()) === p ? true : null), `active ${p}`, 10_000).catch(() => null)
    await pause(800)
    return { expected: p, mark: await readMark() }
  }
  // initial — 서버 시작 뒤 앱이 고른 활성(사용자 재개 workspace), fixture 열린 것 0.
  await trial({ start: 'initial', target: wt('nb-1'), setup: async () => ({ note: '앱이 승격한 활성 그대로 — fixture 열린 것 0' }) })
  await trial({ start: 'main', target: wt('nb-2'), setup: () => activate(fxReal) })
  await trial({ start: 'other', target: wt('nb-3'), setup: () => activate(wt('nb-0')) })
  out.steps.n2 = trials
  out.steps.n2Shots = [await shot('n2-after', `[data-repo="${fxReal}"]`)]
  const final = await state()
  out.steps.fixtureOpenAfter = final.repos.find((repo) => repo.root === fxReal)?.worktrees.filter((w) => w.openWorkspaceId !== null).map((w) => w.path)
  out.steps.otherReposOpenUnchanged = final.repos.filter((repo) => repo.root !== fxReal).map((repo) => ({ root: '<redacted>', open: repo.worktrees.filter((w) => w.openWorkspaceId !== null).length }))
}

let code = 0
try {
  await main()
  code = out.checks.every((item) => item.pass) ? 0 : 1
} catch (error) {
  out.error = String(error?.stack ?? error)
  console.log(`ERROR ${out.error}`)
  code = 2
} finally {
  fs.writeFileSync(path.join(RAWD, 'native-run.json'), JSON.stringify(out, null, 2))
  console.log(`checks ${out.checks.filter((item) => item.pass).length}/${out.checks.length} → exit ${code}`)
  process.exit(code)
}
