// C10 재현성 검사의 순수 알맹이 — 회차를 **읽는 일**만 CLI 가 하고, 판정은 여기서 한다(단위 테스트).
//
// 왜 유효성 검사가 먼저인가 (F10): 이전 판은 `*-diff.json` 이 하나도 없는 회차 둘을 견주고
// "상세까지 동일 — 통과" 를 적었다. 시딩 단계에서 죽은 회차 두 개가 재현성 통과로 나온 것이다.
// **아무것도 재지 않은 것은 같은 것이 아니다.**

/** 회차 하나의 모양: `{ label, dir, keys: Map<칸이름, {total, elements:Set}>, summary }` */
export function validateRun(run) {
  const problems = []
  if (!run) return { ok: false, problems: ['회차가 비어 있다'] }
  const keys = [...(run.keys?.keys() ?? [])]
  if (keys.length === 0) problems.push('diff 결과가 한 칸도 없다 (측정에 실패한 회차다)')
  if (!run.summary) problems.push('summary.json 이 없다')
  else {
    const requested = expectedKeys(run.summary)
    const missing = requested.filter((key) => !keys.includes(key))
    if (requested.length === 0) problems.push('summary.json 에 요청한 영역·상태가 없다')
    if (missing.length > 0) problems.push(`요청한 칸이 빠졌다: ${missing.join(', ')}`)
    if (run.summary.gate && run.summary.gate.pass === false) {
      problems.push(`그 회차가 자기 관문을 통과하지 못했다: ${run.summary.gate.why ?? '사유 없음'}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/** `summary.json` 의 인자에서 "이 회차가 내야 하는 칸" 을 만든다 — 실제 파일 목록과 견주는 기준. */
export function expectedKeys(summary) {
  const areas = summary?.args?.areas ?? []
  const states = summary?.args?.states ?? []
  const out = []
  for (const area of areas) for (const state of states) out.push(`${area}-${state}`)
  return out
}

/**
 * 여러 회차의 차이 **집합**을 견준다. 원소 = (단위 id, 순번, 종류, 상세 전문).
 * 유효하지 않은 회차가 하나라도 있으면 집합 비교에 들어가지 않는다 — 통과로 오해될 값을 만들지 않는다.
 */
export function compareRuns(runs) {
  const validations = runs.map((run) => ({ label: run.label, ...validateRun(run) }))
  const invalid = validations.filter((entry) => !entry.ok)
  if (runs.length < 2) {
    return { ok: false, validations, rows: [], mismatches: [], reason: '회차가 2개 미만이다 — 한 회차로는 재현성을 말할 수 없다' }
  }
  if (invalid.length > 0) {
    return { ok: false, validations, rows: [], mismatches: [], reason: '유효하지 않은 회차가 있다' }
  }
  const keys = [...new Set(runs.flatMap((run) => [...run.keys.keys()]))].sort()
  const rows = []
  const mismatches = []
  let ok = true
  for (const key of keys) {
    const entries = runs.map((run) => run.keys.get(key) ?? null)
    const base = entries[0]
    let same = entries.every((entry) => entry !== null)
    if (same) {
      for (const entry of entries.slice(1)) {
        if (entry.elements.size !== base.elements.size) { same = false; break }
        for (const element of entry.elements) if (!base.elements.has(element)) { same = false; break }
        if (!same) break
      }
    }
    if (!same) {
      ok = false
      const union = new Set(entries.flatMap((entry) => (entry ? [...entry.elements] : [])))
      for (const element of union) {
        const only = runs.filter((run, index) => entries[index]?.elements.has(element))
        if (only.length === runs.length) continue
        mismatches.push({ key, element, onlyIn: only.map((run) => run.label) })
      }
    }
    rows.push({ key, totals: entries.map((entry) => (entry ? entry.total : null)), same })
  }
  return { ok, validations, rows, mismatches, reason: ok ? null : '회차마다 다른 원소가 있다' }
}
