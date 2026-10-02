// 외부 git worktree 변경 감지 (LIFE-445) — 셸 `git worktree add/remove/prune` 은 corral 이벤트를 하나도 내지 않는다.
//
// **값싼 지문 폴링**이다. 레포마다 git 공통 디렉터리의 `worktrees/` 이름 목록과, 각 항목의 `gitdir` 파일(그 worktree 의
// `.git` 파일 경로)과 그 대상의 존재만 읽는다 — git 프로세스를 띄우지 않는다. 지문이 바뀐 틱에만 재빌드를 부른다.
//
// 왜 네이티브 감시(fs.watch)가 아닌가 (00-analysis E2·F1):
//   · macOS libuv 는 감시를 열고 닫을 때마다 FSEventStream 을 다시 만들고 그 사이 이벤트를 버린다 — 「반드시 반영」 근거가 못 된다
//   · 마지막 linked 를 지우면 `.git/worktrees` 자체가 사라져 감시 루트가 없어진다 — 재무장이 따로 필요하다
//   · orca 도 감시 위에 폴링 대조를 백스톱으로 둔다(E1). 백스톱만으로 5초 안에 들어오면 감시는 군더더기다
// 되먹임 없음 (F7): 지문에 파일 내용·mtime 이 없다. 재빌드의 `git status` 가 `worktrees/<이름>/index` 를 고쳐도 지문은 그대로다.

import fs from 'node:fs/promises'
import path from 'node:path'

/** 기본 주기 — 반영 통과선 5초(기준 Q4) 안에 뭉침 80ms·재빌드가 넉넉히 들어간다. `CORRAL_WORKTREE_POLL_MS=0` 이면 끈다(계측용). */
export const WORKTREE_POLL_MS = 1000

/**
 * 레포 root 의 git 공통 디렉터리 — `git rev-parse --git-common-dir` 과 같은 답을 파일만 읽어 낸다.
 * `.git` 이 디렉터리면 그것, 파일(`gitdir: X`)이면 X 의 `commondir` 을 따른다(등록 root 가 linked worktree 인 경우).
 */
export async function gitCommonDir(root: string): Promise<string> {
  const dotGit = path.join(root, '.git')
  const stat = await fs.stat(dotGit)
  if (stat.isDirectory()) return dotGit
  const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'))?.[1]
  if (pointer === undefined) throw new Error(`.git 파일 모양을 모른다: ${dotGit}`)
  const gitDir = path.resolve(root, pointer.trim())
  try {
    return path.resolve(gitDir, (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim())
  } catch {
    return gitDir
  }
}

/**
 * 레포 하나의 worktree 지문. 같으면 `git worktree list` 결과(디렉터리 있는 것)도 같다고 본다.
 * 읽기 실패도 지문이다(`error:<code>`) — 실패로 바뀐 순간 한 번 재빌드하고, 계속 실패하면 조용하다.
 */
export async function worktreeFingerprint(root: string): Promise<string> {
  let common: string
  try {
    common = await gitCommonDir(root)
  } catch (error) {
    return `error:${errorCode(error)}`
  }
  const dir = path.join(common, 'worktrees')
  let names: string[]
  try {
    names = (await fs.readdir(dir)).sort()
  } catch (error) {
    // 마지막 linked 를 지우면 git 이 이 디렉터리를 지운다(F1) — 없음도 하나의 상태다.
    return errorCode(error) === 'ENOENT' ? 'none' : `error:${errorCode(error)}`
  }
  const parts = await Promise.all(
    names.map(async (name) => {
      const target = await fs.readFile(path.join(dir, name, 'gitdir'), 'utf8').then((text) => text.trim(), () => '')
      // 대상의 존재 — `rm -rf` 한 worktree(prunable, F2)도 지문이 바뀐다.
      const exists = target === '' ? false : await fs.access(target).then(() => true, () => false)
      return `${name}\t${target}\t${exists ? 1 : 0}`
    }),
  )
  return parts.join('\n')
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'
}

/**
 * 등록 레포들의 지문을 주기로 대조한다. 바뀐 레포가 있으면 `onChange` 한 번 — 재빌드는 부르는 쪽의 뭉침·세대 가드를 탄다.
 * 처음 보는 레포도 바뀐 것으로 친다: 등록·기동 재빌드가 git 을 읽은 뒤 첫 지문을 뜨기 전까지의 변화를 놓치지 않으려고.
 * 레지스트리에서 빠진 레포는 상태를 버린다(누수 없음).
 */
export class WorktreePoller {
  private readonly prints = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly options: {
      roots: () => readonly string[]
      onChange: (changed: string[]) => void
      onRoots?: (count: number) => void
      fingerprint?: (root: string) => Promise<string>
    },
  ) {}

  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer !== null) return
    this.timer = setInterval(() => void this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** 한 번 대조한다. 앞 틱이 아직 돌고 있으면 건너뛴다(겹치지 않는다). 바뀐 root 목록을 돌려준다. */
  async tick(): Promise<string[]> {
    if (this.running) return []
    this.running = true
    try {
      let roots: readonly string[]
      try {
        roots = this.options.roots()
      } catch {
        return [] // 레지스트리 읽기 실패 — 상태를 건드리지 않는다(일시 오류로 전부 「새 레포」가 되지 않게)
      }
      const fingerprint = this.options.fingerprint ?? worktreeFingerprint
      const fresh = await Promise.all(roots.map(async (root) => [root, await fingerprint(root)] as const))
      const changed = fresh.filter(([root, print]) => this.prints.get(root) !== print).map(([root]) => root)
      const sizeBefore = this.prints.size
      const live = new Set(roots)
      for (const root of [...this.prints.keys()]) if (!live.has(root)) this.prints.delete(root)
      for (const [root, print] of fresh) this.prints.set(root, print)
      if (this.prints.size !== sizeBefore) this.options.onRoots?.(this.prints.size)
      if (changed.length > 0) this.options.onChange(changed)
      return changed
    } finally {
      this.running = false
    }
  }

  /** 지금 상태를 든 레포 수 (계측·시험용). */
  size(): number {
    return this.prints.size
  }
}
