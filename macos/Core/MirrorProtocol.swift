import AVFoundation
import CoreMedia
import Foundation

enum MirrorMode: String, CaseIterable {
  case quality, latency
  var title: String { self == .quality ? "Quality" : "Low latency" }
}

struct MirrorProfile: Equatable {
  var mode: MirrorMode = .quality
  var width = 1280
  var fps = 30
  var jpeg = 0.82
  var format = "h264"
  var bitrate: Int { mode == .quality ? 5_000_000 : 1_800_000 }
  init(mode: MirrorMode = .quality) {
    self.mode = mode
    width = mode == .quality ? 1280 : 720
    jpeg = mode == .quality ? 0.82 : 0.52
  }
  init?(message: [String: Any]) {
    guard message["type"] as? String == "configure",
      let mode = MirrorMode(rawValue: message["mode"] as? String ?? ""),
      let format = message["format"] as? String, ["jpeg", "h264"].contains(format)
    else { return nil }
    self.init(mode: mode)
    width = min(1920, max(320, message["width"] as? Int ?? width))
    fps = min(30, max(10, message["fps"] as? Int ?? 30))
    jpeg = min(0.9, max(0.2, message["jpeg"] as? Double ?? jpeg))
    self.format = format
  }
  func dimensions(for source: CGSize) -> (width: Int, height: Int) {
    let w = max(2, source.width)
    let h = max(2, source.height)
    let scale = min(1, CGFloat(width) / max(w, h))
    return (max(2, Int(w * scale) & ~1), max(2, Int(h * scale) & ~1))
  }
}

struct RelayConnection {
  let base: URL
  let key: String
  init(address: String, key: String) throws {
    guard let c = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
      let host = c.host, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
      c.scheme == "https"
        || (c.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)),
      let url = c.url, !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      throw MirrorError.message(
        "Enter an HTTPS relay address and connection key or pairing phrase.")
    }
    base = url
    self.key = key.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  func url(_ path: String) -> URL { base.appendingPathComponent(path) }
  var socketURL: URL {
    var c = URLComponents(url: url("ws/broadcast"), resolvingAgainstBaseURL: false)!
    c.scheme = base.scheme == "https" ? "wss" : "ws"
    c.queryItems = [URLQueryItem(name: "token", value: key)]
    return c.url!
  }
  func request(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
    var req = URLRequest(url: url(path), timeoutInterval: 15)
    req.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
    if let body {
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    // Credentials must never follow a redirect to a different destination.
    let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (data, response) = try await session.data(for: req)
    let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    guard let http = response as? HTTPURLResponse else {
      throw MirrorError.message("The relay returned an invalid response.")
    }
    guard http.statusCode == 200 else {
      throw MirrorError.response(
        http.statusCode, json["error"] as? String ?? "The relay could not connect.")
    }
    return json
  }
  func authenticated() async throws -> RelayConnection {
    do {
      _ = try await request("api/state")
      return self
    } catch MirrorError.response(401, _) {
      let phrase = key.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(
        separator: "-")
      let result = try await request("api/pair", body: ["phrase": phrase])
      guard let token = result["token"] as? String else {
        throw MirrorError.message("Pairing did not return a connection key.")
      }
      return try RelayConnection(address: base.absoluteString, key: token)
    }
  }
}

final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}

enum MirrorError: LocalizedError {
  case message(String)
  case response(Int, String)
  var errorDescription: String? {
    switch self {
    case .message(let text), .response(_, let text): return text
    }
  }
}

enum MirrorPacket {
  static func video(_ bytes: Data, keyframe: Bool, timestamp: Double) -> Data {
    var packet = Data([4, keyframe ? 1 : 0])
    packet.appendDouble(timestamp)
    packet.append(bytes)
    return packet
  }
  static func jpeg(_ bytes: Data, timestamp: Double) -> Data {
    var packet = Data([1])
    packet.appendDouble(timestamp)
    packet.append(bytes)
    return packet
  }
}

final class MirrorAudioEncoder {
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?
  func packet(_ sample: CMSampleBuffer) -> Data? {
    guard let description = CMSampleBufferGetFormatDescription(sample) else { return nil }
    let format = AVAudioFormat(cmAudioFormatDescription: description)
    let count = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
    guard count > 0, let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else {
      return nil
    }
    input.frameLength = count
    guard
      CMSampleBufferCopyPCMDataIntoAudioBufferList(
        sample, at: 0, frameCount: Int32(count), into: input.mutableAudioBufferList) == noErr,
      let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 1, interleaved: false)
    else { return nil }
    if converter == nil || inputFormat != format {
      converter = AVAudioConverter(from: format, to: outputFormat)
      inputFormat = format
    }
    guard let converter,
      let output = AVAudioPCMBuffer(
        pcmFormat: outputFormat,
        frameCapacity: AVAudioFrameCount(Double(count) * 44100 / format.sampleRate) + 64)
    else { return nil }
    var consumed = false
    var error: NSError?
    let result = converter.convert(to: output, error: &error) { _, state in
      if consumed {
        state.pointee = .noDataNow
        return nil
      }
      consumed = true
      state.pointee = .haveData
      return input
    }
    let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000
    guard result != .error, timestamp.isFinite, output.frameLength > 0,
      let samples = output.floatChannelData?[0]
    else { return nil }
    var packet = Data([2])
    packet.appendLE(UInt32(44100))
    packet.appendLE(UInt32(output.frameLength))
    packet.appendDouble(timestamp)
    // Supported Macs are little endian; the relay expects mono Float32 PCM.
    packet.append(Data(bytes: samples, count: Int(output.frameLength) * MemoryLayout<Float>.size))
    return packet
  }
}
