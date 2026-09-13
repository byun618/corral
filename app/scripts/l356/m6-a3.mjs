// M6 — A3. "닫기 직후 pyenv 락 잔존 여부" 실측 1회 (분석 §5-1.5 보완). 리스크 크기를 남긴다.
//
// pyenv 락 = `$PYENV_ROOT/shims/.pyenv-shim` (일반 파일). pyenv-rehash 가 acquire_lock 으로
// 만들고 `trap release_lock EXIT` 로 지운다 — SIGKILL 은 트랩을 건너뛰어 락이 잔존한다. 잔존 시
// 다음 rehash 는 60초(PYENV_REHASH_TIMEOUT) 재시도 후 실패. **자가 치유 없음** (rm 전까지 영속).
//
// 안전: 사용자 ~/.pyenv 는 **읽기로도 안 건드린다** (불가침). 강제 재현은 **격리 PYENV_ROOT**
// (tmp) 를 tab env 로 주입해 그 위에서만 돌린다. 사용자 락 경로는 관측만(전/후 부재 확인).
//
// 두 부분:
//   A3-실사용: corral 정상 닫기 10회(생성 직후 닫기 — ⓐ 창) → 사용자 락 경로 부재 유지?
//              (이 환경 셸 rc 에 pyenv init 이 없어 startup rehash 가 안 돈다 — 그 사실도 기록)
//   A3-강제  : 격리 PYENV_ROOT 에서 `pyenv rehash` 루프를 돌리는 탭을 corral UI 로 닫아
//              닫기 직후 격리 락 잔존율을 잰다 (리스크 크기).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const USER_LOCK = path.join(os.homedir(), '.pyenv', 'shims', '.pyenv-shim')
const app = await startApp({ name: 'm6-a3' })
const out = {
  at: new Date().toISOString(),
  ready: app.ready,
  mechanism: {
    lockPath: '$PYENV_ROOT/shims/.pyenv-shim',
    createdBy: 'pyenv-rehash acquire_lock (echo -n > 파일, noclobber)',
    releasedBy: 'trap release_lock EXIT (rm -f) — SIGKILL 은 트랩 우회 → 잔존',
    recovery: '다음 rehash 가 PYENV_REHASH_TIMEOUT=60s 재시도 후 실패. 자가 치유 없음(수동 rm 필요)',
    source: '/opt/homebrew/opt/pyenv/libexec/pyenv-rehash',
  },
  realistic: {},
  forced: {},
}

function userLockPresent() {
  try { return fs.existsSync(USER_LOCK) } catch { return null }
}
async function panesInWs(workspaceId) {
  return (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === workspaceId)
}

try {
  out.realistic.userLockBaseline = userLockPresent()
  out.realistic.pyenvInitInRc = false // grep 확인: ~/.zshenv·zprofile·zshrc·zlogin 에 pyenv 0건

  const repo = makeScratchRepo('a3')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })
  await app.click(`[data-open-worktree="${repo.root}"]`)
  const workspaceId = (await until(async () => {
    const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
    return wt?.workspace?.workspaceId ?? null
  }, { what: 'primary ws', timeoutMs: 15000 })).value

  // ---------- A3-실사용: 정상 닫기 10회, 사용자 락 부재 유지 ----------
  const realisticRounds = []
  for (let i = 0; i < 10; i++) {
    const before = new Set((await panesInWs(workspaceId)).map((p) => p.pane_id))
    await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
    const pane = (await until(async () => {
      for (const p of await panesInWs(workspaceId)) if (!before.has(p.pane_id)) return p
      return null
    }, { what: 'pane', timeoutMs: 12000 })).value
    // 생성 직후(프롬프트 정착 전) 바로 닫는다 — ⓐ 창 최대화. 셸만이라 게이트 clear → 모달 없음.
    await app.click(`[data-close-tab="${pane.tab_id}"]`)
    await until(async () => !(await panesInWs(workspaceId)).some((p) => p.pane_id === pane.pane_id), { what: 'closed', timeoutMs: 12000 })
    // 닫기 직후 사용자 락 관측 (2초 폴)
    let sawLock = false
    for (let t = 0; t < 20; t++) { if (userLockPresent()) { sawLock = true; break } await sleep(100) }
    realisticRounds.push({ round: i + 1, userLockAfterClose: sawLock })
  }
  out.realistic.rounds = realisticRounds
  out.realistic.userLockEverAppeared = realisticRounds.some((r) => r.userLockAfterClose)
  out.realistic.userLockFinal = userLockPresent()
  console.log(`[A3-realistic] userLockEverAppeared=${out.realistic.userLockEverAppeared} (rc pyenv init 없음 → startup rehash 안 돎)`)

  // ---------- A3-강제: 격리 PYENV_ROOT 에서 rehash 루프 탭을 corral UI 로 닫기 ----------
  const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'l356-pyenv-'))
  fs.mkdirSync(path.join(isoRoot, 'shims'), { recursive: true })
  // rehash 가 할 일이 있도록 가짜 버전에 실행파일 몇 개
  const vbin = path.join(isoRoot, 'versions', '3.0.0', 'bin')
  fs.mkdirSync(vbin, { recursive: true })
  for (const exe of ['python', 'pip', 'python3', 'pip3', 'pydoc', 'idle', 'wheel', 'easy_install']) {
    const f = path.join(vbin, exe)
    fs.writeFileSync(f, '#!/bin/sh\n')
    fs.chmodSync(f, 0o755)
  }
  const isoLock = path.join(isoRoot, 'shims', '.pyenv-shim')
  // pyenv 절대경로 (init 함수가 rc 에 없으니 바이너리로 해석되지만, 확정을 위해 경로를 잡는다)
  const pyenvBin = ['/opt/homebrew/bin/pyenv', path.join(os.homedir(), '.pyenv/bin/pyenv')].find((p) => fs.existsSync(p)) ?? 'pyenv'
  out.forced.isoRoot = isoRoot
  out.forced.pyenvBin = pyenvBin

  const forcedRounds = []
  const CYCLES = 5
  for (let i = 0; i < CYCLES; i++) {
    // env 를 심어 탭 생성 (setup — herdr 직접). corral 은 이 탭을 목록에 보이고 UI 로 닫는다.
    const created = await herdrRequest('tab.create', { workspace_id: workspaceId, cwd: repo.root, env: { PYENV_ROOT: isoRoot } })
    const paneId = created.root_pane?.pane_id
    const tabId = created.tab?.tab_id
    await until(async () => (await panesInWs(workspaceId)).some((p) => p.pane_id === paneId), { what: 'pane up', timeoutMs: 12000 })
    await sleep(800)
    // rehash 를 촘촘히 돌린다 — 락이 자주 존재하는 상태
    await herdrRequest('pane.send_text', { pane_id: paneId, text: `export PYENV_ROOT='${isoRoot}'; while true; do '${pyenvBin}' rehash; done\n` })
    // 격리 락이 한 번이라도 뜰 때까지 (rehash 진행 중 확인)
    const lockSeen = await until(async () => (fs.existsSync(isoLock) ? true : null), { what: 'iso lock present', timeoutMs: 8000, everyMs: 30 })
    // corral UI 로 닫는다 — 살아있는 프로세스라 게이트 → 모달 → 승인
    await app.click(`[data-close-tab="${tabId}"]`)
    const modal = await until(async () => ((await app.query('[data-confirm-close-modal]')).found.length > 0 ? true : null), { what: 'modal', timeoutMs: 6000, everyMs: 60 })
    if (modal.ok) await app.click('[data-close-confirm-ok]')
    await until(async () => !(await panesInWs(workspaceId)).some((p) => p.pane_id === paneId), { what: 'tab closed', timeoutMs: 12000 })
    // 닫기 직후 격리 락 잔존 관측 (3초 — 루프 죽었으니 다시 생기지 않는다)
    await sleep(3000)
    const residual = fs.existsSync(isoLock)
    forcedRounds.push({ round: i + 1, lockSeenDuringRehash: lockSeen.ok, modalShown: modal.ok, residualAfterClose: residual })
    console.log(`[A3-forced ${i + 1}/${CYCLES}] lockSeen=${lockSeen.ok} residual=${residual}`)
    if (residual) fs.rmSync(isoLock, { force: true }) // 다음 회차 위해 정리 (격리 경로)
  }
  out.forced.rounds = forcedRounds
  out.forced.residualCount = forcedRounds.filter((r) => r.residualAfterClose).length
  out.forced.cycles = CYCLES

  // 정리
  fs.rmSync(isoRoot, { recursive: true, force: true })
  for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
    await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
  }

  out.summary = {
    userLockUntouched: out.realistic.userLockBaseline === false && out.realistic.userLockFinal === false && !out.realistic.userLockEverAppeared,
    realisticRehashTriggered: out.realistic.userLockEverAppeared,
    forcedResidualRate: `${out.forced.residualCount}/${out.forced.cycles}`,
  }
  // 판정 없음 — 리스크 기록이 산출물이다. 다만 사용자 리소스 불가침은 게이트.
  out.verdict = out.summary.userLockUntouched ? 'RECORDED' : 'FAIL(사용자 락 오염)'
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

writeRaw('m6-a3.json', out)
console.log('\nM6(A3):', out.verdict, JSON.stringify(out.summary))
if (out.verdict.startsWith('FAIL')) process.exitCode = 1
