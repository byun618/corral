// C7 — data-* 계약 변동 여부 (09-gate1-fix.md G: "C6·C7·C8 불필요. `data-*` 를 새로
// 추가/변경했다면 C7 매핑표만 갱신").
//
// 이번 라운드는 렌더 텍스트·필터·토큰만 건드렸다는 주장의 **기계적 증거**를 남긴다:
// 승자 머지 커밋(be280ed, 이 수정 라운드의 출발점)과 현재 HEAD 의 렌더러 `data-*` 집합을
// 비교해 차집합이 비어 있음을 보인다. 비어 있으면 C7 매핑표는 그대로 유효하다.
import { execFileSync } from 'node:child_process'
import { REPO_DIR, writeRaw } from './lib.mjs'

const BASE = process.env.L357FIX_BASE ?? 'be280ed'

function attrsAt(rev) {
  const out = execFileSync(
    'git',
    ['grep', '-ho', 'data-[a-z-]*', rev, '--', 'app/src/renderer/src/*.tsx', 'app/src/renderer/src/components/*.tsx'],
    { cwd: REPO_DIR, encoding: 'utf8' },
  )
  return [...new Set(out.split('\n').filter((line) => line.trim().length > 0))].sort()
}

const before = attrsAt(BASE)
const after = attrsAt('HEAD')
const added = after.filter((a) => !before.includes(a))
const removed = before.filter((a) => !after.includes(a))

const result = {
  criterion: 'C7 — data-* 계약 (재실행 불필요 조건 확인)',
  baseRev: BASE,
  baseRevNote: '승자 -claude-orca 머지 커밋 = 이 수정 라운드의 출발점',
  beforeCount: before.length,
  afterCount: after.length,
  added,
  removed,
  unchanged: added.length === 0 && removed.length === 0,
  note: '차집합이 비었다 → 이번 라운드가 화면 계약(셀렉터)을 건드리지 않았다는 뜻이고, 그러면 C7 매핑표는 갱신 대상이 아니다. `data-worktree-branch` 의 *값* 도 그대로다(b-field-mapping.json `dataAttrValueUnchanged`).',
  attrs: after,
}
console.log(JSON.stringify({ ...result, attrs: `${after.length} attrs` }, null, 2))
writeRaw('c7-data-attr-diff.json', result)
