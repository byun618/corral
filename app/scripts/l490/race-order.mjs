// K1ⓐ 경합 순서 요약 — result.json 의 회차별 계측 사건에서 세 시각을 뽑는다(원자료 그대로, 클릭 기준 ms):
//   respAt  : 렌더러 activeWorkspaceId 가 「state 에 아직 없는 id」 로 바뀐 첫 시각(= openWorktree 응답의 setActive — IPC 는 감쌀 수 없어 이것으로 본다)
//   gapPush : 그 뒤 새 workspace 가 없는 state 도착 수(경합 창 안의 push)
//   promotedAt : 그 뒤 activeWorkspaceId 가 다른 열린 workspace 로 바뀐 시각(옛 규칙의 승격) · arriveAt : 새 workspace 가 state 에 처음 실린 시각
// 사용: node race-order.mjs <result.json> → 표준 출력 markdown 표
import fs from 'node:fs'
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
console.log(`build ${result.identity.head} out ${result.identity.outSha256.slice(0, 12)} — pass ${result.pass}/${result.trials}\n`)
console.log('| trial | start | respAt(id) | gapPush | promotedAt(id) | arriveAt | reachedAt | held | final active |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const row of result.rows.filter((item) => item.trial !== undefined)) {
  let open = new Set()
  let resp = null
  let gap = 0
  let promoted = null
  let arrive = null
  for (const event of row.events) {
    if (event.kind === 'state') {
      open = new Set(event.open)
      if (resp !== null && arrive === null) {
        if (open.has(resp.id)) arrive = event.dt
        else gap += 1
      }
    }
    if (event.kind === 'active' && event.active !== null) {
      if (resp === null && !open.has(event.active)) resp = { at: event.dt, id: event.active }
      else if (resp !== null && promoted === null && event.active !== resp.id) promoted = { at: event.dt, id: event.active }
    }
  }
  const f = (value) => (value === null ? '—' : value)
  console.log(`| ${row.trial} | ${row.start} | ${resp ? `${resp.at}(${resp.id})` : '—'} | ${gap} | ${promoted ? `${promoted.at}(${promoted.id})` : '—'} | ${f(arrive)} | ${f(row.reachedAt)} | ${row.held} | ${row.triple.active} |`)
}
