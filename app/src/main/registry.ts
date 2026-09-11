// 레포 레지스트리 — **corral 이 소유하는 유일한 영속 상태** (기준 N3).
//
// 저장하는 것은 **레포 루트 경로 목록뿐**이다. worktree 목록도, 어느 것이 열려 있는지도
// 저장하지 않는다 — 그건 git 과 herdr 에서 읽는다. 저장하는 순간 두 진실이 생기고 낡는다.
//
// 형식·위치 (A2): `<userData>/repos.json`, 원자적 쓰기(같은 디렉터리에 tmp → rename).
// electron-store 를 쓰지 않은 이유 (수정 1회차 L11 — 1회차 문장이 이 레포의 모듈 형식과
// 안 맞았다): electron-store 11 은 **ESM 전용**이고, 그 함정은 main 을 CJS 로 묶는 설정에서
// `Store is not a constructor` 로 터지는 것이다 (분석 §5 U4). 이 앱의 main 은 ESM 이라
// 그 함정 자체는 안 밟는다 — 그래도 안 쓴다: 저장하는 것이 **경로 목록 한 줄**이라
// 의존성·마이그레이션·스키마를 얹을 값이 없다. tmp→rename 이 같은 보장을 더 싸게 준다.
// 계측은 `CORRAL_REGISTRY` 로 파일 경로를 통째로 돌린다 (관문 ④ 격리).

import fs from 'node:fs'
import path from 'node:path'
import { isRecord, readArray, safeParse } from '../shared/json.js'
import { canonicalPath } from './canonical-path.js'
import type { AddRepoResult, RegistryState } from '../shared/types.js'
import { log } from './log.js'

const VERSION = 1

export class RepoRegistry {
  private readonly file: string
  private roots: string[] = []
  private lastError: string | null = null

  constructor(userDataDir: string) {
    const fromEnv = process.env.CORRAL_REGISTRY
    this.file = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(userDataDir, 'repos.json')
  }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) {
        this.roots = []
        this.lastError = null
        log('registry.load', { file: this.file, roots: 0, note: '파일 없음 — 빈 레지스트리' })
        return
      }
      const parsed = safeParse(fs.readFileSync(this.file, 'utf8'))
      if (!isRecord(parsed)) throw new Error('레지스트리 파일이 객체가 아니다')
      const roots: string[] = []
      for (const item of readArray(parsed, 'repos')) {
        if (typeof item !== 'string' || item.length === 0) continue
        if (!roots.includes(item)) roots.push(item)
      }
      this.roots = roots.sort()
      this.lastError = null
      log('registry.load', { file: this.file, roots: this.roots.length })
    } catch (error) {
      this.roots = []
      this.lastError = String(error)
      log('registry.load_failed', { file: this.file, error: String(error) })
    }
  }

  state(): RegistryState {
    return { file: this.file, roots: [...this.roots], lastError: this.lastError }
  }

  list(): string[] {
    return [...this.roots]
  }

  /**
   * 레포 루트를 더한다. 받는 것은 사용자가 친 경로고, **레포 루트로 정규화해서** 넣는다 —
   * worktree 안쪽 경로를 그대로 넣으면 같은 레포가 두 줄로 앉는다.
   */
  add(input: string): AddRepoResult {
    const raw = input.trim()
    if (raw.length === 0) return { ok: false, error: '경로가 비었다' }
    const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : raw
    // 조인에 쓰는 경로는 전부 같은 정규화를 지난다 (L8) — symlink 로 등록해도 git·herdr 와 맞는다.
    const resolved = canonicalPath(expanded)
    if (!fs.existsSync(resolved)) return { ok: false, error: `없는 경로다: ${resolved}` }
    const root = repoRootOf(resolved)
    if (root === null) return { ok: false, error: `git 레포가 아니다: ${resolved}` }
    if (this.roots.includes(root)) return { ok: true, root }
    const next = [...this.roots, root].sort()
    const saved = this.save(next)
    if (!saved.ok) return { ok: false, error: saved.error }
    this.roots = next
    log('registry.added', { root, roots: this.roots.length, file: this.file })
    return { ok: true, root }
  }

  /** 원자적 쓰기 — 같은 디렉터리에 tmp 를 쓰고 rename 한다 (rename 은 같은 파일시스템에서 원자적). */
  private save(roots: string[]): { ok: true } | { ok: false; error: string } {
    const payload = JSON.stringify({ version: VERSION, repos: roots }, null, 2) + '\n'
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload)
      fs.renameSync(tmp, this.file)
      this.lastError = null
      return { ok: true }
    } catch (error) {
      fs.rmSync(tmp, { force: true })
      this.lastError = String(error)
      log('registry.save_failed', { file: this.file, error: String(error) })
      return { ok: false, error: String(error) }
    }
  }
}

/** 그 경로가 속한 **레포 루트**(주 체크아웃)를 찾는다. worktree 안쪽을 줘도 루트로 접힌다. */
function repoRootOf(target: string): string | null {
  let dir = fs.statSync(target).isDirectory() ? target : path.dirname(target)
  for (;;) {
    const git = path.join(dir, '.git')
    if (fs.existsSync(git)) {
      const stat = fs.statSync(git)
      // 디렉터리면 주 체크아웃이다. 파일이면 링크된 worktree — `gitdir:` 를 따라 주 체크아웃으로 간다.
      if (stat.isDirectory()) return dir
      const pointer = fs.readFileSync(git, 'utf8').trim()
      const match = /^gitdir:\s*(.+)$/.exec(pointer)
      if (match === null || match[1] === undefined) return dir
      // <main>/.git/worktrees/<name> → <main>
      const worktreeGitDir = canonicalPath(path.resolve(dir, match[1]))
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`
      const index = worktreeGitDir.indexOf(marker)
      return index === -1 ? dir : worktreeGitDir.slice(0, index)
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
