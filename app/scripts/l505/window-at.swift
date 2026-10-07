// LIFE-497 — 화면 점(층 20 미만 창만)(왼쪽 위 원점)에서 **맨 위 창의 소유 pid** (읽기만, 권한 불필요 — 창 이름은 안 읽는다).
//   window-at <x> <y> [<x> <y> ...]  → [{x,y,pid,layer}]
import CoreGraphics
import Foundation

let nums = CommandLine.arguments.dropFirst().compactMap { Double($0) }
let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
var rows: [String] = []
var i = 0
while i + 1 < nums.count {
  let x = nums[i], y = nums[i + 1]
  var hit = "{\"x\":\(x),\"y\":\(y),\"pid\":-1}"
  for w in list {
    guard let b = w[kCGWindowBounds as String] as? [String: Double], let layer = w[kCGWindowLayer as String] as? Int, let pid = w[kCGWindowOwnerPID as String] as? Int else { continue }
    let alpha = w[kCGWindowAlpha as String] as? Double ?? 1
    if alpha == 0 || layer >= 20 { continue }  // 시스템 오버레이(screencaptureui 층 24 등)는 입력 대상이 아니다
    if x >= b["X"]! && x < b["X"]! + b["Width"]! && y >= b["Y"]! && y < b["Y"]! + b["Height"]! {
      hit = "{\"x\":\(x),\"y\":\(y),\"pid\":\(pid),\"layer\":\(layer)}"
      break
    }
  }
  rows.append(hit)
  i += 2
}
print("[" + rows.joined(separator: ",") + "]")
