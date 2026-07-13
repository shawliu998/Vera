import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2 else { exit(2) }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let width = 1800
let height = 1200
var mediaBox = CGRect(x: 0, y: 0, width: width, height: height)
guard let consumer = CGDataConsumer(url: output as CFURL),
      let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else {
    exit(3)
}

let pages: [[String]] = [
    [
        "CONTRACT PAYMENT TERMS",
        "PAYMENT DUE 2026-09-01",
        "PURCHASE CONTRACT RECORD",
    ],
    [
        "PAYMENT LEDGER TABLE",
        "ITEM                 AMOUNT       RECORD",
        "FIRST PAYMENT        480000       PAYONE",
        "DISPUTED BALANCE     320000       PAYTWO",
    ],
    [
        "COURT SERVICE RECORD",
        "FIRST ENTRY 2026-06-26",
        "CORRECTED RECEIPT 2026-06-28",
    ],
]

for lines in pages {
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
    ) else { exit(4) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 68, weight: .medium),
        .foregroundColor: NSColor.black,
    ]
    for (index, line) in lines.enumerated() {
        NSString(string: line).draw(
            at: NSPoint(x: 100, y: 930 - index * 180),
            withAttributes: attributes
        )
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let image = bitmap.cgImage else { exit(5) }
    context.beginPDFPage(nil)
    context.draw(image, in: mediaBox)
    context.endPDFPage()
}
context.closePDF()
