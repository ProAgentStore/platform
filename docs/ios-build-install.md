# iOS Build, Install & Debug

## Golden Rule

Always use `-derivedDataPath .build` so there is one exact path to the binary.

## Commands

```bash
cd platform/ios

# Regenerate the project after changing project.yml
xcodegen generate

# Build for simulator
xcodebuild -project PAGS.xcodeproj -scheme PAGS \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build \
  build

# Run unit tests
xcodebuild test -project PAGS.xcodeproj -scheme PAGS \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -derivedDataPath .build

# Static analyzer
xcodebuild analyze -project PAGS.xcodeproj -scheme PAGS \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build

# Build and install on a paired iPhone
DEVICE_ID=00008130-001C7DD101FA001C ./deploy.sh

# Launch with device console logs
xcrun devicectl device process launch \
  --device 00008130-001C7DD101FA001C \
  --terminate-existing --console online.proagentstore.app
```

## App Store Archive

```bash
cd platform/ios
xcodegen generate
xcodebuild archive \
  -project PAGS.xcodeproj \
  -scheme PAGS \
  -destination 'generic/platform=iOS' \
  -archivePath .build/PAGS.xcarchive \
  -allowProvisioningUpdates

xcodebuild -exportArchive \
  -archivePath .build/PAGS.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath .build/export \
  -allowProvisioningUpdates
```

Codemagic uses `platform/codemagic.yaml`. Set `APP_STORE_APP_ID` once the App Store Connect app record exists; until then it falls back to the Codemagic build number.

## Native-Only Guard

PAGS must not ship a web wrapper. Before submission, keep this check clean:

```bash
rg 'WKWebView|WebView|SFSafariViewController|SafariServices|UIViewRepresentable' platform/ios/PAGS
```
