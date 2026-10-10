// LIFE-580 최종 관문 L4·L5·L7·L8 에뮬레이터 캡처용 **격리 장면** 도구. 격리 런타임 CLI(`CORRAL_RUNTIME_SOCKET=<ROOT>/ud/runtime/rpc.sock`,
// 설치본 바이너리를 클라이언트로만)로 레포·작업·터미널을 만들고, 격리 herdr 에 에이전트 상태를 보고한다. 설치본·사용자 herdr 무접촉(lib.mjs 루트 검사).
//
// 사용(app/):
//   node scripts/l580/scene.mjs build  --root /tmp/l580g-x --fake /tmp/l580g-fx --out <scene.json>
//       레포 l5repo · 작업 alpha(에이전트 3 + 셸 1) · alpha-sub(alpha 의 하위, 에이전트 1) · beta(에이전트 4) · shellonly(셸만 — M3-b 숨김) · quiet(한가 에이전트 2 — 기본 접힘)
//       pane id 를 <scene.json> 에 이름 → id 로 남긴다(제목은 이름 그대로 — 비밀 없음).
//   node scripts/l580/scene.mjs report --root … --fake … --scene <scene.json> <이름|pane id>=<idle|working|blocked|unknown> […]
//   node scripts/l580/scene.mjs close  --root … --fake … --scene <scene.json> <이름|pane id>       — herdr 에서 직접 닫는다(corral 이 닫은 게 아니라 보존 행이 남는다 — L8)
//   node scripts/l580/scene.mjs add    --root … --fake … --scene <scene.json> <작업 이름> <새 이름> [state] — 그 작업에 에이전트 터미널 하나 더(L4ⓐ)
//   node scripts/l580/scene.mjs shell  --root … --fake … --scene <scene.json> <작업 이름> <새 이름>         — 그 작업에 셸 터미널(보고 없음)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoots, herdr, reportAgent, setMobile, sleep, writeJson } from './lib.mjs'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, scene: { type: 'string' }, corral: { type: 'string', default: '/Applications/corral.app/Contents/Resources/bin/corral' } },
})
const [cmd, ...rest] = positionals
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (!['build', 'report', 'close', 'add', 'shell'].includes(cmd)) throw new Error('명령: build · report · close · add · shell')
  if (cmd === 'build' && !args.out) throw new Error('--out 필요')
  if (cmd !== 'build' && !args.scene) throw new Error('--scene 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
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
const log = (value) => console.log(JSON.stringify({ at: Date.now(), ...value }))

async function build() {
  await setMobile(ROOT, args.fake, true)
  const repo = path.join(ROOT, 'l5repo')
  fs.mkdirSync(repo, { recursive: true })
  spawnSync('git', ['init', '-q', '-b', 'main', repo])
  spawnSync('git', ['-C', repo, '-c', 'user.name=l580', '-c', 'user.email=l580@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
  corral('repo', 'add', '--path', repo)
  const tasks = {}
  const wt = (name, parent) => {
    tasks[name] = corral('worktree', 'create', '--name', name, '--repo', repo, '--setup', 'skip', ...(parent ? ['--parent-worktree', `path:${tasks[parent].path}`] : [])).worktree
  }
  wt('alpha')
  wt('alpha-sub', 'alpha')
  wt('beta')
  wt('shellonly')
  wt('quiet')
  const plan = [
    ['alpha', 'alpha-build', 'working'], ['alpha', 'alpha-review', 'blocked'], ['alpha', 'alpha-docs', 'idle'], ['alpha', 'alpha-shell', null],
    ['alpha-sub', 'sub-fix', 'idle'],
    ['beta', 'beta-api', 'blocked'], ['beta', 'beta-db', 'blocked'], ['beta', 'beta-ui', 'blocked'], ['beta', 'beta-test', 'idle'],
    ['shellonly', 'only-shell', null],
    ['quiet', 'quiet-a', 'idle'], ['quiet', 'quiet-b', 'idle'],
  ]
  const panes = {}
  for (const [task, name] of plan) panes[name] = corral('terminal', 'create', '--worktree', `path:${tasks[task].path}`, '--title', name).terminal.paneId
  for (const [, name, state] of plan) {
    if (state === null) continue
    await reportAgent(ROOT, { paneId: panes[name], state })
    await sleep(150)
  }
  const scene = { repo, tasks: Object.fromEntries(Object.entries(tasks).map(([name, row]) => [name, row.path])), panes }
  writeJson(path.resolve(args.out), scene)
  log({ built: true, tasks: Object.keys(tasks), panes })
}

const load = () => JSON.parse(fs.readFileSync(args.scene, 'utf8'))
const paneOf = (scene, name) => scene.panes[name] ?? name

async function main() {
  if (cmd === 'build') return build()
  const scene = load()
  if (cmd === 'report') {
    for (const pair of rest) {
      const [name, state] = pair.split('=')
      const causeAt = await reportAgent(ROOT, { paneId: paneOf(scene, name), state })
      log({ report: name, pane: paneOf(scene, name), state, causeAt })
      await sleep(150)
    }
  } else if (cmd === 'close') {
    const pane = paneOf(scene, rest[0])
    await herdr(ROOT, 'pane.close', { pane_id: pane })
    log({ close: rest[0], pane })
  } else if (cmd === 'add' || cmd === 'shell') {
    const [task, name, state = 'idle'] = rest
    const pane = corral('terminal', 'create', '--worktree', `path:${scene.tasks[task]}`, '--title', name).terminal.paneId
    if (cmd === 'add') await reportAgent(ROOT, { paneId: pane, state })
    scene.panes[name] = pane
    writeJson(args.scene, scene)
    log({ [cmd]: name, task, pane, state: cmd === 'add' ? state : null })
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
