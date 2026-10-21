// LIFE-637 R1 · LIFE-676 R1 — 수집기 순수 층. 고정 ps 표 + footprint 표 + pane 루트 표로 귀속을 손계산과 대조한다.
import { describe, expect, it } from 'vitest'
import type { ResourceMeasure } from '../shared/resource.js'
import {
  attribute,
  parseCompressedBytes,
  parseFootprintTable,
  parsePressureLevel,
  parsePsTable,
  parseSwapUsage,
  psInvocation,
  totalOf,
  type FootprintTable,
  type PsTable,
} from './resource-collector.js'

// 고정 입력 한 장: pid ppid %cpu footprint(KB). 앞 세 칸이 ps 표(`pid= ppid= pcpu=`), 넷째 칸이 도우미 footprint 표가 된다(`tables`).
// ps 표에는 메모리 칸이 없다 — 메모리 합의 출처는 footprint 표뿐이다(LIFE-676 R1ⓐ). 손계산 표(메모리 = footprint 합):
//   앱(roots 100·101)   = 100·101·102            cpu 1.5+2.0+0.5 = 4.0   fp  204800+102400+51200 = 358400
//   herdr(=셸들의 부모 200) = 200·250            cpu 3.0+0.3 = 3.3       fp  40960+1024 = 41984
//   pane A(셸 300)       = 300·301               cpu 0.0+50.0 = 50.0     fp  2048+10240 = 12288
//   pane B(셸 400)       = 400·401·402·403       cpu 0.1+10.0+1.0+0.2 = 11.3  fp  2048+122880+32768+4096 = 161792
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

/** 고정 입력 → ps 표 stdout(앞 세 칸)·footprint 표 stdout(`pid 바이트`). 칸이 모자란 줄(이상 입력 시험)은 ps 쪽에만 그대로 둔다. */
function split(text: string): { ps: string; fp: string } {
  const lines = text.split('\n')
  const ps = lines.map((line) => line.trim().split(/\s+/).slice(0, 3).join(' ')).join('\n')
  const fp = lines.flatMap((line) => {
    const cells = line.trim().split(/\s+/)
    return cells.length === 4 && /^\d+$/.test(cells[0] ?? '') && /^\d+$/.test(cells[3] ?? '') ? [`${cells[0]} ${Number(cells[3]) * KB}`] : []
  }).join('\n')
  return { ps, fp }
}

function tables(text: string, footprint?: FootprintTable): { table: PsTable; footprint: FootprintTable } {
  const { ps, fp } = split(text)
  return { table: parsePsTable(ps), footprint: footprint ?? parseFootprintTable(fp) }
}
const PANES = [
  { paneId: 'A', shellPid: 300, expectedParent: null },
  { paneId: 'B', shellPid: 400, expectedParent: null },
]

function usage(measure: ResourceMeasure | undefined): { cpu: number; memory: number | string; pids: number[] } {
  if (measure === undefined || measure.state !== 'measured') throw new Error(`측정값이 아니다: ${JSON.stringify(measure)}`)
  const { memory } = measure.usage
  return { cpu: Number(measure.usage.cpu.toFixed(3)), memory: memory.state === 'measured' ? memory.bytes : `측정 불가: ${memory.reason}`, pids: measure.pids }
}

describe('parsePsTable', () => {
  it('빈 줄은 건너뛴다 — 칸은 pid·ppid·%cpu 셋(메모리 칸 없음)', () => {
    const table = parsePsTable(split(TABLE).ps)
    expect(table.malformed).toBe(0)
    expect(table.rows.size).toBe(13)
    expect(table.rows.get(301)).toEqual({ pid: 301, ppid: 300, cpu: 50 })
  })
  it('로캘 콤마·칸 수 다름·같은 pid 두 줄은 malformed 로 센다', () => {
    expect(parsePsTable('  301 300 50,0\n').malformed).toBe(1)
    expect(parsePsTable('  301 300\n').malformed).toBe(1)
    // 칸이 남는 줄도(J3 X9 — 모자란 쪽만 보던 시험). 637 의 rss 칸이 남은 4칸 줄도 이상이다.
    expect(parsePsTable('  301 300 1.0 10240\n').malformed).toBe(1)
    expect(parsePsTable('  301 300 1.0\n  301 300 1.0\n').malformed).toBe(1)
    expect(parsePsTable('').malformed).toBe(0)
  })
})

describe('attribute — R1ⓐ 자손 합 = 손계산 (메모리 = footprint 합)', () => {
  const result = attribute({ ...tables(TABLE), panes: PANES, appRoots: [100, 101] })
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
    const { total, unavailableCount, memoryUnavailableCount } = totalOf([result.app, result.herdr, ...[...result.panes.values()]])
    expect(unavailableCount).toBe(0)
    expect(memoryUnavailableCount).toBe(0)
    expect(total?.memory).toEqual({ state: 'measured', bytes: (358400 + 41984 + 12288 + 161792) * KB })
    expect(Number(total?.cpu.toFixed(3))).toBe(68.6)
  })
})

describe('attribute — R1ⓑ 한 pid 는 한 곳에만', () => {
  it('앱·herdr·pane 사이 중복 0 (herdr 가 앱의 자식이어도)', () => {
    // 개발 실행처럼 앱이 herdr 를 띄운 경우: 200 의 부모가 100.
    const nested = TABLE.replace('  200     1   3.0  40960', '  200   100   3.0  40960')
    const result = attribute({ ...tables(nested), panes: PANES, appRoots: [100, 101] })
    const sets = [result.app, result.herdr, ...result.panes.values()].map((measure) => usage(measure).pids)
    const all = sets.flat()
    expect(new Set(all).size).toBe(all.length)
    expect(usage(result.app).pids).toEqual([100, 101, 102])
    expect(usage(result.herdr).pids).toEqual([200, 250])
  })
  it('두 pane 이 같은 셸 pid 를 가리키면 뒤의 것은 측정 불가', () => {
    const result = attribute({ ...tables(TABLE), panes: [{ paneId: 'A', shellPid: 300, expectedParent: null }, { paneId: 'A2', shellPid: 300, expectedParent: null }], appRoots: [100] })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
    expect(result.panes.get('A2')?.state).toBe('unavailable')
  })
})

describe('attribute — R1ⓒ 이상 입력에서 예외 없이 측정 불가', () => {
  it('사라진 루트 pid — 그 pane 만', () => {
    const result = attribute({ ...tables(TABLE), panes: [...PANES, { paneId: 'gone', shellPid: 4242, expectedParent: null }], appRoots: [100] })
    expect(result.panes.get('gone')).toEqual({ state: 'unavailable', reason: '셸 프로세스(pid 4242)가 없다' })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
  })
  it('셸 pid 를 모름(herdr 실패)', () => {
    const result = attribute({ ...tables(TABLE), panes: [{ paneId: 'x', shellPid: null, expectedParent: null }], appRoots: [100] })
    expect(result.panes.get('x')?.state).toBe('unavailable')
    expect(result.herdr.state).toBe('unavailable')
  })
  it('ppid 순환 — 그 pane 측정 불가, 다른 pane 은 그대로', () => {
    const cyclic = `${TABLE}\n  500   501   1.0  100\n  501   500   1.0  100\n`
    const result = attribute({ ...tables(cyclic), panes: [...PANES, { paneId: 'loop', shellPid: 500, expectedParent: null }], appRoots: [100] })
    expect(result.panes.get('loop')).toEqual({ state: 'unavailable', reason: 'ppid 순환' })
    expect(usage(result.panes.get('B')).pids).toEqual([400, 401, 402, 403])
  })
  it('자기 자신이 부모인 루트도 순환', () => {
    const result = attribute({ ...tables('  600 600 0.0 10\n'), panes: [{ paneId: 'self', shellPid: 600, expectedParent: null }], appRoots: [] })
    expect(result.panes.get('self')?.state).toBe('unavailable')
  })
  it('빈 표 — 전부 측정 불가, 전체 null', () => {
    const result = attribute({ ...tables('\n\n'), panes: PANES, appRoots: [100] })
    expect([...result.panes.values()].every((measure) => measure.state === 'unavailable')).toBe(true)
    expect(result.app.state).toBe('unavailable')
    expect(totalOf([result.app, result.herdr, ...result.panes.values()]).total).toBeNull()
  })
  it('로캘 콤마 줄 — 표 전체를 믿지 않는다', () => {
    const comma = TABLE.replace('  301   300  50.0  10240', '  301   300  50,0  10240')
    const result = attribute({ ...tables(comma), panes: PANES, appRoots: [100] })
    expect(result.panes.get('A')).toEqual({ state: 'unavailable', reason: 'ps 표 이상 (1줄)' })
    expect(result.panes.get('B')?.state).toBe('unavailable')
    expect(result.app.state).toBe('unavailable')
  })
})

describe('psInvocation — R1ⓓ LC_ALL=C', () => {
  it('로캘을 덮어쓰고 나머지 환경은 유지한다', () => {
    const invocation = psInvocation({ PATH: '/usr/bin', LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' })
    expect(invocation.file).toBe('ps')
    expect(invocation.args).toEqual(['-axo', 'pid=,ppid=,pcpu='])
    expect(invocation.env).toEqual({ PATH: '/usr/bin', LC_ALL: 'C', LANG: 'de_DE.UTF-8' })
  })
})

describe('attribute — F1 셸 pid 재사용 의심', () => {
  it('처음 본 부모와 지금 ppid 가 다르면 그 pane 은 측정 불가 — 다른 프로세스를 그 pane 으로 세지 않는다 (리뷰 P5)', () => {
    // 300 이 ppid 1 의 무관 프로세스로 재사용됐다.
    const reused = TABLE.replace('  300   200   0.0   2048', '  300     1  77.0 900000').replace('  301   300  50.0  10240\n', '')
    const result = attribute({ ...tables(reused), panes: [{ paneId: 'A', shellPid: 300, expectedParent: 200 }, { paneId: 'B', shellPid: 400, expectedParent: 200 }], appRoots: [100] })
    expect(result.panes.get('A')).toEqual({ state: 'unavailable', reason: '셸 pid 300 의 부모가 바뀌었다(200 → 1) — pid 재사용 의심' })
    expect(usage(result.panes.get('B')).pids).toEqual([400, 401, 402, 403])
  })
  it('부모가 같으면 그대로 측정', () => {
    const result = attribute({ ...tables(TABLE), panes: [{ paneId: 'A', shellPid: 300, expectedParent: 200 }], appRoots: [100] })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
  })
})

describe('attribute — F9 걸러진 루트 0개는 측정 불가', () => {
  it('셸 부모(herdr)가 표에 없으면 herdr 는 0 이 아니라 측정 불가 (리뷰 G1-6)', () => {
    const noHerdr = TABLE.replace('  200     1   3.0  40960\n', '')
    const result = attribute({ ...tables(noHerdr), panes: PANES, appRoots: [100] })
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '셸 부모 pid(200)가 ps 표에 없다' })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
  })
  it('앱 루트가 pane 자손으로 이미 귀속됐으면 앱은 측정 불가 (리뷰 P2 — corral 개발 실행을 pane 안에서 띄운 경우)', () => {
    const nested = TABLE.replace('  100     1   1.5 204800', '  100   401   1.5 204800')
    const result = attribute({ ...tables(nested), panes: PANES, appRoots: [100, 101] })
    expect(result.app).toEqual({ state: 'unavailable', reason: '앱 프로세스가 이미 pane·herdr 몫으로 귀속됐다' })
    expect(usage(result.panes.get('B')).pids).toContain(100)
  })
  it('앱 루트가 표에 없으면 측정 불가', () => {
    const result = attribute({ ...tables(TABLE), panes: PANES, appRoots: [4242] })
    expect(result.app).toEqual({ state: 'unavailable', reason: '앱 프로세스가 ps 표에 없다' })
  })
})

describe('attribute — 셸 부모가 1 이면 herdr 루트로 쓰지 않는다', () => {
  it('pid 1 아래 전체를 herdr 로 삼키지 않는다', () => {
    const orphan = TABLE.replace('  300   200   0.0   2048', '  300     1   0.0   2048')
    const result = attribute({ ...tables(orphan), panes: [{ paneId: 'A', shellPid: 300, expectedParent: null }], appRoots: [100] })
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '측정된 pane 셸의 부모가 모두 pid 1 이라 herdr 서버 pid 를 모른다' })
    expect(usage(result.app).pids).not.toContain(999)
  })
})

describe('attribute — H9 herdr 사유는 경우별로', () => {
  it('측정된 pane 셸의 부모가 모두 pid 1', () => {
    const orphan = TABLE.replace('  300   200   0.0   2048', '  300     1   0.0   2048')
    const result = attribute({ ...tables(orphan), panes: [{ paneId: 'A', shellPid: 300, expectedParent: null }], appRoots: [100] })
    expect(result.panes.get('A')?.state).toBe('measured')
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '측정된 pane 셸의 부모가 모두 pid 1 이라 herdr 서버 pid 를 모른다' })
  })
  it('셸의 부모가 앱 프로세스 — 앱 행을 herdr 로 삼키지 않는다(C5)', () => {
    const appChild = TABLE.replace('  300   200   0.0   2048', '  300   100   0.0   2048')
    const result = attribute({ ...tables(appChild), panes: [{ paneId: 'A', shellPid: 300, expectedParent: null }], appRoots: [100, 101] })
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '측정된 pane 셸의 부모가 앱 프로세스라 herdr 서버를 따로 세지 않는다' })
    expect(usage(result.app).pids).toEqual([100, 101, 102])
  })
})

describe('attribute — J3 herdr·앱 가지의 순환·귀속', () => {
  it('herdr 루트가 ppid 순환 위면 herdr 는 측정 불가, pane 은 그대로 (Q1)', () => {
    const cyclic = TABLE.replace('  200     1   3.0  40960', '  200   250   3.0  40960')
    const result = attribute({ ...tables(cyclic), panes: PANES, appRoots: [100] })
    expect(result.herdr).toEqual({ state: 'unavailable', reason: 'ppid 순환' })
    expect(usage(result.panes.get('A')).pids).toEqual([300, 301])
    expect(usage(result.app).pids).toEqual([100, 101, 102])
  })
  it('앱 루트가 ppid 순환 위면 앱은 측정 불가 (Q2)', () => {
    const cyclic = TABLE.replace('  100     1   1.5 204800', '  100   101   1.5 204800')
    const result = attribute({ ...tables(cyclic), panes: PANES, appRoots: [100] })
    expect(result.app).toEqual({ state: 'unavailable', reason: 'ppid 순환' })
    expect(usage(result.herdr).pids).toEqual([200, 250])
  })
  it('셸 부모가 이미 다른 pane 의 자손이면 herdr 로 다시 세지 않는다 — 0 이 아니라 측정 불가 (Q6)', () => {
    // pane B 셸(400)의 부모 200 이 pane A 셸(300)의 자식이다. B 를 먼저 세고, A 가 200 을 가져간다.
    const nested = TABLE.replace('  200     1   3.0  40960', '  200   300   3.0  40960').replace('  300   200   0.0   2048', '  300     1   0.0   2048')
    const result = attribute({ ...tables(nested), panes: [PANES[1], PANES[0]].flatMap((pane) => (pane === undefined ? [] : [pane])), appRoots: [100] })
    expect(usage(result.panes.get('A')).pids).toEqual([200, 250, 300, 301])
    expect(result.herdr).toEqual({ state: 'unavailable', reason: '셸 부모 pid(200)가 이미 pane 몫으로 귀속됐다' })
  })
})

describe('parseFootprintTable — LIFE-676 R1ⓒ 표 이상은 표 전체 측정 불가', () => {
  it('`pid 바이트`·`pid ERR errno` 줄을 읽는다', () => {
    const table = parseFootprintTable('  1 ERR 1\n300 2097152\n\n301 ERR 3\n')
    expect(table).toEqual({ kind: 'ok', bytes: new Map([[300, 2097152]]), errors: new Map([[1, 1], [301, 3]]) })
  })
  it('숫자 아닌 칸·칸 수 다름·같은 pid 두 줄·빈 출력', () => {
    expect(parseFootprintTable('300 2.5M\n301 10\n')).toEqual({ kind: 'unavailable', reason: 'footprint 표 이상 (1줄)' })
    expect(parseFootprintTable('300 -1\n')).toEqual({ kind: 'unavailable', reason: 'footprint 표 이상 (1줄)' })
    expect(parseFootprintTable('300 10 20\n')).toEqual({ kind: 'unavailable', reason: 'footprint 표 이상 (1줄)' })
    expect(parseFootprintTable('300 ERR\n')).toEqual({ kind: 'unavailable', reason: 'footprint 표 이상 (1줄)' })
    expect(parseFootprintTable('300 10\n300 ERR 3\n')).toEqual({ kind: 'unavailable', reason: 'footprint 표 이상 (1줄)' })
    expect(parseFootprintTable('300 10\n300 10\n')).toEqual({ kind: 'unavailable', reason: 'footprint 표 이상 (1줄)' })
    expect(parseFootprintTable('')).toEqual({ kind: 'unavailable', reason: 'footprint 표가 비었다' })
    expect(parseFootprintTable('\n  \n')).toEqual({ kind: 'unavailable', reason: 'footprint 표가 비었다' })
  })
})

describe('attribute — LIFE-676 R1ⓐ RSS 는 메모리 합에 쓰이지 않는다', () => {
  it('ps 표에 메모리 칸이 없다 — 메모리는 footprint 표 값만 따라간다', () => {
    // 같은 ps 표에 footprint 만 바꾸면 메모리만 바뀌고 CPU 는 그대로다.
    const doubled = parseFootprintTable(split(TABLE).fp.split('\n').map((line) => line.replace(/ (\d+)$/, (_m, bytes: string) => ` ${Number(bytes) * 2}`)).join('\n'))
    const result = attribute({ ...tables(TABLE, doubled), panes: PANES, appRoots: [100, 101] })
    expect(usage(result.panes.get('B'))).toEqual({ cpu: 11.3, memory: 2 * 161792 * KB, pids: [400, 401, 402, 403] })
  })
})

describe('attribute — LIFE-676 R1ⓒ 도우미 실패 = 메모리 측정 불가, CPU 는 그대로 (Q2)', () => {
  for (const reason of ['footprint 도우미가 없다 (/x/corral-footprint)', 'footprint 도우미 비정상 종료 (코드 2)', 'footprint 도우미 시한 초과 (2000 ms)', 'footprint 표 이상 (3줄)', 'footprint 표가 비었다']) {
    it(reason, () => {
      const result = attribute({ ...tables(TABLE, { kind: 'unavailable', reason }), panes: PANES, appRoots: [100, 101] })
      for (const measure of [result.app, result.herdr, ...result.panes.values()]) expect(usage(measure).memory).toBe(`측정 불가: ${reason}`)
      expect(usage(result.panes.get('A')).cpu).toBe(50)
      const { total, unavailableCount, memoryUnavailableCount } = totalOf([result.app, result.herdr, ...result.panes.values()])
      expect(unavailableCount).toBe(0)
      expect(memoryUnavailableCount).toBe(4)
      expect(Number(total?.cpu.toFixed(3))).toBe(68.6)
      expect(total?.memory).toEqual({ state: 'unavailable', reason })
    })
  }
  it('RSS 로 대신하지 않는다 — 측정 불가 칸에 숫자가 없다', () => {
    const result = attribute({ ...tables(TABLE, { kind: 'unavailable', reason: 'x' }), panes: PANES, appRoots: [100] })
    const measure = result.panes.get('B')
    expect(measure?.state === 'measured' ? measure.usage.memory : null).toEqual({ state: 'unavailable', reason: 'x' })
  })
})

describe('attribute — LIFE-676 R1ⓓ ps 에는 있고 footprint 표에 없는 pid', () => {
  it('표에 없음 = ps 와 도우미 사이에 끝남 — 그 pid 만 메모리 합에서 뺀다', () => {
    const fp = split(TABLE).fp.split('\n').filter((line) => !line.startsWith('401 ')).join('\n')
    const result = attribute({ ...tables(TABLE, parseFootprintTable(fp)), panes: PANES, appRoots: [100] })
    expect(usage(result.panes.get('B'))).toEqual({ cpu: 11.3, memory: (161792 - 122880) * KB, pids: [400, 401, 402, 403] })
  })
  it('ERR ESRCH(3) 도 끝남 — 뺀다', () => {
    const fp = split(TABLE).fp.replace(/^401 \d+$/m, '401 ERR 3')
    const result = attribute({ ...tables(TABLE, parseFootprintTable(fp)), panes: PANES, appRoots: [100] })
    expect(usage(result.panes.get('B')).memory).toBe((161792 - 122880) * KB)
  })
  it('ERR 그 밖(EPERM 등) — 그 칸 메모리만 측정 불가, 다른 칸은 그대로', () => {
    const fp = split(TABLE).fp.replace(/^401 \d+$/m, '401 ERR 1')
    const result = attribute({ ...tables(TABLE, parseFootprintTable(fp)), panes: PANES, appRoots: [100, 101] })
    expect(usage(result.panes.get('B'))).toEqual({ cpu: 11.3, memory: '측정 불가: pid 401 의 footprint 를 못 읽었다 (errno 1)', pids: [400, 401, 402, 403] })
    expect(usage(result.panes.get('A')).memory).toBe(12288 * KB)
    const { total, memoryUnavailableCount } = totalOf([result.app, result.herdr, ...result.panes.values()])
    expect(memoryUnavailableCount).toBe(1)
    expect(total?.memory).toEqual({ state: 'measured', bytes: (358400 + 41984 + 12288) * KB })
  })
  it('귀속 밖 pid 의 ERR 는 아무 칸에도 영향이 없다 (pid 1 은 root — EPERM)', () => {
    const fp = split(TABLE).fp.replace(/^1 \d+$/m, '1 ERR 1')
    const result = attribute({ ...tables(TABLE, parseFootprintTable(fp)), panes: PANES, appRoots: [100, 101] })
    expect(totalOf([result.app, result.herdr, ...result.panes.values()]).memoryUnavailableCount).toBe(0)
  })
})

describe('시스템 지표 파서 — LIFE-676 R5ⓓ 못 읽으면 null', () => {
  it('vm.swapusage', () => {
    expect(parseSwapUsage('vm.swapusage: total = 24576.00M  used = 23332.38M  free = 1243.62M  (encrypted)\n')).toEqual({ total: 24576 * 1024 ** 2, used: 23332.38 * 1024 ** 2 })
    expect(parseSwapUsage('vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)')).toEqual({ total: 0, used: 0 })
    expect(parseSwapUsage('')).toBeNull()
    expect(parseSwapUsage('vm.swapusage: total = 2G')).toBeNull()
  })
  it('kern.memorystatus_vm_pressure_level', () => {
    expect(parsePressureLevel('1\n')).toBe('normal')
    expect(parsePressureLevel('2')).toBe('warning')
    expect(parsePressureLevel('4')).toBe('critical')
    expect(parsePressureLevel('3')).toBeNull()
    expect(parsePressureLevel('')).toBeNull()
  })
  it('vm_stat 압축기 점유 페이지 × 페이지 크기', () => {
    const vmStat = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      88474.\nPages stored in compressor:     1036162.\nPages occupied by compressor:            505637.\n'
    expect(parseCompressedBytes(vmStat)).toBe(505637 * 16384)
    expect(parseCompressedBytes('Pages occupied by compressor: 5.\n')).toBeNull()
    expect(parseCompressedBytes('Mach Virtual Memory Statistics: (page size of 16384 bytes)\n')).toBeNull()
  })
})
