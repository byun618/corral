// 앱 전체에 하나뿐인 연결 관리자 + 수명 신호(AppState·NetInfo) 배선 + React 구독.
import NetInfo from '@react-native-community/netinfo'
import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { createTimerClock } from '../core/clock'
import { ConnectionManager, type Snapshot } from '../core/connection'
import { ConnectionLog, type LogEntry } from '../core/log'
import { appVersion, deviceName } from './app-info'
import { attachLogFile, readLogFile } from './logfile'
import { openSocket } from './socket'
import { secureVault } from './vault'

const clock = createTimerClock()

export const connectionLog = new ConnectionLog(() => clock.now())
connectionLog.restore(readLogFile())
attachLogFile(connectionLog)

export const connection = new ConnectionManager({
  openSocket,
  vault: secureVault,
  clock,
  log: connectionLog,
  appVersion: appVersion(),
  deviceName: deviceName(),
})

let wired = false

/** 한 번만 — 루트 레이아웃이 부른다. */
export function startConnection(): void {
  if (wired) return
  wired = true
  // 'background' 만 백그라운드다 — 기동 직후 currentState 가 null·'unknown' 일 수 있어 그때도 붙기 시작한다.
  connection.setForeground(AppState.currentState !== 'background')
  AppState.addEventListener('change', (state) => connection.setForeground(state !== 'background'))
  let lastType: string | null = null
  NetInfo.addEventListener((state) => {
    const type = state.type
    // 첫 통지는 기준선 — 바뀐 것만 프로브 사유다.
    if (lastType !== null && lastType !== type) connection.networkChanged({ type, reachable: state.isInternetReachable })
    lastType = type
  })
  void connection.start()
}

export function useConnection(): Snapshot {
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot)
}

export function useConnectionLog(): readonly LogEntry[] {
  return useSyncExternalStore(
    (listener) => connectionLog.subscribe(listener),
    () => connectionLog.list(),
  )
}
