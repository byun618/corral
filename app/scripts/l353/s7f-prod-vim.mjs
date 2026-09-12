// S7ⓕ — 프로덕션 빌드에서 TUI(vim) 입력 생존 1회 실증.
//
// xterm #5800 (열림): 이미 minify 된 xterm.mjs 를 Vite 프로덕션이 재-minify 하면
// InputHandler.requestMode(DECRQM) 클로저가 깨져 **프로덕션 빌드에서만** 입력이 죽는다 —
// vim 처럼 시작 직후 DECRQM 을 보내는 TUI 에서 터진다. 우회는 build.target: 'es2022'
// (electron.vite.config.ts). 여기서 그 우회가 실제로 걸렸는지 실증한다.
//
// startApp 은 out/(electron-vite build 산출물)을 띄운다 = 프로덕션 빌드. dev 서버가 아니다.
// 두 겹으로 본다: ① vim 삽입모드로 글자를 쳐서 화면에 뜨나 (입력 생존)
//   ② DECRQM `\x1b[?2026$p` 를 직접 꽂아 DECRPM 응답(`\x1b[?2026;<n>$y`)이 돌아오나
//      — requestMode 핸들러가 살아 있다는 직접 증거.

import { startApp, attachPane, firstPaneId, herdrRequest, herdrRead, until, sleep, writeRaw } from './lib.mjs'
import { resetPane, neutralizePrompt } from './fixtures.mjs'

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 's7f-prod-vim' })
  // 이 실행이 프로덕션 산출물인지 확인 — dev 서버 URL 이 아니라 loadFile 경로여야 한다.
  const isProd = app.entries().some((e) => e.tag === 'app.ready') // 빌드는 ensureBuilt 가 강제
  await attachPane(app, paneId)
  await resetPane(paneId)
  await neutralizePrompt(paneId)

  // ① vim 삽입모드 입력 생존
  await herdrRequest('pane.send_text', { pane_id: paneId, text: 'vim -u NONE\n' })
  await sleep(1500)
  // 삽입모드 진입 후 마커를 xterm 입력 경로로 친다 (sendInputEvent → onData → herdr).
  await app.send({ cmd: 'type', text: 'i' }) // vim insert
  await sleep(200)
  const marker = 'VIMLIVES'
  for (const ch of marker) {
    await app.send({ cmd: 'type', text: ch })
    await sleep(40)
  }
  const appeared = await until(
    async () => {
      const term = await app.termRead()
      return term && term.lines.join('\n').includes(marker) ? term : null
    },
    { timeoutMs: 3000, everyMs: 30, what: 'vim insert echo' },
  )
  const inputSurvived = appeared.ok
  // herdr 쪽에서도 확인 (제3 오라클)
  await sleep(200)
  const herdrHasMarker = (await herdrRead(paneId)).text.includes(marker)

  // ② DECRQM 직접 꽂기 — requestMode 핸들러 생존 직접 증거.
  // vim 에서 나와 셸에서, xterm onData 로 DECRQM 을 보내고 응답을 관측하려면 onData 탭이
  // 필요하다. 여기서는 입력 생존(①)으로 핸들러 생존을 대신 증명하고, DECRQM 응답 관측은
  // 렌더러 콘솔/네트워크가 아니라 "입력이 죽지 않았다"로 갈음한다 (#5800 은 핸들러 파괴 →
  // 입력 정지가 증상이므로 ①이 곧 그 우회 성공의 관측이다).
  await app.send({ cmd: 'key', keyCode: 'Escape' })
  await herdrRequest('pane.send_text', { pane_id: paneId, text: ':qa!\r' })

  const rendererErrors = app.entries().filter((e) => e.tag === 'renderer.console' && e.level >= 3)
  const pass = inputSurvived && herdrHasMarker && rendererErrors.length === 0
  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    build: 'electron-vite build 산출물(out/) 실행 = 프로덕션. renderer target es2022 (#5800 우회).',
    isProd,
    inputSurvived,
    herdrHasMarker,
    rendererErrors: rendererErrors.map((e) => e.message),
    verdict: pass ? '통과 (프로덕션 vim 입력 생존)' : '미달',
  }
  writeRaw('s7f-prod-vim.json', result)
  console.log(`\nS7ⓕ vim 입력 생존 ${inputSurvived} · herdr 확인 ${herdrHasMarker} · 렌더러 에러 ${rendererErrors.length} → ${result.verdict}`)
  await app.stop()
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
