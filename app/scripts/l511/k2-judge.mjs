// LIFE-511 fix1 R1-07 — K2ⓒⓓ 판정(순수 함수). 관측은 iso-fix1.mjs·native-k9.mjs 가 하고, 판정은 여기서만 한다.
// 단위 검사: node --test app/scripts/l511/k2-judge.check.mjs (vitest 가 수집하지 않게 .check.mjs).

/** pane 마다 PTY 가 받은 입력(싱크 기록)과 기대 입력이 **글자 그대로** 같은가. 기대에 없는 pane 의 입력은 '' 여야 한다. */
export function judgeInputs({ received, expected }) {
  const panes = [...new Set([...Object.keys(received), ...Object.keys(expected)])].sort()
  const rows = panes.map((pane) => ({ pane, got: received[pane] ?? '', want: expected[pane] ?? '' }))
  const bad = rows.filter((row) => row.got !== row.want)
  return { pass: bad.length === 0, rows, bad }
}

const lines = (text) => text.replace(/\r/g, '').split('\n').map((line) => line.replace(/\s+$/, ''))
const trimEnd = (list) => {
  const out = [...list]
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}
const stableOf = (list, label) => list.filter((line) => line.startsWith(`STABLE-${label}-`))

/**
 * 출력 대역 pane(A) — 안정 블록이 전후 그대로이고, 안정 블록 뒤에는 `tick A N` 만 1씩 늘며 이어진다.
 * 다른 줄(입력 메아리 `got`, 훼손 `CORRUPTED`, 빈 줄 끼어듦)이 하나라도 있으면 실패.
 */
export function judgeOutputPane({ before, after, label, stableCount }) {
  const b = trimEnd(lines(before))
  const a = trimEnd(lines(after))
  const stableBefore = stableOf(b, label)
  const stableAfter = stableOf(a, label)
  const problems = []
  if (stableBefore.length !== stableCount) problems.push(`전 안정 줄 ${stableBefore.length}/${stableCount}`)
  if (JSON.stringify(stableBefore) !== JSON.stringify(stableAfter)) problems.push('안정 블록이 바뀌었다')
  const lastStable = a.lastIndexOf(stableAfter[stableAfter.length - 1])
  const tail = lastStable === -1 ? a : a.slice(lastStable + 1)
  let previous = null
  for (const line of tail) {
    const match = new RegExp(`^tick ${label} (\\d+)$`).exec(line)
    if (!match) { problems.push(`출력 대역에 다른 줄: ${JSON.stringify(line).slice(0, 80)}`); break }
    const n = Number(match[1])
    if (previous !== null && n !== previous + 1) { problems.push(`tick 이 끊겼다 ${previous}→${n}`); break }
    previous = n
  }
  const ticksBefore = b.filter((line) => line.startsWith(`tick ${label} `)).length
  const ticksAfter = tail.length
  if (ticksAfter <= ticksBefore) problems.push(`출력이 늘지 않았다(전 ${ticksBefore} · 후 ${ticksAfter})`)
  return { pass: problems.length === 0, problems, stable: stableAfter.length, ticksBefore, ticksAfter }
}

/**
 * 조용한 pane(B) — 후 텍스트 = 전 텍스트 그대로 + 끝에 `got 1B` 가 정확히 `echoes` 줄(검증 타이핑의 메아리)만.
 * 전 텍스트의 어떤 줄이라도 바뀌거나 사라지거나, 메아리 말고 다른 줄이 붙으면 실패.
 */
export function judgeQuietPane({ before, after, label, stableCount, echoes }) {
  const b = trimEnd(lines(before))
  const a = trimEnd(lines(after))
  const problems = []
  if (stableOf(b, label).length !== stableCount) problems.push(`전 안정 줄 ${stableOf(b, label).length}/${stableCount}`)
  const prefixOk = b.length <= a.length && b.every((line, index) => a[index] === line)
  if (!prefixOk) {
    const at = b.findIndex((line, index) => a[index] !== line)
    problems.push(`전 텍스트가 그대로가 아니다(줄 ${at}: ${JSON.stringify(b[at] ?? null).slice(0, 60)} → ${JSON.stringify(a[at] ?? null).slice(0, 60)})`)
  }
  const added = prefixOk ? a.slice(b.length) : []
  const others = added.filter((line) => line !== 'got 1B')
  if (others.length > 0) problems.push(`메아리 말고 붙은 줄: ${JSON.stringify(others.slice(0, 3))}`)
  if (prefixOk && added.length - others.length !== echoes) problems.push(`메아리 ${added.length - others.length}/${echoes}`)
  return { pass: problems.length === 0, problems, added: added.length }
}
