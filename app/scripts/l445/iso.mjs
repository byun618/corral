// LIFE-445 격리 실행 — 외부 git worktree 추가·삭제가 사이드바에 반영되는가 (01-criteria K1~K7).
//
// 사용: node app/scripts/l445/iso.mjs --mode <모드> --out <raw 폴더> [--herdr on|off] [--rounds 5] [--idle 120] [--port 9445]
// 모드:
//   repro    — before 버그 재현: 외부 삭제 뒤 15초 동안 항목이 남는가(남으면 재현)
//   baseline — K4ⓐⓑ: 기동 안정 뒤 변화 없는 --idle 초 동안 tree.built · git 프로세스(shim) · herdr 요청(req.conn.open) 수
//   timing   — K1ⓐⓑⓒ · K2ⓐⓑⓒ (herdr on 이면 K7: K1ⓐ·K2ⓐ + 겹침 회차) — 회차별 반영 시간
//   feedback — K4ⓒ: 외부 변경 1건 → 재빌드 수, 그 뒤 60초 tree.built 0 · K4ⓓ: 레포 추가·제거 3회 왕복의 감시 루트 수
//   prunable — K3: rm -rf 한 worktree 가 재빌드 결과·runtime CLI 목록에서 같이 빠지는가 (--poll off 면 새로고침으로)
//   refresh  — K5: 자동 경로를 끈(CORRAL_WORKTREE_POLL_MS=0) 인스턴스에서 새로고침 버튼 · 연타 10회
//   cascade  — K6: 핀 · 수동 순서 · Parent · (herdr on) 열려 있고 선택된 worktree 의 외부 삭제
// 결과: <out>/<mode>[-herdr].json — 종료코드 0 = 그 모드의 통과선 전부 충족(before 모드는 기록용으로 항상 0, 판정은 result 에).
// 창 포커스 아님: 미끼 창(l471 decoy)을 앞에 두고 회차마다 `window-visibility read` 와 맨 앞 앱 pid 를 기록한다.

/* global document, CSS */
import fs from 'node:fs'
import path from 'node:path'
import { buildIdentity } from '../l478/build-identity.mjs'
import { Work, Corral, Decoy, frontPid, waitReflect, pause, git, load, yesCount, makeLogger, rpc } from './lib.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]?.startsWith('--') ? true : (all[index + 1] ?? true)]] : pairs), []),
)
const mode = String(args.mode)
const herdrOn = args.herdr === 'on'
const rounds = Number(args.rounds ?? 5)
const idleSec = Number(args.idle ?? 120)
const out = path.resolve(String(args.out))
fs.mkdirSync(out, { recursive: true })
const tag = `${mode}${herdrOn ? '-herdr' : ''}${args.poll === 'off' ? '-polloff' : ''}${args.label ? `-${args.label}` : ''}`
const log = makeLogger()
const LIMIT_MS = 5000
const result = { mode, herdr: herdrOn, tag, build: buildIdentity(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')), startedAt: new Date().toISOString(), env: { load: load(), yes: yesCount() }, checks: [], rounds: [], notes: [] }
function check(id, criterion, pass, observed) {
  result.checks.push({ id, criterion, pass: pass === true, observed })
  log(pass ? 'PASS' : 'FAIL', id, criterion, JSON.stringify(observed).slice(0, 300))
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const pollOff = args.poll === 'off' || mode === 'refresh'
const work = new Work(`${mode}${herdrOn ? '-h' : ''}${pollOff ? '-p0' : ''}`)
const corral = new Corral(work, { herdr: herdrOn, port: Number(args.port ?? 9445), log, extraEnv: pollOff ? { CORRAL_WORKTREE_POLL_MS: '0' } : {} })
const decoy = new Decoy(work)

/** 등록 레포 전부의 git 진실 = 기대 DOM 집합. */
function truth(roots) {
  return roots.flatMap((root) => work.gitSet(root)).sort()
}
async function focusSample() {
  const vis = await corral.focused().catch((error) => ({ error: String(error) }))
  return { corralFocused: vis.focused ?? null, frontPid: frontPid(), decoyPid: decoy.pid, corralPid: corral.desktopPid }
}
async function ensureUnfocused() {
  let sample = await focusSample()
  if (sample.corralFocused !== false || sample.frontPid !== decoy.pid) {
    decoy.front()
    await pause(500)
    sample = await focusSample()
  }
  return sample
}
/** 준비 단계의 외부 변경도 반영을 기다린다(회차 밖 — 기록만). */
async function settleTo(roots, label) {
  const expected = truth(roots)
  const seen = await waitReflect(corral, (set) => same(set, expected), { from: Date.now(), timeoutMs: 20_000 })
  if (seen.ms === null) result.notes.push({ label, prepNotReflected: true, expected, got: seen.set })
  await pause(1200)
  return seen
}

/** 한 회차 — op() 가 외부 git 을 돌리고 마지막 명령의 종료 시각을 돌려준다. */
async function measure(id, roots, op, extra = {}) {
  const focus = await ensureUnfocused()
  const before = await corral.domSet()
  const builtBefore = corral.count('tree.built', 0)
  const { endedAt, firstEndedAt, detail } = await op()
  const expected = truth(roots)
  const seen = await waitReflect(corral, (set) => same(set, expected), { from: endedAt, timeoutMs: 15_000 })
  const focusAfter = await focusSample()
  const row = {
    id,
    ms: seen.ms,
    msFromFirstCommand: seen.at === null || firstEndedAt === undefined ? null : seen.at - firstEndedAt,
    pass: seen.ms !== null && seen.ms <= LIMIT_MS && focus.corralFocused === false && focusAfter.corralFocused === false,
    polls: seen.polls,
    maxPollGapMs: seen.maxGapMs,
    focusBefore: focus,
    focusAfter,
    before,
    expected,
    got: seen.set,
    treeBuilt: corral.count('tree.built', 0) - builtBefore,
    load: load(),
    detail,
    ...extra,
  }
  result.rounds.push(row)
  log(row.pass ? 'ok  ' : 'MISS', id, `${row.ms}ms`, `built+${row.treeBuilt}`)
  return row
}

function finish(code) {
  result.endedAt = new Date().toISOString()
  result.envEnd = { load: load(), yes: yesCount() }
  result.spawned = corral.spawned.concat([{ pid: decoy.pid, label: 'decoy' }])
  result.gitCalls = work.gitCalls().length
  fs.writeFileSync(path.join(out, `${tag}.json`), JSON.stringify(result, null, 2) + '\n')
  // 원 로그 사본(분석용) — 경로는 /tmp/l445w 아래 격리 값뿐이다.
  fs.copyFileSync(corral.logFile, path.join(out, `${tag}.corral.ndjson`))
  fs.writeFileSync(path.join(out, `${tag}.git-calls.log`), work.gitCalls().join('\n') + '\n')
  log('result', path.join(out, `${tag}.json`), 'exit', code)
  process.exitCode = code
}

async function main() {
  // --- fixture: A(keep 하나 + 회차용), B(다른 레포 — 그대로여야 한다), C(linked 0 ↔ 1 왕복용) ---
  const A = work.makeRepo('alpha', ['keep'])
  const B = work.makeRepo('bravo', ['other'])
  const C = work.makeRepo('charlie', [])
  const roots = [A, B, C]
  corral.seedRegistry(roots)
  if (mode === 'cascade') seedCascade(A)
  await corral.launch()
  await decoy.start()
  await settleTo(roots, 'launch')
  result.launch = { focus: await focusSample() }

  switch (mode) {
    case 'repro':
      return repro(A, roots)
    case 'baseline':
      return baseline(roots)
    case 'timing':
      return herdrOn ? timingHerdr(A, roots) : timing(A, C, roots)
    case 'feedback':
      return feedback(A, roots)
    case 'prunable':
      return prunable(A, roots)
    case 'refresh':
      return refresh(A, roots)
    case 'cascade':
      return cascade(A, roots)
    default:
      throw new Error(`mode ${mode}`)
  }
}

async function repro(A, roots) {
  const victim = work.addWorktree(A, 'victim')
  await pause(3000)
  // before 코드에서는 외부 추가도 안 보일 수 있다 — 기록하고, 삭제 재현을 위해 앱이 알게 rebuild 한 번(기존 트리거: control rebuild-tree).
  result.addVisibleWithoutTrigger = (await corral.domSet()).includes(victim.path)
  await rpc(corral.control, { cmd: 'rebuild-tree' }, 30_000)
  await pause(1500)
  result.visibleBeforeRemove = (await corral.domSet()).includes(victim.path)
  const focus = await ensureUnfocused()
  work.removeWorktree(A, victim.path)
  const ended = work.deleteBranch(A, 'victim').endedAt
  const samples = []
  while (Date.now() - ended < 15_000) {
    samples.push({ t: Date.now() - ended, present: (await corral.domSet()).includes(victim.path) })
    await pause(250)
  }
  const cliList = corral.cli(A, 'worktree', 'list')
  const cliPaths = (cliList.result?.worktrees ?? cliList.result ?? []).map?.((row) => row.path) ?? cliList
  result.repro = { focus, samples: samples.filter((_, i) => i % 4 === 0), stillPresentAfter15s: samples.at(-1)?.present, cliPaths, gitSet: work.gitSet(A) }
  check('repro', '외부 삭제 15초 뒤 사이드바 잔존(버그 재현)', samples.at(-1)?.present === true, result.repro.stillPresentAfter15s)
  return 0
}

async function baseline(roots) {
  await pause(15_000) // 기동 안정
  await ensureUnfocused()
  const from = Date.now()
  const gitFrom = work.gitCalls().length
  const loadFrom = load()
  log(`idle ${idleSec}s`)
  await pause(idleSec * 1000)
  const to = Date.now()
  const gitCalls = work.gitCalls().slice(gitFrom)
  const b = {
    windowMs: to - from,
    repos: roots.length,
    treeBuilt: corral.count('tree.built', from, to),
    herdrRequests: corral.count('req.conn.open', from, to),
    herdrRequestsByMethod: corral.logLines().filter((e) => e.tag === 'req.conn.open' && e.at >= from && e.at < to).reduce((acc, e) => ({ ...acc, [e.method]: (acc[e.method] ?? 0) + 1 }), {}),
    gitProcesses: gitCalls.length,
    gitBySubcommand: gitCalls.reduce((acc, line) => {
      const sub = line.split(' ').slice(1).filter((w) => !w.startsWith('-') && !w.startsWith('/'))[0] ?? '?'
      return { ...acc, [sub]: (acc[sub] ?? 0) + 1 }
    }, {}),
    loadFrom,
    loadTo: load(),
    focusEnd: await focusSample(),
  }
  b.gitPerRepoPerMinute = b.gitProcesses / b.repos / (b.windowMs / 60_000)
  result.baseline = b
  check('K4a', `변화 없는 ${idleSec}초 tree.built 0회`, b.treeBuilt === 0, b.treeBuilt)
  check('K4b-git', 'git 프로세스 레포당 분당 2회 이하', b.gitPerRepoPerMinute <= 2, b.gitPerRepoPerMinute)
  return 0
}

async function timing(A, C, roots) {
  // K1ⓐ remove + branch -D (A 에 keep 이 있는 상태)
  for (let i = 1; i <= rounds; i += 1) {
    const v = work.addWorktree(A, `k1a-${i}`)
    await settleTo(roots, `k1a-${i} prep`)
    await measure(`K1a-${i}`, roots, async () => {
      const first = work.removeWorktree(A, v.path).endedAt
      return { firstEndedAt: first, endedAt: work.deleteBranch(A, `k1a-${i}`).endedAt }
    })
  }
  // K1ⓑ task-finish 순서: remove --force ×2 → prune → branch -D ×2
  for (let i = 1; i <= rounds; i += 1) {
    const w1 = work.addWorktree(A, `k1b-${i}`)
    const w2 = work.addWorktree(A, `k1b-${i}-claude`)
    fs.writeFileSync(path.join(w2.path, 'dirty.txt'), 'uncommitted\n') // --force 가 필요한 상태
    await settleTo(roots, `k1b-${i} prep`)
    await measure(`K1b-${i}`, roots, async () => {
      const first = work.removeWorktree(A, w1.path, { force: true }).endedAt
      work.removeWorktree(A, w2.path, { force: true })
      git(A, 'worktree', 'prune')
      work.deleteBranch(A, `k1b-${i}`)
      return { firstEndedAt: first, endedAt: work.deleteBranch(A, `k1b-${i}-claude`).endedAt }
    })
  }
  // K2ⓐ linked 가 이미 있는 레포(A)에 추가
  for (let i = 1; i <= rounds; i += 1) {
    let added = null
    await measure(`K2a-${i}`, roots, async () => {
      added = work.addWorktree(A, `k2a-${i}`)
      return { endedAt: added.endedAt }
    })
    work.removeWorktree(A, added.path)
    work.deleteBranch(A, `k2a-${i}`)
    await settleTo(roots, `k2a-${i} cleanup`)
  }
  // K2ⓑ linked 0 → 1 (C, 0개로 안정된 뒤) · K1ⓒ 마지막 linked 삭제(.git/worktrees 소멸) · K2ⓒ 그 직후 다시 추가
  const commonWorktrees = path.join(C, '.git', 'worktrees')
  for (let i = 1; i <= rounds; i += 1) {
    await pause(3000)
    const existsBefore = fs.existsSync(commonWorktrees)
    let solo = null
    await measure(`K2b-${i}`, roots, async () => {
      solo = work.addWorktree(C, `k2b-${i}`)
      return { endedAt: solo.endedAt }
    }, { worktreesDirBefore: existsBefore })
    await pause(1200)
    await measure(`K1c-${i}`, roots, async () => {
      work.removeWorktree(C, solo.path)
      return { endedAt: work.deleteBranch(C, `k2b-${i}`).endedAt }
    })
    result.rounds.at(-1).worktreesDirAfter = fs.existsSync(commonWorktrees)
    let again = null
    await measure(`K2c-${i}`, roots, async () => {
      again = work.addWorktree(C, `k2c-${i}`)
      return { endedAt: again.endedAt }
    }, { worktreesDirBefore: fs.existsSync(commonWorktrees) })
    work.removeWorktree(C, again.path)
    work.deleteBranch(C, `k2c-${i}`)
    await settleTo(roots, `k2c-${i} cleanup`)
  }
  summarize(['K1a', 'K1b', 'K1c', 'K2a', 'K2b', 'K2c'])
  return 0
}

function summarize(groups) {
  for (const group of groups) {
    const rows = result.rounds.filter((row) => row.id.startsWith(`${group}-`))
    const ms = rows.map((row) => row.ms)
    check(group, `조건별 ${rows.length}회 전 회차 ≤ ${LIMIT_MS}ms · 포커스 아님`, rows.length >= (group.startsWith('K7') ? 3 : Math.min(rounds, 5)) && rows.every((row) => row.pass), { n: rows.length, ms })
  }
}

/** K7 — 격리 herdr 세션이 붙은 상태. K1ⓐ·K2ⓐ 각 --rounds 회 + 재동기·재빌드와 겹친 회차. */
async function timingHerdr(A, roots) {
  for (let i = 1; i <= rounds; i += 1) {
    const v = work.addWorktree(A, `k7a-${i}`)
    await settleTo(roots, `k7a-${i} prep`)
    await measure(`K7-K1a-${i}`, roots, async () => {
      const first = work.removeWorktree(A, v.path).endedAt
      return { firstEndedAt: first, endedAt: work.deleteBranch(A, `k7a-${i}`).endedAt }
    })
  }
  for (let i = 1; i <= rounds; i += 1) {
    let added = null
    await measure(`K7-K2a-${i}`, roots, async () => {
      added = work.addWorktree(A, `k7b-${i}`)
      return { endedAt: added.endedAt }
    })
    work.removeWorktree(A, added.path)
    work.deleteBranch(A, `k7b-${i}`)
    await settleTo(roots, `k7b-${i} cleanup`)
  }
  // 겹침: 재동기(refreshBindings) + rebuild-tree(onTopologyChange 와 같은 rebuildTree 경로) 를 외부 변경과 같은 순간에 쏜다.
  for (let i = 1; i <= Math.max(2, Math.ceil(rounds / 2)); i += 1) {
    const v = work.addWorktree(A, `k7o-${i}`)
    await settleTo(roots, `k7o-${i} prep`)
    const logFrom = Date.now()
    await measure(`K7-overlap-${i}`, roots, async () => {
      const resync = rpc(corral.control, { cmd: 'resync', reason: 'l445-overlap' }, 30_000).catch((error) => ({ error: String(error) }))
      const rebuild = rpc(corral.control, { cmd: 'rebuild-tree' }, 30_000).catch((error) => ({ error: String(error) }))
      const first = work.removeWorktree(A, v.path).endedAt
      const ended = work.deleteBranch(A, `k7o-${i}`).endedAt
      const rebuild2 = rpc(corral.control, { cmd: 'rebuild-tree' }, 30_000).catch((error) => ({ error: String(error) }))
      const replies = await Promise.all([resync, rebuild, rebuild2])
      return { firstEndedAt: first, endedAt: ended, detail: { replies } }
    })
    await pause(3000)
    const row = result.rounds.at(-1)
    const lines = corral.logLines().filter((e) => e.at >= logFrom && ['tree.built', 'tree.stale', 'binding.stale', 'tree.binding_drift', 'link.resync', 'worktree.changed'].some((t) => e.tag.startsWith(t.split('.')[0]) && e.tag === t))
    row.overlapLog = lines.map((e) => ({ tag: e.tag, at: e.at - logFrom, generation: e.generation, current: e.current, reason: e.reason, worktrees: e.worktrees }))
    row.staysCorrect3s = same(await corral.domSet(), truth(roots))
    row.pass = row.pass && row.staysCorrect3s
  }
  summarize(['K7-K1a', 'K7-K2a', 'K7-overlap'])
  return 0
}

async function feedback(A, roots) {
  await pause(10_000)
  await ensureUnfocused()
  const v = work.addWorktree(A, 'fb-1')
  await settleTo(roots, 'fb prep')
  await pause(10_000)
  const t0 = Date.now()
  const r = await measure('K4c-change', roots, async () => {
    work.removeWorktree(A, v.path)
    return { endedAt: work.deleteBranch(A, 'fb-1').endedAt }
  })
  await pause(5000)
  const builtAfterChange = corral.logLines().filter((e) => e.tag === 'tree.built' && e.at >= t0)
  const last = builtAfterChange.at(-1)?.at ?? t0
  log('quiet 60s')
  await pause(Math.max(0, last + 60_000 - Date.now()) + 500)
  const quiet = corral.count('tree.built', last + 1, last + 60_001)
  const gitInQuiet = work.gitCalls().length
  result.feedback = { reflectMs: r.ms, rebuildsForChange: builtAfterChange.length, rebuildAts: builtAfterChange.map((e) => e.at - t0), quietWindow: [last + 1 - t0, last + 60_001 - t0], treeBuiltInQuiet60s: quiet, gitCallsTotal: gitInQuiet }
  check('K4c-rebuilds', '외부 변경 1건 → 재빌드 1~2회', builtAfterChange.length >= 1 && builtAfterChange.length <= 2, builtAfterChange.length)
  check('K4c-quiet', '그 뒤 60초 tree.built 0회', quiet === 0, quiet)
  // K4ⓓ — 레포 추가·제거 3회 왕복. 감시(fs watch)는 쓰지 않는다 — 폴러가 든 루트 상태 수가 레지스트리를 따라가는지(누수 없음)를 로그로 본다.
  const D = work.makeRepo('delta', ['d1'])
  const marks = []
  for (let i = 1; i <= 3; i += 1) {
    await rpc(corral.control, { cmd: 'add-repo', root: D })
    await pause(2500)
    marks.push({ step: `add-${i}`, dom: (await corral.domSet()).filter((p) => p.includes('/delta')).length })
    const data = JSON.parse(fs.readFileSync(corral.registryFile, 'utf8'))
    data.repos = data.repos.filter((repo) => (typeof repo === 'string' ? repo : repo.path) !== D)
    fs.writeFileSync(corral.registryFile, JSON.stringify(data, null, 2)) // 앱 밖 편집(제거) — 격리 레지스트리
    await pause(2500)
    marks.push({ step: `remove-${i}`, dom: (await corral.domSet()).filter((p) => p.includes('/delta')).length })
  }
  const rootsLog = corral.logLines().filter((e) => e.tag === 'worktree.poll_roots').map((e) => ({ at: e.at - t0, count: e.count }))
  result.k4d = { marks, rootsLog }
  check('K4d', '폴러 루트 수가 레포 추가·제거를 따라간다(3회 왕복 후 처음 수)', rootsLog.length > 0 && rootsLog.at(-1).count === roots.length, rootsLog.slice(-7))
  return 0
}

async function prunable(A, roots) {
  const p1 = work.addWorktree(A, 'pr-1')
  await settleTo(roots, 'pr prep')
  if (pollOff) await rpc(corral.control, { cmd: 'rebuild-tree' }, 30_000)
  await pause(1500)
  const focus = await ensureUnfocused()
  if (!work.owns(p1.path)) throw new Error('G8')
  fs.rmSync(p1.path, { recursive: true, force: true })
  const removedAt = Date.now()
  const porcelain = git(A, 'worktree', 'list', '--porcelain').stdout
  const auto = await waitReflect(corral, (set) => !set.includes(p1.path), { from: removedAt, timeoutMs: 10_000 })
  result.k3c = { pollOff, autoReflectMs: auto.ms, porcelainHasPrunable: porcelain.includes('prunable'), focus }
  let refreshMs = null
  if (pollOff) {
    const clickedAt = await corral.click('[data-refresh-tree]')
    const seen = await waitReflect(corral, (set) => !set.includes(p1.path), { from: clickedAt, timeoutMs: 10_000 })
    refreshMs = seen.ms
    check('K3b', '새로고침으로 prunable 항목이 빠진다', seen.ms !== null && seen.ms <= LIMIT_MS, seen.ms)
  } else {
    await rpc(corral.control, { cmd: 'rebuild-tree' }, 30_000)
    await pause(1000)
  }
  const dom = await corral.domSet()
  const cli = corral.cli(A, 'worktree', 'list')
  const cliPaths = (cli.result?.worktrees ?? []).map((row) => row.path).sort()
  result.k3a = { dom, cliPaths, gitTruth: truth(roots), refreshMs, prunableInDom: dom.includes(p1.path) }
  check('K3a', '재빌드 결과에 prunable 없음 · runtime CLI 와 같은 집합', !dom.includes(p1.path) && same(dom, cliPaths), { dom: dom.length, cli: cliPaths.length })
  git(A, 'worktree', 'prune')
  work.deleteBranch(A, 'pr-1')
  return 0
}

async function refresh(A, roots) {
  // ⓐ 자동 경로 꺼짐 증명: 외부 삭제 뒤 3초 동안 그대로 → 새로고침 → 빠짐
  const v = work.addWorktree(A, 'rf-1')
  await rpc(corral.control, { cmd: 'rebuild-tree' }, 30_000)
  await pause(1500)
  const visible = (await corral.domSet()).includes(v.path)
  const focus = await ensureUnfocused()
  work.removeWorktree(A, v.path)
  const ended = work.deleteBranch(A, 'rf-1').endedAt
  await pause(3000)
  const stillThere = (await corral.domSet()).includes(v.path)
  const clickedAt = await corral.click('[data-refresh-tree]')
  const seen = await waitReflect(corral, (set) => same(set, truth(roots)), { from: clickedAt, timeoutMs: 10_000 })
  result.k5a = { visibleBefore: visible, stillThereAfter3sWithoutRefresh: stillThere, sinceRemoveMs: clickedAt - ended, refreshReflectMs: seen.ms, focus }
  check('K5a', '자동 경로를 끈 상태에서 새로고침이 다시 읽은 목록을 보인다', visible && stillThere && seen.ms !== null, result.k5a)
  // ⓑ 연타 10회 — 낡은 결과가 새것을 덮지 않는다
  await pause(1000)
  const w = work.addWorktree(A, 'rf-2')
  const logFrom = Date.now()
  const clicks = []
  for (let i = 0; i < 10; i += 1) clicks.push(await corral.click('[data-refresh-tree]'))
  const trace = []
  const until = Date.now() + 4000
  while (Date.now() < until) {
    trace.push({ t: Date.now() - logFrom, has: (await corral.domSet()).includes(w.path) })
    await pause(50)
  }
  const firstSeen = trace.findIndex((row) => row.has)
  const regressed = firstSeen >= 0 && trace.slice(firstSeen).some((row) => !row.has)
  const lines = corral.logLines().filter((e) => e.at >= logFrom && (e.tag === 'tree.built' || e.tag === 'tree.stale'))
  result.k5b = { clicksSpanMs: clicks.at(-1) - clicks[0], firstSeenAtMs: trace[firstSeen]?.t ?? null, regressed, treeBuilt: lines.filter((e) => e.tag === 'tree.built').length, treeStale: lines.filter((e) => e.tag === 'tree.stale').length, finalCorrect: same(await corral.domSet(), truth(roots)), trace: trace.filter((_, i) => i % 5 === 0) }
  check('K5b', '연타 10회 — 낡은 결과가 새것을 덮지 않는다(한 번 보인 뒤 사라지지 않음 · 최종 = git)', firstSeen >= 0 && !regressed && result.k5b.finalCorrect, { regressed, stale: result.k5b.treeStale, built: result.k5b.treeBuilt })
  work.removeWorktree(A, w.path)
  work.deleteBranch(A, 'rf-2')
  return 0
}

/** K6 준비 — 핀(pin-1) · 수동 순서(ord-1 이 맨 위인 역순) · Parent(par → chi). 기동 전에 ui-prefs 를 쓴다. */
const cascadeNames = ['pin-1', 'ord-1', 'ord-2', 'ord-3', 'par', 'chi']
function seedCascade(A) {
  const paths = Object.fromEntries(cascadeNames.map((name) => [name, work.addWorktree(A, name).path]))
  const keep = fs.realpathSync(work.worktreePath(A, 'keep'))
  fs.writeFileSync(
    path.join(work.dir, 'ui-prefs.json'),
    JSON.stringify({ pinnedWorktrees: [paths['pin-1']], manualWorktreeOrder: { [A]: [paths['ord-3'], paths['ord-1'], keep, paths['ord-2'], paths['pin-1'], paths['par'], paths['chi']] } }, null, 2),
  )
  result.cascadePaths = paths
}
async function domOrder() {
  return corral.cdp.evaluate(() => Array.from(document.querySelectorAll('[data-worktree]')).map((el) => el.getAttribute('data-worktree')))
}
async function cascade(A, roots) {
  const paths = result.cascadePaths
  const consoleErrors = []
  await corral.cdp.send('Runtime.enable')
  corral.cdp.socket.addEventListener?.('message', (event) => {
    try {
      const msg = JSON.parse(String(event.data))
      if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push({ kind: 'exception', text: msg.params.exceptionDetails?.text })
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push({ kind: 'console.error', text: msg.params.args?.map((a) => a.value ?? a.description).join(' ').slice(0, 300) })
    } catch {
      // 다른 메시지
    }
  })
  const setParent = corral.cli(A, 'worktree', 'set', '--worktree', `path:${paths.chi}`, '--parent-worktree', `path:${paths.par}`)
  await pause(1500)
  result.k6setup = { setParent: setParent.ok ?? setParent.status, order0: await domOrder(), pinnedCount: await corral.domCount(paths['pin-1']) }
  const logFrom = Date.now()
  const cases = [
    { id: 'K6a-pinned', name: 'pin-1' },
    { id: 'K6b-manual-order', name: 'ord-1' },
    { id: 'K6c-parent', name: 'par' },
  ]
  if (herdrOn) {
    // ⓓ 열려 있고 선택된 worktree — 격리 herdr 에 셸 터미널을 열고, 카드를 눌러 선택한다(CDP 입력 — 이 인스턴스 페이지에만).
    const opened = corral.cli(paths['ord-2'], 'terminal', 'create', '--worktree', `path:${paths['ord-2']}`, '--title', 'l445-k6d', '--command', 'sh')
    await pause(2500)
    await corral.click(`[data-worktree="${paths['ord-2']}"] [data-worktree-card-surface]`)
    await pause(2500)
    const state = await rpc(corral.control, { cmd: 'state' })
    result.k6dSetup = { opened: opened.ok ?? opened.status, terminal: state.state?.terminal ?? null, groups: (state.state?.terminalGroups ?? []).length }
    cases.push({ id: 'K6d-open-selected', name: 'ord-2', force: true })
  }
  for (const item of cases) {
    const before = await domOrder()
    const target = paths[item.name]
    const row = await measure(item.id, roots, async () => {
      work.removeWorktree(A, target, { force: item.force === true })
      return { endedAt: work.deleteBranch(A, item.name).endedAt }
    })
    await pause(1500)
    const after = await domOrder()
    const expectedOrder = before.filter((p) => p !== target)
    row.ghost = after.includes(target)
    row.orderKept = same(after, expectedOrder)
    row.orderBefore = before
    row.orderAfter = after
    if (item.name === 'par') {
      row.childChip = await corral.cdp.evaluate((p) => {
        const el = document.querySelector(`[data-worktree="${CSS.escape(p)}"]`)
        return el ? el.textContent.slice(0, 200) : null
      }, paths.chi)
    }
    if (item.id === 'K6d-open-selected') {
      await pause(2000)
      const state = await rpc(corral.control, { cmd: 'state' })
      row.streamAfter = { terminal: state.state?.terminal ?? null, groups: (state.state?.terminalGroups ?? []).length }
      row.streamLog = corral.logLines().filter((e) => e.at >= logFrom && /^stream\.|^tree\.binding_drift/.test(e.tag)).map((e) => ({ tag: e.tag, at: e.at - logFrom, panes: e.panes }))
    }
    row.pass = row.pass && !row.ghost && row.orderKept
  }
  const mainErrors = corral.logLines().filter((e) => e.at >= logFrom && /error|fail|uncaught/i.test(e.tag))
  result.k6errors = { console: consoleErrors, main: mainErrors.map((e) => ({ tag: e.tag, at: e.at - logFrom })) }
  for (const item of cases) {
    const row = result.rounds.find((r) => r.id === item.id)
    check(item.id, '유령 카드 없음 · 남은 순서 유지 · ≤ 5초', row.pass, { ms: row.ms, ghost: row.ghost, orderKept: row.orderKept })
  }
  check('K6-errors', '앱 오류 없음(렌더러 예외·console.error · main 오류 로그)', consoleErrors.length === 0 && mainErrors.length === 0, result.k6errors)
  return 0
}

let code = 1
try {
  await main()
  code = result.checks.every((c) => c.pass) ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  log('ERROR', result.error)
  code = 2
} finally {
  decoy.stop()
  await corral.quit().catch((error) => result.notes.push({ quitError: String(error) }))
  finish(code)
}
