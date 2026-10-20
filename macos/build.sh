#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
mkdir -p build Assets
swift Tools/make-icon.swift ../identity/iconography/demon-tesla-appicon-v1.png build/DemonTesla.iconset
iconutil -c icns build/DemonTesla.iconset -o Assets/DemonTesla.icns
xcodegen generate
xcodebuild -project SIDemonMac.xcodeproj -scheme SIDemonMac \
  -configuration Release -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath build -allowProvisioningUpdates build
codesign --verify --deep --strict 'build/Build/Products/Release/SI-DEMON-TV Mac.app'
ditto -c -k --sequesterRsrc --keepParent \
  'build/Build/Products/Release/SI-DEMON-TV Mac.app' 'build/SI-DEMON-TV-Mac.zip'
