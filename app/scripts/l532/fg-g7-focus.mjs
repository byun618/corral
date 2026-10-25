// LIFE-532 G7 보강 — 창 포커스 관측. 로그의 window-focus 흔적은 링크 live 일 때의 재동기에서만 남아(link.resync 가 live 가 아니면 조용히 건너뜀)
// 기동 초기의 포커스를 못 본다. 그래서 평시 격리 인스턴스 하나에서 기동 직후부터 20초간 1초마다 document.hasFocus() 를 표본으로 센다. 사용: node fg-g7-focus.mjs [ROOT=/tmp/l532g]
import { check, fail, finish, Iso, sleep } from './lib.mjs'

const iso = new Iso(process.argv[2] ?? '/tmp/l532g')
iso.fresh()
try {
  await iso.startServer()
  await iso.launch({ label: 'g7' })
  const samples = []
  for (let i = 0; i < 20; i += 1) {
    samples.push(await iso.evalJs('document.hasFocus()'))
    await sleep(1000)
  }
  const focused = samples.filter(Boolean).length
  console.log(`## document.hasFocus() 표본 20개: ${JSON.stringify(samples)} · 참 ${focused}개`)
  const g7 = iso.g7()
  check('G7 input.raw 0', g7.inputRaw, 0)
  console.log(`## 창 포커스 표본 참 ${focused}/20 (기록 — 통과선 아님)`)
} catch (error) {
  fail(`예외: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await iso.quit()
  iso.stopServer()
}
finish()
