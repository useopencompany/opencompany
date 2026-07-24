import SwiftUI

struct ComposerView: View {
  @ObservedObject var model: AppModel
  @FocusState private var composerFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let configurationError = model.configurationError {
        configurationMessage(configurationError)
      } else if !model.isSignedIn {
        signedOutView
      } else {
        composer
      }
    }
    .padding(16)
    .frame(width: 620)
    .background(.ultraThickMaterial)
    .onAppear { composerFocused = model.isSignedIn }
    .onChange(of: model.isSignedIn) { _, signedIn in
      if signedIn { composerFocused = true }
    }
    .onChange(of: model.draft) { _, draft in
      if draft.count > 10_000 { model.draft = String(draft.prefix(10_000)) }
    }
    .onExitCommand { model.dismiss() }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack(alignment: .topLeading) {
        if model.draft.isEmpty {
          Text("Ask Goat anything…")
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .allowsHitTesting(false)
        }
        TextEditor(text: $model.draft)
          .font(.system(size: 17))
          .scrollContentBackground(.hidden)
          .focused($composerFocused)
          .frame(minHeight: 76, maxHeight: 160)
          .onKeyPress(phases: .down) { press in
            guard press.key == .return else { return .ignored }
            guard !press.modifiers.contains(.shift) else { return .ignored }
            model.submit()
            return .handled
          }
      }

      HStack(spacing: 10) {
        statusContent
        Spacer()
        Text("\(model.characterCount)/10,000")
          .font(.caption)
          .foregroundStyle(.secondary)
        Button(action: model.submit) {
          Image(systemName: "arrow.up")
            .font(.system(size: 13, weight: .bold))
            .frame(width: 26, height: 26)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.circle)
        .disabled(!model.canSubmit)
        .help("Send to Goat")
      }
    }
  }

  @ViewBuilder
  private var statusContent: some View {
    if let errorMessage = model.errorMessage {
      HStack(spacing: 8) {
        Image(systemName: "exclamationmark.circle.fill")
          .foregroundStyle(.red)
        Text(errorMessage)
          .lineLimit(2)
        if model.openSessionURL != nil {
          Button("Open in Goat", action: model.openSession)
            .buttonStyle(.link)
        }
      }
      .font(.caption)
    } else {
      Text("↩ Send   ⇧↩ New line   esc Close")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private var signedOutView: some View {
    HStack(spacing: 14) {
      Image(systemName: "person.crop.circle.badge.questionmark")
        .font(.system(size: 30))
        .foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 4) {
        Text("Sign in to Goat")
          .font(.headline)
        Text(
          model.errorMessage
            ?? (model.isSigningIn
              ? "Finish signing in with the browser window."
              : "Your browser will open to authenticate this Mac.")
        )
        .font(.caption)
        .foregroundStyle(model.errorMessage == nil ? Color.secondary : Color.red)
      }
      Spacer()
      if model.isSigningIn {
        Button("Cancel", action: model.cancelSignIn)
        Button("Open Browser Again", action: model.reopenSignIn)
          .buttonStyle(.borderedProminent)
      } else {
        Button("Sign in", action: model.signIn)
          .buttonStyle(.borderedProminent)
      }
    }
    .frame(minHeight: 86)
  }

  private func configurationMessage(_ message: String) -> some View {
    Label {
      Text(message)
        .textSelection(.enabled)
    } icon: {
      Image(systemName: "gearshape.fill")
    }
    .frame(minHeight: 86)
  }
}
