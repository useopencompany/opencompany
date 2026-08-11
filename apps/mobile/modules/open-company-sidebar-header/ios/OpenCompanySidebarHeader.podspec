Pod::Spec.new do |s|
  s.name           = 'OpenCompanySidebarHeader'
  s.version        = '0.1.0'
  s.summary        = 'Native sidebar header for OpenCompany mobile'
  s.description    = 'A native iOS sidebar header with system navigation items and scroll-edge effects.'
  s.author         = 'OpenCompany'
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
