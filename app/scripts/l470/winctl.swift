// LIFE-469 K8 — 창 앞면 확인·활성화 도우미 (CoreGraphics 창 목록 + NSRunningApplication). 손쉬움 권한이 필요 없다.
//   winctl front                → 맨 앞 앱 {pid,name}
//   winctl top <x> <y>          → 화면 점 (x,y) 를 덮는 맨 위 창(레이어 0) {pid,owner,name,bounds}
//   winctl windows <pid>        → 그 pid 의 화면 위 창들 bounds
//   winctl activate <pid>       → 그 앱을 앞으로
import AppKit
import CoreGraphics
import Foundation

func emit(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

func onScreen() -> [[String: Any]] {
  (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
}

func bounds(_ window: [String: Any]) -> CGRect? {
  guard let dict = window[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: dict as CFDictionary)
}

func describe(_ window: [String: Any]) -> [String: Any] {
  let rect = bounds(window) ?? .zero
  return [
    "pid": window[kCGWindowOwnerPID as String] as? Int ?? -1,
    "owner": window[kCGWindowOwnerName as String] as? String ?? "",
    "name": window[kCGWindowName as String] as? String ?? "",
    "layer": window[kCGWindowLayer as String] as? Int ?? -1,
    "bounds": ["x": rect.origin.x, "y": rect.origin.y, "w": rect.size.width, "h": rect.size.height],
  ]
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "front":
  let app = NSWorkspace.shared.frontmostApplication
  emit(["pid": Int(app?.processIdentifier ?? -1), "name": app?.localizedName ?? ""])
case "top":
  let point = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
  // 목록은 앞에서 뒤 순서다 — 레이어 0(일반 창) 중 그 점을 덮는 첫 창이 맨 위다.
  let hit = onScreen().first { ($0[kCGWindowLayer as String] as? Int) == 0 && (bounds($0)?.contains(point) ?? false) }
  emit(hit.map(describe) ?? ["pid": -1])
case "windows":
  let pid = Int(args[2])!
  emit(onScreen().filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid }.map(describe))
case "activate":
  let pid = pid_t(Int32(args[2])!)
  let ok = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps]) ?? false
  emit(["activated": ok])
default:
  FileHandle.standardError.write("usage: winctl front | top x y | windows pid | activate pid\n".data(using: .utf8)!)
  exit(2)
}
