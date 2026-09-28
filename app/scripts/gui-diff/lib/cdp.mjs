// raw CDP 클라이언트 — `/json/list` 로 대상 창을 고르고 WebSocket 으로 붙는다.
//
// 왜 Playwright 가 아닌가: corral 의 기존 계측(`l373impl/p-profile.mjs`, `l391-first/gui-verify.mjs`)이
// 이미 이 경로로 Electron 44 에 붙었다 — 검증된 자산에서 출발하라는 기준(C11)이 여기를 가리킨다.
// Playwright `connectOverCDP` 는 기본 연결이 포커스·미디어 에뮬레이션을 깔고(00-analysis K2),
// 응답 없는 기존 페이지 하나가 connect 전체를 붙잡는 보고가 있다(K3, playwright#42882).
// **측정에 에뮬레이션이 끼면 그 자체가 차이로 나온다.** raw CDP 는 우리가 보낸 것만 한다.

const CONNECT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 30_000

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 조건이 참을 돌려줄 때까지 기다린다. 마지막 오류를 실패 메시지에 싣는다. */
export async function until(fn, label, timeoutMs = 30_000, stepMs = 120) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = String(error)
    }
    await pause(stepMs)
  }
  throw new Error(`[cdp] timeout waiting for ${label}${last ? ` — last: ${last}` : ''}`)
}

/**
 * 대상 창 고르기 (K3). `pages()[0]` 을 믿지 않는다 — DevTools·webview·서비스워커가 같은 목록에 있고,
 * Electron 은 숨은 창(팝아웃·백그라운드)을 먼저 돌려줄 수 있다. `type==='page'` 로 거른 뒤
 * 호출자가 준 술어로 고른다. 후보가 여럿이면 **고르지 않고 던진다** — 조용히 아무거나 재면
 * 캡처마다 다른 창을 잴 수 있고 그 흔들림은 잡음 바닥(C5)에 나타나지 않는다.
 */
/**
 * 기동 **전에** 그 CDP 포트가 비어 있는지 본다.
 *
 * 비어 있지 않으면 `pickTarget` 이 **남의 창**(앞선 회차가 남긴 고아 인스턴스)에 조용히 붙는다.
 * 실측: 고아에 붙은 회차는 스토어에 레포가 2개인데 DOM 은 0개로 나와
 * "corral worktree rows rendered" 에서 죽었고, 원인이 도구 밖에 있어 세 회차를 헛돌았다.
 * 그 자리에서 사유를 말하고 멈추는 편이 낫다 — 조용히 엉뚱한 앱을 재는 것이 최악이다.
 */
export async function assertPortFree(port, label) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return
    const body = await response.json().catch(() => ({}))
    throw new Error(
      `[cdp] ${label} 의 CDP 포트 ${port} 를 이미 누가 쓰고 있다 (${body.Browser ?? '알 수 없음'}). ` +
        '앞선 회차가 남긴 고아 인스턴스일 수 있다 — 그 프로세스를 닫고 다시 돌려라. ' +
        `확인: lsof -nP -iTCP:${port} -sTCP:LISTEN`
    )
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[cdp]')) throw error
    /* 못 붙으면 비어 있다는 뜻이다 */
  }
}

export async function pickTarget(port, { match, label }) {
  const targets = await until(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      const pages = list.filter((entry) => entry.type === 'page')
      const hits = pages.filter((entry) => match(entry))
      return hits.length > 0 ? { hits, pages } : null
    },
    `${label} CDP target on :${port}`,
    CONNECT_TIMEOUT_MS
  )
  if (targets.hits.length > 1) {
    const seen = targets.hits.map((entry) => ({ title: entry.title, url: entry.url }))
    throw new Error(`[cdp] ${label}: ${targets.hits.length} targets matched — ${JSON.stringify(seen)}`)
  }
  return { target: targets.hits[0], allPages: targets.pages }
}

/** 하나의 CDP 세션. `send` 는 메서드 하나를 호출하고 result 를 돌려준다. */
export async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('[cdp] websocket open timeout')), CONNECT_TIMEOUT_MS)
    socket.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.onerror = (event) => {
      clearTimeout(timer)
      reject(new Error(`[cdp] websocket error: ${event?.message ?? 'unknown'}`))
    }
  })

  let nextId = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const slot = pending.get(message.id)
    if (!slot) return
    pending.delete(message.id)
    clearTimeout(slot.timer)
    if (message.error) slot.reject(new Error(`[cdp] ${slot.method}: ${JSON.stringify(message.error)}`))
    else slot.resolve(message.result)
  }
  socket.onclose = () => {
    for (const [, slot] of pending) {
      clearTimeout(slot.timer)
      slot.reject(new Error('[cdp] websocket closed while a call was in flight'))
    }
    pending.clear()
  }

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`[cdp] ${method}: call timeout after ${CALL_TIMEOUT_MS}ms`))
      }, CALL_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer, method })
      socket.send(JSON.stringify({ id, method, params }))
    })

  /**
   * 페이지 안에서 함수를 돌리고 값을 받는다.
   *
   * 값은 JSON 으로 건너온다(`returnByValue`). `awaitPromise` 를 켜 두는 이유는 시드 단계가
   * 스토어의 async 액션(`fetchWorktrees` 등)을 기다려야 하기 때문이다.
   * 페이지가 던진 예외는 여기서 다시 던진다 — 조용한 `undefined` 는 "안 잡힘" 과 구분이 안 된다.
   */
  const evaluate = async (fn, arg = null) => {
    const expression = `(${fn.toString()})(${JSON.stringify(arg)})`
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      const text = detail.exception?.description ?? detail.text ?? JSON.stringify(detail)
      throw new Error(`[cdp] page threw: ${text}`)
    }
    return result.result?.value
  }

  const close = () =>
    new Promise((resolve) => {
      if (socket.readyState === 3) return resolve()
      socket.onclose = () => resolve()
      socket.close()
    })

  return { send, evaluate, close, socket }
}

/**
 * **브라우저 수준** 세션. 페이지 타깃 소켓에는 `Browser.*` 도메인이 없다.
 * (Electron 은 `Browser.getWindowForTarget`·`setWindowBounds` 를 구현하지 않는다 — 아래 참고.)
 */
export async function connectBrowser(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  return connect(version.webSocketDebuggerUrl)
}

/**
 * 두 앱의 **뷰포트를 같은 크기로** 세운다. Orca 탭 폭은 1280px 에서 갈리고
 * (`w-[180px] min-w-[72px] min-[1280px]:w-[220px]`, 실측), 사이드바 폭도 창 폭을 따라간다 —
 * 크기가 다르면 거의 모든 행이 차이로 나와 보고서가 쓸모없어진다.
 *
 * **왜 OS 창이 아니라 뷰포트인가**: Electron 43·44 둘 다 브라우저 수준에서
 * `Browser.getWindowForTarget` 을 구현하지 않는다 — 실측 오류
 * `{"code":-32601,"message":"'Browser.getWindowForTarget' wasn't found"}`
 * (`Browser.getVersion`·`Target.getTargets` 는 같은 소켓에서 정상 응답한다. 도메인이 없는 게 아니라
 * 그 명령이 없다). osascript 로 OS 창을 옮기는 길은 손쉬움 접근 권한 프롬프트를 띄울 수 있어
 * 사람 손을 부르므로 쓰지 않는다.
 *
 * 대신 **두 앱에 똑같은** device metrics 를 건다. 한쪽에만 걸면 그 비대칭이 곧 잡음이므로
 * 이 함수는 항상 두 앱에 같은 인자로 불린다. `deviceScaleFactor: 0` 은 "시스템 기본을 쓰라" 는 뜻이라
 * DPR 은 건드리지 않는다. 적용 사실은 보고서의 「측정 조건」에 적는다.
 */
export async function setViewport(cdp, { width, height }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false
  })
  // 실제로 그 크기가 됐는지는 페이지에 물어서 확인한다 — 요청값을 관측값으로 적지 않는다.
  return cdp.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio
  }))
}

export { pause }
