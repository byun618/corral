// LIFE-471 「다른 앱이 앞」 회차용 무해한 미끼 창 — 사용자 앱을 건드리지 않으려고 스스로 창 하나를 띄우고 앞으로 나선다.
// 글자 입력을 받지 않는다(텍스트 칸 없음). stdout 첫 줄 = 자기 pid. SIGTERM 으로 끈다.
//   decoy            → 창을 띄우고 활성화
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 320, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "l471 decoy"
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
print(ProcessInfo.processInfo.processIdentifier)
fflush(stdout)
signal(SIGTERM) { _ in exit(0) }
app.run()
