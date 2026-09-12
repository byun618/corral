// 고른 폴더 하나를 **등록할 레포 루트 목록**으로 바꾼다 (게이트 ① 2번째 지시, 2026-09-12).
//
// 규칙은 두 갈래다:
//   ① 고른 폴더가 git 레포면 (`git rev-parse --git-dir` 성공) → 그것 하나
//   ② 아니면 **바로 아래 1단계 자식**만 훑어 git 레포인 것들 → 전부
//
// 1단계에서 멈추는 이유: 깊이를 열면 `~/repos` 같은 폴더에서 worktree·서브모듈·`node_modules`
// 안쪽까지 기어들어가 수백 줄이 된다. "레포가 많은 폴더" 는 보통 한 단 아래에 레포를 둔다.
//
// **레포 루트로 접는 일은 여기서 안 한다.** 여기가 내놓는 것은 후보 경로고, 정규화·접힘·중복은
// `RepoRegistry.add()` 가 한다 (지시 (3) — 기존 로직 재사용). 그래서 ① 은 하위 폴더를 골라도
// 되고, 그때 레지스트리에 앉는 것은 레포 루트다.

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

/** `git -C <dir> rev-parse --git-dir` 이 0 으로 끝나나. 프로세스를 띄우는 판별이라 비동기다. */
export function isGitRepo(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'rev-parse', '--git-dir'], { timeout: 5000 }, (error) => resolve(error === null))
  })
}

export type BrowseDecision = {
  mode: 'repo' | 'scan'
  candidates: string[]
  /** `scan` 에서 실제로 들여다본 자식 수 — 0개일 때 "빈 폴더였나" 를 원자료가 말할 수 있게. */
  scanned: number
}

export async function decideRoots(selected: string): Promise<BrowseDecision> {
  if (await isGitRepo(selected)) return { mode: 'repo', candidates: [selected], scanned: 0 }

  let entries: string[] = []
  try {
    const dirents = await fs.readdir(selected, { withFileTypes: true })
    // 심링크도 폴더일 수 있다 — `isDirectory()` 만 보면 놓친다. 숨김 폴더는 건너뛴다(.git 포함).
    entries = dirents.filter((item) => !item.name.startsWith('.')).map((item) => path.join(selected, item.name))
  } catch {
    return { mode: 'scan', candidates: [], scanned: 0 }
  }

  const dirs: string[] = []
  for (const entry of entries) {
    try {
      if ((await fs.stat(entry)).isDirectory()) dirs.push(entry)
    } catch {
      // 읽을 수 없는 항목은 그냥 건너뛴다 — 하나 때문에 폴더 전체가 실패하면 안 된다.
    }
  }
  const checks = await Promise.all(dirs.map(async (dir) => ({ dir, repo: await isGitRepo(dir) })))
  return { mode: 'scan', candidates: checks.filter((item) => item.repo).map((item) => item.dir).sort(), scanned: dirs.length }
}
