// LIFE-505 — l497/clip.swift 복사 + textfile. 원 주석: LIFE-497 — 일반 클립보드(NSPasteboard.general) 도우미. 관문이 사용자 클립보드를 덮어쓰므로 시작 전 종류를 적고(dump) 텍스트면 되돌린다.
//   clip dump                 → 현재 항목들의 타입 목록(JSON)
//   clip text <문자열>         → 텍스트만
//   clip png <파일>            → PNG 이미지만(public.png) — 스크린샷 클립보드와 같은 꼴
//   clip fileref <경로>...     → 파일 참조(NSURL 쓰기 = Finder ⌘C 와 같은 public.file-url + 이름 텍스트)
//   clip finder <경로>        → Finder ⌘C 꼴(file-url + 이름 텍스트 + 아이콘 TIFF)
//   clip fileicon <경로>      → 텍스트 없는 꼴(file-url + 아이콘 TIFF) — K1ⓐ 의 「텍스트 없음 + 파일 참조 + 미리보기」
//   clip clear                → 비운다(항목 0 — 관문 전 사용자 클립보드 상태)
//   clip get-text             → 텍스트(없으면 빈 줄)
//   clip textfile <파일>       → 그 파일의 UTF-8 내용을 텍스트로(LIFE-505 — 큰 붙여넣기는 argv 상한을 넘는다)
import AppKit

let pb = NSPasteboard.general
let args = Array(CommandLine.arguments.dropFirst())
func out(_ s: String) { print(s) }
switch args.first {
case "dump":
  let items = (pb.pasteboardItems ?? []).map { item in item.types.map { $0.rawValue } }
  let data = try! JSONSerialization.data(withJSONObject: ["changeCount": pb.changeCount, "items": items])
  out(String(data: data, encoding: .utf8)!)
case "text":
  pb.clearContents(); pb.setString(args[1], forType: .string); out("ok text")
case "png":
  let data = try! Data(contentsOf: URL(fileURLWithPath: args[1]))
  pb.clearContents(); pb.setData(data, forType: .png); out("ok png \(data.count)")
case "fileref":
  pb.clearContents(); pb.writeObjects(args.dropFirst().map { NSURL(fileURLWithPath: $0) }); out("ok fileref \(args.count - 1)")
case "finder", "fileicon":
  // Finder ⌘C 흉내 — 한 항목에 public.file-url + (finder 만) 이름 텍스트 + 아이콘 TIFF.
  let url = URL(fileURLWithPath: args[1])
  let item = NSPasteboardItem()
  item.setString(url.absoluteString, forType: .fileURL)
  if args[0] == "finder" { item.setString(url.lastPathComponent, forType: .string) }
  if let tiff = NSWorkspace.shared.icon(forFile: url.path).tiffRepresentation { item.setData(tiff, forType: .tiff) }
  pb.clearContents(); pb.writeObjects([item]); out("ok \(args[0])")
case "textfile":
  let text = try! String(contentsOfFile: args[1], encoding: .utf8)
  pb.clearContents(); pb.setString(text, forType: .string); out("ok textfile \(text.utf8.count)")
case "clear":
  pb.clearContents(); out("ok clear")
case "get-text":
  out(pb.string(forType: .string) ?? "")
default:
  FileHandle.standardError.write("usage: clip dump|text|png|fileref|get-text\n".data(using: .utf8)!); exit(2)
}
