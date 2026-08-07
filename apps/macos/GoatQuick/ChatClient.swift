import Foundation

struct GoatChatSubmission: Equatable, Sendable {
  let sessionID: String
  let messageID: String
  let prompt: String

  init(
    prompt: String,
    sessionUUID: UUID = UUID(),
    messageUUID: UUID = UUID()
  ) {
    sessionID = "goat_chat_\(sessionUUID.uuidString.lowercased())"
    messageID = "goat_chat_msg_\(messageUUID.uuidString.lowercased())"
    self.prompt = prompt
  }

  init(sessionID: String, messageID: String, prompt: String) {
    self.sessionID = sessionID
    self.messageID = messageID
    self.prompt = prompt
  }
}

struct GoatChatSendError: LocalizedError {
  let message: String
  let sessionID: String
  let acceptedByServer: Bool

  var errorDescription: String? { message }
}

@MainActor
final class GoatChatClient {
  typealias RequestPerformer = @MainActor (URLRequest) async throws -> ChatHTTPResponse

  private let baseURL: URL
  private let tokenProvider: AccessTokenProviding
  private let session: URLSession
  private let requestPerformer: RequestPerformer?

  init(
    baseURL: URL,
    tokenProvider: AccessTokenProviding,
    session: URLSession = .shared,
    requestPerformer: RequestPerformer? = nil
  ) {
    self.baseURL = baseURL
    self.tokenProvider = tokenProvider
    self.session = session
    self.requestPerformer = requestPerformer
  }

  func send(prompt: String) async throws -> GoatChatSubmission {
    let submission = GoatChatSubmission(prompt: prompt)
    do {
      let token = try await tokenProvider.accessToken(forceRefresh: false)
      let response = try await perform(submission, token: token)
      if response.statusCode == 401 {
        let refreshedToken = try await tokenProvider.accessToken(forceRefresh: true)
        let retriedResponse = try await perform(submission, token: refreshedToken)
        try validate(retriedResponse, submission: submission)
      } else {
        try validate(response, submission: submission)
      }
      return submission
    } catch let error as GoatChatSendError {
      throw error
    } catch {
      throw GoatChatSendError(
        message: error.localizedDescription,
        sessionID: submission.sessionID,
        acceptedByServer: false
      )
    }
  }

  static func request(
    baseURL: URL,
    submission: GoatChatSubmission,
    accessToken: String
  ) throws -> URLRequest {
    let url = baseURL.appending(path: "api/chat")
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue("GoatQuick/1", forHTTPHeaderField: "User-Agent")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "newSessionId": submission.sessionID,
      "message": [
        "id": submission.messageID,
        "role": "user",
        "parts": [["type": "text", "text": submission.prompt]],
      ],
    ])
    return request
  }

  private func perform(
    _ submission: GoatChatSubmission,
    token: String
  ) async throws -> ChatHTTPResponse {
    let request = try Self.request(
      baseURL: baseURL,
      submission: submission,
      accessToken: token
    )
    if let requestPerformer { return try await requestPerformer(request) }

    let (bytes, response) = try await session.bytes(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw GoatChatSendError(
        message: "opencompany returned an invalid response.",
        sessionID: submission.sessionID,
        acceptedByServer: false
      )
    }

    do {
      let body = try await Self.drain(bytes)
      return ChatHTTPResponse(statusCode: httpResponse.statusCode, body: body)
    } catch {
      throw GoatChatSendError(
        message: "The opencompany session started, but the response stream disconnected.",
        sessionID: submission.sessionID,
        acceptedByServer: (200..<300).contains(httpResponse.statusCode)
      )
    }
  }

  static func drain<Bytes: AsyncSequence>(
    _ bytes: Bytes,
    bodyLimit: Int = 16_384
  ) async throws -> Data where Bytes.Element == UInt8 {
    var body = Data()
    for try await byte in bytes {
      if body.count < bodyLimit { body.append(byte) }
    }
    return body
  }

  private func validate(_ response: ChatHTTPResponse, submission: GoatChatSubmission) throws {
    guard (200..<300).contains(response.statusCode) else {
      let details =
        String(data: response.body, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      throw GoatChatSendError(
        message: details.isEmpty ? "opencompany returned HTTP \(response.statusCode)." : details,
        sessionID: submission.sessionID,
        acceptedByServer: false
      )
    }
  }
}

struct ChatHTTPResponse: Sendable {
  let statusCode: Int
  let body: Data
}
