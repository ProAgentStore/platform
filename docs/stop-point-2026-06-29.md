> **Historical planning doc — superseded; see the internal KB `docs/stores/pags.md` for the shipped state.**

# PAGS Stop Point - 2026-06-29

## Current State

- Branch: `main`
- Remote: `origin/main`
- Native iOS app exists under `ios/`.
- Native Android app exists under `android/`.
- No embedded web wrapper is used for the native apps.
- Console/API custom surface support is in place, including the demo Notes surface.
- Repo indexing has been hardened for multi-repo state, stale memory cleanup, and inline failed-file reporting.
- Browser runner handoff handling now avoids false submit/resume states when a live takeover session is missing.
- Job-apply now rejects concurrent active applications on the same instance because the runner drives one browser page.

## Latest Known Good Checks

- GitHub CI passed for latest pushed app/API/console changes.
- GitHub API and host deploy workflows passed for the latest relevant pushes.
- Local `pnpm -r typecheck` passed.
- Local Android debug build passed with:

```bash
cd android
./gradlew assembleDebug
```

- Local iOS validation previously passed:

```bash
cd ios
xcodebuild test -project PAGS.xcodeproj -scheme PAGS -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath .build/test COMPILER_INDEX_STORE_ENABLE=NO
xcodebuild analyze -project PAGS.xcodeproj -scheme PAGS -destination 'generic/platform=iOS Simulator' -derivedDataPath .build/analyze COMPILER_INDEX_STORE_ENABLE=NO
```

## CI/CD

### iOS

- `codemagic.yaml` contains `ios-release` and push-triggered `ios-testflight`.
- GitHub Actions contains manual `Deploy to TestFlight`.
- The manual GitHub TestFlight workflow is blocked until these repo secrets are configured:
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_PRIVATE_KEY`
- Codemagic requires the `Codemagic CI` App Store Connect integration and signing profiles for `online.proagentstore.app`.

### Android

- Android source, Gradle wrapper, launcher assets, and native Compose UI are committed.
- `android/upload-keystore.jks` is intentionally ignored and must remain outside git.
- Play deploy automation still needs CI secret wiring for signing and Google Play upload credentials.

## Store Submission Blockers

- App Store Connect secrets/profiles must be configured.
- Google Play signing/deploy credentials must be moved into CI secrets.
- App Store and Play reviewer credentials must be entered in the store consoles, not in git.
- Play Console app content/data safety still needs final review.
- App screenshots/listing metadata should be reviewed against `docs/app-store-listing.md` and `assets/store/`.

## Resume Order

1. Configure the three App Store Connect GitHub secrets and rerun `Deploy to TestFlight`.
2. Confirm Codemagic is connected and that `ios-testflight` runs on pushes to `main`.
3. Add Android Play deploy automation using CI secrets for the keystore and Play credentials.
4. Complete App Store and Play Console submission forms.
5. Run a native app QA pass: auth, agents, chat, board, coder, settings, custom surfaces, repo indexing.

## Local Artifacts Intentionally Not Committed

- `android/upload-keystore.jks`
- `android/.gradle/`
- `android/app/build/`
- `ios/.build/`
