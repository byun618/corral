// LIFE-834 — 음성 받아쓰기 도우미. 마이크(또는 시험용 오디오 파일) → Apple SpeechAnalyzer `SpeechTranscriber`(ko-KR 고정, 온디바이스).
// `scripts/build-dictation.mjs` 가 swiftc 로 빌드·ad-hoc 서명한다. main(`src/main/dictation.ts`)이 띄우고 stdout 줄을 읽는다.
//
// 출력 = stdout 에 JSON 한 줄씩(규약 원본 `src/shared/dictation.ts`):
//   {"type":"ready"} · {"type":"partial","text":…} · {"type":"final","text":…} · {"type":"level","rms":…}
//   {"type":"error","code":…,"message":…} (뒤이어 0 이 아닌 종료) · {"type":"done"} (정상 끝, 종료 0)
//   `--check` = {"type":"check",…} 한 줄 — 마이크를 열지 않고(권한 창도 안 띄운다) 로케일·권한 상태만 읽는다.
//   `--file <오디오>` = 파일 받아쓰기(FINAL 만, C7). `--simulate-mic <오디오>` = 마이크 대신 파일을 실시간 속도로 — 마이크 모드와 같은 변환·스트림·레벨·stdin stop 경로(fix1 F7).
// 입력(마이크 모드): stdin 의 `stop` 줄 또는 EOF = 정지 — 마지막 FINAL 까지 확정하고 `done`. 취소는 main 이 SIGTERM 으로 한다.
// stdin EOF 를 정지로 보므로 main 이 죽어도 도우미가 고아로 남지 않는다.
@preconcurrency import AVFoundation
import Foundation
import Speech

let outputLock = NSLock()
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []), let line = String(data: data, encoding: .utf8) else { return }
  outputLock.lock()
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
  outputLock.unlock()
}
func fail(_ code: String, _ message: String, status: Int32) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(status)
}

let koKR = Locale(identifier: "ko_KR")

func micStatusName(_ status: AVAuthorizationStatus) -> String {
  switch status {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .authorized: return "authorized"
  @unknown default: return "unknown"
  }
}

/// 로케일 상태를 읽는다 — 마이크를 열지 않는다.
func localeState() async -> (available: Bool, supported: Bool, installed: Bool) {
  let available = SpeechTranscriber.isAvailable
  let supported = await SpeechTranscriber.supportedLocale(equivalentTo: koKR) != nil
  let installed = await SpeechTranscriber.installedLocales.contains { $0.identifier(.bcp47) == "ko-KR" }
  return (available, supported, installed)
}

/// 인식을 시작하기 전 공통 확인 — 실패하면 오류 줄을 내고 끝낸다.
func requireLocale() async {
  let state = await localeState()
  if !state.available { fail("transcriber-unavailable", "이 기기에서 음성 인식기를 쓸 수 없다", status: 4) }
  if !state.supported { fail("locale-unsupported", "한국어(ko-KR) 인식을 지원하지 않는다", status: 4) }
  if !state.installed { fail("locale-not-installed", "한국어(ko-KR) 인식 자산이 설치돼 있지 않다", status: 4) }
}

func makeTranscriber(volatile: Bool) -> SpeechTranscriber {
  SpeechTranscriber(locale: koKR, transcriptionOptions: [], reportingOptions: volatile ? [.volatileResults] : [], attributeOptions: [])
}

func runCheck() async {
  let state = await localeState()
  emit([
    "type": "check",
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "available": state.available,
    "localeSupported": state.supported,
    "localeInstalled": state.installed,
    "mic": micStatusName(AVCaptureDevice.authorizationStatus(for: .audio)),
  ])
}

/// 시험 경로(C7) — 마이크 대신 오디오 파일. FINAL 만 내고 `done`.
func runFile(_ path: String) async {
  await requireLocale()
  let transcriber = makeTranscriber(volatile: false)
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let file: AVAudioFile
  do { file = try AVAudioFile(forReading: URL(fileURLWithPath: path)) } catch { fail("file-read", "오디오 파일을 열지 못했다: \(error.localizedDescription)", status: 5) }
  let reader = Task {
    for try await result in transcriber.results where result.isFinal { emit(["type": "final", "text": String(result.text.characters)]) }
  }
  do {
    if let last = try await analyzer.analyzeSequence(from: file) { try await analyzer.finalizeAndFinish(through: last) } else { await analyzer.cancelAndFinishNow() }
    try await reader.value
  } catch {
    fail("analyzer", "인식 중 오류: \(error.localizedDescription)", status: 6)
  }
  emit(["type": "done"])
}

/// stdin 의 `stop` 줄 또는 EOF 를 기다린다.
func waitForStop() async {
  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    Thread.detachNewThread {
      while let line = readLine() {
        if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
      }
      continuation.resume()
    }
  }
}

final class LevelMeter: @unchecked Sendable {
  private let lock = NSLock()
  private var sumSquares: Double = 0
  private var frames = 0
  func add(_ buffer: AVAudioPCMBuffer) {
    guard let channel = buffer.floatChannelData?[0] else { return }
    var sum: Double = 0
    for index in 0..<Int(buffer.frameLength) { sum += Double(channel[index] * channel[index]) }
    lock.lock(); sumSquares += sum; frames += Int(buffer.frameLength); lock.unlock()
  }
  /// 지난 호출 뒤의 RMS. 프레임이 없었으면 nil.
  func take() -> Double? {
    lock.lock(); defer { lock.unlock() }
    guard frames > 0 else { return nil }
    let rms = (sumSquares / Double(frames)).squareRoot()
    sumSquares = 0; frames = 0
    return rms
  }
}

/// 받아쓰기 입력 — 마이크(AVAudioEngine tap) 또는 시험용 파일(`--simulate-mic`, fix1 F7). 둘 다 같은 `feed`(레벨·변환·분석기 스트림)로 흘린다.
enum CaptureSource {
  case mic
  case file(String)
}

func runCapture(_ source: CaptureSource) async {
  await requireLocale()
  if case .mic = source {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    switch status {
    case .authorized: break
    case .notDetermined:
      if !(await AVCaptureDevice.requestAccess(for: .audio)) { fail("mic-denied", "마이크 권한이 거부됐다", status: 3) }
    default:
      fail("mic-denied", "마이크 권한이 거부됐다 (\(micStatusName(status)))", status: 3)
    }
  }
  let transcriber = makeTranscriber(volatile: true)
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { fail("no-input-format", "인식기 오디오 형식을 정하지 못했다", status: 7) }
  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  let meter = LevelMeter()
  /// 입력 형식이 정해지면 만드는 공통 처리 — 레벨을 재고, 분석기 형식으로 바꿔 스트림에 넣는다.
  func makeFeed(_ inputFormat: AVAudioFormat) -> (AVAudioPCMBuffer) -> Void {
    guard inputFormat.sampleRate > 0, let converter = AVAudioConverter(from: inputFormat, to: format) else { fail("audio-engine", "입력 형식을 읽지 못했다", status: 7) }
    return { buffer in
      meter.add(buffer)
      let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / inputFormat.sampleRate) + 16
      guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
      var fed = false
      _ = converter.convert(to: out, error: nil) { _, state in
        if fed { state.pointee = .noDataNow; return nil }
        fed = true; state.pointee = .haveData; return buffer
      }
      continuation.yield(AnalyzerInput(buffer: out))
    }
  }
  // 결과 스트림 오류는 정지까지 숨기지 않고 바로 오류 줄로 끝낸다(fix1 F2·G4).
  let reader = Task {
    do {
      for try await result in transcriber.results { emit(["type": result.isFinal ? "final" : "partial", "text": String(result.text.characters)]) }
    } catch {
      fail("analyzer", "인식 중 오류: \(error.localizedDescription)", status: 6)
    }
  }
  do {
    try await analyzer.start(inputSequence: stream)
  } catch {
    fail("analyzer", "인식기를 시작하지 못했다: \(error.localizedDescription)", status: 6)
  }
  var stopCapture: () -> Void = {}
  switch source {
  case .mic:
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let feed = makeFeed(input.outputFormat(forBus: 0))
    input.installTap(onBus: 0, bufferSize: 4096, format: input.outputFormat(forBus: 0)) { buffer, _ in feed(buffer) }
    do { try engine.start() } catch { fail("audio-engine", "녹음을 시작하지 못했다: \(error.localizedDescription)", status: 7) }
    stopCapture = { engine.stop(); input.removeTap(onBus: 0) }
  case .file(let path):
    let file: AVAudioFile
    do { file = try AVAudioFile(forReading: URL(fileURLWithPath: path)) } catch { fail("file-read", "오디오 파일을 열지 못했다: \(error.localizedDescription)", status: 5) }
    let feed = makeFeed(file.processingFormat)
    // 마이크처럼 실시간 속도로 4096 프레임씩 흘리고, 파일이 끝나면 프레임이 끊긴다(입력 끊김과 같은 모양 — 레벨이 0 으로 간다).
    let pump = Task {
      while !Task.isCancelled {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096) else { return }
        do { try file.read(into: buffer, frameCount: 4096) } catch { return }
        if buffer.frameLength == 0 { return }
        feed(buffer)
        try? await Task.sleep(for: .seconds(Double(buffer.frameLength) / file.processingFormat.sampleRate))
      }
    }
    stopCapture = { pump.cancel() }
  }
  emit(["type": "ready"])
  // 입력 레벨 — main 이 연속 무음을 알린다(C5). 250ms 마다. 그 사이 프레임이 하나도 없었으면(장치 끊김) 0 으로 낸다(fix1 F2·G4).
  let levels = Task {
    while !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(250))
      emit(["type": "level", "rms": meter.take() ?? 0])
    }
  }
  await waitForStop()
  levels.cancel()
  stopCapture()
  continuation.finish()
  do {
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  } catch {
    fail("analyzer", "인식 중 오류: \(error.localizedDescription)", status: 6)
  }
  await reader.value
  emit(["type": "done"])
}

@main struct CorralDictation {
  static func main() async {
    let args = Array(CommandLine.arguments.dropFirst())
    switch args.first {
    case "--check": await runCheck()
    case "--file":
      guard args.count >= 2 else { fail("bad-args", "--file 뒤에 오디오 파일 경로가 필요하다", status: 2) }
      await runFile(args[1])
    case "--simulate-mic":
      guard args.count >= 2 else { fail("bad-args", "--simulate-mic 뒤에 오디오 파일 경로가 필요하다", status: 2) }
      await runCapture(.file(args[1]))
    case nil: await runCapture(.mic)
    default: fail("bad-args", "알 수 없는 인자: \(args.joined(separator: " "))", status: 2)
    }
    exit(0)
  }
}
