// LIFE-497 U2 — OS 수준 파일 드래그의 **출발점**. 작은 창(떠 있는 층)을 띄우고, 그 창에서 마우스를 누르면
// 주어진 파일들을 NSDraggingSession(파일 URL — Finder 드래그와 같은 public.file-url)으로 끌기 시작한다.
// 마우스 이동·놓기는 밖에서 CGEvent(cliclick dd/dm/du)로 준다 — 받는 쪽(corral)은 진짜 OS 드롭을 받는다.
//   drag-source <x> <y> <파일>...   (화면 좌표 = 왼쪽 위 원점, 창 크기 160×100). stdout 에 READY·DRAG·END 줄.
import AppKit

final class SourceView: NSView, NSDraggingSource {
  var files: [URL] = []
  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
  override func mouseDown(with event: NSEvent) {
    let items = files.map { url -> NSDraggingItem in
      let item = NSDraggingItem(pasteboardWriter: url as NSURL)
      item.setDraggingFrame(NSRect(x: 10, y: 10, width: 32, height: 32), contents: NSImage(named: NSImage.multipleDocumentsName))
      return item
    }
    print("DRAG \(files.count)"); fflush(stdout)
    beginDraggingSession(with: items, event: event, source: self)
  }
  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
    print("END op=\(operation.rawValue) at=\(Int(screenPoint.x)),\(Int(screenPoint.y))"); fflush(stdout)
  }
  override func draw(_ dirtyRect: NSRect) { NSColor.systemOrange.setFill(); dirtyRect.fill() }
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 3, let x = Double(args[0]), let y = Double(args[1]) else { print("usage"); exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screenHeight = NSScreen.screens.first?.frame.height ?? 0
let frame = NSRect(x: x, y: screenHeight - y - 100, width: 160, height: 100)
let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.level = .floating
let view = SourceView(frame: NSRect(x: 0, y: 0, width: 160, height: 100))
view.files = args.dropFirst(2).map { URL(fileURLWithPath: $0) }
window.contentView = view
window.orderFrontRegardless()
print("READY \(Int(x)),\(Int(y)) files=\(view.files.count)"); fflush(stdout)
app.run()
