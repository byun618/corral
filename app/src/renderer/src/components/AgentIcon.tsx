// 에이전트 브랜드 아이콘 (11-gate1-fix3.md I-2). 사용자 지시: *"각 AI 아이콘을 쓰면 좋겠어.
// 실제 아이콘"* — 유니코드 글리프(`✳ ◆ ✦`)를 진짜 마크로 바꾼다.
//
// ## 출처 · 라이선스
//
// `claude` · `codex` 패스와 `grok` PNG 는 **Orca 에서 이식**했다:
//   출처: `~/repos/etc/orca/src/renderer/src/components/status-bar/icons.tsx`
//         (`ClaudeIcon` · `OpenAIIcon`)
//         `~/repos/etc/orca/src/shared/agent-icons/grok.png` (590 B)
//
//   MIT License — Copyright (c) 2026 Lovecast Inc.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE. (MIT 허가 문단 전문 — fix3 리뷰 grok L1)
//
// 브랜드 마크의 **상표권은 MIT 와 별건**이다. Orca 의 MIT 는 코드 사용을 허락할 뿐
// Anthropic·OpenAI·xAI 의 상표 사용권을 주지 않는다 — 여기서는 각 에이전트를 가리키는
// 지시적 용법(nominative use)으로만 쓴다.
//
// ## 색: 토큰을 새로 만들지 않고 `currentColor` 로 받는다
//
// 원본 `ClaudeIcon` 은 `fill="#D97757"` 리터럴인데 corral 은 hex 리터럴 재입력을 금지한다
// (freeze v2). 새 토큰을 만드는 대신 **`currentColor`** 로 두고 색은 소비처의 기존
// `.agent-*` 클래스가 정한다 — 그 클래스들이 이미 `--agent-claude`(= `#d97757`, H-6 에서
// 토큰화해 둔 바로 그 브랜드 색) 등을 쓰고 있어서, 새 토큰 0개로 브랜드 색이 그대로 나온다.
// C9(a) 토큰 색 셈도 그대로다.
//
// ## grok — **정정 (fix3 리뷰 M1 / 13-gate1-fix4.md J-3)**
//
// 이 주석의 옛 판은 *"Orca 에도 grok SVG 가 없다 → Google favicon 서비스를 때린다 → 네트워크
// 금지라 글자 배지로 떨어뜨린다"* 였다. **그 전제가 사실이 아니었다.** 지시서
// (`11-gate1-fix3.md` I-2)가 사실로 단정해 넘긴 것을 그대로 옮겨 적은 것이고, 원본을 다시 열어
// 확인한 결과는 정반대다:
//
//   · `~/repos/etc/orca/src/shared/agent-icons/grok.png` — **590 B, 실재한다**
//   · `lib/agent-favicon-assets.ts:2` `import grokUrl from '…/grok.png?url'` · `:36` `grok: grokUrl`
//   · `agent-catalog.tsx:362-364` 원문: *"prefer the favicon **bundled at build time** so the icon
//     renders **without a live network request**"* — 번들이 **네트워크 회피책**이지 그 반대가 아니다.
//
// → grok 도 **진짜 마크**를 쓴다. 빌드 타임 번들이라 런타임 네트워크 요청이 없다(원칙은 유효).
//   Orca 자신의 렌더링과 같게 `<img>` + `borderRadius: 2` 다(`agent-catalog.tsx:368-377`).
//
// ### 색이 갈리는 이유 — 자산의 성질이다
//
// claude·codex 는 SVG 패스라 `currentColor` 로 토큰 색을 먹지만 **grok 은 원색 그대로** 나온다.
// 취향이 아니라 파일 성질 때문이다: 이 PNG 는 **팔레트(color type 3) + `tRNS` 청크 없음**,
// 즉 **알파 채널이 아예 없다**(`raw/gate1-fix4/j3-grok-asset.json` 에 청크 실측). 알파 마스킹
// (`mask-image`)은 붙을 데가 없고, 휘도 마스킹은 흰 배경이 남고 검은 마크가 뚫려 **마크가 반전**된다.
// 브랜드 마크를 변형하는 쪽보다 **원본 그대로 두는 쪽**을 골랐다 — 상표는 변형하지 않는 게 안전하고,
// Orca 도 같은 그림을 같은 방식으로 그린다.
//
// ⚠ 행 높이를 밀지 않는다 — `size` 기본값이 기존 글리프 칸 폭에 맞춰져 있고, 세로는
// `--h-session-row` 등 C9(b) 통과선이 잡는다.
import type { AgentKind } from '../../../shared/types.js'
import grokUrl from '../assets/grok.png?url'

/** Orca `ClaudeIcon` 이식. `fill` 만 `currentColor` 로 바꿨다. */
function ClaudeMark({ size }: { size: number }): React.JSX.Element {
  return (
    <svg height={size} width={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="currentColor" fillRule="nonzero" />
    </svg>
  )
}

/** Orca `OpenAIIcon` 이식 — codex 의 마크다. 원본이 이미 `currentColor` 다. */
function OpenAIMark({ size }: { size: number }): React.JSX.Element {
  return (
    <svg fill="currentColor" fillRule="evenodd" height={size} width={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  )
}

/**
 * Orca `grok.png` 이식 (J-3). Orca 자신의 렌더링과 같다 — `<img>` + `borderRadius: 2`
 * (`agent-catalog.tsx:368-377`).
 *
 * `?url` 은 **빌드 타임 번들**이다. 런타임 네트워크 요청이 없다는 원칙은 그대로 지킨다.
 * ⚠ 이 앱의 CSP 는 `default-src 'self'` 라 **data: URI 이미지가 막힌다** — 그래서
 * `electron.vite.config.ts` 가 `assetsInlineLimit: 0` 으로 이 PNG 를 인라인하지 않고
 * 파일로 내보낸다. 실측은 `raw/gate1-fix4/j3-grok-asset.json` 의 `naturalWidth`.
 */
function GrokMark({ size }: { size: number }): React.JSX.Element {
  return <img src={grokUrl} width={size} height={size} alt="" aria-hidden style={{ borderRadius: 2 }} />
}

/**
 * 종류별 마크. `shell` 만 글자 그대로 `$` 다 — 브랜드가 아니라서 마크를 지어내지 않는다
 * (`session-glyphs.ts` AGENT_ICON 의 `glyph` 를 그대로 쓴다).
 *
 * 세 소비처(`SessionRow` · 접힘 요약 행 · `MainTabBar`)가 **이 컴포넌트 하나**를 쓴다 —
 * 표를 한 군데 모아 둔 `session-glyphs.ts` 의 취지를 아이콘에도 적용한다.
 */
export function AgentIcon({ kind, glyph, size = 13 }: { kind: AgentKind; glyph: string; size?: number }): React.JSX.Element {
  switch (kind) {
    case 'claude':
      return <ClaudeMark size={size} />
    case 'codex':
      return <OpenAIMark size={size} />
    case 'grok':
      return <GrokMark size={size} />
    case 'shell':
      return <>{glyph}</>
  }
}
