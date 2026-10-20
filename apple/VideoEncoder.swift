import CoreMedia
import Foundation
import VideoToolbox

final class VideoEncoder {
  var onConfig: ((String, Double) -> Void)?
  var onFrame: ((Data, Bool, Double) -> Void)?
  private var session: VTCompressionSession?
  private var size = CGSize.zero
  private var appliedBitRate = 0
  private var appliedFrameRate: Int32 = 0
  var bitRate = 1_800_000
  var frameRate: Int32 = 30
  func invalidate() {
    if let session { VTCompressionSessionInvalidate(session) }
    session = nil
    size = .zero
    appliedBitRate = 0
    appliedFrameRate = 0
  }
  deinit { invalidate() }
  func encode(_ buffer: CVPixelBuffer, timestamp: Double, keyFrame: Bool) {
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    if session == nil || size != CGSize(width: w, height: h) {
      invalidate()
      var created: VTCompressionSession?
      guard
        VTCompressionSessionCreate(
          allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
          encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
          outputCallback: nil, refcon: nil, compressionSessionOut: &created) == noErr, let created
      else { return }
      session = created
      size = CGSize(width: w, height: h)
      VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
      VTSessionSetProperty(
        created, key: kVTCompressionPropertyKey_ProfileLevel,
        value: kVTProfileLevel_H264_Baseline_AutoLevel)
      VTSessionSetProperty(
        created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
      VTSessionSetProperty(
        created, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 1 as CFNumber)
      applySettings(created)
      VTCompressionSessionPrepareToEncodeFrames(created)
    }
    guard let session else { return }
    applySettings(session)
    let properties = keyFrame ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    VTCompressionSessionEncodeFrame(
      session, imageBuffer: buffer,
      presentationTimeStamp: CMTime(seconds: timestamp / 1000, preferredTimescale: 1_000_000),
      duration: CMTime(value: 1, timescale: frameRate), frameProperties: properties,
      infoFlagsOut: nil
    ) { [weak self] status, _, sample in
      guard status == noErr, let sample, let self else { return }
      self.output(sample, timestamp: timestamp)
    }
  }
  private func applySettings(_ session: VTCompressionSession) {
    if appliedBitRate != bitRate {
      VTSessionSetProperty(
        session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitRate as CFNumber)
      // A one-second peak-rate cap smooths upload bursts while retaining
      // the selected mode's average bitrate and picture resolution.
      VTSessionSetProperty(
        session, key: kVTCompressionPropertyKey_DataRateLimits,
        value: [NSNumber(value: bitRate * 12 / 80), NSNumber(value: 1)] as CFArray)
      appliedBitRate = bitRate
    }
    if appliedFrameRate != frameRate {
      VTSessionSetProperty(
        session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: frameRate as CFNumber)
      VTSessionSetProperty(
        session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: frameRate as CFNumber)
      appliedFrameRate = frameRate
    }
  }
  private func output(_ sample: CMSampleBuffer, timestamp: Double) {
    guard let block = CMSampleBufferGetDataBuffer(sample),
      let description = CMSampleBufferGetFormatDescription(sample)
    else { return }
    let attachments =
      CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
      as? [[CFString: Any]]
    let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    var output = Data()
    var lengthField: Int32 = 4
    if key {
      for index in 0...1 {
        var pointer: UnsafePointer<UInt8>?
        var length = 0
        var count = 0
        if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          description, parameterSetIndex: index, parameterSetPointerOut: &pointer,
          parameterSetSizeOut: &length, parameterSetCountOut: &count,
          nalUnitHeaderLengthOut: &lengthField) == noErr, let pointer
        {
          output.append(contentsOf: [0, 0, 0, 1])
          output.append(pointer, count: length)
          if index == 0 && length >= 4 {
            onConfig?(
              String(format: "avc1.%02X%02X%02X", pointer[1], pointer[2], pointer[3]), timestamp)
          }
        }
      }
    }
    let length = CMBlockBufferGetDataLength(block)
    var data = Data(count: length)
    let result = data.withUnsafeMutableBytes {
      CMBlockBufferCopyDataBytes(
        block, atOffset: 0, dataLength: length, destination: $0.baseAddress!)
    }
    guard result == noErr, lengthField == 4 else { return }
    var offset = 0
    while offset + 4 <= data.count {
      let count = data[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
      offset += 4
      guard count > 0, offset + count <= data.count else { return }
      output.append(contentsOf: [0, 0, 0, 1])
      output.append(data[offset..<offset + count])
      offset += count
    }
    onFrame?(output, key, timestamp)
  }
}
