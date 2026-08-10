import ExpoModulesCore
import SwiftUI
import UIKit

private enum ComposerMetrics {
  static let closedHorizontalInset: CGFloat = 40
  static let openHorizontalInset: CGFloat = 12
  static let contentHorizontalPadding: CGFloat = 10
  static let collapsedVerticalPadding: CGFloat = 6
  static let expandedVerticalPadding: CGFloat = 10
  static let minimumHeight: CGFloat = 52
  static let controlSize: CGFloat = 36
  static let controlSpacing: CGFloat = 8
  static let textControlInset = controlSize + controlSpacing
  static let expandedActionGap: CGFloat = 12
  static let expandedCornerRadius: CGFloat = 24
  static let fontSize: CGFloat = 17
  static let lineHeightEpsilon: CGFloat = 1
  static let outerTopPadding: CGFloat = 8
  static let outerBottomPadding: CGFloat = 8
}

final class OpenCompanyChatComposerViewProps: ExpoSwiftUI.ViewProps {
  @Field var value = ""
  @Field var disabled = false
  @Field var bottomInset: Double = 0
  @Field var accentColor: Color = .blue
  @Field var accentForegroundColor: Color = .white

  let onTextChange = EventDispatcher()
  let onSend = EventDispatcher()
  let onAttachmentPress = EventDispatcher()
  let onComposerHeightChange = EventDispatcher()
}

private final class ComposerModel: ObservableObject {
  @Published var text: String
  private var lastReportedHeight: CGFloat?

  init(text: String) {
    self.text = text
  }

  func reportHeight(_ height: CGFloat, dispatcher: EventDispatcher) {
    if let lastReportedHeight, abs(lastReportedHeight - height) < 0.25 {
      return
    }

    lastReportedHeight = height
    dispatcher(["height": height])
  }
}

struct OpenCompanyChatComposerView: ExpoSwiftUI.View {
  @ObservedObject var props: OpenCompanyChatComposerViewProps
  @StateObject private var model: ComposerModel
  @FocusState private var isInputFocused: Bool
  @State private var isExpanded = false
  @State private var isKeyboardVisible = false
  @State private var singleLineHeight: CGFloat?
  @State private var measuredCollapsedContentHeight: CGFloat?
  @State private var measuredExpandedContentHeight: CGFloat?

  init(props: OpenCompanyChatComposerViewProps) {
    self.props = props
    _model = StateObject(wrappedValue: ComposerModel(text: props.value))
  }

  var body: some View {
    composer
      .padding(.horizontal, horizontalInset)
      .padding(.top, ComposerMetrics.outerTopPadding)
      .padding(.bottom, max(0, CGFloat(props.bottomInset)) + ComposerMetrics.outerBottomPadding)
      .frame(maxWidth: .infinity)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
      .onAppear {
        synchronizeExternalValue(props.value)
      }
      .onChange(of: props.value) { value in
        synchronizeExternalValue(value)
      }
      .onReceive(
        NotificationCenter.default.publisher(
          for: UIResponder.keyboardWillChangeFrameNotification
        )
      ) { notification in
        updateKeyboardVisibility(from: notification)
      }
  }

  private var composer: some View {
    ZStack(alignment: .bottom) {
      actionRow
        .zIndex(2)

      TextField("Ask opencompany", text: textBinding, axis: .vertical)
        .textFieldStyle(.plain)
        .font(.system(size: ComposerMetrics.fontSize))
        .lineLimit(1...5)
        .fixedSize(horizontal: false, vertical: true)
        .focused($isInputFocused)
        .tint(props.accentColor)
        .accessibilityLabel("Message")
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: displayedInputHeight, alignment: .top)
        .clipped()
        .padding(.horizontal, isExpanded ? 0 : ComposerMetrics.textControlInset)
        .padding(.bottom, textBottomInset)
        .zIndex(1)
    }
    .padding(.horizontal, ComposerMetrics.contentHorizontalPadding)
    .padding(
      .vertical,
      isExpanded
        ? ComposerMetrics.expandedVerticalPadding
        : ComposerMetrics.collapsedVerticalPadding
    )
    .frame(minHeight: ComposerMetrics.minimumHeight)
    .glassEffect(
      .regular.interactive(),
      in: RoundedRectangle(
        cornerRadius: isExpanded
          ? ComposerMetrics.expandedCornerRadius
          : ComposerMetrics.minimumHeight / 2,
        style: .continuous
      )
    )
    .overlay(alignment: .top) {
      lineProbe(
        text: "M",
        horizontalInset: ComposerMetrics.contentHorizontalPadding
          + ComposerMetrics.textControlInset,
        lineLimit: 1
      ) { height in
        singleLineHeight = height
        updateExpandedState()
      }
    }
    .overlay(alignment: .top) {
      lineProbe(
        text: measurementText,
        horizontalInset: ComposerMetrics.contentHorizontalPadding
          + ComposerMetrics.textControlInset,
        lineLimit: 2
      ) { height in
        measuredCollapsedContentHeight = height
        updateExpandedState()
      }
    }
    .overlay(alignment: .top) {
      lineProbe(
        text: measurementText,
        horizontalInset: ComposerMetrics.contentHorizontalPadding,
        lineLimit: 5
      ) { height in
        measuredExpandedContentHeight = height
      }
    }
    .onGeometryChange(
      for: CGFloat.self,
      of: { geometry in
        geometry.size.height
      },
      action: { height in
        model.reportHeight(height, dispatcher: props.onComposerHeightChange)
      }
    )
    .animation(.smooth(duration: 0.18), value: isExpanded)
    .animation(.smooth(duration: 0.18), value: displayedInputHeight)
  }

  private var actionRow: some View {
    HStack(spacing: ComposerMetrics.controlSpacing) {
      Button {
        props.onAttachmentPress()
      } label: {
        Image(systemName: "plus")
          .font(.system(size: 20, weight: .medium))
          .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open attachments")

      Spacer(minLength: 0)

      Button(action: send) {
        Image(systemName: "arrow.up")
          .font(.system(size: 14, weight: .bold))
          .foregroundStyle(props.accentForegroundColor)
          .frame(width: 30, height: 30)
          .background(props.accentColor, in: Circle())
          .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(isSendDisabled)
      .opacity(isSendDisabled ? 0.4 : 1)
      .animation(.easeInOut(duration: 0.1), value: isSendDisabled)
      .accessibilityLabel("Send message")
    }
    .frame(maxWidth: .infinity)
  }

  private var textBinding: Binding<String> {
    Binding(
      get: { model.text },
      set: { value in
        model.text = value
        props.onTextChange(["value": value])
        if value.isEmpty {
          isExpanded = false
        }
      }
    )
  }

  private var isSendDisabled: Bool {
    props.disabled || model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var horizontalInset: CGFloat {
    if isExpanded {
      return ComposerMetrics.openHorizontalInset
    }

    return isKeyboardVisible
      ? ComposerMetrics.openHorizontalInset
      : ComposerMetrics.closedHorizontalInset
  }

  private var displayedInputHeight: CGFloat {
    let collapsedHeight =
      singleLineHeight
      ?? UIFont.systemFont(
        ofSize: ComposerMetrics.fontSize
      ).lineHeight

    guard isExpanded, let measuredExpandedContentHeight else {
      return collapsedHeight
    }

    return max(collapsedHeight, measuredExpandedContentHeight)
  }

  private var textBottomInset: CGFloat {
    if isExpanded {
      return ComposerMetrics.controlSize + ComposerMetrics.expandedActionGap
    }

    return max(0, (ComposerMetrics.controlSize - displayedInputHeight) / 2)
  }

  private var measurementText: String {
    model.text.isEmpty ? "M" : "\(model.text)\u{200B}"
  }

  private func lineProbe(
    text: String,
    horizontalInset: CGFloat,
    lineLimit: Int,
    onHeightChange: @escaping (CGFloat) -> Void
  ) -> some View {
    Text(text)
      .font(.system(size: ComposerMetrics.fontSize))
      .lineLimit(lineLimit)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, horizontalInset)
      .frame(maxWidth: .infinity)
      .hidden()
      .accessibilityHidden(true)
      .allowsHitTesting(false)
      .onGeometryChange(
        for: CGFloat.self,
        of: { geometry in
          geometry.size.height
        }, action: onHeightChange)
  }

  private func updateExpandedState() {
    guard !model.text.isEmpty,
      let singleLineHeight,
      let measuredCollapsedContentHeight
    else {
      if model.text.isEmpty {
        isExpanded = false
      }
      return
    }

    isExpanded =
      measuredCollapsedContentHeight
      > singleLineHeight + ComposerMetrics.lineHeightEpsilon
  }

  private func synchronizeExternalValue(_ value: String) {
    guard model.text != value else {
      return
    }
    model.text = value
    if value.isEmpty {
      isExpanded = false
    }
  }

  private func send() {
    let draft = model.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !props.disabled, !draft.isEmpty else {
      return
    }

    model.text = ""
    isExpanded = false
    props.onTextChange(["value": ""])
    props.onSend(["value": draft])
  }

  private func updateKeyboardVisibility(from notification: Notification) {
    guard let userInfo = notification.userInfo,
      let endFrameValue = userInfo[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue
    else {
      return
    }

    let endFrame = endFrameValue.cgRectValue
    let screenHeight =
      (UIApplication.shared.connectedScenes.first as? UIWindowScene)?
      .screen.bounds.height ?? UIScreen.main.bounds.height
    let nextIsKeyboardVisible = endFrame.minY < screenHeight - 1
    let duration = userInfo[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
    let curveValue = userInfo[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int
    let animation: Animation

    switch curveValue.flatMap(UIView.AnimationCurve.init(rawValue:)) {
    case .easeIn:
      animation = .easeIn(duration: duration)
    case .easeOut:
      animation = .easeOut(duration: duration)
    case .linear:
      animation = .linear(duration: duration)
    default:
      animation = .easeInOut(duration: duration)
    }

    withAnimation(animation) {
      isKeyboardVisible = nextIsKeyboardVisible
    }
  }
}
