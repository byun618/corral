// LIFE-497 — 맨 앞 앱 pid·이름 (읽기만).
import AppKit
let app = NSWorkspace.shared.frontmostApplication
print("{\"pid\":\(app?.processIdentifier ?? -1),\"name\":\"\(app?.localizedName ?? "")\"}")
