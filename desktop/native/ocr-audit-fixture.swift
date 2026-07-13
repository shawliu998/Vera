import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2 else { exit(2) }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let width = 1800
let height = 700
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else { exit(3) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 82, weight: .medium),
    .foregroundColor: NSColor.black,
]
NSString(string: "PAYMENT DUE 2026-09-01").draw(
    at: NSPoint(x: 120, y: 390),
    withAttributes: attributes
)
NSString(string: "CONTRACT EVIDENCE RECORD").draw(
    at: NSPoint(x: 120, y: 230),
    withAttributes: attributes
)
NSGraphicsContext.restoreGraphicsState()
guard let image = bitmap.cgImage,
      let consumer = CGDataConsumer(url: output as CFURL) else { exit(4) }
var mediaBox = CGRect(x: 0, y: 0, width: width, height: height)
guard let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { exit(5) }
context.beginPDFPage(nil)
context.draw(image, in: mediaBox)
context.endPDFPage()
context.closePDF()
