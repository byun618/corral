// LIFE-497 R1-04 — `herdr pane read` 화면에서 **지금 입력 중인 줄(composer)** 만 떼어 낸다.
// 화면 전체에 정규식을 걸면 앞서 전송한 `› [Image #1] 질문` 같은 대화 기록의 칩이 걸려, 이번 입력이 칩이 아니어도 통과로 셌다(r1).
//   claude: 마지막 두 가로줄(─) 사이 — 입력창 상자.
//   codex : 마지막 `›` 로 시작하는 줄부터 빈 줄 전까지 — 입력창(줄바꿈된 이어지는 줄 포함).
// 못 찾으면 null — 부르는 쪽은 null 을 실패로 센다(빈 결과를 통과로 읽지 않는다).

export function composerText(cli, screen) {
  const lines = screen.split('\n')
  if (cli === 'claude') {
    const rules = lines.flatMap((line, index) => (/^─{10,}\s*$/.test(line) ? [index] : []))
    if (rules.length < 2) return null
    const [top, bottom] = rules.slice(-2)
    return lines.slice(top + 1, bottom).map((line) => line.replace(/^❯\s?/, '').trimEnd()).join('\n').trim()
  }
  if (cli === 'codex') {
    let start = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^›(\s|$)/.test(lines[index])) {
        start = index
        break
      }
    }
    if (start < 0) return null
    const block = [lines[start].replace(/^›\s?/, '')]
    for (let index = start + 1; index < lines.length && lines[index].trim() !== ''; index += 1) block.push(lines[index].trim())
    return block.join('\n').trim()
  }
  throw new Error(`알 수 없는 cli: ${cli}`)
}

export const IMAGE_CHIP = /\[Image #\d+\]/g

/** 입력줄의 이미지 칩 수. 입력줄을 못 찾으면 null. */
export function composerChips(cli, screen) {
  const text = composerText(cli, screen)
  if (text === null) return null
  return { text, chips: text.match(IMAGE_CHIP) ?? [] }
}
