import AppKit
import Combine
import Foundation

@MainActor
final class AppModel: ObservableObject {
  @Published var draft = ""
  @Published private(set) var errorMessage: String?
  @Published private(set) var openSessionURL: URL?
  @Published private(set) var isSignedIn = false
  @Published private(set) var isSigningIn = false

  let configurationError: String?
  var hidePanel: () -> Void = {}
  var showPanel: () -> Void = {}

  private let configuration: GoatQuickConfiguration?
  private let oauthClient: OAuthClient?
  private let chatClient: GoatChatClient?
  private var subscriptions = Set<AnyCancellable>()

  init(configurationResult: Result<GoatQuickConfiguration, Error>) {
    switch configurationResult {
    case .success(let configuration):
      do {
        let oauthClient = try OAuthClient(configuration: configuration)
        self.configuration = configuration
        configurationError = nil
        self.oauthClient = oauthClient
        chatClient = GoatChatClient(baseURL: configuration.apiBaseURL, tokenProvider: oauthClient)
        isSignedIn = oauthClient.isSignedIn
        oauthClient.$isSignedIn
          .removeDuplicates()
          .sink { [weak self] in self?.isSignedIn = $0 }
          .store(in: &subscriptions)
      } catch {
        self.configuration = nil
        oauthClient = nil
        chatClient = nil
        configurationError = error.localizedDescription
      }
    case .failure(let error):
      configuration = nil
      oauthClient = nil
      chatClient = nil
      configurationError = error.localizedDescription
    }
  }

  var characterCount: Int { draft.count }
  var canSubmit: Bool {
    isSignedIn && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && draft.count <= 10_000
  }

  func submit() {
    guard let chatClient, canSubmit else { return }
    let prompt = draft
    draft = ""
    errorMessage = nil
    openSessionURL = nil
    hidePanel()

    Task { [weak self] in
      do {
        _ = try await chatClient.send(prompt: prompt)
      } catch {
        guard let self else { return }
        if draft.isEmpty { draft = prompt }
        if let sendError = error as? GoatChatSendError {
          errorMessage = sendError.message
          openSessionURL =
            sendError.acceptedByServer
            ? configuration?.appendingChatPath(sessionID: sendError.sessionID)
            : nil
        } else {
          errorMessage = error.localizedDescription
        }
        showPanel()
      }
    }
  }

  func signIn() {
    guard let oauthClient, !isSigningIn else { return }
    isSigningIn = true
    errorMessage = nil
    hidePanel()
    Task { [weak self] in
      guard let self else { return }
      defer { isSigningIn = false }
      do {
        try await oauthClient.signIn()
      } catch is CancellationError {
        errorMessage = nil
      } catch {
        errorMessage = error.localizedDescription
        showPanel()
      }
    }
  }

  func reopenSignIn() {
    guard oauthClient?.reopenAuthorizationPage() == true else {
      errorMessage = "The sign-in page is not ready yet. Try again in a moment."
      return
    }
    hidePanel()
  }

  func cancelSignIn() {
    oauthClient?.cancelSignIn()
  }

  func signOut() {
    do {
      try oauthClient?.signOut()
      errorMessage = nil
      openSessionURL = nil
    } catch {
      errorMessage = error.localizedDescription
      showPanel()
    }
  }

  func dismiss() {
    hidePanel()
  }

  func openSession() {
    guard let openSessionURL else { return }
    NSWorkspace.shared.open(openSessionURL)
  }
}

extension GoatQuickConfiguration {
  fileprivate func appendingChatPath(sessionID: String) -> URL {
    apiBaseURL.appending(path: "chat").appending(path: sessionID)
  }
}
