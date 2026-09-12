Pod::Spec.new do |s|
  s.name           = 'NativeChatComposer'
  s.version        = '0.1.0'
  s.summary        = 'Native SwiftUI chat composer for opencompany mobile'
  s.description    = 'A Fabric-native, auto-sizing SwiftUI chat composer exposed through the Expo Modules API.'
  s.author         = 'opencompany'
  s.homepage       = 'https://github.com/useopencompany/opencompany-experimental'
  s.platforms      = {
    :ios => '26.0'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
