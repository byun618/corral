// LIFE-580 R3-A2 — 「보고한 그 전이를 담은 첫 목록」 고르기. 격리 J5(`three-sec.mjs`)와 네이티브 J5(`native-j5.mjs`)가 같이 쓴다.
//
// 원인(대상 채널 id · 기대 상태 · 원인 시각)마다, 목록들(받은 순서) 중에서 **대상 채널의 점이 기대 상태로 바뀐 첫 목록**을 고른다.
// 다른 채널만 바뀐 목록은 짝이 아니다. 판별이 안 되는 경우는 짝을 만들지 않고 보류로 돌려 5회·20회에서 뺀다:
//   - 원인 전에 받은 목록이 없다 → 대상의 이전 상태를 모른다(보류)
//   - 원인 직전에 이미 기대 상태였다 → 같은 상태 반복이라 전이가 아니다(보류)
//   - 대상 채널이 원인 전·후 어느 목록에도 없다 → 대상 확인 불가(보류)
//   - 대상은 보이는데 다음 원인 전까지 기대 상태가 안 왔다 → 미수신(세는 회차 — 미달)
// 목록 항목: { builtAt(서버가 목록을 만든 시각, 원인과 같은 맥 시계), dot(그 목록에서 대상의 점 · 목록에 없으면 null · 기록이 없어 모르면 undefined), ...그 밖 칸 }.
// 점을 모르는 목록이 판정에 걸리면 보류다(짐작하지 않는다).
// builtAt 이 원인 시각 이후인 목록만 짝 후보다 — 원인 전에 만든 목록은 그 보고를 담을 수 없다.

/** herdr 보고 상태 → 데스크톱 점(`shared/agent-dot.ts`) — provider 없는 보고라 이 셋으로만 간다. idle 은 done 으로 보일 수 있다(seen 장부 없음). */
export const DOTS_OF = { working: ['working'], idle: ['idle', 'done'], blocked: ['blocked', 'waiting'] }

/**
 * @param {{ lists: { builtAt: number, dot: string | null }[], expect: string, causeAt: number, nextCauseAt?: number }} input
 * @returns {{ kind: 'hit', list: object } | { kind: 'held', why: string } | { kind: 'miss', why: string }}
 */
export function matchTransition({ lists, expect, causeAt, nextCauseAt = Number.POSITIVE_INFINITY }) {
  const dots = DOTS_OF[expect]
  if (dots === undefined) return { kind: 'held', why: `기대 상태를 점으로 옮길 수 없다(${expect})` }
  const before = lists.filter((list) => list.builtAt < causeAt)
  if (before.length === 0) return { kind: 'held', why: '원인 전 목록 없음 — 대상의 이전 상태를 모른다' }
  const prior = before[before.length - 1].dot
  if (prior === undefined) return { kind: 'held', why: '원인 직전 목록에 대상 점 기록 없음(`changes` 없는 기록)' }
  if (prior !== null && dots.includes(prior)) return { kind: 'held', why: `같은 상태 반복 — 원인 직전 대상 점이 이미 ${prior}` }
  const window = lists.filter((list) => list.builtAt >= causeAt && list.builtAt < nextCauseAt)
  const hit = window.find((list) => list.dot !== null && dots.includes(list.dot))
  if (hit !== undefined) return { kind: 'hit', list: hit }
  if (window.some((list) => list.dot === undefined)) return { kind: 'held', why: '원인 뒤 목록에 대상 점 기록 없음(`changes` 없는 기록)' }
  if (prior === null && window.every((list) => list.dot === null)) return { kind: 'held', why: '대상 채널이 목록에 없다 — 대상 확인 불가' }
  return { kind: 'miss', why: `대상이 다음 원인 전까지 ${expect} 로 바뀐 목록이 없다` }
}

/**
 * 폰 `list_recv` 의 `changes`(`id=dot,…`, 사라짐 `id=-`)를 접어 목록마다 대상의 점을 낸다.
 * `changes` 없는 줄(옛 앱 기록)을 만나면 그때부터 대상 점을 모른다(undefined). 그 뒤 **대상을 명시한** `id=dot`·`id=-` 를 다시 읽으면
 * 그 줄부터 다시 안다(R4-A2 — 옛 기록 한 줄이 이어진 새 기록 전체를 보류시키지 않게). 대상을 언급하지 않은 delta 로는 짐작하지 않는다.
 */
export function foldTargetDots({ recv, target }) {
  let known = true
  let dot = null
  return recv.map((entry) => {
    if (typeof entry.changes !== 'string') {
      known = false
      return { ...entry, dot: undefined }
    }
    for (const part of entry.changes === '' ? [] : entry.changes.split(',')) {
      const at = part.lastIndexOf('=')
      if (part.slice(0, at) !== target) continue
      dot = part.slice(at + 1) === '-' ? null : part.slice(at + 1)
      known = true
    }
    return { ...entry, dot: known ? dot : undefined }
  })
}
