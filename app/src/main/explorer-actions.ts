// 탐색기 우클릭 메뉴 동작 (LIFE-589 E6) — 전부 비파괴. 경로는 `confine` 을 지난 것만 쓴다(E7).
//   copyPath         절대 경로(루트 + 상대 — 링크를 풀지 않은 논리 경로, VS Code 「Copy Path」 와 같다)
//   copyRelativePath worktree 루트 기준 상대 경로(VS Code 「Copy Relative Path」 — 구분자 `/`)
//   reveal           Finder 에서 보기(`shell.showItemInFolder`)
//   openTerminal     폴더면 그 폴더, 파일이면 부모 폴더를 cwd 로 그 worktree 에 새 셸 탭 — main 의 기존 탭 만들기 입구(`createRowInWorkspace`)로 간다(어댑터 경계)
import path from 'node:path'
import { parentRel, type ExplorerActionResult } from '../shared/explorer.js'
import { confine } from './explorer-fs.js'

export type ExplorerActionDeps = {
  roots: () => readonly string[]
  writeClipboard: (text: string) => void
  showItemInFolder: (target: string) => void
  /** 그 worktree 루트의 열린 workspace 에 셸 탭(cwd). 실패면 오류 문자열. */
  openShell: (input: { root: string; cwd: string }) => Promise<string | null>
}

const KINDS = ['copyPath', 'copyRelativePath', 'reveal', 'openTerminal'] as const

export async function explorerAction(deps: ExplorerActionDeps, input: unknown): Promise<ExplorerActionResult> {
  const record = typeof input === 'object' && input !== null ? input : {}
  const action = 'action' in record ? record.action : undefined
  const root = 'root' in record ? record.root : undefined
  const rel = 'rel' in record ? record.rel : undefined
  const kind = KINDS.find((item) => item === action)
  if (kind === undefined) return { ok: false, code: 'invalid_argument', error: '모르는 동작' }
  const confined = await confine({ roots: deps.roots(), root, rel })
  if (!confined.ok || typeof root !== 'string' || typeof rel !== 'string') return { ok: false, code: confined.ok ? 'invalid_argument' : confined.code, error: confined.ok ? '형 위반' : confined.error }
  const logical = rel === '' ? root : path.join(root, ...rel.split('/'))
  switch (kind) {
    case 'copyPath':
      deps.writeClipboard(logical)
      return { ok: true, value: logical }
    case 'copyRelativePath':
      deps.writeClipboard(rel)
      return { ok: true, value: rel }
    case 'reveal':
      deps.showItemInFolder(logical)
      return { ok: true, value: logical }
    case 'openTerminal': {
      const isDir = 'isDir' in record && record.isDir === true
      const dirRel = isDir ? rel : parentRel(rel)
      const cwd = dirRel === '' ? root : path.join(root, ...dirRel.split('/'))
      // 파일의 부모도 같은 가둠을 다시 지난다(부모가 루트 밖 링크일 수는 없지만, 검사를 한 자리로 모은다).
      const dirConfined = await confine({ roots: deps.roots(), root, rel: dirRel })
      if (!dirConfined.ok) return { ok: false, code: dirConfined.code, error: dirConfined.error }
      const error = await deps.openShell({ root, cwd })
      return error === null ? { ok: true, value: cwd } : { ok: false, code: 'io_error', error }
    }
  }
}
