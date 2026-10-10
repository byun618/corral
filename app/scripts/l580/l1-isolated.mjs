// LIFE-580 최종 관문 L1 ⓐ~ⓓ 격리 원자료. 격리 런타임 CLI(`CORRAL_RUNTIME_SOCKET=<ROOT>/ud/runtime/rpc.sock`, 설치본 바이너리를 클라이언트로만)로
// 레포 1 · worktree 부모/자식/손자/고아 · 각 worktree 의 터미널을 만들고, 일부 pane 만 에이전트로 보고한다(나머지는 셸 — 같은 worktree 에 섞는다).
//   ⓐ 폰 자리 A: 구독 → 첫 메시지 = 전체 스냅샷 · 이후 보고마다 push · seq 단조 증가(같은 epoch)
//   ⓑ herdr 의 셸 pane(에이전트 없음) ≥ 1 이 같은 worktree 에 있는데 목록 채널에는 0건 — 양성 대조: 같은 worktree 의 에이전트 pane 은 있다
//   ⓒ 그룹 재료: 레포 이름 · 작업(worktree) · 자식/손자 worktree 의 채널이 최상위 조상 작업 아래 · 고아(부모 지운 worktree)는 자기 작업으로
//   ⓓ 폰 자리 B·C·D 를 동시에 구독 → main 로그(`<ROOT>/ud/corral.ndjson`) 의 그 구간 `mobile.list_built` 수 ≤ 1(스냅샷 공유), 셋 다 같은 seq 를 받는다
// 사용(app/): node scripts/l580/l1-isolated.mjs --root /tmp/l580g-x --fake /tmp/l580g-fx --out <폴더> [--tag a]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoots, herdr, pairDevice, phone, reportAgent, revokeAll, setMobile, sleep, until, writeJson } from './lib.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, tag: { type: 'string', default: 'a' }, corral: { type: 'string', default: '/Applications/corral.app/Contents/Resources/bin/corral' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (!args.out) throw new Error('--out 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const OUT = path.resolve(args.out)
fs.mkdirSync(OUT, { recursive: true })
const T = args.tag
const REPO = path.join(ROOT, `l1repo-${T}`)
const LOG = path.join(ROOT, 'ud', 'corral.ndjson')
// 격리 런타임만 — HERDR_* 는 지운다(내 셸은 설치본 런타임 pane 이다).
const env = { ...process.env, CORRAL_RUNTIME_SOCKET: path.join(ROOT, 'ud', 'runtime', 'rpc.sock') }
delete env.HERDR_PANE_ID
delete env.HERDR_SOCKET_PATH
delete env.HERDR_BIN_PATH
const corral = (...argv) => {
  const run = spawnSync(args.corral, [...argv, '--json'], { env, encoding: 'utf8', timeout: 60_000 })
  const body = JSON.parse(run.stdout || '{}')
  if (!body.ok) throw new Error(`corral ${argv.slice(0, 2).join(' ')}: ${JSON.stringify(body.error ?? run.stderr).slice(0, 300)}`)
  return body.result
}
const git = (...argv) => spawnSync('git', argv, { encoding: 'utf8' })

const checks = {}
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)

async function main() {
  await setMobile(ROOT, args.fake, true)
  // ── 위상 만들기
  fs.mkdirSync(REPO, { recursive: true })
  git('init', '-q', '-b', 'main', REPO)
  git('-C', REPO, '-c', 'user.name=l580', '-c', 'user.email=l580@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init')
  corral('repo', 'add', '--path', REPO)
  const wt = (name, parent) => corral('worktree', 'create', '--name', name, '--repo', REPO, '--setup', 'skip', ...(parent ? ['--parent-worktree', `path:${path.join(REPO, '.claude/worktrees', parent)}`] : [])).worktree
  const parent = wt(`l1-${T}-parent`)
  const child = wt(`l1-${T}-child`, `l1-${T}-parent`)
  const grand = wt(`l1-${T}-grand`, `l1-${T}-child`)
  const gone = wt(`l1-${T}-gone`)
  const orphan = wt(`l1-${T}-orphan`, `l1-${T}-gone`)
  corral('worktree', 'rm', '--worktree', `path:${gone.path}`, '--force')
  const term = (worktree, title) => corral('terminal', 'create', '--worktree', `path:${worktree.path}`, '--title', title).terminal
  const panes = {
    parentAgent: term(parent, 'pa').paneId,
    parentShell: term(parent, 'ps').paneId,
    childAgent: term(child, 'ca').paneId,
    childShell: term(child, 'cs').paneId,
    grandAgent: term(grand, 'ga').paneId,
    orphanAgent: term(orphan, 'oa').paneId,
  }
  for (const key of ['parentAgent', 'childAgent', 'grandAgent', 'orphanAgent']) await reportAgent(ROOT, { paneId: panes[key], state: 'idle' })
  await sleep(1_500)

  // ── ⓐ 구독 → 스냅샷 → push · seq 단조
  const gotA = []
  const a = await phone(ROOT, { name: `l1-${T}-a`, onList: ({ message, recvAt }) => gotA.push({ message, recvAt }) })
  await until(() => (gotA.length > 0 ? true : null), { timeoutMs: 10_000, label: '첫 스냅샷' })
  const first = gotA[0].message
  for (const [i, state] of ['working', 'blocked', 'idle'].entries()) {
    await reportAgent(ROOT, { paneId: panes.childAgent, state })
    await until(() => (gotA.length > 1 + i ? true : null), { timeoutMs: 5_000, label: `push ${state}` }).catch(() => null)
    await sleep(400)
  }
  const seqs = gotA.map((item) => item.message.seq)
  checks.a = {
    firstIsFull: first.type === 'list' && first.list.available === true && Array.isArray(first.list.repos),
    pushes: gotA.length - 1,
    seqs,
    epochs: [...new Set(gotA.map((item) => item.message.epoch))].length,
    monotonic: seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]),
  }
  checks.a.pass = checks.a.firstIsFull && checks.a.pushes >= 3 && checks.a.monotonic && checks.a.epochs === 1

  // ── ⓑ 셸 0건 · ⓒ 그룹
  const last = gotA.at(-1).message.list
  const herdrPanes = (await herdr(ROOT, 'pane.list')).panes ?? []
  const channelIds = new Set(last.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels.map((channel) => channel.id))))
  const shells = herdrPanes.filter((pane) => !pane.agent).map((pane) => pane.pane_id)
  checks.b = {
    herdrPanes: herdrPanes.length,
    shellPanes: shells,
    shellInList: shells.filter((id) => channelIds.has(id)),
    agentPanesInList: [panes.parentAgent, panes.childAgent].filter((id) => channelIds.has(id)),
    sameWorktreeMix: shells.includes(panes.parentShell) && shells.includes(panes.childShell),
  }
  checks.b.pass = checks.b.shellPanes.length >= 2 && checks.b.shellInList.length === 0 && checks.b.agentPanesInList.length === 2 && checks.b.sameWorktreeMix
  const repo = last.repos.find((item) => item.name === path.basename(REPO))
  const taskOf = (paneId) => repo?.tasks.find((task) => task.channels.some((channel) => channel.id === paneId)) ?? null
  const structure = repo === undefined ? null : repo.tasks.map((task) => ({ task: task.name, isDefault: task.isDefault, channels: task.channels.map((channel) => ({ id: channel.id, depth: channel.depth, dot: channel.dot })) }))
  checks.c = {
    repoName: repo?.name ?? null,
    structure,
    parentTask: taskOf(panes.parentAgent)?.name ?? null,
    childTask: taskOf(panes.childAgent)?.name ?? null,
    grandTask: taskOf(panes.grandAgent)?.name ?? null,
    orphanTask: taskOf(panes.orphanAgent)?.name ?? null,
  }
  checks.c.pass = checks.c.repoName !== null && checks.c.parentTask !== null && checks.c.childTask === checks.c.parentTask && checks.c.grandTask === checks.c.parentTask && checks.c.orphanTask !== null && checks.c.orphanTask !== checks.c.parentTask

  // ── ⓓ 동시 구독 — 그 구간 main 로그 list_built 수
  // 페어링은 차례로(코드는 한 번에 하나), hello·구독만 동시에
  const tokens = {}
  for (const key of ['b', 'c', 'd']) tokens[key] = await pairDevice(ROOT, { name: `l1-${T}-${key}` })
  const before = lines(LOG).length
  const got = { b: [], c: [], d: [] }
  const t0 = Date.now()
  const clients = await Promise.all(['b', 'c', 'd'].map((key) => phone(ROOT, { name: `l1-${T}-${key}`, token: tokens[key], onList: ({ message }) => got[key].push(message.seq) })))
  await until(() => (Object.values(got).every((list) => list.length > 0) ? true : null), { timeoutMs: 10_000, label: '동시 스냅샷' })
  await sleep(300)
  const window = lines(LOG).slice(before).filter((entry) => entry.at >= t0)
  const built = window.filter((entry) => entry.tag === 'mobile.list_built')
  const subscribes = window.filter((entry) => entry.tag === 'mobile.list_subscribe')
  checks.d = { subscribes: subscribes.length, listBuilt: built.map((entry) => ({ seq: entry.seq, subscribers: entry.subscribers, buildMs: entry.buildMs })), firstSeqs: Object.fromEntries(Object.entries(got).map(([key, list]) => [key, list[0]])) }
  const firstSeqs = Object.values(checks.d.firstSeqs)
  checks.d.pass = subscribes.length === 3 && built.length <= 1 && new Set(firstSeqs).size === 1
  for (const client of [a, ...clients]) await client.close()
  await revokeAll(ROOT)

  const pass = ['a', 'b', 'c', 'd'].every((key) => checks[key].pass)
  writeJson(path.join(OUT, `l1-${T}.json`), { at: new Date().toISOString(), panes, checks, verdict: pass ? '통과' : '미달' })
  for (const key of ['a', 'b', 'c', 'd']) console.log(`L1${key} ${checks[key].pass ? '통과' : '미달'} ${JSON.stringify(checks[key]).slice(0, 400)}`)
  console.log(`L1 → ${pass ? '통과' : '미달'}`)
  process.exit(pass ? 0 : 1)
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
