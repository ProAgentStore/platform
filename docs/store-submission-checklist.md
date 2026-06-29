# Store Submission Checklist

## Ready
- Native SwiftUI iOS app exists under `platform/ios`.
- Bundle id is `online.proagentstore.app`.
- App icon is present in `Assets.xcassets`.
- Privacy manifest is present at `platform/ios/PAGS/PrivacyInfo.xcprivacy`.
- App Store listing draft is in `platform/docs/app-store-listing.md`.
- Public privacy, terms, and support pages are under `platform/store/app`.
- Codemagic iOS workflows are in `platform/codemagic.yaml`.

## Before TestFlight
- Create the App Store Connect app record.
- Confirm Apple team `55DT52UQXE` is correct for ProAgentStore.
- Set Codemagic `APP_STORE_APP_ID`.
- Add App Store Connect signing integration/profiles for `online.proagentstore.app`.
- Seed a reviewer account and document credentials in App Store Connect, not in git.
- Generate PNG screenshots from `platform/assets/store/*.html`.

## Verification Commands

```bash
cd platform/ios
xcodegen generate
xcodebuild -project PAGS.xcodeproj -scheme PAGS -destination 'generic/platform=iOS Simulator' -derivedDataPath .build build
xcodebuild test -project PAGS.xcodeproj -scheme PAGS -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath .build
xcodebuild analyze -project PAGS.xcodeproj -scheme PAGS -destination 'generic/platform=iOS Simulator' -derivedDataPath .build
rg 'WKWebView|WebView|SFSafariViewController|SafariServices|UIViewRepresentable' PAGS
```

## Android

Android is not scaffolded yet. Do not submit a Play Store listing until a native Android target exists; the user explicitly does not want embedded web.
