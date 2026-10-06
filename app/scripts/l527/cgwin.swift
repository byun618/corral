// LIFE-527 OS 수준 관측·활성화 헬퍼 (읽기 + 우리가 띄운 앱 활성화만).
//   cgwin list            — 화면에 있는 창(앞→뒤 순서): 번호·소유 pid·소유 이름·소유 앱 번들 경로·레이어·bounds(포인트, 화면 왼쪽 위 원점) JSON
//   cgwin list-all        — 화면 밖(다른 Space·최소화) 창까지 — 설치본 Orca 캡처용 창 번호 찾기(읽기)
//   cgwin activate <pid>  — 그 pid 의 앱을 앞으로(NSRunningApplication.activate — 손쉬운 사용 권한 불필요). 설치본 Orca pid 는 호출자가 거른다
//   cgwin mouse           — 지금 OS 커서 위치(포인트, 왼쪽 위 원점)
import AppKit
import CoreGraphics
import Foundation

let args = CommandLine.arguments
func emit(_ value: Any) {
  // fix2 H5 — 강제 언랩 없이. 직렬화 실패는 표준 오류 + exit 3.
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8) else {
    FileHandle.standardError.write(Data("cgwin: JSON 직렬화 실패\n".utf8))
    exit(3)
  }
  print(text)
}
/** 소유 앱 번들 경로 — 설치본 Orca(/Applications/Orca.app) 판정용(fix2 H3). 모르면 빈 문자열. */
func bundlePath(_ pid: Int) -> String {
  guard pid > 0, let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return "" }
  return app.bundleURL?.path ?? ""
}
switch args.count > 1 ? args[1] : "" {
case "list", "list-all":
  let info = CGWindowListCopyWindowInfo(args[1] == "list" ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  emit(info.map { w -> [String: Any] in
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
    return [
      "number": w[kCGWindowNumber as String] as? Int ?? -1,
      "pid": pid,
      "bundle": bundlePath(pid),
      "owner": w[kCGWindowOwnerName as String] as? String ?? "",
      "name": w[kCGWindowName as String] as? String ?? "",
      "layer": w[kCGWindowLayer as String] as? Int ?? 0,
      "onscreen": w[kCGWindowIsOnscreen as String] as? Bool ?? false,
      "bounds": ["x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0],
    ]
  })
case "activate":
  guard args.count > 2, let pid = Int32(args[2]), let app = NSRunningApplication(processIdentifier: pid) else { emit(["ok": false]); exit(1) }
  let ok = app.activate(options: [.activateAllWindows])
  emit(["ok": ok, "pid": Int(pid), "name": app.localizedName ?? ""])
case "mouse":
  let event = CGEvent(source: nil)
  let p = event?.location ?? .zero
  emit(["x": p.x, "y": p.y])
default:
  FileHandle.standardError.write(Data("usage: cgwin list|activate <pid>|mouse\n".utf8))
  exit(2)
}
