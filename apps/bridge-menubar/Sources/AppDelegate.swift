import AppKit

// The menubar control surface for the local bridge. A menubar-only (accessory) app: an
// icon in the status bar whose menu shows connection state + recent activity and lets
// the user start/stop the daemon, flip the permission mode, and open the rules file.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let daemon = DaemonController()
    private var pollTimer: Timer?
    // Treat a status file older than this as a crashed/exited daemon even if it still says
    // connected:true (the daemon flips connected:false on a clean disconnect, not a crash).
    private let staleAfter: TimeInterval = 20

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem.button?.imagePosition = .imageLeft
        rebuildMenu()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.rebuildMenu()
        }
        RunLoop.main.add(pollTimer!, forMode: .common)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Quitting the control surface also stops the daemon it launched, so "quit" can't
        // silently leave the machine reachable.
        daemon.stop()
    }

    // MARK: - State

    private enum State {
        case stopped, connecting, connected
    }

    private func currentState(_ status: BridgeStatus?) -> State {
        guard daemon.isRunning else { return .stopped }
        guard let status = status, status.connected, isFresh(status.updatedAt) else { return .connecting }
        return .connected
    }

    private func isFresh(_ iso: String) -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) else { return false }
        return Date().timeIntervalSince(date) < staleAfter
    }

    // MARK: - Menu

    private func rebuildMenu() {
        let status = BridgeFiles.readStatus()
        let state = currentState(status)
        renderIcon(state)

        let menu = NSMenu()
        let header = menu.addItem(withTitle: headerTitle(state, status), action: nil, keyEquivalent: "")
        header.isEnabled = false

        if !BridgeFiles.isPaired() {
            menu.addItem(.separator())
            let hint = menu.addItem(withTitle: "Not paired — run `oc-bridge pair`", action: nil, keyEquivalent: "")
            hint.isEnabled = false
            addQuit(to: menu)
            statusItem.menu = menu
            return
        }

        menu.addItem(.separator())
        if daemon.isRunning {
            menu.addItem(withTitle: "Stop bridge", action: #selector(stopDaemon), keyEquivalent: "s").target = self
        } else {
            menu.addItem(withTitle: "Start bridge", action: #selector(startDaemon), keyEquivalent: "s").target = self
        }

        menu.addItem(.separator())
        let mode = BridgeFiles.currentMode()
        let askItem = menu.addItem(withTitle: "Ask before each action", action: #selector(setAsk), keyEquivalent: "")
        askItem.target = self
        askItem.state = mode == "ask" ? .on : .off
        let allowItem = menu.addItem(withTitle: "Allow everything (except deny rules)", action: #selector(setAllowEverything), keyEquivalent: "")
        allowItem.target = self
        allowItem.state = mode == "allow-everything" ? .on : .off

        menu.addItem(.separator())
        let activityHeader = menu.addItem(withTitle: "Recent activity", action: nil, keyEquivalent: "")
        activityHeader.isEnabled = false
        let actions = status?.recentActions ?? []
        if actions.isEmpty {
            let none = menu.addItem(withTitle: "  Nothing yet", action: nil, keyEquivalent: "")
            none.isEnabled = false
        } else {
            for action in actions.prefix(8) {
                let item = menu.addItem(withTitle: "  " + activityLine(action), action: nil, keyEquivalent: "")
                item.isEnabled = false
            }
        }

        menu.addItem(.separator())
        menu.addItem(withTitle: "Edit permission rules…", action: #selector(editRules), keyEquivalent: "").target = self
        addQuit(to: menu)
        statusItem.menu = menu
    }

    private func addQuit(to menu: NSMenu) {
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q").target = self
    }

    private func renderIcon(_ state: State) {
        let (symbol, color): (String, NSColor)
        switch state {
        case .connected: (symbol, color) = ("laptopcomputer", .systemGreen)
        case .connecting: (symbol, color) = ("laptopcomputer", .systemYellow)
        case .stopped: (symbol, color) = ("laptopcomputer.slash", .secondaryLabelColor)
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "OpenCompany bridge")
        image?.isTemplate = false
        statusItem.button?.image = image?.tinted(with: color)
    }

    private func headerTitle(_ state: State, _ status: BridgeStatus?) -> String {
        let name = status?.deviceName ?? "This device"
        switch state {
        case .connected: return "\(name) — connected"
        case .connecting: return "\(name) — starting…"
        case .stopped: return "\(name) — stopped"
        }
    }

    private func activityLine(_ action: BridgeActivity) -> String {
        let tool = action.tool.replacingOccurrences(of: "local_", with: "")
        let verdict = action.decision.replacingOccurrences(of: "_", with: " ")
        let summary = action.summary.count > 40 ? String(action.summary.prefix(40)) + "…" : action.summary
        return "\(tool): \(summary) [\(verdict)]"
    }

    // MARK: - Actions

    @objc private func startDaemon() { daemon.start(); rebuildMenu() }
    @objc private func stopDaemon() { daemon.stop(); rebuildMenu() }

    @objc private func setAsk() {
        BridgeFiles.setMode("ask")
        rebuildMenu()
    }

    // Allow-everything is the high-trust mode, so it requires an explicit local
    // confirmation here (never a remote/browser click).
    @objc private func setAllowEverything() {
        let alert = NSAlert()
        alert.messageText = "Allow everything on this computer?"
        alert.informativeText = "Agents will be able to read, write, and run commands without asking — except anything matching your deny rules. You can switch back to Ask anytime."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Allow everything")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            BridgeFiles.setMode("allow-everything")
        }
        rebuildMenu()
    }

    @objc private func editRules() {
        // Ensure the file exists so the editor opens something, then reveal it.
        if !FileManager.default.fileExists(atPath: BridgeFiles.settingsURL.path) {
            BridgeFiles.setMode(BridgeFiles.currentMode())
        }
        NSWorkspace.shared.open(BridgeFiles.settingsURL)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

private extension NSImage {
    func tinted(with color: NSColor) -> NSImage {
        let image = self.copy() as! NSImage
        image.lockFocus()
        color.set()
        NSRect(origin: .zero, size: image.size).fill(using: .sourceAtop)
        image.unlockFocus()
        image.isTemplate = false
        return image
    }
}
