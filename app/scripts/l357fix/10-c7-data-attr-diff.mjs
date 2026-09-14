// C7 — data-* 계약 변동 여부 (09-gate1-fix.md G: "C6·C7·C8 불필요. `data-*` 를 새로
// 추가/변경했다면 C7 매핑표만 갱신").
//
// 승자 머지 커밋(be280ed, 이 수정 라운드의 출발점)과 현재 HEAD 의 렌더러 `data-*` 집합을
// 비교해 **기계적 증거**를 남긴다. C7 매핑표가 다루는 건 구→신 대응이라, 판정을 가르는 건
// `removed` 다: 사라지거나 이름이 바뀐 게 있으면 대체 위치를 적어야 하고, 추가만 있으면
// 기존 대응은 그대로 유효하되 새 계약 항목을 결과 문서에 적으면 된다.
//
// note 를 결과에 맞춰 **계산**한다 — 1회차의 "차집합이 비었다" 문구가 상수로 박혀 있어서
// 2회차에 3개가 추가됐는데도 같은 문장이 나왔다. 원자료가 스스로를 틀리게 서술하면 안 된다.
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
  note:
    added.length === 0 && removed.length === 0
      ? '차집합이 비었다 → 화면 계약(셀렉터)을 안 건드렸다는 뜻이라 C7 매핑표는 갱신 대상이 아니다.'
      : removed.length === 0
        ? `추가 ${added.length}건 · 삭제 0건 → 구→신 대응은 깨지지 않았다(기존 셀렉터가 전부 살아 있다). 새로 생긴 계약 항목만 결과 문서 계약표에 적는다.`
        : `삭제/개명 ${removed.length}건 → C7 매핑표에 대체 위치를 반드시 적어야 한다.`,
  mappingTableNeedsRewrite: removed.length > 0,
  attrs: after,
}
console.log(JSON.stringify({ ...result, attrs: `${after.length} attrs` }, null, 2))
writeRaw('c7-data-attr-diff.json', result)
