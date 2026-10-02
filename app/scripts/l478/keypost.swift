// LIFE-478 K11 — 키코드를 정확히 실은 OS 키 입력(CGEvent). cliclick `t:` 는 유니코드 글자만 싣고 키코드가 0(A)이라
// ⌘ 와 함께 보내면 메뉴가 ⌘A 로 읽었다(native2 type-06 — ⌘V 가 붙여넣기 대신 전체 선택). 보호 확인(ⓐ~ⓓ)은 부르는 쪽이 한다.
//   keypost <keycode> [cmd] [alt] [shift] [ctrl]   → 수정키 누름 → 그 키 keyDown·keyUp → 수정키 뗌
import CoreGraphics
import Foundation

let args = CommandLine.arguments.dropFirst()
guard let first = args.first, let code = CGKeyCode(first) else {
  FileHandle.standardError.write("usage: keypost <keycode> [cmd] [alt] [shift] [ctrl]\n".data(using: .utf8)!)
  exit(2)
}
var flags: CGEventFlags = []
var modifiers: [(CGKeyCode, CGEventFlags)] = []
for name in args.dropFirst() {
  switch name {
  case "cmd": modifiers.append((55, .maskCommand))
  case "alt": modifiers.append((58, .maskAlternate))
  case "shift": modifiers.append((56, .maskShift))
  case "ctrl": modifiers.append((59, .maskControl))
  default:
    FileHandle.standardError.write("unknown modifier \(name)\n".data(using: .utf8)!)
    exit(2)
  }
}
// 수정키도 실제로 눌렀다 뗀다(flagsChanged) — 키에 flags 만 실으면 세션 상태에 ⌘ 가 남아 다음 키가 ⌘ 를 달고 갔다(native2 key-16).
let source = CGEventSource(stateID: .hidSystemState)
func post(_ code: CGKeyCode, _ down: Bool, _ with: CGEventFlags) {
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { exit(1) }
  event.flags = with
  event.post(tap: .cghidEventTap)
  usleep(30_000)
}
for (code, flag) in modifiers {
  flags.insert(flag)
  post(code, true, flags)
}
post(code, true, flags)
post(code, false, flags)
for (code, flag) in modifiers.reversed() {
  flags.remove(flag)
  post(code, false, flags)
}
print("{\"keycode\":\(code),\"modifiers\":\(modifiers.count)}")
