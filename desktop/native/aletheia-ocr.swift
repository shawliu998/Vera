import AppKit
import Foundation
import PDFKit
import Vision

struct OCRPage: Codable {
    let page: Int
    let text: String
    let confidence: Double
}

struct OCRResult: Codable {
    let schemaVersion: String
    let engine: String
    let pages: [OCRPage]
}

enum OCRError: Error {
    case invalidPDF
    case tooManyPages
    case renderFailed(Int)
}

func render(_ page: PDFPage, pageNumber: Int) throws -> CGImage {
    let bounds = page.bounds(for: .mediaBox)
    let longest = max(bounds.width, bounds.height)
    let scale = min(3.0, max(1.5, 3200.0 / max(longest, 1.0)))
    let width = max(1, Int(ceil(bounds.width * scale)))
    let height = max(1, Int(ceil(bounds.height * scale)))
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw OCRError.renderFailed(pageNumber)
    }
    context.setFillColor(CGColor(gray: 1.0, alpha: 1.0))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()
    guard let image = context.makeImage() else {
        throw OCRError.renderFailed(pageNumber)
    }
    return image
}

func recognize(_ image: CGImage, pageNumber: Int) throws -> OCRPage {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let observations = (request.results ?? []).sorted { left, right in
        let verticalDelta = left.boundingBox.midY - right.boundingBox.midY
        if abs(verticalDelta) > 0.012 { return verticalDelta > 0 }
        return left.boundingBox.minX < right.boundingBox.minX
    }
    let candidates = observations.compactMap { $0.topCandidates(1).first }
    let text = candidates.map(\.string).joined(separator: "\n")
    let confidence = candidates.isEmpty
        ? 0.0
        : candidates.reduce(0.0) { $0 + Double($1.confidence) } / Double(candidates.count)
    return OCRPage(page: pageNumber, text: text, confidence: confidence)
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let document = PDFDocument(data: input) else { throw OCRError.invalidPDF }
    guard document.pageCount <= 500 else { throw OCRError.tooManyPages }
    var pages: [OCRPage] = []
    for index in 0..<document.pageCount {
        guard let page = document.page(at: index) else { continue }
        pages.append(try recognize(try render(page, pageNumber: index + 1), pageNumber: index + 1))
    }
    let result = OCRResult(
        schemaVersion: "aletheia-native-ocr-v1",
        engine: "apple-vision",
        pages: pages
    )
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
} catch {
    let message = String(describing: error).replacingOccurrences(of: "\n", with: " ")
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}
