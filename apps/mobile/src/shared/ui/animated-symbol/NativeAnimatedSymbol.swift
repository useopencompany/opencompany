internal import ExpoModulesCore
import UIKit

// Expo registers inline modules by filename, so the file, class, and Name must stay identical.
class NativeAnimatedSymbol: Module {
  func definition() -> ModuleDefinition {
    Name("NativeAnimatedSymbol")

    View(NativeAnimatedSymbolView.self) {
      Prop("name") { (view: NativeAnimatedSymbolView, name: String) in
        view.name = name
      }

      Prop("size") { (view: NativeAnimatedSymbolView, size: Double) in
        view.pointSize = max(1, CGFloat(size))
      }

      Prop("weight") { (view: NativeAnimatedSymbolView, weight: String) in
        view.weight = NativeAnimatedSymbolView.symbolWeight(weight)
      }

      Prop("tintColor") { (view: NativeAnimatedSymbolView, color: UIColor?) in
        view.tint = color
      }

      Prop("animated") { (view: NativeAnimatedSymbolView, animated: Bool) in
        view.animated = animated
      }

      OnViewDidUpdateProps { (view: NativeAnimatedSymbolView) in
        view.render()
      }
    }
  }
}

/// Renders one SF Symbol and swaps it with Magic Replace. The system falls back to a
/// down-up replace for symbol pairs that cannot share shapes. React Native owns the
/// surrounding control, so this view is decorative and ignores touches.
final class NativeAnimatedSymbolView: ExpoView {
  var name = ""
  var pointSize: CGFloat = 17
  var weight: UIImage.SymbolWeight = .regular
  var tint: UIColor?
  var animated = true

  private let imageView = UIImageView()
  private var renderedName: String?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    imageView.contentMode = .center
    addSubview(imageView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
  }

  func render() {
    imageView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
      pointSize: pointSize,
      weight: weight
    )
    imageView.tintColor = tint

    guard name != renderedName else { return }
    guard let image = UIImage(systemName: name) else {
      imageView.image = nil
      renderedName = nil
      return
    }

    // The first render has nothing to replace. Reduce Motion keeps the state change and drops
    // the shape morph, matching how system controls treat symbol transitions.
    if renderedName == nil || !animated || UIAccessibility.isReduceMotionEnabled {
      imageView.image = image
    } else {
      imageView.setSymbolImage(image, contentTransition: .replace.magic(fallback: .replace.downUp))
    }
    renderedName = name
  }

  static func symbolWeight(_ value: String) -> UIImage.SymbolWeight {
    switch value {
    case "ultraLight": return .ultraLight
    case "thin": return .thin
    case "light": return .light
    case "medium": return .medium
    case "semibold": return .semibold
    case "bold": return .bold
    case "heavy": return .heavy
    case "black": return .black
    default: return .regular
    }
  }
}
