import Carbon.HIToolbox
import Foundation

final class HotKeyController: @unchecked Sendable {
  private var hotKey: EventHotKeyRef?
  private var eventHandler: EventHandlerRef?
  private let action: @MainActor @Sendable () -> Void

  init(action: @escaping @MainActor @Sendable () -> Void) throws {
    self.action = action
    var eventType = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )
    let handlerStatus = InstallEventHandler(
      GetApplicationEventTarget(),
      Self.eventHandlerCallback,
      1,
      &eventType,
      Unmanaged.passUnretained(self).toOpaque(),
      &eventHandler
    )
    guard handlerStatus == noErr else { throw HotKeyError.registrationFailed(handlerStatus) }

    let identifier = EventHotKeyID(signature: Self.signature, id: 1)
    let registrationStatus = RegisterEventHotKey(
      UInt32(kVK_Space),
      UInt32(cmdKey | optionKey),
      identifier,
      GetApplicationEventTarget(),
      0,
      &hotKey
    )
    guard registrationStatus == noErr else {
      if let eventHandler { RemoveEventHandler(eventHandler) }
      throw HotKeyError.registrationFailed(registrationStatus)
    }
  }

  deinit {
    if let hotKey { UnregisterEventHotKey(hotKey) }
    if let eventHandler { RemoveEventHandler(eventHandler) }
  }

  private static let signature: OSType = 0x4751_554B  // GQUK
  private static let eventHandlerCallback: EventHandlerUPP = { _, _, userData in
    guard let userData else { return OSStatus(eventNotHandledErr) }
    let controller = Unmanaged<HotKeyController>.fromOpaque(userData).takeUnretainedValue()
    Task { @MainActor in controller.action() }
    return noErr
  }
}

enum HotKeyError: LocalizedError {
  case registrationFailed(OSStatus)

  var errorDescription: String? {
    switch self {
    case .registrationFailed(let status):
      "Could not register Option-Command-Space (\(status)). Another app may already use it."
    }
  }
}
