import AppKit
import SwiftUI

final class GoatQuickPanel: NSPanel {
  override var canBecomeKey: Bool { true }
}

@MainActor
final class PanelController {
  private let panel: GoatQuickPanel

  init(model: AppModel) {
    panel = GoatQuickPanel(
      contentRect: NSRect(x: 0, y: 0, width: 620, height: 150),
      styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    panel.contentViewController = NSHostingController(rootView: ComposerView(model: model))
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    panel.animationBehavior = .utilityWindow
    panel.contentView?.wantsLayer = true
    panel.contentView?.layer?.cornerRadius = 18
    panel.contentView?.layer?.masksToBounds = true
  }

  func toggle() {
    panel.isVisible ? hide() : show()
  }

  func show() {
    positionOnActiveScreen()
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
  }

  func hide() {
    panel.orderOut(nil)
  }

  private func positionOnActiveScreen() {
    let pointer = NSEvent.mouseLocation
    let screen = NSScreen.screens.first(where: { $0.frame.contains(pointer) }) ?? NSScreen.main
    guard let visibleFrame = screen?.visibleFrame else { return }
    let size = panel.frame.size
    let origin = NSPoint(
      x: visibleFrame.midX - size.width / 2,
      y: visibleFrame.maxY - size.height - min(visibleFrame.height * 0.18, 150)
    )
    panel.setFrameOrigin(origin)
  }
}
