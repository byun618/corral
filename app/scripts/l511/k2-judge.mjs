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
 * 출력 대역 pane(A) — **전 텍스트 전체가 후 텍스트의 접두부**이고(r2 R2-01: 안정 줄만 뽑아 보면 옛 tick 손실·안정 블록 사이 삽입·
 * 프롬프트 손실을 놓쳤다), 새로 붙은 꼬리는 `tick A N` 만 — 전 텍스트의 마지막 tick 다음 번호부터 1씩 — 이어진다.
 * 꼬리에 다른 줄(입력 메아리 `got`, 훼손 `CORRUPTED`, 빈 줄)이 하나라도 있거나 꼬리가 비면(출력 정지) 실패.
 */
export function judgeOutputPane({ before, after, label, stableCount }) {
  const b = trimEnd(lines(before))
  const a = trimEnd(lines(after))
  const problems = []
  const stableBefore = stableOf(b, label)
  if (stableBefore.length !== stableCount) problems.push(`전 안정 줄 ${stableBefore.length}/${stableCount}`)
  const tickPattern = new RegExp(`^tick ${label} (\\d+)$`)
  const tickOf = (line) => { const match = tickPattern.exec(line); return match ? Number(match[1]) : null }
  // 전 텍스트 자체도 모양이 맞아야 기준이 된다 — 마지막 안정 줄 뒤는 연속 tick 뿐.
  const lastStable = b.lastIndexOf(stableBefore[stableBefore.length - 1])
  const beforeTicks = lastStable === -1 ? [] : b.slice(lastStable + 1)
  for (const [index, line] of beforeTicks.entries()) {
    const n = tickOf(line)
    if (n === null) { problems.push(`전 텍스트 출력 대역에 다른 줄: ${JSON.stringify(line).slice(0, 80)}`); break }
    if (index > 0 && n !== tickOf(beforeTicks[index - 1]) + 1) { problems.push(`전 텍스트 tick 이 끊겼다 ${tickOf(beforeTicks[index - 1])}→${n}`); break }
  }
  const prefixOk = b.length <= a.length && b.every((line, index) => a[index] === line)
  if (!prefixOk) {
    const at = b.findIndex((line, index) => a[index] !== line)
    problems.push(`전 텍스트가 그대로가 아니다(줄 ${at}: ${JSON.stringify(b[at] ?? null).slice(0, 60)} → ${JSON.stringify(a[at] ?? null).slice(0, 60)})`)
  }
  const tail = prefixOk ? a.slice(b.length) : []
  const lastBefore = beforeTicks.length > 0 ? tickOf(beforeTicks[beforeTicks.length - 1]) : 0
  let expected = (lastBefore ?? 0) + 1
  for (const line of tail) {
    const n = tickOf(line)
    if (n === null) { problems.push(`출력 대역에 다른 줄: ${JSON.stringify(line).slice(0, 80)}`); break }
    if (n !== expected) { problems.push(`tick 이 끊겼다 ${expected - 1}→${n}`); break }
    expected += 1
  }
  if (prefixOk && tail.length === 0) problems.push('출력이 늘지 않았다(꼬리 0줄)')
  return { pass: problems.length === 0, problems, stable: stableBefore.length, ticksBefore: beforeTicks.length, added: tail.length }
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
