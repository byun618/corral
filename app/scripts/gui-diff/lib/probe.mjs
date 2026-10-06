// 페이지 안에서 도는 관측기. **이 파일의 함수들은 문자열로 직렬화돼 렌더러에서 돈다** —
// 클로저를 잡으면 안 되고, 필요한 도우미는 전부 함수 안에 있어야 한다.
//
// 무엇을 재나 (C4): 의미 단위마다 ① 존재/부재·개수 ② 박스(영역 루트 기준 상대 좌표·크기)
// ③ 선별 computed style. 글자는 **적기만 하고 비교하지 않는다** — 두 앱의 문구가 다른 것은
// 이 도구가 가릴 일이 아니고(K7), 경과 시간("2분 전")은 캡처 사이에 저절로 바뀌어 잡음이 된다.

/**
 * 비교하는 속성 목록 (C4 "목록은 워커가 정하고 문서화").
 *
 * 고른 기준: **눈에 보이는 결과를 만드는 것만.** 넣지 않은 것과 그 이유는 아래 EXCLUDED 에 적는다.
 */
export const PROP_SETS = {
  // 상자 — 자리와 크기를 만드는 것
  box: [
    'display',
    'position',
    'boxSizing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'marginTop',
    'marginRight',
    'marginBottom',
    'marginLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'gap',
    'flexDirection',
    'alignItems',
    'justifyContent',
    'overflowX',
    'overflowY'
  ],
  // 칠 — 색·테두리·그림자
  paint: [
    'color',
    'backgroundColor',
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
    'borderTopStyle',
    'borderTopLeftRadius',
    'borderTopRightRadius',
    'borderBottomRightRadius',
    'borderBottomLeftRadius',
    'opacity',
    'boxShadow'
  ],
  // LIFE-527 — 창 드래그 영역 선언값(`-webkit-app-region`). **기록용** — drag 동작의 판정은 OS 수준 입력으로만 한다(527 G2).
  // `areas/titlebar.json` 만 이 세트를 청한다 — 다른 영역의 차이 수를 바꾸지 않는다.
  region: ['webkitAppRegion'],
  // 글자 — 선언값. 실제 렌더 폰트는 CDP `CSS.getPlatformFontsForNode` 로 따로 받는다(C7 분류 규칙)
  text: [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'letterSpacing',
    'textTransform',
    'textAlign',
    'whiteSpace',
    'textOverflow',
    'textDecorationLine'
  ]
}

/**
 * 일부러 뺀 속성과 사유. 리뷰어가 "왜 이건 안 보나" 를 문서에서 찾을 수 있게 코드 옆에 둔다.
 */
export const EXCLUDED_PROPS = [
  ['transition* / animation*', '캡처 시점에 값이 흔들리고, 우리는 애니메이션을 얼려 놓고 잰다 (K5)'],
  ['cursor', '포인터 모양은 정지 화면에 안 나오고 hover 상태 재현에 따라 흔들린다 (K5)'],
  ['outline*', 'OS·창 포커스에 따라 붙었다 떨어진다 — 두 앱의 포커스 상태를 완전히 맞출 수 없다 (K5)'],
  ['backgroundImage / listStyleImage', 'url() 안에 번들 해시가 들어가 매 빌드 달라진다. 값 비교 제외 (K5)'],
  ['zIndex', '쌓임 맥락이 다르면 숫자가 달라도 결과가 같다 — 숫자 차이가 곧 시각 차이가 아니다'],
  ['width / height (computed)', 'getBoundingClientRect 의 박스로 이미 잰다. 두 번 세면 한 차이가 두 행이 된다']
]

/**
 * 관측 함수 본문. `cdp.evaluate(collectSnapshot, spec)` 로 부른다.
 *
 * 인자 spec: `{ root, units: [{id, selector, props}], props: {세트이름: [속성…]} }`
 * — root·selector 는 **그 앱의** 선택자다. 짝짓기는 영역 정의 파일이 하고 여기는 모른다.
 */
export function collectSnapshot(spec) {
  // ---- 색 정규화 ----------------------------------------------------------
  // Chromium 은 같은 색을 빌드·속성에 따라 `rgb()`·`rgba()`·`oklch()`·`color(srgb …)` 로 돌려준다.
  // 표기가 다르면 같은 색이 차이로 잡힌다(K5). canvas 2d 로 한 번 통과시키면 전부 8비트 rgba 가 된다.
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const scratch = canvas.getContext('2d', { willReadFrequently: true })
  const colorCache = new Map()
  const normalizeColor = (value) => {
    if (colorCache.has(value)) return colorCache.get(value)
    let out = String(value)
    try {
      // **픽셀까지 간다.** `fillStyle` 을 되읽는 방식은 Chromium 이 `color(srgb 0.1436 …)` 를
      // 그대로 돌려줘서 같은 색이 표기 차이로 남는다(실측). 1×1 캔버스에 실제로 칠하고
      // 바이트를 읽으면 어떤 표기(oklch·color()·hsl·#hex)든 8비트 sRGB 하나로 모인다.
      scratch.clearRect(0, 0, 1, 1)
      scratch.fillStyle = 'rgba(0, 0, 0, 0)'
      scratch.fillStyle = value
      scratch.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = scratch.getImageData(0, 0, 1, 1).data
      // 알파는 0~255 로 오므로 소수 3자리로 되돌린다. 완전 투명은 색 성분이 의미 없으니 하나로 모은다.
      const alpha = Math.round((a / 255) * 1000) / 1000
      out = alpha === 0 ? 'rgba(0, 0, 0, 0)' : `rgba(${r}, ${g}, ${b}, ${alpha})`
    } catch {
      out = String(value)
    }
    colorCache.set(value, out)
    return out
  }
  const isColorProp = (name) => /color$/i.test(name)

  // 그림자·테두리 값 안에도 색이 박혀 있다. 색 토큰만 골라 바꾼다.
  const normalizeComposite = (value) =>
    String(value).replace(
      /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix)\([^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-fA-F]{3,8}\b/g,
      (token) => normalizeColor(token)
    )

  const round = (n) => Math.round(n * 100) / 100

  const rootEl = document.querySelector(spec.root)
  const meta = {
    capturedAt: new Date().toISOString(),
    href: location.href,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    hasFocus: document.hasFocus(),
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    htmlClass: document.documentElement.className || null,
    htmlDataTheme: document.documentElement.getAttribute('data-theme'),
    bodyClass: document.body?.className || null,
    // 관측값이다 — 리터럴 `true` 를 적어 두면 스냅샷을 읽는 사람이 「이 회차는 폰트가 준비됐었다」로
    // 읽는다 (L1). 준비 자체는 `settlePage` 의 `await document.fonts.ready` 가 한다.
    fontsStatus: document.fonts?.status ?? null,
    // **오류 오버레이**가 떠 있으면 화면을 덮으므로 그 캡처는 못 믿는다 (K4). 0 이어야 한다.
    devOverlays: document.querySelectorAll('vite-error-overlay, #vite-error-overlay').length,
    // dev 서버가 CSS 를 주입하는 <style> 태그 수. head 안이라 화면을 가리지 않으므로 경고가 아니라
    // **기록**이다 — 두 앱의 실행 모드가 다르다는 사실(Orca dev / corral build)을 숫자로 남긴다.
    devStyleTags: document.querySelectorAll('[data-vite-dev-id]').length,
    rootFound: Boolean(rootEl)
  }
  if (!rootEl) return { meta, error: `root selector not found: ${spec.root}`, elements: {} }

  const rootRect = rootEl.getBoundingClientRect()
  meta.rootBox = { w: round(rootRect.width), h: round(rootRect.height) }

  const elements = {}
  // 부모당 자식 상한도 이 값이다 — `diff.mjs` `MAX_CHILDREN` 과 같아야 한다(페이지 안에서 도는 함수라 가져올 수 없다).
  const MAX_ITEMS = 12
  const isVisible = (el) => {
    // `[inert]` 조상 아래는 박스가 있어도 **화면에서 쓸 수 없는** 자리다 (R4 — 접힌 무리 안에 남은 행을
    // present 로 세던 자리). 박스만 보면 숨은 행이 있는 것으로 잡힌다.
    if (el.closest('[inert]') !== null) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }
  const measure = (el, unit) => {
    const rect = el.getBoundingClientRect()
    const computed = getComputedStyle(el)
    const style = {}
    const wanted = new Set()
    for (const setName of unit.props ?? ['box', 'paint', 'text']) {
      for (const prop of spec.props[setName] ?? []) wanted.add(prop)
    }
    for (const prop of wanted) {
      const raw = computed[prop]
      if (raw === undefined || raw === null) continue
      style[prop] = isColorProp(prop) ? normalizeColor(String(raw)) : normalizeComposite(raw)
    }
    return {
      box: {
        x: round(rect.left - rootRect.left),
        y: round(rect.top - rootRect.top),
        w: round(rect.width),
        h: round(rect.height)
      },
      style,
      // 비교하지 않는 기록값 — 판정 문서에서 "무엇이 거기 있었나" 를 사람이 읽을 자리.
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      tag: el.tagName.toLowerCase()
    }
  }
  // 폰트(`CSS.getPlatformFontsForNode`)는 CDP 쪽에서 **노드마다** 받아야 한다 (G7). 여기서 잰
  // 요소에 표시를 남겨, 호출자가 같은 요소를 다시 집을 수 있게 한다 — 첫 요소만 재던 자리를 막는다.
  const mark = (el, unitId, index, childIndex) => {
    try {
      // **한 요소가 여러 단위에 걸릴 수 있다** — 예: Orca 의 첫 내비 버튼은 `search-row` 이면서
      // `nav-buttons[0]` 이고, 탭 요소는 `tab` 이면서 `tab-active` 다. 덮어쓰면 앞 단위의 표시가
      // 사라져 그 요소의 폰트가 「수집 실패」로 남는다(실측). 그래서 **덧붙이고** `~=` 로 찾는다.
      const key = childIndex === undefined ? `${unitId}#${index}` : `${unitId}#${index}.${childIndex}`
      const before = el.getAttribute('data-l443-node')
      const parts = before ? before.split(/\s+/).filter(Boolean) : []
      if (!parts.includes(key)) parts.push(key)
      el.setAttribute('data-l443-node', parts.join(' '))
    } catch {
      /* 표시를 못 달면 그 요소의 폰트는 「수집 실패」로 남는다 — 조용히 같다고 하지 않는다 */
    }
  }

  for (const unit of spec.units) {
    const scope = unit.global ? document : rootEl
    const record = {
      // **선언상 없음**(짝짓기 파일에 그 앱 선택자가 없다)과 **선택자가 0개를 찾음**을 갈라 둔다 (F11).
      declaredAbsent: unit.selector === null || unit.selector === undefined
    }
    if (typeof unit.parentSelector === 'string') {
      // **부모 단위로 잰다** (G2). 전역 순번으로 묶으면 자식이 없는 부모를 건너뛰면서
      // 다른 탭·다른 카드의 자식끼리 비교된다 — 실측으로 보고서에 거짓 차이가 실렸다.
      // 자식이 없는 부모는 **그 자리에 부재를 적는다**: 순번이 밀리지 않는다.
      const parents = Array.from(scope.querySelectorAll(unit.parentSelector)).filter(isVisible)
      record.parentScoped = true
      record.parentSelector = unit.parentSelector
      record.parents = parents.length
      const childCounts = []
      record.items = parents.slice(0, MAX_ITEMS).flatMap((parent, parentIndex) => {
        // 자식은 부모 **아래**를 먼저 보고, 없으면 **부모 자신**이 그 선택자인지 본다 —
        // 카드·탭처럼 「부모 자신의 상태」를 재는 단위(`.main-tab.is-active`)도 같은 순번 규약으로
        // 묶이게 하려는 것이다. 순번이 곧 의미인 자리라 예외를 만들지 않는다.
        let found = Array.from(parent.querySelectorAll(unit.selector)).filter(isVisible)
        if (found.length === 0) {
          try {
            if (parent.matches(unit.selector) && isVisible(parent)) found = [parent]
          } catch {
            /* 선택자가 matches 에서 깨지면 부재로 남는다 — 조용히 같다고 하지 않는다 */
          }
        }
        childCounts[parentIndex] = found.length
        if (found.length === 0) return [{ parentIndex, childIndex: 0, present: false }]
        // **부모 안의 자식을 전부 잰다** (R4). 첫 자식만 재던 판은 둘째 행·둘째 무리의 차이를 못 봤다.
        return found.slice(0, MAX_ITEMS).map((el, childIndex) => {
          mark(el, unit.id, parentIndex, childIndex)
          return { parentIndex, childIndex, present: true, siblings: found.length, ...measure(el, unit) }
        })
      })
      record.itemsTruncated = parents.length > MAX_ITEMS
      // 부모별 **실제** 자식 수 (fix-r2 S2) — 재는 것은 부모당 MAX_ITEMS 개까지라, 그 뒤가 있었는지는 이 칸만 안다.
      // diff 가 부모별 자식 수 차이를 이 값으로 견주고, 상한을 넘은 부모는 「미측정」 으로 드러낸다.
      record.childCounts = childCounts
      record.childrenTruncated = record.childCounts.some((n) => n > MAX_ITEMS)
      record.countAll = record.items.reduce((sum, item) => sum + (item.present && item.childIndex === 0 ? item.siblings : 0), 0)
      // count 는 예전 뜻(자식이 있는 부모 수) 그대로 — 자식 수 차이는 부모별 (부모, 자식) 짝에서 부재로 나온다.
      record.count = new Set(record.items.filter((item) => item.present).map((item) => item.parentIndex)).size
      record.present = record.count > 0
    } else {
      const found = Array.from(scope.querySelectorAll(unit.selector))
      // 화면에 없는 것(display:none 조상 포함)은 "부재" 다 — 박스가 0 인 요소를 존재로 세면
      // 조건부 렌더링 차이가 스타일 차이로 둔갑한다.
      const visible = found.filter(isVisible)
      record.present = visible.length > 0
      record.countAll = found.length
      record.count = visible.length
      // **걸린 요소를 전부 잰다** (F7). 개수 상한을 둔다 — 한 선택자에 수십 개가 걸리는 자리는
      // 짝짓기 규약이 잘못된 것이다.
      record.items = visible.slice(0, MAX_ITEMS).map((el, index) => {
        mark(el, unit.id, index)
        return { index, present: true, ...measure(el, unit) }
      })
      record.itemsTruncated = visible.length > MAX_ITEMS
    }
    // 양성 대조 (R4) — `[inert]` 라서 뺀 요소 수. 0 이 아니면 「숨은 행이 DOM 에 있었고 부재로 셌다」 는 뜻이다.
    if (typeof unit.selector === 'string') {
      try {
        record.inertExcluded = Array.from(scope.querySelectorAll(unit.selector)).filter((el) => {
          const rect = el.getBoundingClientRect()
          return el.closest('[inert]') !== null && (rect.width > 0 || rect.height > 0)
        }).length
      } catch {
        /* 선택자가 깨지면 기록하지 않는다 — 위에서 이미 부재로 남는다 */
      }
    }
    const first = record.items?.find((item) => item.present)
    // 첫 요소는 예전 모양 그대로도 남긴다 — 기존 원자료·보고서와 읽는 자리를 맞춘다.
    if (first) Object.assign(record, { box: first.box, style: first.style, text: first.text, tag: first.tag })
    elements[unit.id] = record
  }
  return { meta, elements }
}

/**
 * 캡처 직전 화면을 세운다 (K5). 폰트가 아직 안 붙었거나 전환이 도는 중이면 같은 화면을 두 번 찍어도
 * 다르게 나온다 — 그 흔들림은 잡음 바닥(C5)을 통과해 버릴 만큼 작고 꾸준하지 않다.
 *
 * 두 앱에 **같은** 스타일을 꽂는다. 비대칭이 곧 잡음이다.
 */
export async function settlePage(cdp) {
  // 포커스는 OS 창 하나에만 있다 — 두 앱을 동시에 띄우면 한쪽은 반드시 흐려진다.
  // `:focus-within`·활성 창 색이 걸린 칸이 그 차이로 갈리므로, **두 앱 모두** 포커스된 것으로
  // 에뮬레이션해 같은 조건으로 만든다. 실패해도 진행하고, 실제 값은 meta.hasFocus 로 관측한다.
  try {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  } catch {
    /* 이 Electron 이 안 받으면 meta.hasFocus 비대칭 경고로 드러난다 */
  }
  await cdp.evaluate(async () => {
    const id = '__l443_freeze'
    if (!document.getElementById(id)) {
      const style = document.createElement('style')
      style.id = id
      style.textContent =
        '*,*::before,*::after{transition:none !important;animation:none !important;caret-color:transparent !important}'
      document.head.appendChild(style)
    }
    if (document.fonts?.ready) await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return true
  })
}
