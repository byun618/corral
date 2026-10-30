// LIFE-520 final R3-02 — `index.ts` 종료 배선의 **정적 대조**. `index.ts` 는 Electron 앱 수명(whenReady·before-quit·window-all-closed)을 묶는
// 모듈이라 단위 시험으로 적재하지 않는다(적재하면 app·BrowserWindow·런타임 전부가 뜬다). 그래서 소스에서 두 사실만 본다:
//   ① `before-quit` 에서 `agentDetector?.killAll()` 이 quitGate 가로챔(`quitGate.intercept`) **뒤**에 있다 — 종료가 취소되면 감지기는 산다
//   ② `window-all-closed` 에서 `agentDetector?.killAll()` 을 부른다
//   ③ IPC 는 `registerAgentDetectionIpc` 로 등록한다
// 실제 종료 동작(감지 중 앱 종료 → 셸·손주 잔존 0)은 N1 ⓖ 네이티브 회차가 본다. 감지기 단 동작은 `agent-detection.test.ts` 「ⓗ」.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'index.ts'), 'utf8')

/** `app.on('<이름>'` 부터 다음 최상위 `app.on(` 또는 파일 끝까지. */
function handlerBody(name: string): string {
  const start = source.indexOf(`app.on('${name}'`)
  if (start < 0) throw new Error(`${name} 처리 없음`)
  const next = source.indexOf('\napp.on(', start + 1)
  return source.slice(start, next < 0 ? undefined : next)
}

describe('index.ts 감지기 배선 (K3ⓗ 정적 대조, R3-02)', () => {
  it('① before-quit — quitGate 가로챔 뒤에 killAll', () => {
    const body = handlerBody('before-quit')
    const gate = body.indexOf('quitGate.intercept')
    const kill = body.indexOf('agentDetector?.killAll()')
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(kill).toBeGreaterThan(gate)
  })
  it('② window-all-closed — killAll', () => {
    expect(handlerBody('window-all-closed')).toContain('agentDetector?.killAll()')
  })
  it('③ IPC 등록은 registerAgentDetectionIpc 하나로, 기동 감지는 await 없이', () => {
    expect(source).toContain('registerAgentDetectionIpc({')
    expect(source).toMatch(/\n\s*void agentDetector\.ensure\(\)\n/)
  })
})
