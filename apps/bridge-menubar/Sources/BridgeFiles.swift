import Foundation

// Reads the daemon's observation-only status file and the hand-editable settings file,
// and owns the small amount of writing the menubar does (flipping the mode). The
// settings file is the permission authority; the menubar only ever changes `mode`, and
// preserves every other key (including hand-authored allow/deny rules) on write.

struct BridgeActivity: Decodable {
    let at: String
    let tool: String
    let decision: String
    let summary: String
}

struct BridgeStatus: Decodable {
    let deviceName: String
    let connected: Bool
    let updatedAt: String
    let mode: String
    let recentActions: [BridgeActivity]
}

enum BridgeFiles {
    static var home: URL {
        if let override = ProcessInfo.processInfo.environment["OC_BRIDGE_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".opencompany", isDirectory: true)
    }

    static var statusURL: URL { home.appendingPathComponent("bridge-status.json") }
    static var settingsURL: URL { home.appendingPathComponent("bridge-settings.json") }
    static var configURL: URL { home.appendingPathComponent("bridge.json") }
    static var menubarConfigURL: URL { home.appendingPathComponent("menubar.json") }

    static func readStatus() -> BridgeStatus? {
        guard let data = try? Data(contentsOf: statusURL) else { return nil }
        return try? JSONDecoder().decode(BridgeStatus.self, from: data)
    }

    static func isPaired() -> Bool {
        FileManager.default.fileExists(atPath: configURL.path)
    }

    static func currentMode() -> String {
        guard
            let data = try? Data(contentsOf: settingsURL),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let mode = obj["mode"] as? String
        else { return "ask" }
        return mode
    }

    // Flip only the `mode` key, preserving allow/deny and any hand-added keys. Creates a
    // minimal settings file (with the daemon's safe ssh denies) if none exists yet.
    static func setMode(_ mode: String) {
        var obj: [String: Any]
        if let data = try? Data(contentsOf: settingsURL),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            obj = parsed
        } else {
            obj = [
                "allow": [],
                "deny": ["read(~/.ssh/**)", "write(~/.ssh/**)"],
            ]
        }
        obj["mode"] = mode
        guard let out = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try? out.write(to: settingsURL)
    }

    // The command the menubar runs to start the daemon. Read from menubar.json so the
    // dev path (bun + cli.ts) and a future packaged binary both work; defaults to the
    // `oc-bridge` binary on PATH.
    static func daemonCommand() -> [String] {
        if let data = try? Data(contentsOf: menubarConfigURL),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let cmd = obj["daemonCommand"] as? [String], !cmd.isEmpty {
            return cmd
        }
        return ["oc-bridge", "start"]
    }
}
