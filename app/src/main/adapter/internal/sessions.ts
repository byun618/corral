// 세션 발견 — 소켓 API 의 **바깥** 문제다.
//
// 27종 구독 타입에 세션 라이프사이클이 없는 것은 누락이 아니라 구조상 있을 수 없는 것이다:
// herdr 는 세션마다 독립된 서버 프로세스 + 독립된 소켓이고, 소켓에 붙었다는 건 이미 한 세션을
// 고른 뒤라는 뜻이다. 그래서 이 층은 **구독이 아니라 재조회(polling)** 다.
// (macOS 에서 fs.watch 로 유닉스 소켓 파일 생성을 감지할 수 없다는 1차 근거도 있다 —
//  nodejs/node#38014. 파일 watch 는 시도하지 않는다.)
//
// 경로 규칙이 두 갈래다 (`herdr` 는 앱 폴더 이름 — 동봉 herdr 는 `corral-herdr`, LIFE-556):
//   default        → ~/.config/herdr/herdr.sock
//   named <이름>   → ~/.config/herdr/sessions/<이름>/herdr.sock

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { isRecord, readString, safeParse } from '../../../shared/json.js'
import type { SessionInfo } from '../../../shared/types.js'
import { log } from '../../log.js'
import { STOCK_HERDR_APP_DIR } from './server.js'

const run = promisify(execFile)

export const SESSION_POLL_MS = 3000

/**
 * `appDir` — herdr 앱 폴더 이름(`herdr` 또는 동봉 `corral-herdr`, LIFE-556). `HERDR_CONFIG_DIR` 덮어쓰기는 별도 설치 herdr 에만 —
 * 그 값이 동봉 폴더를 별도 설치 쪽으로 돌리지 않게 한다.
 */
export function herdrHome(appDir: string = STOCK_HERDR_APP_DIR): string {
  const fromEnv = process.env.HERDR_CONFIG_DIR
  if (appDir === STOCK_HERDR_APP_DIR && fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  // herdr 0.9.0 의 config_dir() 은 XDG_CONFIG_HOME/<앱 폴더> 를 따른다 (LIFE-485 S1) — 폴백도 같은 곳을 본다.
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg !== undefined && xdg.length > 0) return path.join(xdg, appDir)
  return path.join(os.homedir(), '.config', appDir)
}

/**
 * 세션 하나 — **소켓 경로까지** 든 것 (수정 1회차 L9).
 *
 * 렌더러가 보는 `SessionInfo` 에는 소켓이 없다. 소켓을 들고 다니는 건 이 타입이고,
 * 이건 어댑터 공개 입구를 지나 **main 까지만** 간다. preload·renderer 는 이 이름을 모른다.
 */
export type SessionHandle = SessionInfo & {
  socketPath: string
  /** 세션 디렉터리 — 재개 대상 계수가 읽을 session.json 의 자리 (LIFE-485 D2). CLI 가 준 값만 믿는다. */
  sessionDir: string | null
}

export type SessionScan = { sessions: SessionHandle[]; source: 'cli' | 'filesystem'; error: string | null }

/**
 * `binary` 는 해소한 절대경로다 (LIFE-485 D5) — bare name `herdr` 는 Finder·Dock 기동 앱의 최소 PATH 에서
 * ENOENT 로 떨어진다. 해소 전·해소 실패면 null 이고 그때는 파일시스템 폴백이다.
 * `appDir` — 폴백이 볼 herdr 앱 폴더 이름 (LIFE-556). 설치본은 동봉 폴더만 본다.
 */
export async function listSessions(input: { binary: string | null; appDir: string }): Promise<SessionScan> {
  const { binary, appDir } = input
  if (process.env.CORRAL_BACKEND_SOCKET && process.env.CORRAL_SESSION) return {sessions:[{name:process.env.CORRAL_SESSION,isDefault:false,running:fs.existsSync(process.env.CORRAL_BACKEND_SOCKET),socketPath:process.env.CORRAL_BACKEND_SOCKET,sessionDir:null}],source:'filesystem',error:null}
  if (binary === null) return scanFilesystem({ reason: 'herdr 실행 파일을 해소하지 못했다', appDir })
  try {
    const { stdout } = await run(binary, ['session', 'list', '--json'], { timeout: 5000 })
    const sessions = parseSessionList(stdout)
    if (sessions !== null) {
      log('sessions.poll', { source: 'cli', binary, count: sessions.length, names: sessions.map((item) => item.name) })
      return { sessions, source: 'cli', error: null }
    }
    return scanFilesystem({ reason: 'herdr session list --json 의 모양이 예상과 다르다', appDir })
  } catch (error) {
    return scanFilesystem({ reason: String(error), appDir })
  }
}

function parseSessionList(stdout: string): SessionHandle[] | null {
  const parsed = safeParse(stdout)
  if (!isRecord(parsed)) return null
  const list = parsed['sessions']
  if (!Array.isArray(list)) return null
  const sessions: SessionHandle[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const name = readString(item, 'name')
    const socketPath = readString(item, 'socket_path')
    if (name === null || socketPath === null) continue
    sessions.push({
      name,
      isDefault: item['default'] === true,
      running: item['running'] === true,
      socketPath,
      sessionDir: readString(item, 'session_dir'),
    })
  }
  return sessions
}

/** CLI 가 없거나 실패할 때의 폴백. 경로 규칙 두 갈래를 그대로 구현한다. */
function scanFilesystem(input: { reason: string; appDir: string }): SessionScan {
  const { reason } = input
  const home = herdrHome(input.appDir)
  const sessions: SessionHandle[] = []
  const defaultSocket = path.join(home, 'herdr.sock')
  if (fs.existsSync(defaultSocket)) {
    sessions.push({ name: 'default', isDefault: true, running: true, socketPath: defaultSocket, sessionDir: null })
  }
  const namedDir = path.join(home, 'sessions')
  if (fs.existsSync(namedDir)) {
    for (const entry of fs.readdirSync(namedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const socketPath = path.join(namedDir, entry.name, 'herdr.sock')
      if (!fs.existsSync(socketPath)) continue
      sessions.push({ name: entry.name, isDefault: false, running: true, socketPath, sessionDir: null })
    }
  }
  log('sessions.poll', { source: 'filesystem', count: sessions.length, reason })
  return { sessions, source: 'filesystem', error: reason }
}
