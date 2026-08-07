import Foundation
import XCTest

@testable import GoatQuick

@MainActor
final class GoatChatClientTests: XCTestCase {
  func testSubmissionIDsAndRequestContract() throws {
    let submission = GoatChatSubmission(
      prompt: "Ship it",
      sessionUUID: UUID(uuidString: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")!,
      messageUUID: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
    )
    let request = try GoatChatClient.request(
      baseURL: URL(string: "https://goat.example/")!,
      submission: submission,
      accessToken: "access-token"
    )
    XCTAssertEqual(request.url?.absoluteString, "https://goat.example/api/chat")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")

    let body = try XCTUnwrap(request.httpBody)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(
      json["newSessionId"] as? String, "goat_chat_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
    let message = try XCTUnwrap(json["message"] as? [String: Any])
    XCTAssertEqual(message["id"] as? String, "goat_chat_msg_11111111-2222-4333-8444-555555555555")
    XCTAssertEqual(message["role"] as? String, "user")
    let parts = try XCTUnwrap(message["parts"] as? [[String: String]])
    XCTAssertEqual(parts, [["type": "text", "text": "Ship it"]])
  }

  func testEachSubmissionUsesFreshSessionAndMessageIdentifiers() {
    let first = GoatChatSubmission(prompt: "One")
    let second = GoatChatSubmission(prompt: "Two")

    XCTAssertNotEqual(first.sessionID, second.sessionID)
    XCTAssertNotEqual(first.messageID, second.messageID)
    XCTAssertTrue(first.sessionID.hasPrefix("goat_chat_"))
    XCTAssertTrue(first.messageID.hasPrefix("goat_chat_msg_"))
  }

  func testRetriesOnlyOnceAfter401WithSameIdentifiers() async throws {
    let tokens = FakeAccessTokenProvider(tokens: ["expired", "fresh"])
    var requests = [URLRequest]()
    let client = GoatChatClient(
      baseURL: URL(string: "https://goat.example")!,
      tokenProvider: tokens,
      requestPerformer: { request in
        requests.append(request)
        return ChatHTTPResponse(statusCode: requests.count == 1 ? 401 : 200, body: Data())
      }
    )

    let submission = try await client.send(prompt: "Hello")
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(tokens.forceRefreshValues, [false, true])
    let bodies = try requests.map { try XCTUnwrap($0.httpBody) }
    XCTAssertEqual(bodies[0], bodies[1])
    XCTAssertTrue(submission.sessionID.hasPrefix("goat_chat_"))
  }

  func testDoesNotRetryAmbiguousTransportFailure() async {
    let tokens = FakeAccessTokenProvider(tokens: ["token"])
    var requestCount = 0
    let client = GoatChatClient(
      baseURL: URL(string: "https://goat.example")!,
      tokenProvider: tokens,
      requestPerformer: { _ in
        requestCount += 1
        throw URLError(.networkConnectionLost)
      }
    )

    do {
      _ = try await client.send(prompt: "Hello")
      XCTFail("Expected the request to fail")
    } catch let error as GoatChatSendError {
      XCTAssertFalse(error.acceptedByServer)
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
    XCTAssertEqual(requestCount, 1)
    XCTAssertEqual(tokens.forceRefreshValues, [false])
  }

  func testSecond401IsNotRetriedAgain() async {
    let tokens = FakeAccessTokenProvider(tokens: ["one", "two"])
    var requestCount = 0
    let client = GoatChatClient(
      baseURL: URL(string: "https://goat.example")!,
      tokenProvider: tokens,
      requestPerformer: { _ in
        requestCount += 1
        return ChatHTTPResponse(statusCode: 401, body: Data())
      }
    )

    await assertThrowsErrorAsync { try await client.send(prompt: "Hello") }
    XCTAssertEqual(requestCount, 2)
    XCTAssertEqual(tokens.forceRefreshValues, [false, true])
  }

  func testDrainsTheFullResponseWhileCappingCapturedErrorBody() async throws {
    let counter = LockedCounter()
    let bytes = CountingByteSequence(count: 20_000, counter: counter)

    let body = try await GoatChatClient.drain(bytes, bodyLimit: 100)

    XCTAssertEqual(counter.value, 20_000)
    XCTAssertEqual(body.count, 100)
  }
}

@MainActor
private final class FakeAccessTokenProvider: AccessTokenProviding {
  var isSignedIn = true
  var forceRefreshValues = [Bool]()
  private var tokens: [String]

  init(tokens: [String]) {
    self.tokens = tokens
  }

  func accessToken(forceRefresh: Bool) async throws -> String {
    forceRefreshValues.append(forceRefresh)
    guard !tokens.isEmpty else { throw OAuthError.signInRequired }
    return tokens.removeFirst()
  }
}

private struct CountingByteSequence: AsyncSequence, Sendable {
  typealias Element = UInt8
  let count: Int
  let counter: LockedCounter

  func makeAsyncIterator() -> Iterator {
    Iterator(remaining: count, counter: counter)
  }

  struct Iterator: AsyncIteratorProtocol {
    var remaining: Int
    let counter: LockedCounter

    mutating func next() async -> UInt8? {
      guard remaining > 0 else { return nil }
      remaining -= 1
      counter.increment()
      return UInt8(remaining % 255)
    }
  }
}

private final class LockedCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var storedValue = 0

  var value: Int {
    lock.withLock { storedValue }
  }

  func increment() {
    lock.withLock { storedValue += 1 }
  }
}

@MainActor
private func assertThrowsErrorAsync<T: Sendable>(
  _ expression: @MainActor () async throws -> T,
  file: StaticString = #filePath,
  line: UInt = #line
) async {
  do {
    _ = try await expression()
    XCTFail("Expected expression to throw", file: file, line: line)
  } catch {}
}
