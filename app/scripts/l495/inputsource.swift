// LIFE-495 U1 — 입력 소스(영문·한글) 조회·전환. 관문 끝에 원래 소스로 되돌린다.
//   inputsource current | list | select <id>
import Carbon
import Foundation
func prop(_ s: TISInputSource, _ key: CFString) -> String? {
  guard let p = TISGetInputSourceProperty(s, key) else { return nil }
  return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
}
let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "current":
  let s = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  print("{\"id\":\"\(prop(s, kTISPropertyInputSourceID) ?? "")\"}")
case "list":
  let list = TISCreateInputSourceList([kTISPropertyInputSourceIsSelectCapable: true] as CFDictionary, false).takeRetainedValue() as! [TISInputSource]
  for s in list { print(prop(s, kTISPropertyInputSourceID) ?? "") }
case "select":
  guard args.count == 2 else { exit(2) }
  let list = TISCreateInputSourceList([kTISPropertyInputSourceID: args[1]] as CFDictionary, false).takeRetainedValue() as! [TISInputSource]
  guard let s = list.first else { print("{\"ok\":false}"); exit(3) }
  let status = TISSelectInputSource(s)
  usleep(300_000)
  let now = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  print("{\"ok\":\(status == noErr),\"current\":\"\(prop(now, kTISPropertyInputSourceID) ?? "")\"}")
default: exit(2)
}
