internal import ExpoModulesCore
import PhotosUI

// Expo registers inline modules by filename, so the file, class, and Name must stay identical.
class NativePhotoPickerPrewarm: Module {
  private var warmPicker: PHPickerViewController?
  private var release: DispatchWorkItem?

  func definition() -> ModuleDefinition {
    Name("NativePhotoPickerPrewarm")

    // The photo picker runs in a separate system process that starts cold on first use. Loading
    // a picker while the attachment menu is open starts that process, so the real picker opens
    // without waiting for it. The warm picker is never shown and is dropped after a minute.
    AsyncFunction("prewarm") {
      self.release?.cancel()
      if self.warmPicker == nil {
        var configuration = PHPickerConfiguration(photoLibrary: PHPhotoLibrary.shared())
        configuration.filter = .images
        configuration.selectionLimit = 0
        let picker = PHPickerViewController(configuration: configuration)
        picker.loadViewIfNeeded()
        self.warmPicker = picker
      }
      let release = DispatchWorkItem { [weak self] in self?.warmPicker = nil }
      self.release = release
      DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: release)
    }.runOnQueue(.main)
  }
}
