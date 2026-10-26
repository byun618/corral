// LIFE-532 최종 관문 R1-03② 바인딩 분기 — 대체 회차. `CORRAL_SESSION` 만으로는 런타임이 시작을 거절한다
// (`src/runtime/server.ts:76` invalid_backend "Set both CORRAL_BACKEND_SOCKET and CORRAL_SESSION" → app.exit(1), fg-05 원자료).
// 그래서 앱이 받아 주는 유일한 바인딩 꼴(둘 다 지정 — 소켓 지름길)로 돌린다. 지름길은 CLI 를 부르지 않아 조회 오류가 날 수 없으니 원인 `link` 를 만든다:
// 지정 소켓을 긴 심링크 경로(>104 bytes)로 주면 세션은 running(소켓 존재)인데 링크가 경로 초과로 failed. 사용: node fg-bound-link.mjs [ROOT=/tmp/l532f]
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { check, cleanEnv, fail, finish, Iso, REAL_HERDR, until } from './lib.mjs'

const iso = new Iso(process.argv[2] ?? '/tmp/l532f')
iso.fresh()
const NAME = 'l532-bound'
const longDir = path.join(iso.root, `L${'x'.repeat(90)}`)
fs.symlinkSync(iso.xdg, longDir)
const longSocket = `${longDir}/herdr/sessions/${NAME}/herdr.sock`
let server = null
try {
  const out = fs.openSync(path.join(iso.root, 'bound-server.out'), 'a')
  server = spawn(REAL_HERDR, ['--session', NAME, 'server'], { env: cleanEnv({ XDG_CONFIG_HOME: iso.xdg }), detached: true, stdio: ['ignore', out, out] })
  server.unref()
  iso.pids.push({ pid: server.pid, what: `herdr --session ${NAME} server` })
  console.log(`## 격리 이름 세션 서버 pid ${server.pid}`)
  await until('이름 세션 소켓', () => fs.existsSync(`${iso.xdg}/herdr/sessions/${NAME}/herdr.sock`), 20_000)
  console.log(`## 지정 소켓 ${longSocket} (${Buffer.byteLength(longSocket)} bytes) · 존재 ${fs.existsSync(longSocket)}`)
  await iso.launch({ label: 'bound-link', extra: { CORRAL_SESSION: NAME, CORRAL_BACKEND_SOCKET: longSocket } })
  await until('link.phase failed', () => iso.lines('link.phase').some((line) => line.phase === 'failed'), 20_000)
  const dom = await until('원인 link 카드', async () => { const value = await iso.dom(); return value.card !== null ? value : null }, 10_000, 300)
  const state = await iso.state()
  console.log(`## DOM: ${JSON.stringify(dom)}\n## backend: ${JSON.stringify(state.backend)} · sessions ${JSON.stringify(state.sessions)} · sessionsError ${state.sessionsError}`)
  check('R1-03② 바인딩 — 지정 세션만 목록(running)', state.sessions, [{ name: NAME, isDefault: false, running: true }])
  check('R1-03② 지름길이라 조회 오류 없음', state.sessionsError, null)
  check('R1-03② 바인딩 카드', [dom.card.kind, dom.card.cause], ['unreachable', 'link'])
  check('R1-03② 제목에 지정 세션', dom.card.title, `herdr 세션 ${NAME} 에 연결하지 못했습니다`)
  check('R1-03② 오류 원문 = 경로 초과', dom.card.error.includes('유닉스 소켓 경로가'), true)
  check('R1-03② 버튼 1개 = 다시 시도', dom.card.buttons, [{ text: '다시 시도', retry: true, start: false }])
  const opens = iso.lines('link.open').length
  const click = await iso.clickRetry()
  await until('link.open 새 줄', () => iso.lines('link.open').length > opens, 5_000, 100)
  console.log(`## 클릭 ${JSON.stringify(click)} · backend.retry ${JSON.stringify(iso.lines('backend.retry').at(-1))} · link.open ${JSON.stringify(iso.lines('link.open').at(-1))}`)
  check('R1-03② 클릭 → 지정 세션 링크 다시 열기', iso.lines('link.open').at(-1).session, NAME)
  check('R1-03② 자동 기동 없음(spawn 0)', iso.lines('herdr.server.spawn').length, 0)
  await iso.shot('fg-bound-link-card')
} catch (error) {
  fail(`예외: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await iso.quit()
  iso.g7()
  console.log(`## 이름 세션 서버 stop: ${iso.herdr(['--session', NAME, 'server', 'stop']).trim().slice(0, 200)}`)
  if (server !== null) await until('이름 세션 서버 종료', () => { try { process.kill(server.pid, 0); return false } catch { return true } }, 10_000).catch(() => { process.kill(server.pid, 'SIGKILL'); console.log('## 이름 세션 서버 SIGKILL') })
}
finish()
