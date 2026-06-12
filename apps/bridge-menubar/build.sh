#!/usr/bin/env bash
# Build the menubar app into a runnable .app bundle. No Xcode project needed — swiftc
# compiles the sources directly; the accessory activation policy (set in code) makes it a
# menubar-only app. Output: .build/OpenCompanyBridge.app
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="OpenCompany Bridge"
BUNDLE=".build/OpenCompanyBridge.app"
MACOS_DIR="$BUNDLE/Contents/MacOS"
BIN="$MACOS_DIR/OpenCompanyBridge"

rm -rf "$BUNDLE"
mkdir -p "$MACOS_DIR"

swiftc -O \
  -framework AppKit \
  -o "$BIN" \
  Sources/BridgeFiles.swift \
  Sources/DaemonController.swift \
  Sources/AppDelegate.swift \
  Sources/main.swift

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>cloud.opencompany.bridge.menubar</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleExecutable</key><string>OpenCompanyBridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

echo "Built $BUNDLE"
