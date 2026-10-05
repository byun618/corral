// LIFE-511 측정 도구 보강 — F18(Orca dev 가 실제 ~/.orca/keybindings.json 을 읽는다) · F19(/tmp 정리로 빈 껍데기가 된 fixture·체크아웃) ·
// 504 가드(같은 격리 경로·herdr 세션을 쓰는 프로세스). 판정은 순수 함수(단위 테스트 `diff.test.mjs`), 파일·git·ps 를 읽는 것은 아래 probe* 다.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// ---- F18 --------------------------------------------------------------------
/** 파일 지문 — 없으면 「없음」 도 값이다(전후 비교 대상). */
export function fileFingerprint(file) {
  if (!fs.existsSync(file)) return { file, exists: false, sha256: null, size: null, mtimeMs: null }
  const stat = fs.statSync(file)
  return { file, exists: true, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs }
}

/**
 * 측정 전·후 지문이 같은가. **하나라도 다르면 실패**(존재·sha256·크기·mtime). 둘 중 하나라도 못 쟀으면(null) 통과로 세지 않는다 —
 * 「못 봤다」 를 「안 바뀌었다」 로 읽지 않는다.
 */
export function keybindingsLeakVerdict({ before, after }) {
  if (!before || !after) return { pass: false, why: `F18 지문을 못 쟀다(전 ${before ? '있음' : '없음'} · 후 ${after ? '있음' : '없음'})` }
  const changed = ['exists', 'sha256', 'size', 'mtimeMs'].filter((key) => before[key] !== after[key])
  if (changed.length === 0) return { pass: true, why: null }
  return { pass: false, why: `F18 ~/.orca/keybindings.json 이 측정 중 바뀌었다(${changed.map((key) => `${key} ${before[key]}→${after[key]}`).join(', ')})` }
}

// ---- F19 --------------------------------------------------------------------
/**
 * fixture 레포가 쓸 수 있는가. `.git` 이 있는 것만으로는 모른다 — macOS /tmp 정리가 객체·HEAD 를 지우고 폴더 껍데기만 남긴 회차가 있었다
 * (510 R001 `Not a valid git repository`). 기준: HEAD 를 풀 수 있고 · worktree 가 2개(본체 + `-wt`) · `-wt/.git` 파일 · README.md.
 */
export function fixtureVerdict(probe) {
  if (!probe.gitDir) return { state: 'absent', why: '.git 없음 — 새로 만든다' }
  const missing = [
    probe.headOk ? null : 'HEAD 를 못 푼다(git rev-parse --verify HEAD 실패)',
    probe.worktrees === 2 ? null : `worktree ${probe.worktrees}개(2개여야 한다)`,
    probe.wtGitFile ? null : '-wt/.git 파일 없음',
    probe.readme ? null : 'README.md 없음',
  ].filter(Boolean)
  return missing.length === 0 ? { state: 'ok', why: null } : { state: 'shell', why: `빈 껍데기 — ${missing.join(' · ')}` }
}

export function probeFixture({ root, worktree }) {
  const gitDir = fs.existsSync(path.join(root, '.git'))
  if (!gitDir) return { gitDir }
  const head = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' })
  const list = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  return {
    gitDir,
    headOk: head.status === 0,
    worktrees: list.status === 0 ? list.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length : 0,
    wtGitFile: fs.existsSync(path.join(worktree, '.git')) && fs.statSync(path.join(worktree, '.git')).isFile(),
    readme: fs.existsSync(path.join(root, 'README.md')),
  }
}

/**
 * Orca 체크아웃이 측정 기준(v1.4.198)으로 쓸 수 있는가. **자동 재취득은 하지 않는다** — 체크아웃은 사용자 기계의 /tmp 에 510 이 만든 것이고
 * 재취득(clone + pnpm install)은 수 분 걸리는 네트워크 작업이라 측정 중에 몰래 하지 않는다. 원인과 함께 멈춘다(종료코드 2).
 */
export function orcaCheckoutVerdict(probe, { wantTag = 'v1.4.198' } = {}) {
  if (!probe.exists) return { ok: false, why: `Orca 체크아웃이 없다(${probe.repo})` }
  const missing = [
    probe.statusOk ? null : `git status 실패 — 빈 껍데기거나 git 저장소가 아니다(${probe.statusError ?? '?'})`,
    probe.tag === wantTag ? null : `태그 ${probe.tag ?? '없음'} ≠ ${wantTag}`,
    probe.electronVite ? null : 'node_modules/.bin/electron-vite 없음(pnpm install 필요)',
    probe.runner ? null : 'config/scripts/run-electron-vite-dev.mjs 없음',
    probe.constants ? null : 'src/shared/constants.ts 없음',
  ].filter(Boolean)
  return missing.length === 0 ? { ok: true, why: null } : { ok: false, why: `Orca 체크아웃을 쓸 수 없다(${probe.repo}): ${missing.join(' · ')} — 재취득: git clone --depth 1 --branch ${wantTag} https://github.com/stablyai/orca.git && pnpm install` }
}

export function probeOrcaCheckout(repo) {
  if (!fs.existsSync(repo)) return { repo, exists: false }
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
  const tag = spawnSync('git', ['-C', repo, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' })
  return {
    repo,
    exists: true,
    statusOk: status.status === 0,
    statusError: status.status === 0 ? null : (status.stderr || '').trim().slice(0, 160),
    tag: tag.status === 0 ? tag.stdout.trim() : null,
    electronVite: fs.existsSync(path.join(repo, 'node_modules/.bin/electron-vite')),
    runner: fs.existsSync(path.join(repo, 'config/scripts/run-electron-vite-dev.mjs')),
    constants: fs.existsSync(path.join(repo, 'src/shared/constants.ts')),
  }
}

// ---- 504 가드 ----------------------------------------------------------------
/**
 * 같은 격리 작업 폴더 또는 같은 herdr 세션 이름(`l443-gui-diff`)을 쓰는 프로세스가 있으면 측정하지 않는다(LIFE-504 R7 — `corral open` 이
 * 기존 데스크톱을 재사용해 남의 pid 를 돌려준 사건). `ps` 목록 줄에서 자기 자신과 이 검사 명령은 뺀다.
 */
export function guard504Verdict({ lines, works, session = 'l443-gui-diff', self = [] }) {
  const hits = lines.filter((line) => {
    const pid = Number(line.trim().split(/\s+/)[0])
    // 자기 자신과 부모(이 명령을 띄운 셸)만 뺀다 — 다른 measure.mjs 는 빼지 않는다(같은 작업 폴더를 쓰는 동시 회차가 바로 막을 대상이다).
    if (self.includes(pid)) return false
    return works.some((work) => line.includes(work)) || line.includes(`--session ${session}`)
  })
  return { pass: hits.length === 0, hits }
}

export function probe504({ work, session = 'l443-gui-diff' }) {
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const lines = ps.status === 0 ? ps.stdout.split('\n').filter(Boolean) : []
  // /tmp 는 /private/tmp 의 링크라 명령줄에 둘 중 어느 꼴로든 나온다.
  const works = [...new Set([work, fs.existsSync(work) ? fs.realpathSync(work) : work])]
  return { ok: ps.status === 0, error: ps.status === 0 ? null : (ps.stderr || '').trim(), works, ...guard504Verdict({ lines, works, session, self: [process.pid, process.ppid] }) }
}
