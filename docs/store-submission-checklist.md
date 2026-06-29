# Store Submission Checklist

## Ready
- Native SwiftUI iOS app exists under `platform/ios`.
- Native Android Compose app exists under `platform/android`.
- Bundle id is `online.proagentstore.app`.
- Android package id is `online.proagentstore.app`.
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
- Add GitHub secrets for the manual TestFlight workflow:
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_PRIVATE_KEY`
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

Native Android is scaffolded under `platform/android`; do not use embedded web.

Before Play release:
- Store `android/upload-keystore.jks` outside git and provide it to CI as a secret.
- Configure signing secrets:
  - `PAGS_ANDROID_KEYSTORE_PATH`
  - `PAGS_ANDROID_KEYSTORE_PASSWORD`
  - `PAGS_ANDROID_KEY_ALIAS`
  - `PAGS_ANDROID_KEY_PASSWORD`
- Add or enable the Play deploy workflow/Codemagic workflow.
- Finish Play Console app content, data safety, screenshots, and review notes.

Local verification:

```bash
cd platform/android
./gradlew assembleDebug
```
