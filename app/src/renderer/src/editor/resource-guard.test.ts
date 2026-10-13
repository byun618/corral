// LIFE-590 수정 r1 R1-A — 리소스 참조 판정(순수). 정화 훅 자체의 판정은 실제 Chromium(격리 `scripts/l590/resource-check.mjs`) — happy-dom DOMPurify 는 믿지 못한다.
import { describe, expect, it } from 'vitest'
import { attributeVerdict, loadsResource } from './resource-guard.js'

const HTML = 'http://www.w3.org/1999/xhtml'
const SVG = 'http://www.w3.org/2000/svg'
const MATH = 'http://www.w3.org/1998/Math/MathML'

describe('R1-A loadsResource', () => {
  it('불러오는 CSS 함수·@import·이스케이프는 위험', () => {
    for (const value of ['background-image:url(file:///x.png)', 'fill: URL( "../a.png" )', 'background:image-set("a.png" 1x)', 'mask:-webkit-image-set(a.png 1x)', '@import "x.css"', 'u\\rl(a.png)', 'background:cross-fade(a, b)', 'background:element(#x)', 'background:src("a")', 'url(../a.svg#grad)']) {
      expect(loadsResource(value), value).toBe(true)
    }
  })
  it('같은 문서 조각 url(#id)·일반 값은 안전', () => {
    for (const value of ['url(#grad)', "url('#a-1')", 'fill:red;stroke:url(#s)', 'M0 0L10 10', 'translate(1,2)', '']) expect(loadsResource(value), value).toBe(false)
  })
})

describe('R1-A attributeVerdict', () => {
  const v = (namespace: string, localName: string, name: string, value: string) => attributeVerdict({ namespace, localName, name, value })
  it('HTML A·IMG 는 data-md-* 로 옮긴다(경계는 FileView)', () => {
    expect(v(HTML, 'a', 'href', 'docs/b.md')).toEqual({ kind: 'move', to: 'data-md-href' })
    expect(v(HTML, 'img', 'src', '../outside.png')).toEqual({ kind: 'move', to: 'data-md-src' })
  })
  it('그 밖의 URL 속성은 지운다 — srcset·background·poster·area href·SVG image·use 외부·xml:base', () => {
    expect(v(HTML, 'img', 'srcset', 'a.png 1x')).toEqual({ kind: 'drop' })
    expect(v(HTML, 'table', 'background', '../outside.png')).toEqual({ kind: 'drop' })
    expect(v(HTML, 'area', 'href', '#x')).toEqual({ kind: 'drop' })
    expect(v(SVG, 'image', 'href', '../outside.png')).toEqual({ kind: 'drop' })
    expect(v(SVG, 'image', 'xlink:href', 'file:///tmp/outside.png')).toEqual({ kind: 'drop' })
    expect(v(SVG, 'use', 'href', 'other.svg#x')).toEqual({ kind: 'drop' })
    expect(v(SVG, 'feImage', 'href', 'data:image/png;base64,AA')).toEqual({ kind: 'drop' })
    expect(v(SVG, 'svg', 'xml:base', 'file:///tmp/')).toEqual({ kind: 'drop' })
    expect(v(MATH, 'mi', 'href', 'x.md')).toEqual({ kind: 'drop' })
  })
  it('SVG 같은 문서 조각은 남긴다 — 단 SVG <a> 는 조각도 지운다', () => {
    expect(v(SVG, 'use', 'href', '#shape')).toEqual({ kind: 'keep' })
    expect(v(SVG, 'use', 'xlink:href', '#shape')).toEqual({ kind: 'keep' })
    expect(v(SVG, 'a', 'href', '#shape')).toEqual({ kind: 'drop' })
  })
  it('style·표현 속성의 url() 은 지우고 url(#id) 는 남긴다', () => {
    expect(v(SVG, 'svg', 'style', 'background-image:url(file:///tmp/outside.png)')).toEqual({ kind: 'drop' })
    expect(v(SVG, 'rect', 'fill', 'url(../outside.png)')).toEqual({ kind: 'drop' })
    expect(v(SVG, 'rect', 'filter', 'url(other.svg#f)')).toEqual({ kind: 'drop' })
    expect(v(SVG, 'rect', 'fill', 'url(#grad)')).toEqual({ kind: 'keep' })
    expect(v(SVG, 'rect', 'style', 'fill:red')).toEqual({ kind: 'keep' })
    expect(v(HTML, 'a', 'target', '_blank')).toEqual({ kind: 'drop' })
  })
})
