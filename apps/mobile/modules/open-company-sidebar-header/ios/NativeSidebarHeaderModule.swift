import ExpoModulesCore

public class NativeSidebarHeaderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeSidebarHeader")

    View(NativeSidebarHeaderView.self) {
      Events(
        "onHeaderHeightChange",
        "onSearchActiveChange",
        "onSearchPress",
        "onSearchValueChange"
      )

      Prop("scrollViewTestID") { (view: NativeSidebarHeaderView, testID: String) in
        view.scrollViewTestID = testID
      }

      Prop("searchAccessibilityLabel") { (view: NativeSidebarHeaderView, label: String) in
        view.searchAccessibilityLabel = label
      }

      Prop("topInset") { (view: NativeSidebarHeaderView, topInset: Double) in
        view.topInset = max(0, CGFloat(topInset))
      }
    }
  }
}
