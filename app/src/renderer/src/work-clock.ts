// LIFE-623 R2-A — 작업 쓰기·읽기의 순서 시계. 상세의 「확정 시각」(읽기 시작·쓰기 시작·확정 — `useTaskDetail` stamp)과
// 작업 페이지가 쓰기를 **보낸 시각**(`SettledWrite.sent`)이 같은 단조 증가 정수를 쓴다(창 하나 안). 그래서 「이 쓰기 결과의 근거가 지금 base 의 근거보다 앞인가」 를 바로 비교할 수 있다.
let clock = 0

export function nextWorkStamp(): number {
  clock += 1
  return clock
}
