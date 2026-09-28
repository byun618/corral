// 버리는 fixture 레포 (C2ⓔ). **두 앱에 같은 것을 물린다** — 내용이 다르면 그 차이가
// UI 차이로 둔갑한다. 사용자 레포는 절대 등록하지 않는다: corral 자신을 두 앱에 물리면
// 사이드바에 진짜 작업 상태가 섞여 캡처가 재현되지 않는다.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const git = (args, cwd) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  })
  if (result.status !== 0) {
    throw new Error(`[fixture] git ${args.join(' ')} → ${result.status}\n${result.stderr}`)
  }
  return result.stdout
}

/**
 * fixture 레포를 만든다. 이미 있으면 그대로 쓴다 — 회차마다 다시 만들면 커밋 해시·mtime 이
 * 달라져 "브랜치 이름·상대 시간" 을 그리는 칸이 흔들린다(재현성 C10).
 *
 * @returns { root, worktree, branch } — root 는 주 체크아웃, worktree 는 linked 체크아웃
 */
export function ensureFixtureRepo(baseDir, { name = 'gui-diff-fixture' } = {}) {
  const root = path.join(baseDir, name)
  const worktree = path.join(baseDir, `${name}-wt`)
  if (fs.existsSync(path.join(root, '.git'))) {
    return { root: fs.realpathSync(root), worktree: fs.existsSync(worktree) ? fs.realpathSync(worktree) : null, created: false }
  }
  fs.mkdirSync(root, { recursive: true })
  git(['init', '-b', 'main', '.'], root)
  git(['config', 'user.name', 'GUI Diff Fixture'], root)
  git(['config', 'user.email', 'fixture@example.invalid'], root)
  // 사이드바가 그릴 것이 있어야 한다: 파일 하나 + 커밋 하나.
  fs.writeFileSync(path.join(root, 'README.md'), '# gui-diff fixture\n\nLIFE-443 측정용 버리는 레포.\n')
  git(['add', '-A'], root)
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture: initial'], root)
  // linked worktree 하나 — 두 앱 모두 "레포 아래 체크아웃 여러 개" 를 그리는 자리가 여기다.
  git(['worktree', 'add', '-b', 'fixture-feature', worktree], root)
  return { root: fs.realpathSync(root), worktree: fs.realpathSync(worktree), created: true }
}
