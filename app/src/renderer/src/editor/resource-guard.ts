// 리소스 참조 가둠 (LIFE-590 수정 r1 R1-A · E4ⓓⓔ·E7ⓐ) — Markdown 미리보기·SVG 이미지에서 **브라우저가 스스로 불러오는 참조를 하나도 남기지 않는다.**
// 렌더러가 띄우는 파일 내용은 main 읽기 경계(`readImage` — 등록 루트·realpath 가둠·상한)만 거친다. 정화(DOMPurify) 뒤에 남는 참조 —
// URL 속성(`src`·`href`·`background`·`poster` …)·CSS `url()`/`image-set()`/`@import`(인라인 `style`·SVG 표현 속성 `fill="url(…)"` 등)·
// 애니메이션으로 속성을 바꾸는 요소(`<set>`·`<animate>`) — 를 정화 훅에서 지운다. 예외는 둘뿐:
//   ① HTML `A`·`IMG` 의 대상은 `data-md-href`·`data-md-src` 로 옮긴다 — 브라우저는 따라가지 않고 FileView 가 경계를 거쳐 처리한다(markdown.ts ②③).
//   ② SVG 안 **같은 문서 조각**(`href="#id"`·`url(#id)`) — 그라디언트·`<use>` 처럼 불러오기가 없다(SVG `<a>` 는 조각이어도 지운다 — 누르면 주소가 바뀐다).
// SVG 안 이미지·외부 문서 참조는 경계로 옮기지 않고 **지운다** — 브라우저가 SVG 를 `<img>` 로 띄울 때(VS Code 이미지 미리보기)도 외부 리소스를 싣지 않는다.
// CSP 위반 0 만으로는 가둠을 증명하지 못한다(`default-src 'self'` 는 file:// 앱 폴더 밖 상대 경로도 허용 — 리뷰 r1 재현).
import DOMPurify from 'dompurify'

const SVG_NS = 'http://www.w3.org/2000/svg'
const HTML_NS = 'http://www.w3.org/1999/xhtml'

/**
 * 값을 URL 로 해석하는 속성(HTML·SVG·MathML). 이름은 소문자. `a`·`area` 의 클릭 알림 속성은 `href` 가 있어야만 동작한다 — `href` 를 옮기거나 지우므로
 * 따로 적지 않는다(그 이름이 렌더러 경계 검사 R4 의 herdr 통신 토큰과 같다).
 */
const URL_ATTRS = new Set([
  'href', 'xlink:href', 'src', 'srcset', 'poster', 'background', 'action', 'formaction', 'data', 'codebase', 'cite', 'longdesc', 'lowsrc', 'dynsrc',
  'manifest', 'icon', 'profile', 'usemap', 'archive', 'classid', 'xml:base', 'imagesrcset', 'attributionsrc',
])

/** 정화 단계에서 통째로 빼는 요소 — 속성을 나중에 바꾸거나(애니메이션) 다른 문서를 끼워 넣는다. 정화 설정 `FORBID_TAGS` 에 더한다. */
export const RESOURCE_FORBID_TAGS = ['style', 'link', 'foreignObject', 'set', 'animate', 'animateMotion', 'animateTransform', 'animateColor', 'discard']

/**
 * 같은 문서 조각 참조인가 — `#` 로 시작하는 URL 은 문서를 떠나지 않는다(불러오기 없음). **ID 의 글자 모양은 보지 않는다**(한글·이모지 ID 도 조각 —
 * 수정 r2 R2-A: r1 은 ASCII 만 조각으로 쳐서 `url(#색)` 그라디언트를 지웠다). 따옴표·괄호·이스케이프·공백만 빼 `url()` 밖으로 새지 않게 한다.
 */
const FRAGMENT = String.raw`#[^\s'"()\\]*`
const LOCAL_URL = new RegExp(String.raw`url\(\s*(['"]?)` + FRAGMENT + String.raw`\1\s*\)`, 'giu')
const FRAGMENT_ONLY = new RegExp(`^${FRAGMENT}$`, 'u')
export function isFragmentRef(value: string): boolean {
  return FRAGMENT_ONLY.test(value.trim())
}

/** CSS·속성 값이 무언가를 불러오는가 — 같은 문서 조각 `url(#id)` 만 뺀다. 이스케이프(`\`)는 `u\rl(` 처럼 숨길 수 있어 통째로 위험으로 본다. */
export function loadsResource(value: string): boolean {
  const withoutLocal = value.replace(LOCAL_URL, '')
  return /url\s*\(|image-set|image\s*\(|element\s*\(|cross-fade|src\s*\(|@import|\\/i.test(withoutLocal)
}

export type AttributeVerdict = { kind: 'keep' } | { kind: 'drop' } | { kind: 'move'; to: 'data-md-href' | 'data-md-src' }

/** 정화를 통과한 속성 하나를 어떻게 할지(순수 — 단위 시험 대상). `namespace` = 요소 이름공간(HTML·SVG·MathML). */
export function attributeVerdict(input: { namespace: string | null; localName: string; name: string; value: string }): AttributeVerdict {
  const name = input.name.toLowerCase()
  const html = input.namespace === HTML_NS
  if (URL_ATTRS.has(name)) {
    if (html && input.localName === 'a' && name === 'href') return { kind: 'move', to: 'data-md-href' }
    if (html && input.localName === 'img' && name === 'src') return { kind: 'move', to: 'data-md-src' }
    const fragmentOnly = (name === 'href' || name === 'xlink:href') && input.namespace === SVG_NS && input.localName !== 'a' && isFragmentRef(input.value)
    return fragmentOnly ? { kind: 'keep' } : { kind: 'drop' }
  }
  if (name === 'target') return { kind: 'drop' }
  return loadsResource(input.value) ? { kind: 'drop' } : { kind: 'keep' }
}

let hooked = false
/** DOMPurify 전역 훅을 한 번 건다 — Markdown·SVG 정화가 같은 인스턴스를 쓰므로 둘 다 이 규칙을 거친다. */
export function installResourceGuard(): void {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    for (const attribute of [...node.attributes]) {
      const verdict = attributeVerdict({ namespace: node.namespaceURI, localName: node.localName, name: attribute.name, value: attribute.value })
      if (verdict.kind === 'keep') continue
      node.removeAttribute(attribute.name)
      if (verdict.kind === 'move') node.setAttribute(verdict.to, attribute.value)
    }
  })
}
