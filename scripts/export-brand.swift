import AppKit

// Platform exports from the approved image-generated masters; artwork stays unchanged.
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let icon = NSImage(
  contentsOf: root.appendingPathComponent("identity/iconography/demon-tesla-appicon-v1.png"))!
let logo = NSImage(contentsOf: root.appendingPathComponent("identity/logo/demon-tesla-v1.png"))!
func export(_ source: NSImage, size: Int, path: String, opaque: Bool = false) throws {
  let destination = root.appendingPathComponent(path)
  try FileManager.default.createDirectory(
    at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
  let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  NSGraphicsContext.current?.imageInterpolation = .high
  let bounds = NSRect(x: 0, y: 0, width: size, height: size)
  if opaque {
    NSColor(srgbRed: 20 / 255, green: 22 / 255, blue: 27 / 255, alpha: 1).setFill()
    bounds.fill()
  }
  source.draw(in: bounds)
  NSGraphicsContext.restoreGraphicsState()
  var output = bitmap
  if opaque {
    let rgb = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
      bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    for y in 0..<size {
      for x in 0..<size {
        let source = bitmap.bitmapData!.advanced(by: y * bitmap.bytesPerRow + x * 4)
        let target = rgb.bitmapData!.advanced(by: y * rgb.bytesPerRow + x * 3)
        target[0] = source[0]
        target[1] = source[1]
        target[2] = source[2]
      }
    }
    output = rgb
  }
  try output.representation(using: .png, properties: [:])!.write(to: destination)
}
try export(logo, size: 256, path: "public/demon-tesla-logo-v1.png")
for size in [32, 192, 512] {
  try export(icon, size: size, path: "public/demon-tesla-icon-v1-\(size).png", opaque: true)
}
try export(icon, size: 180, path: "public/apple-touch-icon-v1.png", opaque: true)
try export(
  icon, size: 1024, path: "ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png", opaque: true)
try export(
  logo, size: 256, path: "ios/App/Assets.xcassets/DemonTeslaLogo.imageset/DemonTeslaLogo.png")
let info: [String: Any] = ["author": "xcode", "version": 1]
func json(_ object: [String: Any], path: String) throws {
  try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(
    to: root.appendingPathComponent(path))
}
try json(["info": info], path: "ios/App/Assets.xcassets/Contents.json")
try json(
  [
    "info": info,
    "images": [
      ["filename": "AppIcon.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"]
    ],
  ],
  path: "ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json")
try json(
  ["info": info, "images": [["filename": "DemonTeslaLogo.png", "idiom": "universal"]]],
  path: "ios/App/Assets.xcassets/DemonTeslaLogo.imageset/Contents.json")
// Old bookmarks/cached clients requesting this URL receive the new art too.
let replacement = try Data(
  contentsOf: root.appendingPathComponent("public/demon-tesla-logo-v1.png")
).base64EncodedString()
let svg =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" role=\"img\" aria-label=\"SI-DEMON-TV demon Tesla\"><title>SI-DEMON-TV demon Tesla</title><image width=\"256\" height=\"256\" href=\"data:image/png;base64,\(replacement)\"/></svg>\n"
try svg.write(
  to: root.appendingPathComponent("public/chicken.svg"), atomically: true, encoding: .utf8)
