internal import ExpoModulesCore
import UIKit

/// One piece of composer content as JavaScript sends it: plain text, or a tag the quick action
/// menu inserted. Tags keep every field JavaScript needs to serialize them again.
struct ComposerSegmentRecord: Record {
  @Field var type: String = "text"
  @Field var text: String = ""
  @Field var id: String = ""
  @Field var kind: String = ""
  @Field var label: String = ""
  @Field var symbol: String = ""
  @Field var tint: String? = nil
}

// Expo registers inline modules by filename, so the file, class, and Name must stay identical.
class NativeComposerInput: Module {
  func definition() -> ModuleDefinition {
    Name("NativeComposerInput")

    View(NativeComposerInputView.self) {
      Events(
        "onChangeContent",
        "onTriggerChange",
        "onInputFocus",
        "onInputBlur",
        "onSubmitHighlighted"
      )

      Prop("placeholder") { (view: NativeComposerInputView, placeholder: String) in
        view.placeholder = placeholder
      }

      Prop("inputAccessibilityLabel") { (view: NativeComposerInputView, label: String) in
        view.inputAccessibilityLabel = label
      }

      Prop("textColor") { (view: NativeComposerInputView, color: UIColor?) in
        view.textColor = color ?? .label
      }

      Prop("placeholderColor") { (view: NativeComposerInputView, color: UIColor?) in
        view.placeholderColor = color ?? .placeholderText
      }

      Prop("selectionColor") { (view: NativeComposerInputView, color: UIColor?) in
        view.selectionColor = color
      }

      Prop("tokenColor") { (view: NativeComposerInputView, color: UIColor?) in
        view.tokenColor = color ?? .tintColor
      }

      Prop("triggers") { (view: NativeComposerInputView, triggers: [String]) in
        view.triggers = Set(triggers)
      }

      Prop("maxHeight") { (view: NativeComposerInputView, maxHeight: Double) in
        view.maxHeight = max(0, CGFloat(maxHeight))
      }

      Prop("editable") { (view: NativeComposerInputView, editable: Bool) in
        view.editable = editable
      }

      Prop("submitsHighlighted") { (view: NativeComposerInputView, submits: Bool) in
        view.submitsHighlighted = submits
      }

      AsyncFunction("focus") { (view: NativeComposerInputView) in
        MainActor.assumeIsolated { view.focus() }
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: NativeComposerInputView) in
        MainActor.assumeIsolated { view.blur() }
      }.runOnQueue(.main)

      AsyncFunction("clear") { (view: NativeComposerInputView) in
        MainActor.assumeIsolated { view.setContent([]) }
      }.runOnQueue(.main)

      AsyncFunction("setContent") { (view: NativeComposerInputView, segments: [ComposerSegmentRecord]) in
        MainActor.assumeIsolated { view.setContent(segments) }
      }.runOnQueue(.main)

      AsyncFunction("insertToken") { (view: NativeComposerInputView, token: ComposerSegmentRecord) in
        MainActor.assumeIsolated { view.insertToken(token) }
      }.runOnQueue(.main)
    }
  }
}
