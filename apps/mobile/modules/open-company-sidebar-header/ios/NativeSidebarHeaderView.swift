import ExpoModulesCore
import UIKit

final class NativeSidebarHeaderView: ExpoView, UISearchControllerDelegate, UISearchResultsUpdating {
  let onHeaderHeightChange = EventDispatcher()
  let onSearchActiveChange = EventDispatcher()
  let onSearchPress = EventDispatcher()
  let onSearchValueChange = EventDispatcher()

  var scrollViewTestID = "" {
    didSet {
      guard scrollViewTestID != oldValue else {
        return
      }

      connectedScrollView = nil
      scrollEdgeInteraction.scrollView = nil
      connectToScrollView()
    }
  }

  var searchAccessibilityLabel = "Search" {
    didSet {
      searchItem.accessibilityLabel = searchAccessibilityLabel
      searchController.searchBar.accessibilityLabel = searchAccessibilityLabel
      searchController.searchBar.placeholder = searchAccessibilityLabel
    }
  }

  var topInset: CGFloat = 0 {
    didSet {
      guard topInset != oldValue else {
        return
      }

      lastReportedHeight = nil
      setNeedsLayout()
    }
  }

  private let navigationBar = UINavigationBar()
  private let navigationItem = UINavigationItem()
  private let scrollEdgeInteraction = UIScrollEdgeElementContainerInteraction()
  private weak var connectedScrollView: UIScrollView?
  private var isSearchActive = false
  private var lastReportedHeight: CGFloat?
  private var searchValue = ""

  private lazy var searchController: UISearchController = {
    let searchController = UISearchController(searchResultsController: nil)
    searchController.delegate = self
    searchController.obscuresBackgroundDuringPresentation = false
    searchController.searchResultsUpdater = self
    searchController.searchBar.accessibilityLabel = searchAccessibilityLabel
    searchController.searchBar.placeholder = searchAccessibilityLabel
    return searchController
  }()

  private lazy var searchItem = UIBarButtonItem(
    image: UIImage(systemName: "magnifyingglass"),
    style: .plain,
    target: self,
    action: #selector(didPressSearch)
  )

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    backgroundColor = .clear
    navigationBar.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    searchItem.accessibilityLabel = searchAccessibilityLabel
    if #available(iOS 26.0, *) {
      navigationItem.searchController = searchController
      navigationItem.preferredSearchBarPlacement = .integratedButton
    } else {
      navigationItem.rightBarButtonItem = searchItem
    }
    navigationBar.setItems([navigationItem], animated: false)
    addSubview(navigationBar)

    scrollEdgeInteraction.edge = .top
    addInteraction(scrollEdgeInteraction)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()

    DispatchQueue.main.async { [weak self] in
      self?.connectToScrollView()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()

    let availableNavigationBarHeight = max(0, bounds.height - topInset)
    navigationBar.frame = navigationBarFrame(height: availableNavigationBarHeight)
    navigationBar.layoutIfNeeded()

    let measuredHeight = measuredNavigationBarHeight()
    let navigationBarHeight = measuredHeight > 0 ? measuredHeight : availableNavigationBarHeight
    navigationBar.frame = navigationBarFrame(height: navigationBarHeight)
    navigationBar.layoutIfNeeded()

    reportHeaderHeight(navigationBarHeight: navigationBarHeight)

    if connectedScrollView == nil {
      connectToScrollView()
    }
  }

  private func navigationBarFrame(height: CGFloat) -> CGRect {
    return CGRect(
      x: bounds.minX,
      y: bounds.minY + topInset,
      width: bounds.width,
      height: height
    )
  }

  @objc
  private func didPressSearch() {
    onSearchPress()
  }

  func willPresentSearchController(_ searchController: UISearchController) {
    setSearchActive(true)
    onSearchPress()
  }

  func willDismissSearchController(_ searchController: UISearchController) {
    setSearchActive(false)
  }

  func updateSearchResults(for searchController: UISearchController) {
    let value = searchController.searchBar.text ?? ""

    guard searchValue != value else {
      return
    }

    searchValue = value
    onSearchValueChange(["value": value])
  }

  private func setSearchActive(_ active: Bool) {
    guard isSearchActive != active else {
      return
    }

    isSearchActive = active
    onSearchActiveChange(["active": active])
  }

  private func measuredNavigationBarHeight() -> CGFloat {
    let fittingSize = CGSize(
      width: max(bounds.width, 1),
      height: CGFloat.greatestFiniteMagnitude
    )
    return navigationBar.sizeThatFits(fittingSize).height
  }

  private func reportHeaderHeight(navigationBarHeight: CGFloat) {
    let height = topInset + navigationBarHeight

    guard navigationBarHeight > 0 else {
      return
    }

    if let lastReportedHeight, abs(lastReportedHeight - height) < 0.25 {
      return
    }

    lastReportedHeight = height
    onHeaderHeightChange(["height": height])
  }

  private func connectToScrollView() {
    guard connectedScrollView == nil, !scrollViewTestID.isEmpty else {
      return
    }

    var ancestor = superview
    while let candidateRoot = ancestor {
      if let identifiedView = findView(withTestID: scrollViewTestID, in: candidateRoot),
        let scrollView = findScrollView(in: identifiedView)
      {
        connectedScrollView = scrollView
        scrollView.topEdgeEffect.style = .soft
        scrollEdgeInteraction.scrollView = scrollView
        return
      }

      ancestor = candidateRoot.superview
    }
  }

  private func findView(withTestID testID: String, in root: UIView) -> UIView? {
    if root.accessibilityIdentifier == testID {
      return root
    }

    for subview in root.subviews {
      if let match = findView(withTestID: testID, in: subview) {
        return match
      }
    }

    return nil
  }

  private func findScrollView(in root: UIView) -> UIScrollView? {
    if let scrollView = root as? UIScrollView {
      return scrollView
    }

    for subview in root.subviews {
      if let scrollView = findScrollView(in: subview) {
        return scrollView
      }
    }

    return nil
  }
}
