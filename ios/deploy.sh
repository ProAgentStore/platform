#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$PROJECT_DIR/PAGS.xcodeproj"
SCHEME="PAGS"
BUNDLE_ID="online.proagentstore.app"
BUILD_DIR="$PROJECT_DIR/.build"
CONFIGURATION="${CONFIGURATION:-Debug}"

if [ -z "${DEVICE_ID:-}" ]; then
  echo "ERROR: Set DEVICE_ID to a paired iPhone UDID."
  echo "Example: DEVICE_ID=00008130-001C7DD101FA001C ./deploy.sh"
  exit 1
fi

step() { echo "==> $1"; }

step "Building PAGS for device..."
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$BUILD_DIR" \
  -allowProvisioningUpdates \
  build

APP_PATH="$BUILD_DIR/Build/Products/${CONFIGURATION}-iphoneos/PAGS.app"
if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: Expected app bundle not found at $APP_PATH"
  exit 1
fi

step "Installing on device..."
xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH"

step "Launching..."
xcrun devicectl device process launch --device "$DEVICE_ID" --terminate-existing "$BUNDLE_ID"

step "Done. PAGS is running on your iPhone."
