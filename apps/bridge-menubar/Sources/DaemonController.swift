import Foundation

// Owns the daemon child process the menubar launches. Start spawns it, Stop terminates
// it — Stop is the user's kill switch: with the daemon gone the machine is unreachable
// from the cloud (the runner drops the socket). The daemon may also be run from the CLI
// independently; this controller only manages the process IT started.

final class DaemonController {
    private var process: Process?

    var isRunning: Bool {
        process?.isRunning ?? false
    }

    func start() {
        guard !isRunning else { return }
        let command = BridgeFiles.daemonCommand()
        guard let executable = command.first else { return }

        let proc = Process()
        // Resolve via /usr/bin/env so a bare name like "oc-bridge" or "bun" is found on PATH.
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = [executable] + Array(command.dropFirst())

        // Daemon logs go to a rolling file the user can inspect; the menubar reads state
        // from the status file, not stdout.
        let logURL = BridgeFiles.home.appendingPathComponent("menubar-daemon.log")
        try? FileManager.default.createDirectory(at: BridgeFiles.home, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: logURL) {
            proc.standardOutput = handle
            proc.standardError = handle
        }

        do {
            try proc.run()
            process = proc
        } catch {
            process = nil
        }
    }

    func stop() {
        guard let proc = process, proc.isRunning else {
            process = nil
            return
        }
        proc.terminate()
        process = nil
    }
}
