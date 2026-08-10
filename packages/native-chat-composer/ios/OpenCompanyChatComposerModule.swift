import ExpoModulesCore

public class OpenCompanyChatComposerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenCompanyChatComposer")

    View(OpenCompanyChatComposerView.self)
  }
}
