import ExpoModulesCore

public class OpenCompanySidebarHeaderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenCompanySidebarHeader")

    View(OpenCompanySidebarHeaderView.self) {
      Events("onHeaderHeightChange", "onSearchPress")

      Prop("scrollViewTestID") { (view: OpenCompanySidebarHeaderView, testID: String) in
        view.scrollViewTestID = testID
      }

      Prop("searchAccessibilityLabel") { (view: OpenCompanySidebarHeaderView, label: String) in
        view.searchAccessibilityLabel = label
      }

      Prop("topInset") { (view: OpenCompanySidebarHeaderView, topInset: Double) in
        view.topInset = max(0, CGFloat(topInset))
      }
    }
  }
}
