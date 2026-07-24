import Foundation
import XCTest

@testable import GoatQuick

final class LoopbackCallbackServerTests: XCTestCase {
  func testParsesValidCallback() {
    let callback = LoopbackCallbackServer.parseCallback(
      from: "GET /oauth/callback?code=hello%20world&state=abc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
    )
    XCTAssertEqual(callback, OAuthCallback(code: "hello world", state: "abc", error: nil))
  }

  func testRejectsOtherPathsAndMethods() {
    XCTAssertNil(LoopbackCallbackServer.parseCallback(from: "GET /other?code=x HTTP/1.1\r\n\r\n"))
    XCTAssertNil(
      LoopbackCallbackServer.parseCallback(from: "POST /oauth/callback?code=x HTTP/1.1\r\n\r\n"))
  }

  func testBindsLoopbackAndCompletesOnce() async throws {
    let server = LoopbackCallbackServer()
    let redirectURI = try await server.start()
    XCTAssertEqual(redirectURI.host, "127.0.0.1")
    XCTAssertNotNil(redirectURI.port)

    let callbackTask = Task { try await server.waitForCallback() }
    let callbackURL = redirectURI.appending(queryItems: [
      URLQueryItem(name: "code", value: "code-1"),
      URLQueryItem(name: "state", value: "state-1"),
    ])
    let (_, response) = try await URLSession.shared.data(from: callbackURL)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let callback = try await callbackTask.value
    XCTAssertEqual(callback, OAuthCallback(code: "code-1", state: "state-1", error: nil))
    XCTAssertFalse(server.isListening)
  }
}
