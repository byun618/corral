// LIFE-478 K11 드라이버의 순수 판정 (리뷰 r1 C-02ⓑ·C-06) — OS 입력 없이 자기점검(`native-k11-selfcheck.mjs`)이 부른다.
//
// ① 단계 문지기: 직전 단계가 실패(멈춤)로 끝났으면 다음 **입력** 단계를 거절한다. R030 에서 `type-06` 실패 뒤 연쇄가 멈추지 않아
//    Enter 하나가 나갔다 — 그 재발 방지를 드라이버가 갖는다. 실패를 본 사람이 `ack <꼬리표> <실패한 꼬리표>` 로 확인해야 다음 입력이 나간다.
// ② 클립보드 형식 허용 목록: 평문 텍스트 형식만이면 백업·원복(텍스트)이 원래 클립보드를 그대로 되돌린다. 그 밖(서식·이미지·파일)이 하나라도
//    있으면 텍스트 원복이 서식을 잃는다 — 멈춘다.
import fs from 'node:fs'
import path from 'node:path'

/** 실제 OS 입력(커서 이동 포함)을 보내는 단계. `state`·`vscode`·`ack` 는 읽기·기록만 한다. */
export const INPUT_STEPS = new Set(['hover', 'click', 'rclick', 'dblclick', 'altclick', 'key', 'type', 'unfocused'])

/** 직전 단계 기록 위치 — 관문 회차(ROOT) 하나에 하나. */
export const lastStepFile = (root) => path.join(root, 'last-step.json')

export function readLastStep(root) {
  try {
    return JSON.parse(fs.readFileSync(lastStepFile(root), 'utf8'))
  } catch {
    return null
  }
}

export function writeLastStep(input) {
  fs.writeFileSync(lastStepFile(input.root), JSON.stringify({ step: input.step, tag: input.tag, ok: input.ok, at: new Date().toISOString(), ack: input.ack ?? null }) + '\n')
}

/**
 * 이 단계를 돌려도 되나. 결과는 `{ kind: 'allow' } | { kind: 'refuse', reason }`.
 * - 입력 단계가 아니면 언제나 허용(읽기는 실패 뒤에도 상태를 보러 돈다)
 * - 기록이 없거나 직전이 통과면 허용
 * - 직전이 실패면 거절 — `ack` 만 그 실패의 꼬리표를 정확히 대고 풀 수 있다
 */
export function stepGate(input) {
  const { last, step } = input
  if (step === 'ack') {
    if (last === null || last.ok) return { kind: 'refuse', reason: 'ACK: 확인할 실패가 없다' }
    if (input.ackTag !== last.tag) return { kind: 'refuse', reason: `ACK: 실패한 단계는 ${last.step}-${last.tag} 다 (받은 꼬리표 ${input.ackTag ?? '없음'})` }
    return { kind: 'allow' }
  }
  if (!INPUT_STEPS.has(step)) return { kind: 'allow' }
  if (last === null || last.ok) return { kind: 'allow' }
  return { kind: 'refuse', reason: `GATE: 직전 단계 ${last.step}-${last.tag} 가 실패로 끝났다 — 원인을 본 뒤 \`ack <꼬리표> ${last.tag}\` 로 확인해야 입력 단계를 보낸다` }
}

/** `osascript -e 'clipboard info'` 의 형식 이름들 — 「형식, 크기, 형식, 크기 …」. */
export function clipboardTypes(info) {
  const tokens = info.trim() === '' ? [] : info.trim().split(/,\s*/)
  return tokens.filter((_, index) => index % 2 === 0)
}

/** 평문 텍스트 형식(UTF-8·UTF-16·레거시 string·Unicode text)만 허용한다. */
export const PLAIN_TEXT_TYPES = new Set(['«class utf8»', '«class ut16»', 'string', 'Unicode text'])

export function clipboardVerdict(info) {
  const others = clipboardTypes(info).filter((type) => !PLAIN_TEXT_TYPES.has(type))
  return others.length === 0 ? { kind: 'allow' } : { kind: 'refuse', reason: `클립보드에 평문 텍스트 밖 형식이 있다 — 텍스트 원복으로는 되돌릴 수 없어 멈춘다: ${others.join(' · ')}` }
}
