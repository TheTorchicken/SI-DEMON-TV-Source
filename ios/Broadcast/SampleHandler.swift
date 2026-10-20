import AVFoundation
import CoreImage
import ImageIO
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler {
  private let work = DispatchQueue(label: "sidemon.capture", qos: .userInteractive)
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let encoder = VideoEncoder()
  private var socket: URLSessionWebSocketTask?
  private var session: URLSession?
  private var finished = false
  private var busy = false
  private var lastFrame = 0.0
  private var width = 720
  private var quality = 0.52
  private var fps = 30.0
  private var format = "jpeg"
  private var forceKey = true
  private var converter: AVAudioConverter?
  private var converterFormat: AVAudioFormat?
  private var reconnects = 0
  private var pendingAudio = 0
  private let captureLock = NSLock()
  private var pendingVideo: (CVPixelBuffer, CGImagePropertyOrientation, Double)?
  private var videoScheduled = false
  private var queuedAudio = 0
  private var sendingVideo = false
  private var videoTimestamp = Double.nan
  private var pool: CVPixelBufferPool?
  private var poolSize = CGSize.zero
  private var orientedSize = CGSize.zero

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    guard BroadcastSettings.socketURL() != nil else {
      finishBroadcastWithError(
        NSError(
          domain: "SI-DEMON-TV", code: 1,
          userInfo: [
            NSLocalizedDescriptionKey: "Open SI-DEMON-TV and save your relay connection first."
          ]))
      return
    }
    encoder.onConfig = { [weak self] codec, timestamp in
      self?.work.async {
        guard let self, !self.finished, self.videoTimestamp == timestamp else { return }
        self.sendJSON(["type": "codec", "codec": codec])
      }
    }
    encoder.onFrame = { [weak self] bytes, key, timestamp in
      guard let self else { return }
      self.work.async {
        guard !self.finished, timestamp == self.videoTimestamp else { return }
        var packet = Data([4, key ? 1 : 0])
        packet.appendDouble(timestamp)
        packet.append(bytes)
        self.sendVideo(packet)
      }
    }
    connect()
  }
  private func connect() {
    guard !finished, let url = BroadcastSettings.socketURL() else { return }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    session = URLSession(configuration: config)
    let task = session!.webSocketTask(with: url)
    socket = task
    task.resume()
    sendJSON(["type": "hello", "device": UIDevice.current.model])
    receive(task)
  }
  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let message):
        self.reconnects = 0
        if case .string(let text) = message, let data = text.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
          self.work.async {
            if json["type"] as? String == "keyframe" { self.forceKey = true }
            if json["type"] as? String == "configure" {
              self.width = min(1920, max(320, json["width"] as? Int ?? 720))
              self.quality = min(0.9, max(0.2, json["jpeg"] as? Double ?? 0.52))
              self.fps = min(60, max(10, json["fps"] as? Double ?? 30))
              let format = json["format"] as? String ?? "jpeg"
              if format != self.format {
                self.encoder.invalidate()
                self.format = format
                self.busy = false
                self.sendingVideo = false
                self.videoTimestamp = .nan
              }
              self.encoder.bitRate = json["mode"] as? String == "quality" ? 5_000_000 : 1_800_000
              self.encoder.frameRate = Int32(self.fps)
              self.forceKey = true
            }
          }
        }
        self.receive(task)
      case .failure:
        guard !self.finished, self.socket === task else { return }
        self.work.async {
          self.reconnects += 1
          if self.reconnects > 5 {
            self.finishBroadcastWithError(
              NSError(
                domain: "SI-DEMON-TV", code: 2,
                userInfo: [
                  NSLocalizedDescriptionKey:
                    "The relay disconnected. Check its address and connection key, then restart the broadcast."
                ]))
            return
          }
          self.socket?.cancel(with: .goingAway, reason: nil)
          self.session?.invalidateAndCancel()
          self.busy = false
          self.sendingVideo = false
          self.pendingAudio = 0
          self.forceKey = true
          self.work.asyncAfter(deadline: .now() + 2) { self.connect() }
        }
      }
    }
  }
  override func broadcastFinished() {
    finished = true
    socket?.cancel(with: .normalClosure, reason: nil)
    session?.invalidateAndCancel()
    captureLock.lock()
    pendingVideo = nil
    captureLock.unlock()
    work.sync {
      encoder.invalidate()
      pool = nil
    }
  }
  private func timestamp(_ sample: CMSampleBuffer) -> Double {
    let seconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
    return (seconds.isFinite ? seconds : CACurrentMediaTime()) * 1000
  }
  override func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType
  ) {
    guard !finished else { return }
    if sampleBufferType == .video {
      guard let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
      let attachment =
        CMGetAttachment(
          sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil)
        as? NSNumber
      let orientation = CGImagePropertyOrientation(rawValue: attachment?.uint32Value ?? 1) ?? .up
      let time = timestamp(sampleBuffer)
      captureLock.lock()
      pendingVideo = (pixel, orientation, time)
      let schedule = !videoScheduled
      videoScheduled = true
      captureLock.unlock()
      if schedule {
        work.async {
          self.captureLock.lock()
          let latest = self.pendingVideo
          self.pendingVideo = nil
          self.videoScheduled = false
          self.captureLock.unlock()
          if let (pixel, orientation, time) = latest {
            self.video(pixel, orientation: orientation, timestamp: time)
          }
        }
      }
    } else if sampleBufferType == .audioApp {
      captureLock.lock()
      guard queuedAudio < 32 else {
        captureLock.unlock()
        return
      }
      queuedAudio += 1
      captureLock.unlock()
      work.async {
        self.audio(sampleBuffer)
        self.captureLock.lock()
        self.queuedAudio -= 1
        self.captureLock.unlock()
      }
    }
  }
  private func video(
    _ buffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, timestamp: Double
  ) {
    let now = timestamp / 1000
    guard !busy, socket?.state == .running, now - lastFrame >= 0.9 / fps else { return }
    lastFrame = now
    busy = true
    sendingVideo = false
    videoTimestamp = timestamp
    autoreleasepool {
      let source = CIImage(cvPixelBuffer: buffer).oriented(orientation)
      let scale = min(1, CGFloat(width) / max(source.extent.width, source.extent.height))
      let image = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      let extent = image.extent
      let translated = image.transformed(
        by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
      if format == "h264" {
        let w = Int(extent.width) & ~1
        let h = Int(extent.height) & ~1
        let size = CGSize(width: w, height: h)
        if pool == nil || poolSize != size {
          pool = nil
          poolSize = size
          CVPixelBufferPoolCreate(
            nil, [kCVPixelBufferPoolMinimumBufferCountKey: 2] as CFDictionary,
            [
              kCVPixelBufferWidthKey: w, kCVPixelBufferHeightKey: h,
              kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
              kCVPixelBufferIOSurfacePropertiesKey: [:],
            ] as CFDictionary, &pool)
        }
        var target: CVPixelBuffer?
        guard let pool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &target) == kCVReturnSuccess,
          let target
        else {
          busy = false
          return
        }
        context.render(translated, to: target)
        if size != orientedSize {
          orientedSize = size
          forceKey = true
        }
        let key = forceKey
        forceKey = false
        encoder.encode(target, timestamp: timestamp, keyFrame: key)
        // Encoder callbacks may fail; don't hold the producer indefinitely.
        work.asyncAfter(deadline: .now() + 0.2) {
          if self.busy && !self.sendingVideo && self.videoTimestamp == timestamp {
            self.encoder.invalidate()
            self.busy = false
            self.forceKey = true
          }
        }
      } else {
        guard let color = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = context.jpegRepresentation(
            of: translated, colorSpace: color,
            options: [
              kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality
            ])
        else {
          busy = false
          return
        }
        var packet = Data([1])
        packet.appendDouble(timestamp)
        packet.append(jpeg)
        sendVideo(packet)
      }
    }
  }
  private func audio(_ sample: CMSampleBuffer) {
    guard pendingAudio < (width >= 1280 ? 32 : 8), let task = socket, task.state == .running,
      let description = CMSampleBufferGetFormatDescription(sample)
    else { return }
    let sourceFormat = AVAudioFormat(cmAudioFormatDescription: description)
    let count = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
    guard count > 0, let input = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: count)
    else { return }
    input.frameLength = count
    guard
      CMSampleBufferCopyPCMDataIntoAudioBufferList(
        sample, at: 0, frameCount: Int32(count), into: input.mutableAudioBufferList) == noErr
    else { return }
    guard
      let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 1, interleaved: false)
    else { return }
    if converter == nil || converterFormat != sourceFormat {
      converter = AVAudioConverter(from: sourceFormat, to: outputFormat)
      converterFormat = sourceFormat
    }
    guard let converter,
      let output = AVAudioPCMBuffer(
        pcmFormat: outputFormat,
        frameCapacity: AVAudioFrameCount(Double(count) * 44100 / sourceFormat.sampleRate) + 64)
    else { return }
    var consumed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, state in
      if consumed {
        state.pointee = .noDataNow
        return nil
      }
      consumed = true
      state.pointee = .haveData
      return input
    }
    guard status != .error, output.frameLength > 0, let samples = output.floatChannelData?[0] else {
      return
    }
    var packet = Data([2])
    packet.appendLE(UInt32(44100))
    packet.appendLE(UInt32(output.frameLength))
    packet.appendDouble(timestamp(sample))
    packet.append(Data(bytes: samples, count: Int(output.frameLength) * MemoryLayout<Float>.size))
    pendingAudio += 1
    task.send(.data(packet)) { [weak self] _ in
      self?.work.async {
        guard let self, self.socket === task else { return }
        self.pendingAudio = max(0, self.pendingAudio - 1)
      }
    }
  }
  private func sendJSON(_ json: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: json),
      let text = String(data: bytes, encoding: .utf8)
    else { return }
    socket?.send(.string(text)) { _ in }
  }
  private func sendVideo(_ data: Data) {
    guard let task = socket else {
      busy = false
      return
    }
    sendingVideo = true
    let timestamp = videoTimestamp
    task.send(.data(data)) { [weak self] _ in
      self?.work.async {
        guard let self, self.socket === task, self.videoTimestamp == timestamp else { return }
        self.busy = false
        self.sendingVideo = false
      }
    }
  }
}
