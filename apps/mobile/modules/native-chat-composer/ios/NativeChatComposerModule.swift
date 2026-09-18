import ExpoModulesCore

public class NativeChatComposerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeChatComposer")

    View(NativeChatComposerView.self)
  }
}
