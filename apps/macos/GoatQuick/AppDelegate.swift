import AppKit
import Combine

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem?
  private var panelController: PanelController?
  private var hotKeyController: HotKeyController?
  private var model: AppModel?
  private var signInMenuItem: NSMenuItem?
  private var subscriptions = Set<AnyCancellable>()

  func applicationDidFinishLaunching(_ notification: Notification) {
    let model = AppModel(configurationResult: Result { try GoatQuickConfiguration.load() })
    let panelController = PanelController(model: model)
    self.model = model
    self.panelController = panelController
    model.hidePanel = { [weak panelController] in panelController?.hide() }
    model.showPanel = { [weak panelController] in panelController?.show() }

    configureMenuBar(model: model)
    do {
      hotKeyController = try HotKeyController { [weak panelController] in
        panelController?.toggle()
      }
    } catch {
      let alert = NSAlert()
      alert.messageText = "opencompany Quick shortcut unavailable"
      alert.informativeText = error.localizedDescription
      alert.runModal()
    }
  }

  private func configureMenuBar(model: AppModel) {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem.button?.image = NSImage(
      systemSymbolName: "bolt.circle.fill",
      accessibilityDescription: "opencompany Quick"
    )
    let menu = NSMenu()
    menu.addItem(withTitle: "Open opencompany Quick", action: #selector(openPanel), keyEquivalent: "")
    menu.addItem(.separator())
    let signInItem = NSMenuItem(
      title: "Sign in", action: #selector(toggleSignIn), keyEquivalent: "")
    menu.addItem(signInItem)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit opencompany Quick", action: #selector(quit), keyEquivalent: "q")
    for item in menu.items { item.target = self }
    statusItem.menu = menu
    self.statusItem = statusItem
    signInMenuItem = signInItem

    model.$isSignedIn
      .sink { [weak signInItem] signedIn in
        signInItem?.title = signedIn ? "Sign out" : "Sign in"
      }
      .store(in: &subscriptions)
  }

  @objc private func openPanel() {
    panelController?.show()
  }

  @objc private func toggleSignIn() {
    guard let model else { return }
    if model.isSignedIn {
      model.signOut()
    } else {
      panelController?.show()
      model.signIn()
    }
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }
}
