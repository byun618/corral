// LIFE-566 최종 관문 — 개발 인스턴스 창에 CDP 포커스 에뮬레이션을 건다(사용자 OS 포커스를 뺏지 않는다).
// `Emulation.setFocusEmulationEnabled` 는 CDP 세션이 붙어 있는 동안만 산다 — 이 프로세스를 회차 내내 띄워 두고 끝에 끈다.
// 사용: node focus-emu.mjs <CDP 포트>   (표준출력에 'focus-emulation on' 이 찍히면 준비 완료)
import { connect, pickTarget } from '../gui-diff/lib/cdp.mjs'

const port = Number(process.argv[2])
const { target } = await pickTarget(port, { match: (entry) => entry.url.includes('/renderer/index.html') || entry.url.startsWith('file:'), label: 'corral dev' })
const session = await connect(target.webSocketDebuggerUrl)
await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
console.log(`focus-emulation on target=${target.url}`)
setInterval(() => {}, 60_000)
