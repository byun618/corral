// 이 Mac 의 링크 machine 이름 고정 (LIFE-635 X1-3) — 출처 링크 판별(종류 + 값 + machine)의 machine 은 재기동해도 같아야 한다.
//
// `readMacName` 은 컴퓨터 이름 조회(scutil)가 일시 실패하면 hostname 으로 바뀐다 — 그 값을 매번 새로 읽으면 같은 Mac 이 실행마다 다른 machine 이 돼
// 떼기가 옛 행을 못 찾는다. 그래서 **처음 정한 값을 userData 의 작은 파일(`work-machine.json`)에 두고 그 뒤로는 그 값만 쓴다**.
// - 파일이 있고 모양이 맞으면 조회하지 않는다. 없거나 깨졌으면 한 번 조회해 정규화한 값을 쓰고 파일에 남긴다(쓰기 실패 = 이 실행만 그 값, 로그).
// - 사용자가 Mac 이름을 바꿔도 machine 은 그대로다(판별 키 안정이 먼저 — 표시 이름 갱신은 이 파일을 지우면 다음 실행에 새로 정한다). design-notes §1.
// - `repos.json` 은 건드리지 않는다. 비밀이 아니다.
import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../../shared/json.js'
import { normalizeMachine } from './service.js'

export const MACHINE_FILE = 'work-machine.json'

export function persistedMachine({ dir, read, log = () => {} }: { dir: string; read: () => Promise<string>; log?: (event: string, data: Record<string, unknown>) => void }): () => Promise<string> {
  const file = path.join(dir, MACHINE_FILE)
  return async () => {
    const saved = readSaved(file)
    if (saved !== null) return saved
    const name = normalizeMachine(await read()) ?? 'Mac'
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, machine: name })}\n`)
      fs.renameSync(tmp, file)
    } catch (error) {
      log('work.machine_save_failed', { error: String(error) })
    }
    return name
  }
}

function readSaved(file: string): string | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const parsed = safeParse(text)
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.machine !== 'string') return null
  return normalizeMachine(parsed.machine)
}
