// LIFE-445 K8 네이티브 관문 — 사용자 userData + 구현 브랜치 빌드에서 **실제 셸 git** 으로 외부 추가·삭제를 하고 사이드바 반영 시간을 잰다.
//
// 게이트 ⓪ 확정: Q1 임시 격리 레포(/tmp/l445w/native-repo)를 사용자 레지스트리에 잠깐 등록 — 사용자 레포에는 쓰지 않는다.
//                Q2 herdr `default` 는 꺼진 채 — 띄우지 않는다.
// profile.json: 사용자 profile 의 backend 가 **실행 중인** `life417-native`(격리 규칙 1 무접촉)를 가리킨다. 그대로 띄우면 그 세션에
//   붙으므로 471 선례처럼 backend 를 꺼진 `default` 소켓으로 임시 재작성한다(서버는 띄우지 않는다). 원복은 userData 전체 바이트 복원.
// corral 에는 OS 입력을 보내지 않는다 — 읽기(제어 소켓 `query`·`window-visibility read`)만. 포커스 아님 조건은 미끼 창(l471 decoy)이 앞.
// 맨 앞 앱이 미끼가 아니게 되면(사용자가 Mac 을 쓰는 신호) 측정을 멈추고 원복한 뒤 종료코드 4 — 호출자가 질의로 멈춘다.
// 커밋되는 출력에는 /tmp/l445w 아래 경로와 개수만 싣는다(G7). 사용자 레포 경로·DOM 집합은 /tmp/l445-private/native 에만.
// 종료코드: 0 = 측정 전 회차 ≤ 5초 + 원복 대조 통과 · 1 = 미달 · 3 = 전제 불충족(아무것도 안 바꿈) · 4 = 사용자 활동 신호로 중단 · 2 = 예외(원복은 시도)
// 사용: node native-k8.mjs --out <raw 폴더> [--rounds 3]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildIdentity } from '../l478/build-identity.mjs'
import { Decoy, frontPid, git, load, yesCount, pause, rpc, until, alive } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '../..')
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1] ?? true]] : pairs), []))
const out = path.resolve(String(args.out))
const rounds = Number(args.rounds ?? 3)
const NODE = process.execPath
const HOME = os.homedir()
const UD = path.join(HOME, 'Library/Application Support/corral')
const HCFG = path.join(HOME, '.config/herdr')
const PRIV = '/tmp/l445-private/native'
const ROOT = '/tmp/l445w/native'
const REPO_BASE = '/tmp/l445w/native-repo'
const CTL = path.join(PRIV, 'ctl.sock')
const LIMIT_MS = 5000
const t0 = Date.now()
const log = (...parts) => console.log(`[l445n +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)
const tilde = (text) => String(text).split(HOME).join('~')
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(PRIV, { recursive: true, mode: 0o700 })
fs.chmodSync('/tmp/l445-private', 0o700)

const result = { startedAt: new Date().toISOString(), build: buildIdentity(appRoot), env: { load: load(), yes: yesCount() }, pre: {}, rounds: [], checks: [], restore: {}, notes: [] }
const check = (id, criterion, pass, observed) => {
  result.checks.push({ id, criterion, pass: pass === true, observed })
  log(pass ? 'PASS' : 'FAIL', id, criterion, JSON.stringify(observed).slice(0, 300))
}
const herdrList = () => tilde(spawnSync('/opt/homebrew/bin/herdr', ['session', 'list'], { encoding: 'utf8' }).stdout)
const herdrDefault = () => herdrList().split('\n').find((line) => line.startsWith('default '))?.split(/\s+/)[1] ?? null
const providerHash = () => tilde(execFileSync('sh', [path.join(appRoot, 'scripts/l470/provider-hash.sh')], { encoding: 'utf8' }))
const manifest = (dir, top = false) => JSON.parse(execFileSync(NODE, [path.join(appRoot, 'scripts/l470/native-manifest.mjs'), dir, ...(top ? ['--top'] : [])], { encoding: 'utf8', maxBuffer: 1 << 28 }))
const corralElectron = () => spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((line) => /corral.*(Electron|electron)/.test(line) && !line.includes('grep'))

let appPid = null
let decoy = null
let ndjsonSize = null
let changedProfile = false

function precheck() {
  const ownerFile = path.join(UD, 'runtime/owner.json')
  let owner = 'none'
  if (fs.existsSync(ownerFile)) {
    const pid = JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid
    owner = alive(pid) ? `alive:${pid}` : `dead:${pid}`
  }
  const electron = corralElectron()
  result.pre = { owner, corralElectron: electron.length, herdrDefault: herdrDefault(), herdrListStart: herdrList(), providerStart: providerHash(), frontAppPid: frontPid(), at: new Date().toISOString() }
  if (owner.startsWith('alive') || electron.length > 0) return 'corral 이 이미 떠 있다 — 끄지 않고 멈춘다(K8ⓕ)'
  if (result.pre.herdrDefault !== 'stopped') return `herdr default 가 ${result.pre.herdrDefault} — 사용자 상태라 건드리지 않는다(Q2)`
  if (fs.existsSync(ROOT) || fs.existsSync(REPO_BASE)) return `${ROOT} 또는 ${REPO_BASE} 가 이미 있다`
  return null
}

function backup() {
  fs.mkdirSync(path.join(PRIV, 'backup'), { recursive: true, mode: 0o700 })
  execFileSync('rsync', ['-a', '--exclude', 'corral.ndjson', `${UD}/`, path.join(PRIV, 'backup/ud/')])
  const ud = manifest(UD)
  fs.writeFileSync(path.join(PRIV, 'ud-manifest-before.json'), JSON.stringify(ud))
  const herdr = manifest(HCFG, true)
  fs.writeFileSync(path.join(PRIV, 'herdr-manifest-before.json'), JSON.stringify(herdr))
  ndjsonSize = ud.files['corral.ndjson']?.size ?? 0
  result.backup = { udFiles: ud.count, herdrTopFiles: herdr.count, reposJsonSha256: ud.files['repos.json']?.sha256 ?? null, profileSha256: ud.files['runtime/profile.json']?.sha256 ?? null, ndjsonBytes: ndjsonSize }
}

function rewriteProfile() {
  const file = path.join(UD, 'runtime/profile.json')
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
  result.profileBackendBefore = { session: profile.backend?.session ?? null, socketIsHome: String(profile.backend?.socket ?? '').startsWith(HOME) }
  profile.backend = { socket: path.join(HCFG, 'herdr.sock'), session: 'default' }
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n')
  changedProfile = true
}

async function launch() {
  const clean = path.join(appRoot, 'scripts/l470/clean.sh')
  const res = spawnSync('sh', [clean, `CORRAL_CONTROL_SOCKET=${CTL}`, '--', `${NODE} ${appRoot}/cli/corral.mjs open --json`], { encoding: 'utf8', timeout: 120_000 })
  const parsed = JSON.parse(res.stdout)
  if (!parsed.ok) throw new Error(`open 실패: ${tilde(res.stdout).slice(0, 400)}`)
  appPid = parsed.result.runtime.pid
  await until(() => fs.existsSync(CTL), 'control socket', 60_000)
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(appPid)], { encoding: 'utf8' }).stdout.trim()
  result.app = { pid: appPid, fromImplWorktree: command.includes(appRoot), command: tilde(command).slice(0, 200) }
  log('app', appPid)
}

const count = async (selector) => ((await rpc(CTL, { cmd: 'query', selector })).found ?? []).length
const has = async (target) => (await count(`[data-worktree="${target}"]`)) > 0
const ours = (target) => target.startsWith('/private/tmp/l445w/') || target.startsWith('/tmp/l445w/')

async function focusSample() {
  const vis = await rpc(CTL, { cmd: 'window-visibility', action: 'read' })
  return { corralFocused: vis.focused, visible: vis.visible, frontPid: frontPid(), decoyPid: decoy?.pid ?? null }
}

/** 반영 대기 — 100ms 주기로 기대 상태(있음/없음 목록)가 처음 참이 된 시각. */
async function waitState({ present = [], absent = [] }, from) {
  let polls = 0
  let maxGap = 0
  let last = Date.now()
  while (Date.now() - from < 15_000) {
    let ok = true
    for (const p of present) ok = ok && (await has(p))
    for (const p of absent) ok = ok && !(await has(p))
    polls += 1
    const now = Date.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
    if (ok) return { ms: now - from, polls, maxGapMs: maxGap }
    await pause(100)
  }
  return { ms: null, polls, maxGapMs: maxGap }
}

class Interrupted extends Error {}

async function measure(id, expect, op) {
  // 미끼를 다시 앞으로 세우지 않는다 — 맨 앞이 바뀌었다면 사용자가 Mac 을 쓰는 신호일 수 있다(478·471). 바로 멈춘다.
  const focus = await focusSample()
  if (focus.frontPid !== decoy.pid) {
    result.notes.push({ id, interrupted: '맨 앞 앱이 미끼가 아니다 — 사용자 활동 신호로 본다', frontPid: focus.frontPid })
    throw new Interrupted(id)
  }
  const totalBefore = await count('[data-worktree]')
  const { endedAt, firstEndedAt, commands } = op()
  const seen = await waitState(expect, endedAt)
  const focusAfter = await focusSample()
  const totalAfter = await count('[data-worktree]')
  const row = {
    id,
    ms: seen.ms,
    msFromFirstCommand: firstEndedAt === undefined || seen.ms === null ? null : seen.ms + (endedAt - firstEndedAt),
    pass: seen.ms !== null && seen.ms <= LIMIT_MS && focus.corralFocused === false && focusAfter.corralFocused === false,
    polls: seen.polls,
    maxPollGapMs: seen.maxGapMs,
    focusBefore: focus,
    focusAfter,
    cardsBefore: totalBefore,
    cardsAfter: totalAfter,
    commands,
    expect,
    load: load(),
  }
  result.rounds.push(row)
  log(row.pass ? 'ok  ' : 'MISS', id, `${row.ms}ms`)
  return row
}

function owned(target) {
  if (!ours(target)) throw new Error(`G8: 관문이 만든 경로가 아니다 — ${target}`)
  return target
}
const real = (p) => fs.realpathSync(p)

async function gate() {
  // 임시 격리 레포 — linked `keep` 하나로 시작
  const repo = path.join(REPO_BASE, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, '-c', 'user.email=l445@example.invalid', '-c', 'user.name=l445', 'commit', '-q', '-m', 'init')
  const R = real(repo)
  const wt = (name) => path.join(real(REPO_BASE), 'wt', name)
  fs.mkdirSync(path.join(REPO_BASE, 'wt'), { recursive: true })
  git(R, 'worktree', 'add', '-q', '-b', 'keep', wt('keep'))
  const cardsBeforeRegister = await count('[data-worktree]')
  const added = await rpc(CTL, { cmd: 'add-repo', root: R })
  const registered = await waitState({ present: [R, wt('keep')] }, Date.now())
  result.register = { ok: added.ok ?? added.result?.ok ?? null, ms: registered.ms, cardsBeforeRegister, cardsAfterRegister: await count('[data-worktree]') }
  if (registered.ms === null) throw new Error('임시 레포 등록이 화면에 안 나왔다')
  fs.mkdirSync(ROOT, { recursive: true })
  decoy = new Decoy({ bin: ROOT })
  await decoy.start()
  result.decoyPid = decoy.pid
  await pause(1500)

  // ⓐ 외부 추가 → 등장
  for (let i = 1; i <= rounds; i += 1) {
    const target = wt(`na-${i}`)
    await measure(`K8a-${i}`, { present: [target] }, () => {
      const res = git(R, 'worktree', 'add', '-q', '-b', `na-${i}`, target)
      return { endedAt: res.endedAt, commands: [`git worktree add -b na-${i} <native-repo>/wt/na-${i}`] }
    })
    // 정리(기록만) — 다음 회차 전에 안정
    git(R, 'worktree', 'remove', owned(target))
    git(R, 'branch', '-D', `na-${i}`)
    await waitState({ absent: [target] }, Date.now())
    await pause(1200)
  }
  // ⓑ 외부 삭제 — task-finish 순서(remove --force ×2 → prune → branch -D ×2)
  for (let i = 1; i <= rounds; i += 1) {
    const a = wt(`nb-${i}`)
    const b = wt(`nb-${i}-claude`)
    git(R, 'worktree', 'add', '-q', '-b', `nb-${i}`, a)
    git(R, 'worktree', 'add', '-q', '-b', `nb-${i}-claude`, b)
    fs.writeFileSync(path.join(b, 'dirty.txt'), 'x\n')
    await waitState({ present: [a, b] }, Date.now())
    await pause(1200)
    await measure(`K8b-${i}`, { absent: [a, b], present: [wt('keep')] }, () => {
      const first = git(R, 'worktree', 'remove', '--force', owned(a)).endedAt
      git(R, 'worktree', 'remove', '--force', owned(b))
      git(R, 'worktree', 'prune')
      git(R, 'branch', '-D', `nb-${i}`)
      const last = git(R, 'branch', '-D', `nb-${i}-claude`).endedAt
      return { firstEndedAt: first, endedAt: last, commands: ['git worktree remove --force ×2', 'git worktree prune', 'git branch -D ×2'] }
    })
  }
  // ⓒ 마지막 linked 삭제(.git/worktrees 소멸) → 다시 추가
  let last = wt('keep')
  let lastBranch = 'keep'
  for (let i = 1; i <= rounds; i += 1) {
    const removeRow = await measure(`K8c-remove-${i}`, { absent: [last] }, () => {
      git(R, 'worktree', 'remove', owned(last))
      return { endedAt: git(R, 'branch', '-D', lastBranch).endedAt, commands: ['git worktree remove (마지막 linked)', 'git branch -D'] }
    })
    removeRow.worktreesDirGone = !fs.existsSync(path.join(R, '.git/worktrees'))
    last = wt(`nc-${i}`)
    lastBranch = `nc-${i}`
    const target = last
    const addRow = await measure(`K8c-readd-${i}`, { present: [target] }, () => {
      const res = git(R, 'worktree', 'add', '-q', '-b', lastBranch, target)
      return { endedAt: res.endedAt, commands: ['git worktree add (0 → 1)'] }
    })
    addRow.worktreesDirBack = fs.existsSync(path.join(R, '.git/worktrees'))
    await pause(1200)
  }
  // fix1 — 큰 worktree(파일 --bigrm 개) `.git` 먼저 → rm -rf (r1 F1 순서). 반영 시간은 기록, 유령이면 실패.
  const bigFiles = Number(args.bigrm ?? 0)
  if (bigFiles > 0) {
    for (let d = 0; d < Math.ceil(bigFiles / 1000); d += 1) {
      const dir = path.join(R, 'bulk', `d${d}`)
      fs.mkdirSync(dir, { recursive: true })
      for (let f = 0; f < 1000 && d * 1000 + f < bigFiles; f += 1) fs.writeFileSync(path.join(dir, `f${f}.txt`), `${d}-${f}\n`)
    }
    git(R, 'add', '-A')
    git(R, '-c', 'user.email=l445@example.invalid', '-c', 'user.name=l445', 'commit', '-q', '-m', 'bulk')
    const big = wt('nbig')
    git(R, 'worktree', 'add', '-q', '-b', 'nbig', big)
    await waitState({ present: [big] }, Date.now())
    await pause(1500)
    const row = await measure('K8-bigrm', { absent: [big] }, () => {
      const startedAt = Date.now()
      fs.rmSync(path.join(owned(big), '.git'))
      const rm = spawnSync('rm', ['-rf', owned(big)])
      if (rm.status !== 0) throw new Error(`rm -rf → ${rm.status}`)
      return { firstEndedAt: startedAt, endedAt: Date.now(), commands: [`rm <wt>/.git 먼저 → rm -rf <wt> (${bigFiles} 파일)`] }
    })
    row.rmMs = row.msFromFirstCommand === null || row.ms === null ? null : row.msFromFirstCommand - row.ms
    git(R, 'worktree', 'prune')
    git(R, 'branch', '-D', 'nbig')
    check('K8-bigrm', '큰 worktree rm -rf — 유령 없이 자동 반영(시간 기록)', row.ms !== null, { ms: row.ms, rmMs: row.rmMs })
  }
  for (const group of ['K8a', 'K8b', 'K8c-remove', 'K8c-readd']) {
    const rows = result.rounds.filter((row) => row.id.startsWith(`${group}-`))
    check(group, `${rows.length}회 전 회차 ≤ ${LIMIT_MS}ms · corral 포커스 아님`, rows.length >= rounds && rows.every((row) => row.pass), rows.map((row) => row.ms))
  }
  check('K8c-dir', '마지막 linked 삭제마다 .git/worktrees 소멸 · 다시 추가에 생김', result.rounds.filter((r) => r.id.startsWith('K8c-remove')).every((r) => r.worktreesDirGone) && result.rounds.filter((r) => r.id.startsWith('K8c-readd')).every((r) => r.worktreesDirBack), null)
  // 다른(사용자) 레포 카드 수가 회차 내내 같은가 — 값 없이 개수만
  const others = result.rounds.map((row) => row.cardsAfter - row.cardsBefore)
  result.cardDeltas = others
}

async function quitApp() {
  if (appPid !== null && alive(appPid)) {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(appPid)], { encoding: 'utf8' }).stdout
    if (!command.includes(appRoot)) throw new Error(`app pid ${appPid} 가 구현 worktree 빌드가 아니다 — 죽이지 않는다`)
    process.kill(appPid, 'SIGTERM')
    await until(() => !alive(appPid), 'app exit', 30_000)
  }
  await pause(800)
  result.electronLeft = corralElectron().length
}

function restore() {
  // 이 회차의 로그 꼬리 — 비공개 사본 + 커밋용 요약(태그 개수·tree.built 시각만)
  const nd = path.join(UD, 'corral.ndjson')
  if (ndjsonSize !== null && fs.existsSync(nd)) {
    const size = fs.statSync(nd).size
    const fd = fs.openSync(nd, 'r')
    const buffer = Buffer.alloc(Math.max(0, size - ndjsonSize))
    fs.readSync(fd, buffer, 0, buffer.length, ndjsonSize)
    fs.closeSync(fd)
    fs.writeFileSync(path.join(PRIV, 'run.ndjson'), buffer)
    const lines = buffer.toString('utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    const tags = {}
    for (const line of lines) tags[line.tag] = (tags[line.tag] ?? 0) + 1
    result.runLog = { lines: lines.length, tags, treeBuiltAt: lines.filter((l) => l.tag === 'tree.built').map((l) => l.at - t0), worktreeChangedAt: lines.filter((l) => l.tag === 'worktree.changed').map((l) => l.at - t0), errors: lines.filter((l) => /error|fail|uncaught/i.test(l.tag)).map((l) => l.tag) }
  }
  execFileSync('rsync', ['-a', '-c', '--delete', '--exclude', 'corral.ndjson', path.join(PRIV, 'backup/ud/'), `${UD}/`])
  if (ndjsonSize !== null && fs.existsSync(nd) && fs.statSync(nd).size >= ndjsonSize) fs.truncateSync(nd, ndjsonSize)
  const before = JSON.parse(fs.readFileSync(path.join(PRIV, 'ud-manifest-before.json'), 'utf8')).files
  const after = manifest(UD).files
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const mismatch = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
  result.restore.userData = { files: keys.length, mismatch: mismatch.length, reposJsonSha256After: after['repos.json']?.sha256 ?? null, reposJsonSame: before['repos.json']?.sha256 === after['repos.json']?.sha256, profileSame: before['runtime/profile.json']?.sha256 === after['runtime/profile.json']?.sha256 }
  if (mismatch.length > 0) fs.writeFileSync(path.join(PRIV, 'ud-mismatch.json'), JSON.stringify(mismatch))
  const hBefore = JSON.parse(fs.readFileSync(path.join(PRIV, 'herdr-manifest-before.json'), 'utf8')).files
  const hAfter = manifest(HCFG, true).files
  const hKeys = [...new Set([...Object.keys(hBefore), ...Object.keys(hAfter)])]
  result.restore.herdrTop = { files: hKeys.length, changed: hKeys.filter((k) => JSON.stringify(hBefore[k]) !== JSON.stringify(hAfter[k])) }
  result.restore.herdrDefaultEnd = herdrDefault()
  result.restore.herdrListEnd = herdrList()
  result.restore.providerEnd = providerHash()
  result.restore.providerSame = result.restore.providerEnd === result.pre.providerStart
  check('K8d', 'userData 전 파일 해시 전=후(repos.json·profile.json 포함)', mismatch.length === 0 && result.restore.userData.reposJsonSame && result.restore.userData.profileSame, result.restore.userData)
  check('K8e', 'herdr default 시작·끝 stopped · ~/.config/herdr 최상위 무변경', result.pre.herdrDefault === 'stopped' && result.restore.herdrDefaultEnd === 'stopped' && result.restore.herdrTop.changed.length === 0, { start: result.pre.herdrDefault, end: result.restore.herdrDefaultEnd, changed: result.restore.herdrTop.changed })
  check('G-provider', 'provider 설정 해시 전=후(읽기만)', result.restore.providerSame, null)
}

let code = 2
try {
  const stop = precheck()
  if (stop !== null) {
    result.stopped = stop
    log('STOP', stop)
    code = 3
  } else {
    backup()
    try {
      rewriteProfile()
      await launch()
      await gate()
      code = result.checks.every((c) => c.pass) ? 0 : 1
    } catch (error) {
      if (error instanceof Interrupted) {
        code = 4
        result.interrupted = String(error.message)
      } else {
        result.error = tilde(String(error?.stack ?? error))
        log('ERROR', result.error)
        code = 2
      }
    } finally {
      decoy?.stop()
      try {
        await quitApp()
      } catch (error) {
        result.notes.push({ quitError: tilde(String(error)) })
      }
      if (changedProfile) restore()
      // 임시 레포 — 관문이 만든 것(G8)
      fs.rmSync(REPO_BASE, { recursive: true, force: true })
      fs.rmSync(ROOT, { recursive: true, force: true })
      if (code === 0 && !result.checks.every((c) => c.pass)) code = 1
    }
  }
} finally {
  result.endedAt = new Date().toISOString()
  result.envEnd = { load: load(), yes: yesCount() }
  result.leftover = spawnSync('ps', ['-Ao', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /l445|corral.*Electron|herdr --session default/.test(l) && !/grep|native-k8/.test(l)).map((l) => tilde(l).slice(0, 160))
  fs.writeFileSync(path.join(out, 'native-k8.json'), JSON.stringify(result, null, 2) + '\n')
  log('exit', code)
  process.exitCode = code
}
