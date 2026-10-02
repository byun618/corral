// LIFE-471 「다른 앱이 앞」 회차용 무해한 미끼 창 — 사용자 앱을 건드리지 않으려고 스스로 창 하나를 띄우고 앞으로 나선다.
// 글자 입력을 받지 않는다(텍스트 칸 없음). stdout 첫 줄 = 자기 pid. SIGTERM 으로 끈다.
//   decoy            → 창을 띄우고 활성화 · SIGUSR1 = 다시 앞으로
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
// 다시 앞으로 — 다른 프로세스의 NSRunningApplication.activate 는 번들 없는 이 앱을 앞으로 못 세운다(run2: 두 번째 활성화부터 맨 앞이 그대로).
// SIGUSR1 을 받으면 스스로 활성화한다(첫 기동 때의 자기 활성화와 같은 경로).
signal(SIGUSR1, SIG_IGN)
let reactivate = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
reactivate.setEventHandler {
  window.makeKeyAndOrderFront(nil)
  app.activate(ignoringOtherApps: true)
}
reactivate.resume()
app.run()
