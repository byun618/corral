// 이미지 그리기 (LIFE-590 E4ⓔ·ⓓ) — main 이 준 **바이트**로만 그린다. URL(blob:·file:·data:)을 만들지 않으니 CSP `img-src` 를 바꾸지 않는다(E10 답).
// · 래스터(png·jpg·gif·bmp·ico·webp·avif) — `createImageBitmap(Blob)` → `<canvas>`. GIF 는 첫 프레임만(VS Code 는 움직인다 — 차이로 기록, E9).
// · SVG — 글로 풀어 DOMPurify `svg` 프로필로 정화(`<script>`·`on*`·`foreignObject` 제거)한 뒤 **인라인 SVG** 로 붙인다. 바깥을 가리키는
//   `href`·`xlink:href`(`#` 로 시작하지 않는 것)는 지운다 — 원격·파일 읽기가 없다. 인라인이라 SVG 안 스크립트가 남아도 innerHTML 은 실행하지 않는다(두 겹).
// 판정 회차는 실제 Chromium(격리 앱) — happy-dom 의 DOMPurify 는 믿지 못한다(`raw/claude/happy-dom-dompurify.txt`).
import DOMPurify from 'dompurify'

export type DrawnImage = { element: HTMLElement; width: number; height: number }

const decoder = new TextDecoder('utf-8')

export function sanitizeSvg(text: string): string {
  const clean = DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'script', 'style'] })
  const holder = document.createElement('div')
  holder.innerHTML = clean
  for (const element of holder.querySelectorAll('*')) {
    for (const name of ['href', 'xlink:href']) {
      const value = element.getAttribute(name)
      // SVG 안 `<a>` 는 `#` 조각이어도 지운다 — 누르면 문서 주소(조각)가 바뀐다.
      if (value !== null && (element.localName === 'a' || !value.startsWith('#'))) element.removeAttribute(name)
    }
  }
  return holder.innerHTML
}

/** 바이트 → 그릴 요소. 실패(디코드 불가)면 null — 부르는 쪽이 안내를 띄운다. */
export async function drawImage(input: { bytes: Uint8Array; mime: string }): Promise<DrawnImage | null> {
  if (input.mime === 'image/svg+xml') {
    const holder = document.createElement('div')
    holder.className = 'file-image-svg'
    holder.innerHTML = sanitizeSvg(decoder.decode(input.bytes))
    const svg = holder.querySelector('svg')
    if (svg === null) return null
    const box = svg.viewBox.baseVal
    const width = svg.width.baseVal.value || box?.width || 0
    const height = svg.height.baseVal.value || box?.height || 0
    return { element: holder, width, height }
  }
  try {
    // 바이트를 새 버퍼로 복사해 Blob 에 넘긴다(SharedArrayBuffer 형 회피 — `as` 없이).
    const copy = new Uint8Array(input.bytes.byteLength)
    copy.set(input.bytes)
    const bitmap = await createImageBitmap(new Blob([copy.buffer], { type: input.mime }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    return { element: canvas, width: canvas.width, height: canvas.height }
  } catch {
    return null
  }
}
