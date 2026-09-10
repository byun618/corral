// ⓑ·ⓒ 프로브가 공유하는 pane 조작. 요청 1건 = 커넥션 1개 (서버가 응답 뒤 닫는다).

import { Conn } from './herdr.mjs'
import { sleep } from './raw.mjs'

export function makeApi(raw) {
  async function api(method, params = {}, { timeoutMs = 20000 } = {}) {
    const c = new Conn({ onLine: ({ line }) => raw?.wire('rx', line, { method }) })
    await c.connect()
    try {
      const r = await c.request(method, params, { timeoutMs })
      raw?.log('request', { method, params, ok: !!r.result, error: r.error ?? null })
      if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`)
      return r.result
    } finally {
      c.end()
    }
  }
  return api
}

/** 명령을 치고 엔터. send_text 는 그대로 입력되므로 개행을 붙여 제출한다. */
export async function run(api, paneId, cmd, { settleMs = 700 } = {}) {
  await api('pane.send_text', { pane_id: paneId, text: cmd + '\n' })
  await sleep(settleMs)
}

/** pane.read 결과는 {type:'pane_read', read:{...}} 로 한 겹 싸여 온다. */
const unwrap = (r) => r.read

/** ANSI 스냅샷은 strip_ansi:false 를 같이 줘야 한다 — 기본값이 true 라 벗겨진다. */
export function readAnsi(api, paneId, source = 'visible', lines) {
  return api('pane.read', {
    pane_id: paneId,
    source,
    format: 'ansi',
    strip_ansi: false,
    ...(lines ? { lines } : {}),
  }).then(unwrap)
}

export function readText(api, paneId, source = 'visible', lines) {
  return api('pane.read', {
    pane_id: paneId,
    source,
    format: 'text',
    ...(lines ? { lines } : {}),
  }).then(unwrap)
}

/**
 * 같은 프레임에서 뜬 ansi/text 쌍만 비교에 쓴다 (01-criteria.md 규약 6).
 * revision 이 어긋나면 사이에 화면이 바뀐 것이므로 다시 뜬다.
 */
export async function readPair(api, paneId, source = 'visible', { tries = 8 } = {}) {
  for (let i = 0; i < tries; i++) {
    const ansi = await readAnsi(api, paneId, source)
    const text = await readText(api, paneId, source)
    if (ansi.revision === text.revision) return { ansi, text, attempts: i + 1 }
    await sleep(120)
  }
  throw new Error('revision 이 계속 어긋난다 — 화면이 정지하지 않았다')
}
