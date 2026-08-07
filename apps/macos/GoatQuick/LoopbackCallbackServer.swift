import Foundation
import Network

struct OAuthCallback: Equatable, Sendable {
  let code: String?
  let state: String?
  let error: String?
}

final class LoopbackCallbackServer: @unchecked Sendable {
  private let queue = DispatchQueue(label: "com.opencompany.goat.quick.oauth-loopback")
  private let lock = NSLock()
  private var listener: NWListener?
  private var callbackContinuation: CheckedContinuation<OAuthCallback, Error>?
  private var pendingCallback: Result<OAuthCallback, Error>?
  private var finished = false

  var isListening: Bool {
    lock.withLock { listener != nil }
  }

  func start() async throws -> URL {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    lock.withLock { self.listener = listener }
    listener.newConnectionHandler = { [weak self] connection in
      self?.receiveRequest(on: connection)
    }

    let port: NWEndpoint.Port
    do {
      port = try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<NWEndpoint.Port, Error>) in
        let startState = ListenerStartState()
        listener.stateUpdateHandler = { state in
          guard !startState.resumed else { return }
          switch state {
          case .ready:
            guard let port = listener.port else {
              startState.resumed = true
              continuation.resume(throwing: LoopbackError.missingPort)
              return
            }
            startState.resumed = true
            continuation.resume(returning: port)
          case .failed(let error):
            startState.resumed = true
            continuation.resume(throwing: error)
          case .cancelled:
            startState.resumed = true
            continuation.resume(throwing: CancellationError())
          default:
            break
          }
        }
        listener.start(queue: queue)
      }
    } catch {
      lock.withLock { self.listener = nil }
      listener.cancel()
      throw error
    }

    guard let url = URL(string: "http://127.0.0.1:\(port.rawValue)/oauth/callback") else {
      throw LoopbackError.missingPort
    }
    return url
  }

  func waitForCallback() async throws -> OAuthCallback {
    try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      if let pendingCallback {
        self.pendingCallback = nil
        lock.unlock()
        continuation.resume(with: pendingCallback)
        return
      }
      callbackContinuation = continuation
      lock.unlock()
    }
  }

  func cancel() {
    finish(.failure(CancellationError()))
  }

  private func receiveRequest(on connection: NWConnection, buffer: Data = Data()) {
    if buffer.isEmpty { connection.start(queue: queue) }
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4_096) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      if let error {
        connection.cancel()
        finish(.failure(error))
        return
      }

      var received = buffer
      if let data { received.append(data) }
      guard received.count <= 16_384 else {
        sendResponse(
          on: connection, status: "431 Request Header Fields Too Large", message: "Invalid callback"
        )
        finish(.failure(LoopbackError.invalidRequest))
        return
      }
      guard received.range(of: Data("\r\n\r\n".utf8)) != nil else {
        if isComplete {
          sendResponse(on: connection, status: "400 Bad Request", message: "Invalid callback")
          finish(.failure(LoopbackError.invalidRequest))
        } else {
          receiveRequest(on: connection, buffer: received)
        }
        return
      }
      guard let request = String(data: received, encoding: .utf8),
        let callback = Self.parseCallback(from: request)
      else {
        sendResponse(on: connection, status: "400 Bad Request", message: "Invalid callback")
        finish(.failure(LoopbackError.invalidRequest))
        return
      }

      sendResponse(
        on: connection,
        status: "200 OK",
        message: "You are signed in to opencompany Quick. You can close this tab."
      )
      finish(.success(callback))
    }
  }

  private func sendResponse(on connection: NWConnection, status: String, message: String) {
    let escapedMessage =
      message
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
    let body = """
      <!doctype html><html><head><meta charset="utf-8"><title>opencompany Quick</title></head>
      <body style="font:16px -apple-system;padding:48px;background:#f7f7f5;color:#171915">
      <h1 style="font-size:22px">opencompany Quick</h1><p>\(escapedMessage)</p></body></html>
      """
    let response = """
      HTTP/1.1 \(status)\r
      Content-Type: text/html; charset=utf-8\r
      Content-Length: \(body.utf8.count)\r
      Connection: close\r
      \r
      \(body)
      """
    connection.send(
      content: Data(response.utf8),
      completion: .contentProcessed { _ in
        connection.cancel()
      })
  }

  private func finish(_ result: Result<OAuthCallback, Error>) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    let listener = self.listener
    self.listener = nil
    if let callbackContinuation {
      self.callbackContinuation = nil
      lock.unlock()
      listener?.cancel()
      callbackContinuation.resume(with: result)
      return
    }
    pendingCallback = result
    lock.unlock()
    listener?.cancel()
  }

  static func parseCallback(from request: String) -> OAuthCallback? {
    guard let requestLine = request.split(separator: "\n", maxSplits: 1).first else {
      return nil
    }
    let parts = requestLine.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ")
    guard parts.count >= 2, parts[0] == "GET",
      let url = URL(string: "http://127.0.0.1\(parts[1])"),
      url.path == "/oauth/callback",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else {
      return nil
    }
    let values = Dictionary(
      components.queryItems?.map { ($0.name, $0.value ?? "") } ?? [],
      uniquingKeysWith: { first, _ in first }
    )
    return OAuthCallback(code: values["code"], state: values["state"], error: values["error"])
  }
}

private final class ListenerStartState: @unchecked Sendable {
  var resumed = false
}

enum LoopbackError: LocalizedError {
  case invalidRequest
  case missingPort

  var errorDescription: String? {
    switch self {
    case .invalidRequest:
      "The OAuth callback was invalid."
    case .missingPort:
      "Could not start the local OAuth callback."
    }
  }
}
