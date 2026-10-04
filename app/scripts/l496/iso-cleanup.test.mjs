// LIFE-496 fix6 R6-01 — 격리 정리 계획: 신호 대상은 이번 실행이 spawn 해 받은 pid 와 그 PPID 자손뿐이다.
// 경로 후보(`selectOwnedByPath`)는 진단이다 — 신호 근거가 아니다(own.mjs 머리말 H1). 대역 목록은 리뷰 r6 R6-01 반례 표 그대로.
import { describe, expect, it } from 'vitest'
import { planCleanup } from './iso-cleanup.mjs'

const target = '/tmp/l496i-r6/corral-userdata'
const processes = [
  { pid: 101, command: `Electron --user-data-dir=${target}` }, // 소유 프로필(spawn pid 로 받음)
  { pid: 201, command: `Electron --user-data-dir=${target} backup` }, // 다른 프로필 — ps 가 argv 의 공백을 평탄화
  { pid: 202, command: `Electron --user-data-dir=${target}-other` }, // 접미사 경계 음성
  { pid: 203, command: `python3 /tools/inspect.py ${target}/runtime/desktop.json` }, // 기록을 읽는 관찰자
  { pid: 204, command: '/Applications/Orca.app/Contents/MacOS/Orca' },
  { pid: 205, command: 'herdr --session default server' },
  { pid: 206, command: 'Electron --user-data-dir=/Users/demo/Library/Application Support/corral' },
  { pid: 207, command: `/bin/sh -c tail ${target}/runtime/desktop.log` },
]
const descendants = { 101: [111], 201: [211], 203: [213] }
const descendantsOf = (pid) => descendants[pid] ?? []

describe('planCleanup — spawn pid 와 자손만 신호 (R6-01)', () => {
  it('r6 반례 표: 신호 계획 = 101 과 그 자손 111 뿐이다. 201·203 과 그 자손은 경로 후보로만 남는다', () => {
    const { signals, pathCandidates } = planCleanup({ spawned: [{ pid: 101, label: 'corral desktop' }], descendantsOf, processes, paths: [target], preexisting: [], selfPid: 999 })
    expect(signals.map((entry) => entry.pid)).toEqual([101, 111])
    expect(pathCandidates.map((entry) => entry.pid)).toEqual([101, 201, 203])
  })

  it('spawn pid 가 없으면(detached Electron 의 pid 를 못 받음) 경로 후보가 있어도 신호 0', () => {
    const { signals, pathCandidates } = planCleanup({ spawned: [], descendantsOf, processes, paths: [target], preexisting: [], selfPid: 999 })
    expect(signals).toEqual([])
    expect(pathCandidates.length).toBeGreaterThan(0)
  })

  it('공백 든 소유 경로·기동 전부터 있던 pid 도 신호 근거가 아니다', () => {
    const spaced = '/tmp/l496i-r6 work/corral-userdata'
    const { signals } = planCleanup({
      spawned: [{ pid: 501, label: 'herdr backend' }],
      descendantsOf: () => [],
      processes: [{ pid: 301, command: `Electron --user-data-dir=${spaced}` }, ...processes],
      paths: [spaced, target],
      preexisting: [201, 203],
      selfPid: 999,
    })
    expect(signals.map((entry) => entry.pid)).toEqual([501])
  })
})
