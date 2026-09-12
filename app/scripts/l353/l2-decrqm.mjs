// L2 (수정 1회차 — grok 낮음1) — #5800 우회 **직접 관측**.
//
// #5800: 프로덕션 재-minify 가 xterm 의 DECRQM(모드 질의) CSI 핸들러를 깨뜨린다. 우회는
//   renderer build.target 'es2022'(재-minify 회피). r1 은 이걸 S7ⓕ(vim 입력 생존)로 **간접**
//   실증했다. 여기선 DECRQM 질의(`\x1b[?2026$p`)를 xterm 에 먹여 DECRPM 응답을 직접 받는다:
//   핸들러가 살아 있으면 `\x1b[?2026;<value>$y` 가 오고, 깨졌으면 응답이 없다.
//
// **프로덕션 빌드**에서 재는 것이 요점이다 — 하네스는 electron-vite build 산출물(out/, prod)을
//   `electron .` 로 띄운다(dev 서버 아님). 그래서 이 관측은 재-minify 빌드에 대한 것이다.
//
// 동기화 출력(2026)은 프레임마다 BSU/ESU 로 잠깐 켰다 끄는 것이라 정적 상태에선 **꺼짐(2)** 이
//   정상이다 — 값 2 를 기대하고, 어떤 값이 왔는지 원자료에 남긴다.

import { startApp, attachPane, firstPaneId, writeRaw } from './lib.mjs'
import { neutralizePrompt } from './fixtures.mjs'

/** DECRPM 응답에서 `\x1b[?<mode>;<value>$y` 의 value 를 뽑는다. */
function parseDecrpm(response, mode) {
  const m = new RegExp(`\\x1b\\[\\?${mode};(\\d+)\\$y`).exec(response ?? '')
  return m ? Number(m[1]) : null
}

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 'l2-decrqm' })
  await attachPane(app, paneId)
  await neutralizePrompt(paneId)

  // 두 모드를 본다: 2026(동기화 출력, 이 구현이 실제로 쓰는 것) + 2004(bracketed paste, 참고).
  const cases = []
  for (const mode of [2026, 2004]) {
    const r = await app.termDecrqm(mode)
    const value = parseDecrpm(r.response, mode)
    cases.push({
      mode,
      response: r.response ?? null,
      responseHex: typeof r.response === 'string' ? Buffer.from(r.response, 'utf8').toString('hex') : null,
      value,
      // DECRPM value 의미: 0 미지원 · 1 설정됨 · 2 리셋됨 · 3 영구설정 · 4 영구리셋.
      handlerAlive: value !== null,
    })
  }

  const sync = cases.find((c) => c.mode === 2026)
  // 핵심 판정: 2026 DECRQM 이 DECRPM 로 답했다(핸들러 생존) + 정적 상태라 값은 2(리셋).
  const pass = sync.handlerAlive && sync.value === 2
  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    build: 'electron-vite build 산출물(out/, 프로덕션 재-minify) — dev 서버 아님',
    workaround: "renderer build.target 'es2022' (#5800: 재-minify 가 DECRQM CSI 핸들러 파괴)",
    cases,
    verdict: pass ? '통과' : '미달',
    note: 'DECRQM(?2026$p)→DECRPM(?2026;2$y) 직접 왕복. 값 2=리셋(정적 상태 정상, BSU/ESU 는 프레임마다 잠깐만 켬). 응답 있음 = #5800 우회 생존의 직접 증거.',
  }
  writeRaw('l2-decrqm.json', result)
  for (const c of cases) console.log(`  ?${c.mode}$p → ${JSON.stringify(c.response)} (value=${c.value}, alive=${c.handlerAlive})`)
  console.log('\nL2 →', result.verdict)
  await app.stop()
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
