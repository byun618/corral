// 탐색기 감시 프로세스 (LIFE-589 E4) — Electron `utilityProcess` 안에서 돈다. main 과는 `process.parentPort` 메시지로만 말한다.
//
// 왜 따로 프로세스인가: 감시가 죽거나 이벤트가 폭주해도 main(창·터미널 스트림)이 멀쩡해야 한다(E4ⓖ) — VS Code 도 감시를 utility process 에 둔다
// (`watcherClient.ts` · 572 c06). 왜 Node 재귀 `fs.watch` 인가: 네이티브 모듈 0(패키징 영향 없음)이고, macOS 디렉터리는 FSEvents 라 폴더 수만큼 fd 를 먹지 않는다
// (기준선 `raw/claude/e3-baseline/watch-probe.json` — fd 증가 0, chokidar 5 는 EMFILE). 대가는 제외 경로 이벤트도 JS 에 온다는 것 —
// **여기서** 버리고(`ChangeBatch`), 배치로 묶은 폴더 목록만 main 에 보낸다. FSEvents 는 심볼릭 링크를 따라가지 않는다(루프 안전 — E2ⓗ).
//
// 경로는 main 이 가둠(`explorer-fs.ts` confine)을 거친 realpath 만 보낸다(E7ⓔ). 이 프로세스는 받은 경로를 그대로 감시할 뿐 렌더러 입력을 보지 않는다.
import fs from 'node:fs'
import { ChangeBatch } from './explorer-watch-batch.js'

type Incoming = { type: 'watch'; id: string; path: string } | { type: 'unwatch'; id: string } | { type: 'crash' }

type Watch = { watcher: fs.FSWatcher; batch: ChangeBatch; timer: NodeJS.Timeout | null }

const watches = new Map<string, Watch>()
const port = process.parentPort

const send = (message: unknown): void => port.postMessage(message)

function readIncoming(data: unknown): Incoming | null {
  if (typeof data !== 'object' || data === null || !('type' in data)) return null
  if (data.type === 'crash') return { type: 'crash' }
  if (!('id' in data) || typeof data.id !== 'string') return null
  if (data.type === 'unwatch') return { type: 'unwatch', id: data.id }
  if (data.type === 'watch' && 'path' in data && typeof data.path === 'string') return { type: 'watch', id: data.id, path: data.path }
  return null
}

function flush(id: string): void {
  const entry = watches.get(id)
  if (entry === undefined) return
  entry.timer = null
  if (entry.batch.isEmpty()) return
  const now = Date.now()
  if (!entry.batch.due(now)) {
    entry.timer = setTimeout(() => flush(id), 30)
    return
  }
  const taken = entry.batch.take()
  if (taken !== null) send({ type: 'batch', id, excluded: entry.batch.excludedCount, ...taken })
}

function watch(id: string, target: string): void {
  unwatch(id)
  const batch = new ChangeBatch()
  try {
    const watcher = fs.watch(target, { recursive: true, persistent: true }, (_event, filename) => {
      batch.add({ filename: typeof filename === 'string' ? filename : null, now: Date.now() })
      const entry = watches.get(id)
      if (entry !== undefined && entry.timer === null && !batch.isEmpty()) entry.timer = setTimeout(() => flush(id), 30)
    })
    watcher.on('error', (error) => send({ type: 'error', id, error: String(error) }))
    watches.set(id, { watcher, batch, timer: null })
    send({ type: 'watching', id, count: watches.size })
  } catch (error) {
    send({ type: 'error', id, error: String(error) })
  }
}

function unwatch(id: string): void {
  const entry = watches.get(id)
  if (entry === undefined) return
  entry.watcher.close()
  if (entry.timer !== null) clearTimeout(entry.timer)
  watches.delete(id)
  send({ type: 'unwatched', id, count: watches.size })
}

port.on('message', (event) => {
  const message = readIncoming(event.data)
  if (message === null) return
  switch (message.type) {
    case 'watch':
      watch(message.id, message.path)
      return
    case 'unwatch':
      unwatch(message.id)
      return
    case 'crash':
      // E4ⓖ 장애 주입 — 계측 소켓에서만 온다(main 이 거른다). 처리되지 않은 예외로 프로세스를 끝낸다.
      setTimeout(() => {
        throw new Error('explorer-watcher 장애 주입')
      }, 0)
      return
  }
})

send({ type: 'ready', pid: process.pid })
