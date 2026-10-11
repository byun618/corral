// 연결 기록 파일 — 앱 문서 폴더의 NDJSON(비밀 없음, P8). 앱을 다시 켜도 남아 사후 회수할 수 있다.
// logcat 에도 `[corral-conn]` 한 줄씩 — 개발·코디 회수용.
import { File, Paths } from 'expo-file-system'
import { LOG_CAPACITY, parseLine, type ConnectionLog, type LogEntry } from '../core/log'

const FILE_NAME = 'connection-log.ndjson'
const FLUSH_MS = 1_000

function logFile(): File {
  return new File(Paths.document, FILE_NAME)
}

export function readLogFile(): LogEntry[] {
  try {
    const file = logFile()
    if (!file.exists) return []
    return file
      .textSync()
      .split('\n')
      .map(parseLine)
      .filter((entry): entry is LogEntry => entry !== null)
      .slice(-LOG_CAPACITY)
  } catch {
    return []
  }
}

export function attachLogFile(log: ConnectionLog): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    try {
      const file = logFile()
      if (!file.exists) file.create()
      file.write(log.text() + '\n')
    } catch {
      // 기록 파일은 보조 — 쓰기 실패가 연결을 막지 않는다
    }
  }
  log.addSink((_entry, line) => {
    console.log(`[corral-conn] ${line}`)
    if (timer === null) timer = setTimeout(flush, FLUSH_MS)
  })
}
