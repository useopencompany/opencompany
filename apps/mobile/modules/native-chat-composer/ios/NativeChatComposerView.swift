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
  static let widthAnimationDuration = 0.25
}

final class NativeChatComposerViewProps: ExpoSwiftUI.ViewProps {
  @Field var disabled = false
  @Field var isGenerating = false
  @Field var isStopping = false
  @Field var value = ""
  @Field var mostRecentEventCount = 0
  @Field var bottomInset: Double = 0
  @Field var accentColor: Color = .blue
  @Field var accentForegroundColor: Color = .white
  @Field var hasAttachments = false
  @Field var focusRequest = 0
  @Field var blurRequest = 0

  let onSend = EventDispatcher()
  let onStop = EventDispatcher()
  let onChangeText = EventDispatcher()
  let onAttachmentPress = EventDispatcher()
  let onComposerHeightChange = EventDispatcher()
  let onFocusChange = EventDispatcher()
}

struct NativeChatComposerView: ExpoSwiftUI.View {
  @ObservedObject var props: NativeChatComposerViewProps
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @FocusState private var isInputFocused: Bool
  @State private var text = ""
  @State private var eventCount = 0
  @State private var isExpanded = false
  @State private var lastBlurRequest = 0
  @State private var lastFocusRequest = 0
  @State private var lastReportedHeight: CGFloat?
  @State private var singleLineHeight: CGFloat?
  @State private var measuredCollapsedContentHeight: CGFloat?
  @State private var measuredExpandedContentHeight: CGFloat?

  var body: some View {
    composer
      .padding(.horizontal, horizontalInset)
      .animation(
        .spring(duration: ComposerMetrics.widthAnimationDuration, bounce: 0),
        value: horizontalInset
      )
      .padding(.top, ComposerMetrics.outerTopPadding)
      .padding(.bottom, max(0, CGFloat(props.bottomInset)) + ComposerMetrics.outerBottomPadding)
      .frame(maxWidth: .infinity)
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(
        for: CGFloat.self,
        of: { geometry in geometry.size.height },
        action: reportComposerHeight
      )
      .onChange(of: props.focusRequest, initial: true) {
        guard props.focusRequest > lastFocusRequest else { return }
        lastFocusRequest = props.focusRequest
        isInputFocused = true
      }
      .onChange(of: props.blurRequest, initial: true) {
        guard props.blurRequest > lastBlurRequest else { return }
        lastBlurRequest = props.blurRequest
        isInputFocused = false
      }
      .onChange(of: isInputFocused) {
        props.onFocusChange(["focused": isInputFocused])
      }
      .onChange(of: props.value, initial: true) { synchronizeText() }
      .onChange(of: props.mostRecentEventCount) { synchronizeText() }
      .onChange(of: text) { updateExpandedState() }
  }

  private var composer: some View {
    VStack(spacing: 0) {
      if props.hasAttachments {
        Children()
          .frame(maxWidth: .infinity)
      }

      inputArea
    }
    .padding(.horizontal, ComposerMetrics.contentHorizontalPadding)
    .padding(
      .vertical,
      isComposerExpanded
        ? ComposerMetrics.expandedVerticalPadding
        : ComposerMetrics.collapsedVerticalPadding
    )
    .frame(minHeight: ComposerMetrics.minimumHeight)
    .glassEffect(
      .regular.interactive(),
      in: RoundedRectangle(
        cornerRadius: isComposerExpanded
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
    .animation(.smooth(duration: 0.18), value: isExpanded)
    .animation(.smooth(duration: 0.18), value: displayedInputHeight)
    .animation(.smooth(duration: 0.22), value: props.hasAttachments)
  }

  private var inputArea: some View {
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

      Button(action: props.isGenerating ? stop : send) {
        Image(systemName: props.isGenerating ? "stop.fill" : "arrow.up")
          .font(.system(size: 14, weight: .bold))
          .foregroundStyle(props.accentForegroundColor)
          .contentTransition(
            reduceMotion ? .opacity : .symbolEffect(.replace.downUp.wholeSymbol)
          )
          .animation(reduceMotion ? .easeOut(duration: 0.1) : .default, value: props.isGenerating)
          .frame(width: 30, height: 30)
          .background(props.accentColor, in: Circle())
          .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(props.isGenerating ? props.isStopping : isSendDisabled)
      .opacity((props.isGenerating ? props.isStopping : isSendDisabled) ? 0.6 : 1)
      .animation(.easeInOut(duration: 0.1), value: isSendDisabled)
      .accessibilityLabel(
        props.isGenerating ? (props.isStopping ? "Stopping" : "Stop") : "Send message"
      )
    }
    .frame(maxWidth: .infinity)
  }

  private var textBinding: Binding<String> {
    Binding(
      get: { text },
      set: { value in
        guard value != text else { return }
        text = value
        eventCount += 1
        props.onChangeText(["value": value, "eventCount": eventCount])
        if value.isEmpty { isExpanded = false }
      }
    )
  }

  private var isSendDisabled: Bool {
    props.disabled
      || (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !props.hasAttachments)
  }

  private var horizontalInset: CGFloat {
    if isComposerExpanded || isInputFocused { return ComposerMetrics.openHorizontalInset }
    return ComposerMetrics.closedHorizontalInset
  }

  private var isComposerExpanded: Bool {
    isExpanded || props.hasAttachments
  }

  private var displayedInputHeight: CGFloat {
    let collapsedHeight =
      singleLineHeight
      ?? UIFont.systemFont(ofSize: ComposerMetrics.fontSize).lineHeight

    guard isExpanded, let measuredExpandedContentHeight else { return collapsedHeight }
    return max(collapsedHeight, measuredExpandedContentHeight)
  }

  private var textBottomInset: CGFloat {
    if isExpanded { return ComposerMetrics.controlSize + ComposerMetrics.expandedActionGap }
    return max(0, (ComposerMetrics.controlSize - displayedInputHeight) / 2)
  }

  private var measurementText: String {
    text.isEmpty ? "M" : "\(text)\u{200B}"
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
        of: { geometry in geometry.size.height },
        action: onHeightChange
      )
  }

  private func updateExpandedState() {
    guard !text.isEmpty,
      let singleLineHeight,
      let measuredCollapsedContentHeight
    else {
      if text.isEmpty { isExpanded = false }
      return
    }

    isExpanded =
      measuredCollapsedContentHeight
      > singleLineHeight + ComposerMetrics.lineHeightEpsilon
  }

  private func send() {
    let draft = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !props.disabled, !draft.isEmpty || props.hasAttachments else { return }
    // Clear in the native tap transaction. Older JS echoes must not restore
    // sent text while keyboard dismissal and draft persistence are in flight.
    text = ""
    isExpanded = false
    eventCount += 1
    props.onSend(["value": draft, "eventCount": eventCount])
  }

  private func synchronizeText() {
    guard props.mostRecentEventCount >= eventCount else { return }
    eventCount = props.mostRecentEventCount
    text = props.value
  }

  private func stop() {
    guard props.isGenerating, !props.isStopping else { return }
    props.onStop()
  }

  private func reportComposerHeight(_ height: CGFloat) {
    if let lastReportedHeight, abs(lastReportedHeight - height) < 0.25 { return }
    lastReportedHeight = height
    props.onComposerHeightChange(["height": height])
  }
}
