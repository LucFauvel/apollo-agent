# The Go half (tsnet) is a static C archive per platform in ApolloTailnet.xcframework,
# built by ../scripts/build-go.sh (gitignored). Build it before `pod install`.
#
# The archive is linked by path with SDK-conditional flags rather than through
# `vendored_frameworks`: CocoaPods' "Copy XCFrameworks" phase can be skipped or run
# after Swift scans imports, and on a case-insensitive disk `-lapollotailnet` would
# also match this pod's own libApolloTailnet.a.
xcframework = File.join(__dir__, 'ApolloTailnet.xcframework')
go_headers = File.join(xcframework, 'ios-arm64', 'Headers') # identical in both slices (build-go.sh checks)
device_lib = File.join(xcframework, 'ios-arm64', 'libapollotailnet_go.a')
sim_lib = File.join(xcframework, 'ios-arm64_x86_64-simulator', 'libapollotailnet_go.a')

unless File.exist?(device_lib) && File.exist?(sim_lib)
  Pod::UI.warn "ApolloTailnet: #{xcframework} is missing; run modules/apollo-tailnet/scripts/build-go.sh"
end

Pod::Spec.new do |s|
  s.name           = 'ApolloTailnet'
  s.version        = '1.0.0'
  s.summary        = 'Embedded Tailscale node (tsnet) and Secure Enclave device key for Apollo'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Apollo'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift lives in src/ so source_files never matches the xcframework's headers.
  s.source_files = 'src/**/*.swift'
  s.preserve_paths = 'ApolloTailnet.xcframework/**/*'
  s.frameworks = 'Security', 'CoreFoundation'
  s.libraries = 'resolv'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_INCLUDE_PATHS' => "$(inherited) \"#{go_headers}\"",
  }
  s.user_target_xcconfig = {
    # The app's explicit-module scan follows this pod's imports.
    'SWIFT_INCLUDE_PATHS' => "$(inherited) \"#{go_headers}\"",
    # A conditional OTHER_LDFLAGS[sdk=...] would hide the merged unconditional value, so
    # pick the slice through a helper variable instead.
    'APOLLO_TAILNET_GO_LIB[sdk=iphoneos*]' => "\"#{device_lib}\"",
    'APOLLO_TAILNET_GO_LIB[sdk=iphonesimulator*]' => "\"#{sim_lib}\"",
    'OTHER_LDFLAGS' => '$(inherited) $(APOLLO_TAILNET_GO_LIB)',
  }
end
