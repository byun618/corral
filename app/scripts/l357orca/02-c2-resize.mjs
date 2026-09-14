// C2 — 사이드바 리사이즈: 좌표 드래그로 폭 조절(단조 추종) + 앱 재기동 후 폭 유지.
// 드래그 자체는 `mouseMove`+`mouseDown`+`mouseUp` 시퀀스가 없는 제어 채널이라(click 만 있음)
// `resize-window` 로 대체 증명하지 못한다 — 대신 `computed-style`/`rect` 로 드래그 **전/중/후**
// 폭을 3번 재 단조 추종을 확인하고, ui-prefs.json(`window.corral.getUiPrefs`) 값을 읽어
// 재기동 후 반영을 확인한다.
//
// localStorage 가 아니라 ui-prefs.json 을 재는 이유: 1차 실행에서 localStorage 값이 재기동
// 후 사라지는 걸 실측(구 raw — _discarded 로 옮김)해 main/ui-prefs.ts 로 교체했다. 이 스크립트가
// 쓰는 prefs 파일은 CORRAL_UI_PREFS 로 이 실행 전용 경로에 격리한다(사용자 실제 설정 불가침).
import fs from 'node:fs'
import path from 'node:path'
import { RAW_DIR, RAW_SUBDIR, sleep, startApp, until, writeRaw } from './lib.mjs'

const uiPrefsFile = path.join(RAW_DIR, RAW_SUBDIR, '_runs', '02-c2-resize-ui-prefs.json')

async function dragResizer(app, fromX, toX, steps = 5) {
  // control.ts 에 드래그 전용 cmd 가 없어 여기서 직접 프레임을 만든다 — mousedown 좌표는
  // sidebar-resizer 의 실제 rect 를 읽어 구한다(하드코딩 금지).
  const rect = (await app.rect('[data-sidebar-resizer]')).rect
  const y = Math.round(rect.top + rect.height / 2)
  await app.send({ cmd: 'raw-mouse', type: 'mouseDown', x: fromX, y, button: 'left' })
  const widths = []
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(fromX + ((toX - fromX) * i) / steps)
    await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x, y })
    await sleep(60) // rAF 배칭 커밋을 기다린다 — 원본 useSidebarResize.ts 의 requestAnimationFrame 한 틱
    const r = await app.rect('[data-sidebar]')
    widths.push(r.rect.width)
  }
  await app.send({ cmd: 'raw-mouse', type: 'mouseUp', x: toX, y, button: 'left' })
  await sleep(150)
  return widths
}

async function main() {
  fs.mkdirSync(path.dirname(uiPrefsFile), { recursive: true })
  fs.rmSync(uiPrefsFile, { force: true }) // 결정론적 시작 — 이전 실행 잔여값 제거

  const app = await startApp({ name: '02-c2-resize', env: { CORRAL_UI_PREFS: uiPrefsFile } })
  await until(async () => (await app.rect('[data-sidebar]')).rect !== null, { timeoutMs: 8000, what: 'sidebar mounted' })
  const before = (await app.rect('[data-sidebar]')).rect
  console.log('sidebar width before drag', before.width)

  const widths = await dragResizer(app, Math.round(before.width), Math.round(before.width) + 120)
  console.log('widths during drag', widths)
  const after = (await app.rect('[data-sidebar]')).rect
  console.log('sidebar width after drag', after.width)

  const monotonic = widths.every((w, i) => i === 0 || w >= widths[i - 1])
  const grew = after.width > before.width

  const stored = await app.send({ cmd: 'eval', code: 'window.corral.getUiPrefs().then((p) => p.sidebarWidth)' })
  console.log('ui-prefs sidebarWidth after drag', stored.result)

  await app.stop() // ui-prefs.ts 는 update() 시 동기 쓰기라(디바운스 없음) 커밋 유예가 필요 없다

  // 재기동 — 같은 CORRAL_UI_PREFS 파일을 가리켜 영속 여부를 실제로 확인한다.
  const app2 = await startApp({ name: '02-c2-resize-restart', env: { CORRAL_UI_PREFS: uiPrefsFile } })
  await until(async () => (await app2.rect('[data-sidebar]')).rect !== null, { timeoutMs: 8000, what: 'sidebar mounted (restart)' })
  const afterRestart = (await app2.rect('[data-sidebar]')).rect
  console.log('sidebar width after restart', afterRestart.width)
  const stored2 = await app2.send({ cmd: 'eval', code: 'window.corral.getUiPrefs().then((p) => p.sidebarWidth)' })
  await app2.stop()

  const result = {
    before: before.width,
    widthsDuringDrag: widths,
    monotonic,
    after: after.width,
    grew,
    storedAfterDrag: stored.result,
    afterRestart: afterRestart.width,
    persisted: Math.round(afterRestart.width) === Math.round(after.width),
    storedAfterRestart: stored2.result,
    uiPrefsFileOnDisk: fs.readFileSync(uiPrefsFile, 'utf8'),
  }
  console.log(result)
  writeRaw('c2-resize.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
