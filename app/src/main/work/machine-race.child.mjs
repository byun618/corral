// LIFE-635 X2-3 시험 자식 — 별도 Node 프로세스에서 실제 `persistedMachine` 을 부른다(리뷰 R09 조건 이식). `node --import tsx` 로 띄운다.
// 이름 조회는 부모가 풀어 줄 때까지 기다린다(ready → release). 값을 부모에 보내고 끝낸다.
import { persistedMachine } from './machine.ts'

const gate = new Promise((resolve) => {
  process.on('message', (message) => { if (message !== null && typeof message === 'object' && typeof message.release === 'string') resolve(message.release) })
})
const value = await persistedMachine({ dir: process.argv[2], read: () => { process.send?.({ ready: true, pid: process.pid }); return gate } })()
process.send?.({ value, pid: process.pid }, () => process.disconnect())
