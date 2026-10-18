// 이 Mac 의 링크 machine 이름 고정 (LIFE-635 X1-3) — 출처 링크 판별(종류 + 값 + machine)의 machine 은 재기동해도 같아야 한다.
//
// `readMacName` 은 컴퓨터 이름 조회(scutil)가 일시 실패하면 hostname 으로 바뀐다 — 그 값을 매번 새로 읽으면 같은 Mac 이 실행마다 다른 machine 이 돼
// 떼기가 옛 행을 못 찾는다. 그래서 **처음 정한 값을 userData 의 작은 파일(`work-machine.json`)에 두고 그 뒤로는 그 값만 쓴다**.
// - 파일이 있고 모양이 맞으면 조회하지 않는다. 없거나 깨졌으면 한 번 조회해 정규화한 값을 잠금 안에서 파일에 남긴다.
//   동시에 뜬 실행끼리도 값은 하나 — 잠금에서 진 실행은 확정된 파일 값을 돌려준다(X2-3).
// - **영속하지 못한 값은 확정값이 아니다**(X3-3): 잠금 대기 상한·쓰기 실패면 `MachineUnsettledError`(그 이름을 싣는다 — 화면 표시용)를 던진다.
//   서비스는 그 값으로 출처 쓰기를 하지 않고(미룸) 다음 호출에 다시 확정을 시도한다. design-notes §12.
// - 사용자가 Mac 이름을 바꿔도 machine 은 그대로다(판별 키 안정이 먼저 — 표시 이름 갱신은 이 파일을 지우면 다음 실행에 새로 정한다). design-notes §1.
// - `repos.json` 은 건드리지 않는다. 비밀이 아니다.
import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../../shared/json.js'

export const MACHINE_FILE = 'work-machine.json'

/**
 * 최초 확정 잠금(X2-3) — 이보다 오래된 잠금은 죽은 실행이 남긴 것으로 보고 치운다 · 잠금을 기다리는 상한.
 * 대기 상한 > 잔류 판정(X3-3): 방금 죽은 실행이 남긴 잠금도 한 번의 확정 시도 안에서 오래된 것이 돼 치워지고 이 실행이 쓴다. 잠금은 쓰는 동안(ms)만 잡힌다.
 */
export const MACHINE_LOCK_STALE_MS = 10_000
export const MACHINE_LOCK_WAIT_MS = 12_000

/** 이름은 정했지만 파일에 영속하지 못했다(X3-3) — 이 값으로 출처 쓰기를 하지 않는다. `machine` = 표시용 이름. */
export class MachineUnsettledError extends Error {
  readonly machine: string
  constructor({ machine, reason }: { machine: string; reason: string }) {
    super(`machine 미확정: ${reason}`)
    this.machine = machine
  }
}

/**
 * 최초 확정(파일 없음)과 깨진 파일 재생성은 **같은 규칙** 하나(X2-3): 배타 잠금(`work-machine.json.lock` 디렉터리 — `mkdir` 은 하나만 성공)을 잡은 실행만 쓴다.
 * 잠금 안에서 파일을 다시 읽어 정상이면 그 값을 돌려준다 — 경합에서 진 실행은 이긴 실행이 확정한 값을 다시 읽어 반환한다(자기 조회값을 덮어쓰지 않는다).
 * 잠금을 못 잡으면 정상 파일이 생길 때까지 짧게 다시 본다. 상한까지 못 잡거나 디렉터리에 못 쓰면 `MachineUnsettledError`(X3-3 — 미확정, 출처 쓰기 미룸).
 */
export function persistedMachine({ dir, read, log = () => {}, timing = { staleMs: MACHINE_LOCK_STALE_MS, waitMs: MACHINE_LOCK_WAIT_MS } }: {
  dir: string
  read: () => Promise<string>
  log?: (event: string, data: Record<string, unknown>) => void
  /** 잠금 잔류 판정·대기 상한 — 시험이 줄인다. */
  timing?: { staleMs: number; waitMs: number }
}): () => Promise<string> {
  const file = path.join(dir, MACHINE_FILE)
  const lock = `${file}.lock`
  const unsettled = ({ name, reason }: { name: string; reason: string }): never => {
    log('work.machine_save_failed', { error: reason })
    throw new MachineUnsettledError({ machine: name, reason })
  }
  return async () => {
    const saved = readSaved(file)
    if (saved !== null) return saved
    const name = normalizeMachine(await read().catch(() => '')) ?? 'Mac'
    const deadline = Date.now() + timing.waitMs
    for (;;) {
      const settled = readSaved(file)
      if (settled !== null) return settled
      const taken = takeLock({ dir, lock, staleMs: timing.staleMs })
      if (taken === 'unwritable') return unsettled({ name, reason: 'unwritable' })
      if (taken === 'taken') {
        try {
          const again = readSaved(file)
          if (again !== null) return again
          const tmp = `${file}.${process.pid}.tmp`
          fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, machine: name })}\n`)
          fs.renameSync(tmp, file)
          return name
        } catch (error) {
          return unsettled({ name, reason: String(error) })
        } finally {
          fs.rmSync(lock, { recursive: true, force: true })
        }
      }
      if (Date.now() >= deadline) return unsettled({ name, reason: 'lock_timeout' })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

/** 잠금 잡기 — `busy` = 다른 실행이 잡고 있다(오래된 잠금은 치우고 busy — 다음 회차에 다시 잡는다) · `unwritable` = 디렉터리에 못 쓴다(기다려도 소용없다). */
function takeLock({ dir, lock, staleMs }: { dir: string; lock: string; staleMs: number }): 'taken' | 'busy' | 'unwritable' {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return 'unwritable'
  }
  try {
    fs.mkdirSync(lock)
    return 'taken'
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') return 'unwritable'
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmSync(lock, { recursive: true, force: true })
    } catch {
      // 잠금이 그새 풀렸다 — 다음 회차.
    }
    return 'busy'
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

/** machine 정규화 — LA 와 같이 앞뒤 공백을 떼고(제어 문자는 mac-name 이 이미 뺐다) 100자까지. 비면 null. */
export function normalizeMachine(raw: string): string | null {
  const name = raw.trim().slice(0, 100).trim()
  return name.length > 0 ? name : null
}
