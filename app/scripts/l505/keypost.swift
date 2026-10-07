// LIFE-497 — l478/keypost.swift 복사 + **보호**: 맨 앞 앱 pid 가 기대값이 아니면 입력을 보내지 않는다(exit 4).
//   keypost <기대 pid> <keycode> [cmd] [alt] [shift] [ctrl]
import AppKit
import CoreGraphics

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2, let want = Int32(args[0]), let code = CGKeyCode(args[1]) else {
  FileHandle.standardError.write("usage: keypost <pid> <keycode> [cmd] [alt] [shift] [ctrl]\n".data(using: .utf8)!); exit(2)
}
let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
guard front == want else { print("{\"sent\":false,\"front\":\(front),\"want\":\(want)}"); exit(4) }
var flags: CGEventFlags = []
var modifiers: [(CGKeyCode, CGEventFlags)] = []
for name in args.dropFirst(2) {
  switch name {
  case "cmd": modifiers.append((55, .maskCommand))
  case "alt": modifiers.append((58, .maskAlternate))
  case "shift": modifiers.append((56, .maskShift))
  case "ctrl": modifiers.append((59, .maskControl))
  default: exit(2)
  }
}
let source = CGEventSource(stateID: .hidSystemState)
func post(_ code: CGKeyCode, _ down: Bool, _ with: CGEventFlags) {
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { exit(1) }
  event.flags = with
  event.post(tap: .cghidEventTap)
  usleep(30_000)
}
for (code, flag) in modifiers { flags.insert(flag); post(code, true, flags) }
post(code, true, flags)
post(code, false, flags)
for (code, flag) in modifiers.reversed() { flags.remove(flag); post(code, false, flags) }
print("{\"sent\":true,\"front\":\(front),\"keycode\":\(code),\"modifiers\":\(modifiers.count)}")
