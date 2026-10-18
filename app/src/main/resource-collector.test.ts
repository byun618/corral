// LIFE-637 R1 — 수집기 순수 층. 고정 ps 표 + pane 루트 표로 귀속을 손계산과 대조한다.
import { describe, expect, it } from 'vitest'
import type { ResourceMeasure } from '../shared/resource.js'
import { attribute, parsePsTable, psInvocation, totalOf } from './resource-collector.js'

// pid ppid %cpu rss(KB). 손계산 표:
//   앱(roots 100·101)   = 100·101·102            cpu 1.5+2.0+0.5 = 4.0   rss 204800+102400+51200 = 358400
//   herdr(=셸들의 부모 200) = 200·250            cpu 3.0+0.3 = 3.3       rss 40960+1024 = 41984
//   pane A(셸 300)       = 300·301               cpu 0.0+50.0 = 50.0     rss 2048+10240 = 12288
//   pane B(셸 400)       = 400·401·402·403       cpu 0.1+10.0+1.0+0.2 = 11.3  rss 2048+122880+32768+4096 = 161792
//   999·1 은 어디에도 안 든다.
const TABLE = `
    1     0   0.0   1000
  100     1   1.5 204800
  101   100   2.0 102400
  102   100   0.5  51200
  200     1   3.0  40960
  250   200   0.3   1024
  300   200   0.0   2048
  301   300  50.0  10240

  400   200   0.1   2048
  401   400  10.0 122880
  402   401   1.0  32768
  403   402   0.2   4096
  999     1   9.9  99999
`
const KB = 1024
const PANES = [
  { paneId: 'A', shellPid: 300, expectedParent: null },
  { paneId: 'B', shellPid: 400, expectedParent: null },
]

function usage(measure: ResourceMeasure | undefined): { cpu: number; memory: number; pids: number[] } {
  if (measure === undefined || measure.state !== 'measured') throw new Error(`측정값이 아니다: ${JSON.stringify(measure)}`)
  return { cpu: Number(measure.usage.cpu.toFixed(3)), memory: measure.usage.memory, pids: measure.pids }
}

describe('parsePsTable', () => {
  it('빈 줄은 건너뛰고 rss 는 바이트로 옮긴다', () => {
    const table = parsePsTable(TABLE)
    expect(table.malformed).toBe(0)
    expect(table.rows.size).toBe(13)
    expect(table.rows.get(301)).toEqual({ pid: 301, ppid: 300, cpu: 50, memory: 10240 * KB })
  })
  it('로캘 콤마·칸 수 다름·같은 pid 두 줄은 malformed 로 센다', () => {
    expect(parsePsTable('  301 300 50,0 10240\n').malformed).toBe(1)
    expect(parsePsTable('  301 300 10240\n').malformed).toBe(1)
    expect(parsePsTable('  301 300 1.0 10\n  301 300 1.0 10\n').malformed).toBe(1)
    expect(parsePsTable('').malformed).toBe(0)
  })
})

describe('attribute — R1ⓐ 자손 합 = 손계산', () => {
  const result = attribute({ table: parsePsTable(TABLE), panes: PANES, appRoots: [100, 101] })
  it('pane 별 합', () => {
    expect(usage(result.panes.get('A'))).toEqual({ cpu: 50, memory: 12288 * KB, pids: [300, 301] })
    expect(usage(result.panes.get('B'))).toEqual({ cpu: 11.3, memory: 161792 * KB, pids: [400, 401, 402, 403] })
  })
  it('herdr = pane 셸들의 부모, pane 몫을 뺀 자손', () => {
    expect(usage(result.herdr)).toEqual({ cpu: 3.3, memory: 41984 * KB, pids: [200, 250] })
  })
  it('앱 = main·역할 pid 와 자손', () => {
    expect(usage(result.app)).toEqual({ cpu: 4, memory: 358400 * KB, pids: [100, 101, 102] })
  })
  it('전체 = 넷의 합', () => {
    const { total, unavailableCount } = totalOf([result.app, result.herdr, ...[...result.panes.values()]])
    expect(unavailableCount).toBe(0)
    expect(total?.memory).toBe((358400 + 41984 + 12288 + 161792) * KB)
    expect(Number(total?.cpu.toFixed(3))).toBe(68.6)
  })
})

describe('attribute — R1ⓑ 한 pid 는 한 곳에만', () => {
  it('앱·herdr·pane 사이 중복 0 (herdr 가 앱의 자식이어도)', () => {
    // 개발 실행처럼 앱이 herdr 를 띄운 경우: 200 의 부모가 100.
    const nested = TABLE.replace('  200     1   3.0  40960', '  200   100   3.0  40960')
    const result = attribute({ table: parsePsTable(nested), panes: PANES, appRoots: [100, 101] })
    const sets = [result.app, result.herdr, ...result.panes.values()].map((measure) => usage(measure).pids)
    const all = sets.flat()
    expect(new Set(all).size).toBe(all.length)
    expect(usage(result.app).pids).toEqual([100, 101, 102])
    expect(usage(result.herdr).pids).toEqual([200, 250])
  })
  it('두 pane 이 같은 셸 pid 를 가리키면 뒤의 것은 측정 불가', () => {
    const result = attribute({ table: parsePsTable(TABLE), panes: [{ paneId: 'A', shellPid: 300, expectedParent: null }, { paneId: 'A2', shellPid: 300, expectedParent: null }], appRoots: [100] })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
    expect(result.panes.get('A2')?.state).toBe('unavailable')
  })
})

describe('attribute — R1ⓒ 이상 입력에서 예외 없이 측정 불가', () => {
  it('사라진 루트 pid — 그 pane 만', () => {
    const result = attribute({ table: parsePsTable(TABLE), panes: [...PANES, { paneId: 'gone', shellPid: 4242, expectedParent: null }], appRoots: [100] })
    expect(result.panes.get('gone')).toEqual({ state: 'unavailable', reason: '셸 프로세스(pid 4242)가 없다' })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
  })
  it('셸 pid 를 모름(herdr 실패)', () => {
    const result = attribute({ table: parsePsTable(TABLE), panes: [{ paneId: 'x', shellPid: null, expectedParent: null }], appRoots: [100] })
    expect(result.panes.get('x')?.state).toBe('unavailable')
    expect(result.herdr.state).toBe('unavailable')
  })
  it('ppid 순환 — 그 pane 측정 불가, 다른 pane 은 그대로', () => {
    const cyclic = `${TABLE}\n  500   501   1.0  100\n  501   500   1.0  100\n`
    const result = attribute({ table: parsePsTable(cyclic), panes: [...PANES, { paneId: 'loop', shellPid: 500, expectedParent: null }], appRoots: [100] })
    expect(result.panes.get('loop')).toEqual({ state: 'unavailable', reason: 'ppid 순환' })
    expect(usage(result.panes.get('B')).pids).toEqual([400, 401, 402, 403])
  })
  it('자기 자신이 부모인 루트도 순환', () => {
    const result = attribute({ table: parsePsTable('  600 600 0.0 10\n'), panes: [{ paneId: 'self', shellPid: 600, expectedParent: null }], appRoots: [] })
    expect(result.panes.get('self')?.state).toBe('unavailable')
  })
  it('빈 표 — 전부 측정 불가, 전체 null', () => {
    const result = attribute({ table: parsePsTable('\n\n'), panes: PANES, appRoots: [100] })
    expect([...result.panes.values()].every((measure) => measure.state === 'unavailable')).toBe(true)
    expect(result.app.state).toBe('unavailable')
    expect(totalOf([result.app, result.herdr, ...result.panes.values()]).total).toBeNull()
  })
  it('로캘 콤마 줄 — 표 전체를 믿지 않는다', () => {
    const comma = TABLE.replace('  301   300  50.0  10240', '  301   300  50,0  10240')
    const result = attribute({ table: parsePsTable(comma), panes: PANES, appRoots: [100] })
    expect(result.panes.get('A')).toEqual({ state: 'unavailable', reason: 'ps 표 이상 (1줄)' })
    expect(result.panes.get('B')?.state).toBe('unavailable')
    expect(result.app.state).toBe('unavailable')
  })
})

describe('psInvocation — R1ⓓ LC_ALL=C', () => {
  it('로캘을 덮어쓰고 나머지 환경은 유지한다', () => {
    const invocation = psInvocation({ PATH: '/usr/bin', LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' })
    expect(invocation.file).toBe('ps')
    expect(invocation.args).toEqual(['-axo', 'pid=,ppid=,pcpu=,rss='])
    expect(invocation.env).toEqual({ PATH: '/usr/bin', LC_ALL: 'C', LANG: 'de_DE.UTF-8' })
  })
})

describe('attribute — F1 셸 pid 재사용 의심', () => {
  it('처음 본 부모와 지금 ppid 가 다르면 그 pane 은 측정 불가 — 다른 프로세스를 그 pane 으로 세지 않는다 (리뷰 P5)', () => {
    // 300 이 ppid 1 의 무관 프로세스로 재사용됐다.
    const reused = TABLE.replace('  300   200   0.0   2048', '  300     1  77.0 900000').replace('  301   300  50.0  10240\n', '')
    const result = attribute({ table: parsePsTable(reused), panes: [{ paneId: 'A', shellPid: 300, expectedParent: 200 }, { paneId: 'B', shellPid: 400, expectedParent: 200 }], appRoots: [100] })
    expect(result.panes.get('A')).toEqual({ state: 'unavailable', reason: '셸 pid 300 의 부모가 바뀌었다(200 → 1) — pid 재사용 의심' })
    expect(usage(result.panes.get('B')).pids).toEqual([400, 401, 402, 403])
  })
  it('부모가 같으면 그대로 측정', () => {
    const result = attribute({ table: parsePsTable(TABLE), panes: [{ paneId: 'A', shellPid: 300, expectedParent: 200 }], appRoots: [100] })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
  })
})

describe('attribute — F9 걸러진 루트 0개는 측정 불가', () => {
  it('셸 부모(herdr)가 표에 없으면 herdr 는 0 이 아니라 측정 불가 (리뷰 G1-6)', () => {
    const noHerdr = TABLE.replace('  200     1   3.0  40960\n', '')
    const result = attribute({ table: parsePsTable(noHerdr), panes: PANES, appRoots: [100] })
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '셸 부모 pid(200)가 ps 표에 없다' })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
  })
  it('앱 루트가 pane 자손으로 이미 귀속됐으면 앱은 측정 불가 (리뷰 P2 — corral 개발 실행을 pane 안에서 띄운 경우)', () => {
    const nested = TABLE.replace('  100     1   1.5 204800', '  100   401   1.5 204800')
    const result = attribute({ table: parsePsTable(nested), panes: PANES, appRoots: [100, 101] })
    expect(result.app).toEqual({ state: 'unavailable', reason: '앱 프로세스가 이미 pane·herdr 몫으로 귀속됐다' })
    expect(usage(result.panes.get('B')).pids).toContain(100)
  })
  it('앱 루트가 표에 없으면 측정 불가', () => {
    const result = attribute({ table: parsePsTable(TABLE), panes: PANES, appRoots: [4242] })
    expect(result.app).toEqual({ state: 'unavailable', reason: '앱 프로세스가 ps 표에 없다' })
  })
})

describe('attribute — 셸 부모가 1 이면 herdr 루트로 쓰지 않는다', () => {
  it('pid 1 아래 전체를 herdr 로 삼키지 않는다', () => {
    const orphan = TABLE.replace('  300   200   0.0   2048', '  300     1   0.0   2048')
    const result = attribute({ table: parsePsTable(orphan), panes: [{ paneId: 'A', shellPid: 300, expectedParent: null }], appRoots: [100] })
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '측정된 pane 셸의 부모가 모두 pid 1 이라 herdr 서버 pid 를 모른다' })
    expect(usage(result.app).pids).not.toContain(999)
  })
})

describe('attribute — H9 herdr 사유는 경우별로', () => {
  it('측정된 pane 셸의 부모가 모두 pid 1', () => {
    const orphan = TABLE.replace('  300   200   0.0   2048', '  300     1   0.0   2048')
    const result = attribute({ table: parsePsTable(orphan), panes: [{ paneId: 'A', shellPid: 300, expectedParent: null }], appRoots: [100] })
    expect(result.panes.get('A')?.state).toBe('measured')
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '측정된 pane 셸의 부모가 모두 pid 1 이라 herdr 서버 pid 를 모른다' })
  })
  it('셸의 부모가 앱 프로세스 — 앱 행을 herdr 로 삼키지 않는다(C5)', () => {
    const appChild = TABLE.replace('  300   200   0.0   2048', '  300   100   0.0   2048')
    const result = attribute({ table: parsePsTable(appChild), panes: [{ paneId: 'A', shellPid: 300, expectedParent: null }], appRoots: [100, 101] })
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '측정된 pane 셸의 부모가 앱 프로세스라 herdr 서버를 따로 세지 않는다' })
    expect(usage(result.app).pids).toEqual([100, 101, 102])
  })
})
