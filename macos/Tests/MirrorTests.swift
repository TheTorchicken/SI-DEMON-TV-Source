import AVFoundation
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import XCTest

final class MirrorTests: XCTestCase {
  func testSenderNegotiatesAndStreamsRealFramesThroughAnIsolatedRelay() async throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let location = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let process = Process()
    let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    process.executableURL = URL(
      fileURLWithPath: try XCTUnwrap(
        candidates.first { FileManager.default.isExecutableFile(atPath: $0) }))
    process.currentDirectoryURL = root
    process.arguments = ["--import", "tsx", "macos/TestSupport/relay.mjs", location.path]
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    defer {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
      try? FileManager.default.removeItem(at: location)
    }
    for _ in 0..<100 {
      if FileManager.default.fileExists(atPath: location.path) { break }
      guard process.isRunning else {
        XCTFail("The isolated relay did not start")
        return
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    let base = try String(contentsOf: location, encoding: .utf8)
    let connection = try RelayConnection(address: base, key: "synthetic-mac-test")
    let sender = MirrorSender()
    defer { sender.stop() }
    let connected = expectation(description: "sender connected")
    let profile = expectation(description: "relay quality profile applied")
    sender.onConnection = { if $0 { connected.fulfill() } }
    sender.onProfile = { if $0.mode == .quality && $0.format == "h264" { profile.fulfill() } }
    sender.onFailure = { XCTFail($0) }
    sender.start(connection: connection, mode: .latency)
    await fulfillment(of: [connected, profile], timeout: 10)
    var pixel: CVPixelBuffer?
    XCTAssertEqual(
      CVPixelBufferCreate(
        nil, 1280, 720, kCVPixelFormatType_32BGRA,
        [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixel), kCVReturnSuccess)
    let buffer = try XCTUnwrap(pixel)
    CVPixelBufferLockBaseAddress(buffer, [])
    memset(CVPixelBufferGetBaseAddress(buffer), 90, CVPixelBufferGetDataSize(buffer))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    var description: CMVideoFormatDescription?
    XCTAssertEqual(
      CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: nil, imageBuffer: buffer, formatDescriptionOut: &description), noErr)
    for i in 0..<16 {
      var sample: CMSampleBuffer?
      var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: 30),
        presentationTimeStamp: CMTime(value: Int64(30 + i), timescale: 30),
        decodeTimeStamp: .invalid)
      XCTAssertEqual(
        CMSampleBufferCreateReadyWithImageBuffer(
          allocator: nil, imageBuffer: buffer,
          formatDescription: try XCTUnwrap(description), sampleTiming: &timing,
          sampleBufferOut: &sample), noErr)
      let captured = try XCTUnwrap(sample)
      let attachments = try XCTUnwrap(
        CMSampleBufferGetSampleAttachmentsArray(captured, createIfNecessary: true))
      let dictionary = unsafeBitCast(
        CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      let key = SCStreamFrameInfo.status.rawValue as CFString
      let value = NSNumber(value: SCFrameStatus.complete.rawValue)
      CFDictionarySetValue(
        dictionary, Unmanaged.passUnretained(key).toOpaque(),
        Unmanaged.passUnretained(value).toOpaque())
      sender.accept(captured, type: .screen)
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    let (data, _) = try await URLSession.shared.data(from: URL(string: base + "/test/metrics")!)
    let metrics = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Int])
    XCTAssertGreaterThan(metrics["h264"] ?? 0, 5)
    XCTAssertGreaterThan(metrics["codecs"] ?? 0, 0)
    XCTAssertEqual(metrics["invalid"], 0)
    let state = try await connection.request("api/state")
    let mirror = try XCTUnwrap(state["mirror"] as? [String: Any])
    XCTAssertEqual(mirror["device"] as? String, "Mac")
    XCTAssertEqual(mirror["connected"] as? Bool, true)
  }
  func testConnectionPreservesPrefixAndEscapesKey() throws {
    let connection = try RelayConnection(address: "https://example.com/sidemon/", key: "a&b c")
    let c = try XCTUnwrap(URLComponents(url: connection.socketURL, resolvingAgainstBaseURL: false))
    XCTAssertEqual(c.scheme, "wss")
    XCTAssertEqual(c.path, "/sidemon/ws/broadcast")
    XCTAssertEqual(c.queryItems, [URLQueryItem(name: "token", value: "a&b c")])
    XCTAssertEqual(connection.url("api/state").path, "/sidemon/api/state")
    for address in [
      "http://example.com", "https://user:pass@example.com", "https://example.com?token=x",
      "https://example.com#fragment", "file:///tmp/test",
    ] {
      XCTAssertThrowsError(try RelayConnection(address: address, key: "secret"))
    }
    XCTAssertNoThrow(try RelayConnection(address: "http://127.0.0.1:8789", key: "test"))
  }
  func testProfileFitsPortraitLandscapeAndRetinaWithoutStretching() {
    let quality = MirrorProfile()
    XCTAssertEqual(quality.dimensions(for: CGSize(width: 3024, height: 1964)).width, 1280)
    XCTAssertEqual(quality.dimensions(for: CGSize(width: 1080, height: 1920)).height, 1280)
    let low = MirrorProfile(mode: .latency).dimensions(for: CGSize(width: 2560, height: 1440))
    XCTAssertEqual(low.width, 720)
    XCTAssertEqual(low.height, 404)
    XCTAssertEqual(quality.bitrate, 5_000_000)
    XCTAssertEqual(MirrorProfile(mode: .latency).bitrate, 1_800_000)
    XCTAssertNil(MirrorProfile(message: ["type": "configure", "mode": "bad", "format": "h264"]))
    let bounded = MirrorProfile(message: [
      "type": "configure", "mode": "quality", "format": "jpeg", "width": 9999, "fps": 999,
    ])
    XCTAssertEqual(bounded?.width, 1920)
    XCTAssertEqual(bounded?.fps, 30)
  }
  func testRealH264EncoderProducesOrderedAnnexBFramesAndMatchingTimestamps() throws {
    let encoder = VideoEncoder()
    encoder.bitRate = 5_000_000
    let completed = expectation(description: "encoded frames")
    completed.expectedFulfillmentCount = 12
    let lock = NSLock()
    var packets: [Data] = []
    var codecs: [String] = []
    encoder.onConfig = { codec, _ in
      lock.lock()
      codecs.append(codec)
      lock.unlock()
    }
    encoder.onFrame = { bytes, key, timestamp in
      lock.lock()
      packets.append(MirrorPacket.video(bytes, keyframe: key, timestamp: timestamp))
      lock.unlock()
      completed.fulfill()
    }
    var pixel: CVPixelBuffer?
    XCTAssertEqual(
      CVPixelBufferCreate(
        nil, 1280, 720, kCVPixelFormatType_32BGRA,
        [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixel), kCVReturnSuccess)
    let buffer = try XCTUnwrap(pixel)
    CVPixelBufferLockBaseAddress(buffer, [])
    memset(CVPixelBufferGetBaseAddress(buffer), 64, CVPixelBufferGetDataSize(buffer))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    for i in 0..<12 {
      encoder.encode(buffer, timestamp: 1000 + Double(i) * 1000 / 30, keyFrame: i == 0)
    }
    wait(for: [completed], timeout: 10)
    lock.lock()
    let output = packets
    let configs = codecs
    lock.unlock()
    XCTAssertEqual(output.count, 12)
    XCTAssertTrue(configs.first?.hasPrefix("avc1.") == true)
    XCTAssertEqual(output.first?[1], 1)
    for (i, packet) in output.enumerated() {
      XCTAssertEqual(packet[0], 4)
      let timestamp = packet[2..<10].enumerated().reduce(UInt64(0)) {
        $0 | UInt64($1.element) << ($1.offset * 8)
      }
      XCTAssertEqual(Double(bitPattern: timestamp), 1000 + Double(i) * 1000 / 30, accuracy: 0.01)
      XCTAssertEqual(Array(packet[10..<14]), [0, 0, 0, 1])
    }
    encoder.invalidate()
  }
  func testSystemAudioPacketHasCaptureTimestampAndRelayCompatibleMonoPCM() throws {
    let format = try XCTUnwrap(
      AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 1, interleaved: false))
    let pcm = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 441))
    pcm.frameLength = 441
    for i in 0..<441 { pcm.floatChannelData![0][i] = Float(sin(Double(i) * 0.1)) * 0.2 }
    var sample: CMSampleBuffer?
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: 44100),
      presentationTimeStamp: CMTime(value: 2, timescale: 1), decodeTimeStamp: .invalid)
    XCTAssertEqual(
      CMSampleBufferCreate(
        allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
        makeDataReadyCallback: nil, refcon: nil, formatDescription: format.formatDescription,
        sampleCount: 441, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0,
        sampleSizeArray: nil, sampleBufferOut: &sample), noErr)
    let captured = try XCTUnwrap(sample)
    XCTAssertEqual(
      CMSampleBufferSetDataBufferFromAudioBufferList(
        captured, blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil, flags: 0, bufferList: pcm.audioBufferList), noErr)
    let packet = try XCTUnwrap(MirrorAudioEncoder().packet(captured))
    XCTAssertEqual(packet[0], 2)
    let count = packet[5..<9].enumerated().reduce(UInt32(0)) {
      $0 | UInt32($1.element) << ($1.offset * 8)
    }
    XCTAssertEqual(packet.count, 17 + Int(count) * 4)
    XCTAssertGreaterThan(count, 0)
    let timestamp = packet[9..<17].enumerated().reduce(UInt64(0)) {
      $0 | UInt64($1.element) << ($1.offset * 8)
    }
    XCTAssertEqual(Double(bitPattern: timestamp), 2000)
    let firstNonzero = packet[21..<25].enumerated().reduce(UInt32(0)) {
      $0 | UInt32($1.element) << ($1.offset * 8)
    }
    XCTAssertEqual(Float(bitPattern: firstNonzero), Float(sin(0.1)) * 0.2, accuracy: 0.001)
  }
}
