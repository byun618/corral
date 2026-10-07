// LIFE-497 — pid 의 앱을 맨 앞으로 (보호 키 입력 전 준비). 결과 = 맨 앞 앱 pid.
import AppKit
guard let pid = Int32(CommandLine.arguments.dropFirst().first ?? ""), let app = NSRunningApplication(processIdentifier: pid) else { exit(2) }
_ = app.activate(options: [.activateAllWindows])
usleep(400_000)
print("{\"requested\":\(pid),\"front\":\(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)}")
