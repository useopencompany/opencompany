internal import ExpoModulesCore
import UIKit

/// A tag the quick action menu inserted, as it travels between JavaScript and the text view.
struct ComposerToken: Equatable {
  let id: String
  let kind: String
  let label: String
  let symbol: String
  let tint: String?

  var payload: [String: Any] {
    var payload: [String: Any] = [
      "type": "token", "id": id, "kind": kind, "label": label, "symbol": symbol,
    ]
    if let tint { payload["tint"] = tint }
    return payload
  }
}

/// A tag is one attachment character drawn as an SF Symbol followed by its label. Being a single
/// character makes it atomic: the caret cannot land inside it, one backspace removes all of it,
/// and autocorrect or dictation cannot rewrite part of its label.
final class ComposerTokenAttachment: NSTextAttachment {
  let token: ComposerToken

  init(token: ComposerToken) {
    self.token = token
    super.init(data: nil, ofType: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}

/// Copies and pastes plain text, so a tag never leaves the composer as an attachment and a paste
/// never brings in foreign styling.
final class ComposerTextView: UITextView {
  weak var host: NativeComposerInputView?

  override func copy(_ sender: Any?) {
    guard let host, selectedRange.length > 0 else { return }
    UIPasteboard.general.string = host.plainText(in: selectedRange)
  }

  override func cut(_ sender: Any?) {
    guard let host, selectedRange.length > 0 else { return }
    UIPasteboard.general.string = host.plainText(in: selectedRange)
    host.replaceSelection(with: "")
  }

  override func paste(_ sender: Any?) {
    guard let host, let string = UIPasteboard.general.string else { return }
    host.replaceSelection(with: string)
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)) { return isEditable && UIPasteboard.general.hasStrings }
    return super.canPerformAction(action, withSender: sender)
  }

  // VoiceOver and UI automation read tags as their labels rather than an attachment character.
  override var accessibilityValue: String? {
    get { host?.plainText(in: NSRange(location: 0, length: textStorage.length)) }
    set { super.accessibilityValue = newValue }
  }
}

final class NativeComposerInputView: ExpoView, UITextViewDelegate {
  let onChangeContent = EventDispatcher()
  let onTriggerChange = EventDispatcher()
  let onInputFocus = EventDispatcher()
  let onInputBlur = EventDispatcher()
  let onSubmitHighlighted = EventDispatcher()

  var placeholder = "" {
    didSet { placeholderLabel.text = placeholder }
  }
  var inputAccessibilityLabel = "" {
    didSet { textView.accessibilityLabel = inputAccessibilityLabel }
  }
  var textColor: UIColor = .label {
    didSet { if textColor != oldValue { restyleContent() } }
  }
  var placeholderColor: UIColor = .placeholderText {
    didSet { placeholderLabel.textColor = placeholderColor }
  }
  var selectionColor: UIColor? {
    didSet { textView.tintColor = selectionColor }
  }
  var tokenColor: UIColor = .tintColor {
    didSet { if tokenColor != oldValue { restyleContent() } }
  }
  var triggers: Set<String> = [] {
    didSet { if triggers != oldValue { detectTrigger() } }
  }
  var maxHeight: CGFloat = 0 {
    didSet { if maxHeight != oldValue { updateHeight() } }
  }
  var editable = true {
    didSet {
      textView.isEditable = editable
      if !editable { textView.resignFirstResponder() }
    }
  }
  /// The menu shows a highlighted row, so Return picks it instead of starting a new line.
  var submitsHighlighted = false

  // Matches the React Native input this view replaced: `px-4 pt-3 pb-1` at 17pt.
  private static let insets = UIEdgeInsets(top: 12, left: 16, bottom: 4, right: 16)
  private static let baseFontSize: CGFloat = 17
  private static let attachmentCharacter: unichar = 0xFFFC
  private static let maxQueryLength = 64

  private let textView = ComposerTextView()
  private let placeholderLabel = UILabel()
  private var font = UIFont.systemFont(ofSize: NativeComposerInputView.baseFontSize)
  private var activeTrigger: (trigger: String, query: String, range: NSRange)?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear

    // keyboard-controller finds the focused input's nativeID through the text view's superview,
    // which is this view, so the text view must stay a direct child.
    textView.host = self
    textView.delegate = self
    textView.backgroundColor = .clear
    textView.textContainerInset = Self.insets
    textView.textContainer.lineFragmentPadding = 0
    textView.isScrollEnabled = false
    textView.alwaysBounceVertical = false
    textView.showsHorizontalScrollIndicator = false
    textView.textContentType = .none
    textView.allowsEditingTextAttributes = false
    textView.accessibilityLabel = inputAccessibilityLabel
    addSubview(textView)

    placeholderLabel.numberOfLines = 1
    placeholderLabel.textColor = placeholderColor
    placeholderLabel.isAccessibilityElement = false
    textView.addSubview(placeholderLabel)

    updateFont()
    registerForTraitChanges(
      [UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self]
    ) { (view: NativeComposerInputView, _: UITraitCollection) in
      view.updateFont()
      view.restyleContent()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    let insets = Self.insets
    placeholderLabel.frame = CGRect(
      x: insets.left,
      y: insets.top,
      width: max(0, bounds.width - insets.left - insets.right),
      height: ceil(font.lineHeight)
    )
    updateHeight()
  }

  // MARK: - Commands from JavaScript

  func focus() {
    guard editable else { return }
    textView.becomeFirstResponder()
  }

  func blur() {
    textView.resignFirstResponder()
  }

  /// Replaces everything. JavaScript only calls this while the input is blurred or being cleared,
  /// so it never fights the user's typing, and it does not echo a change event back.
  func setContent(_ segments: [ComposerSegmentRecord]) {
    let content = NSMutableAttributedString()
    for segment in segments {
      if segment.type == "token" {
        content.append(tokenString(for: token(from: segment)))
      } else {
        content.append(NSAttributedString(string: segment.text, attributes: baseAttributes))
      }
    }
    textView.attributedText = content
    textView.selectedRange = NSRange(location: content.length, length: 0)
    textView.typingAttributes = baseAttributes
    textView.undoManager?.removeAllActions()
    contentDidChange(notify: false)
  }

  /// Replaces the trigger being typed with the tag and a space, and puts the caret after both.
  func insertToken(_ record: ComposerSegmentRecord) {
    let range = activeTrigger?.range ?? textView.selectedRange
    let storage = textView.textStorage
    guard range.location != NSNotFound, NSMaxRange(range) <= storage.length else { return }
    let replacement = NSMutableAttributedString(attributedString: tokenString(for: token(from: record)))
    // Reuse a space that already follows. A line break still gets its own space, so the caret
    // stays on the tag's line.
    let followedBySpace =
      NSMaxRange(range) < storage.length
      && (storage.string as NSString).character(at: NSMaxRange(range)) == 0x20
    if !followedBySpace {
      replacement.append(NSAttributedString(string: " ", attributes: baseAttributes))
    }
    storage.replaceCharacters(in: range, with: replacement)
    textView.selectedRange = NSRange(
      location: range.location + replacement.length + (followedBySpace ? 1 : 0), length: 0)
    textView.typingAttributes = baseAttributes
    // Direct storage edits are invisible to the undo stack, which would then undo wrong ranges.
    textView.undoManager?.removeAllActions()
    contentDidChange(notify: true)
  }

  // MARK: - Plain text

  func plainText(in range: NSRange) -> String {
    var result = ""
    let string = textView.textStorage.string as NSString
    textView.textStorage.enumerateAttribute(.attachment, in: range) { value, subrange, _ in
      if let attachment = value as? ComposerTokenAttachment {
        result += attachment.token.label
      } else {
        result += string.substring(with: subrange).replacingOccurrences(of: "\u{FFFC}", with: "")
      }
    }
    return result
  }

  func replaceSelection(with string: String) {
    let range = textView.selectedRange
    guard textView.delegate?.textView?(textView, shouldChangeTextIn: range, replacementText: string)
      ?? true
    else { return }
    textView.textStorage.replaceCharacters(
      in: range, with: NSAttributedString(string: string, attributes: baseAttributes))
    textView.selectedRange = NSRange(location: range.location + (string as NSString).length, length: 0)
    textView.typingAttributes = baseAttributes
    textView.undoManager?.removeAllActions()
    contentDidChange(notify: true)
    textView.scrollRangeToVisible(textView.selectedRange)
  }

  // MARK: - UITextViewDelegate

  func textView(
    _ textView: UITextView,
    shouldChangeTextIn range: NSRange,
    replacementText text: String
  ) -> Bool {
    if text == "\n", activeTrigger != nil, submitsHighlighted {
      onSubmitHighlighted()
      return false
    }
    // Autocorrect, text replacements, and dictation rewrite ranges the user did not select. A tag
    // is never theirs to rewrite; typing over a selection that holds a tag still replaces it.
    if !text.isEmpty, range.length > 0, range != textView.selectedRange,
      containsToken(in: range)
    {
      return false
    }
    return true
  }

  func textViewDidChange(_ textView: UITextView) {
    contentDidChange(notify: true)
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    guard textView.markedTextRange == nil else { return }
    // Typing after a tag must not inherit its attachment styling.
    textView.typingAttributes = baseAttributes
    detectTrigger()
  }

  func textViewDidBeginEditing(_ textView: UITextView) {
    onInputFocus()
    detectTrigger()
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    onInputBlur()
    setTrigger(nil)
  }

  // MARK: - Content

  private var baseAttributes: [NSAttributedString.Key: Any] {
    [.font: font, .foregroundColor: textColor]
  }

  private func contentDidChange(notify: Bool) {
    placeholderLabel.isHidden = textView.textStorage.length > 0
    updateHeight()
    if notify { onChangeContent(["segments": segments()]) }
    detectTrigger()
  }

  private func segments() -> [[String: Any]] {
    var result: [[String: Any]] = []
    var text = ""
    let storage = textView.textStorage
    let string = storage.string as NSString
    storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) {
      value, range, _ in
      if let attachment = value as? ComposerTokenAttachment {
        if !text.isEmpty { result.append(["type": "text", "text": text]) }
        text = ""
        result.append(attachment.token.payload)
      } else {
        text += string.substring(with: range).replacingOccurrences(of: "\u{FFFC}", with: "")
      }
    }
    if !text.isEmpty { result.append(["type": "text", "text": text]) }
    return result
  }

  private func token(from record: ComposerSegmentRecord) -> ComposerToken {
    ComposerToken(
      id: record.id, kind: record.kind, label: record.label, symbol: record.symbol,
      tint: record.tint)
  }

  private func containsToken(in range: NSRange) -> Bool {
    var found = false
    textView.textStorage.enumerateAttribute(.attachment, in: range) { value, _, stop in
      if value is ComposerTokenAttachment {
        found = true
        stop.pointee = true
      }
    }
    return found
  }

  private func updateFont() {
    font = UIFontMetrics(forTextStyle: .body).scaledFont(
      for: .systemFont(ofSize: Self.baseFontSize), compatibleWith: traitCollection)
    placeholderLabel.font = font
    setNeedsLayout()
  }

  /// Rebuilds the text in the current font and colors. Tag images bake in both, so a Dynamic
  /// Type or appearance change redraws them.
  private func restyleContent() {
    guard textView.markedTextRange == nil else { return }
    let selection = textView.selectedRange
    let storage = textView.textStorage
    let full = NSRange(location: 0, length: storage.length)
    var tokens: [(NSRange, ComposerToken)] = []
    storage.enumerateAttribute(.attachment, in: full) { value, range, _ in
      if let attachment = value as? ComposerTokenAttachment { tokens.append((range, attachment.token)) }
    }
    storage.beginEditing()
    storage.setAttributes(baseAttributes, range: full)
    for (range, token) in tokens.reversed() {
      storage.replaceCharacters(in: range, with: tokenString(for: token))
    }
    storage.endEditing()
    textView.selectedRange = selection
    textView.typingAttributes = baseAttributes
    contentDidChange(notify: false)
  }

  private func tokenString(for token: ComposerToken) -> NSAttributedString {
    let attachment = ComposerTokenAttachment(token: token)
    let (image, bounds) = renderToken(token)
    attachment.image = image
    attachment.bounds = bounds
    var attributes = baseAttributes
    attributes[.attachment] = attachment
    return NSAttributedString(string: "\u{FFFC}", attributes: attributes)
  }

  /// Draws the symbol centered on the cap height and the label on the text baseline, so the tag
  /// sits in the line like the words around it at every Dynamic Type size.
  private func renderToken(_ token: ComposerToken) -> (UIImage, CGRect) {
    var image = UIImage()
    var bounds = CGRect.zero
    traitCollection.performAsCurrent {
      let symbolColor = Self.systemColor(named: token.tint) ?? tokenColor
      let configuration = UIImage.SymbolConfiguration(font: font, scale: .small)
        .applying(UIImage.SymbolConfiguration(hierarchicalColor: symbolColor))
      let symbol = (UIImage(systemName: token.symbol, withConfiguration: configuration)
        ?? UIImage(systemName: "circle.fill", withConfiguration: configuration))?
        // Drawing outside an image view takes the color from the image itself, not the
        // configuration, so without this the symbol falls back to the default blue.
        .withTintColor(symbolColor, renderingMode: .alwaysOriginal)
      let label = NSAttributedString(
        string: token.label, attributes: [.font: font, .foregroundColor: tokenColor])
      let symbolSize = symbol?.size ?? .zero
      let gap = symbol == nil ? 0 : ceil(font.pointSize * 0.2)
      let labelWidth = ceil(label.size().width)
      let ascender = ceil(font.ascender)
      let height = ascender + ceil(-font.descender)
      let size = CGSize(width: ceil(symbolSize.width) + gap + labelWidth, height: height)
      let format = UIGraphicsImageRendererFormat(for: traitCollection)
      format.opaque = false
      image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        let capMiddle = ascender - font.capHeight / 2
        symbol?.draw(
          in: CGRect(
            x: 0, y: capMiddle - symbolSize.height / 2, width: symbolSize.width,
            height: symbolSize.height))
        label.draw(at: CGPoint(x: ceil(symbolSize.width) + gap, y: ascender - font.ascender))
      }
      image.accessibilityLabel = token.label
      bounds = CGRect(x: 0, y: -ceil(-font.descender), width: size.width, height: size.height)
    }
    return (image, bounds)
  }

  private static func systemColor(named name: String?) -> UIColor? {
    switch name {
    case "red": return .systemRed
    case "orange": return .systemOrange
    case "yellow": return .systemYellow
    case "green": return .systemGreen
    case "mint": return .systemMint
    case "teal": return .systemTeal
    case "cyan": return .systemCyan
    case "blue": return .systemBlue
    case "indigo": return .systemIndigo
    case "purple": return .systemPurple
    case "pink": return .systemPink
    case "brown": return .systemBrown
    case "gray": return .systemGray
    case "label": return .label
    default: return nil
    }
  }

  // MARK: - Height

  /// Grows with the text up to `maxHeight`, then scrolls. The height goes to the shadow node
  /// directly, so React Native lays the composer out in the same frame the line wraps.
  private func updateHeight() {
    guard bounds.width > 0 else { return }
    // Rounded to device pixels, as React Native rounds the single-line height it reserves.
    let scale = max(1, traitCollection.displayScale)
    let pixelCeil = { (value: CGFloat) in ceil(value * scale) / scale }
    let minimum = pixelCeil(font.lineHeight + Self.insets.top + Self.insets.bottom)
    let fitting = pixelCeil(
      textView.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height)
    let limit = maxHeight > 0 ? max(minimum, maxHeight) : .greatestFiniteMagnitude
    let height = min(max(fitting, minimum), limit)
    let scrolls = fitting > limit + 0.5
    if scrolls != textView.isScrollEnabled {
      textView.isScrollEnabled = scrolls
      if scrolls { textView.scrollRangeToVisible(textView.selectedRange) }
    }
    // Compared with the laid-out height rather than the last request: a request sent before the
    // shadow node existed is lost, and the next layout repeats it. Equal sizes commit nothing.
    if abs(height - bounds.height) > 0.5 {
      setViewSize(CGSize(width: -1, height: height))
    }
  }

  // MARK: - Triggers

  /// A trigger is the first character of the word that ends at the caret, at the start of the
  /// text or after whitespace. The query is the rest of that word. IME composition and dictation
  /// leave the trigger as it was until they commit.
  private func detectTrigger() {
    guard textView.isFirstResponder else {
      setTrigger(nil)
      return
    }
    guard textView.markedTextRange == nil else { return }
    let selection = textView.selectedRange
    guard selection.length == 0, selection.location != NSNotFound, !triggers.isEmpty else {
      setTrigger(nil)
      return
    }
    let string = textView.textStorage.string as NSString
    var start = selection.location
    while start > 0 {
      let character = string.character(at: start - 1)
      if isWhitespace(character) || character == Self.attachmentCharacter { break }
      start -= 1
      if selection.location - start > Self.maxQueryLength + 1 {
        setTrigger(nil)
        return
      }
    }
    // Directly after a tag is not "after whitespace".
    guard start < selection.location,
      start == 0 || string.character(at: start - 1) != Self.attachmentCharacter
    else {
      setTrigger(nil)
      return
    }
    let trigger = string.substring(with: NSRange(location: start, length: 1))
    guard triggers.contains(trigger) else {
      setTrigger(nil)
      return
    }
    let range = NSRange(location: start, length: selection.location - start)
    let query = string.substring(with: NSRange(location: start + 1, length: range.length - 1))
    setTrigger((trigger, query, range))
  }

  private func setTrigger(_ next: (trigger: String, query: String, range: NSRange)?) {
    let changed = next?.trigger != activeTrigger?.trigger || next?.query != activeTrigger?.query
    activeTrigger = next
    guard changed else { return }
    if let next {
      onTriggerChange(["active": true, "trigger": next.trigger, "query": next.query])
    } else {
      onTriggerChange(["active": false])
    }
  }

  private func isWhitespace(_ character: unichar) -> Bool {
    guard let scalar = Unicode.Scalar(character) else { return false }
    return CharacterSet.whitespacesAndNewlines.contains(scalar)
  }
}
