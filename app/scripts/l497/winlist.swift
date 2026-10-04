import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == Int(CommandLine.arguments[1]) {
  print(w[kCGWindowLayer as String] ?? "", w[kCGWindowBounds as String] ?? "", w[kCGWindowName as String] ?? "", w[kCGWindowAlpha as String] ?? "")
}
