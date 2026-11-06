// scripts/lib/face-box.swift — prints the largest face box for each image
// path given, as JSON lines {"path","w","h","face":[x,y,w,h]|null} in pixel
// coordinates with a top-left origin. macOS Vision framework, no network.
// Build: swiftc -O scripts/lib/face-box.swift -o <out>/face-box
import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("{\"path\":\"\(path)\",\"error\":\"unreadable\"}"); continue
  }
  let w = cg.width, h = cg.height
  let req = VNDetectFaceRectanglesRequest()
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  try? handler.perform([req])
  let faces = (req.results ?? []).sorted { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }
  if let f = faces.first {
    let b = f.boundingBox
    let x = Int(b.minX * Double(w)), fw = Int(b.width * Double(w))
    let fh = Int(b.height * Double(h)), y = Int((1 - b.maxY) * Double(h))
    print("{\"path\":\"\(path)\",\"w\":\(w),\"h\":\(h),\"face\":[\(x),\(y),\(fw),\(fh)],\"conf\":\(f.confidence)}")
  } else {
    print("{\"path\":\"\(path)\",\"w\":\(w),\"h\":\(h),\"face\":null}")
  }
}
