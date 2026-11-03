#!/usr/bin/env bash
# macos-ci.sh — the macOS half of iOS CI, run by .github/workflows/ios-ci.yml.
#
# Generates the Xcode project, builds the app and its tests for the iOS Simulator with signing
# disabled, runs the unit and UI tests on a simulator this machine actually has, and enforces the
# app's coverage floor. No Apple account, no signing, no secrets. Exits non-zero on any failure.
#
#   IOS_CI_CHANGED_FILES=<file listing changed paths>  skip (exit 0) when none is iOS-relevant
#   IOS_CI_OUTPUT=<dir>                                where the .xcresult lands (ios/build)
#
# The remaining IOS_CI_* variables exist so ios/scripts/macos-ci.test.mjs can run this script
# with stubbed tools on Linux; CI never sets them.

set -euo pipefail

XCODE_VERSION="26.6"
XCODEGEN_VERSION="2.46.0"
XCODEGEN_SHA256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(dirname "$SCRIPTS_DIR")"

# Succeeds when any path read from stdin (one per line, repo-relative) is under ios/ or is the
# workflow that runs this script. Anything else cannot change what ios-ci would build.
ios_ci_relevant() {
  local path
  while IFS= read -r path || [[ -n "$path" ]]; do
    case "$path" in
      ios/* | .github/workflows/ios-ci.yml) return 0 ;;
    esac
  done
  return 1
}

select_xcode() {
  local app="${IOS_CI_XCODE_APP:-/Applications/Xcode_${XCODE_VERSION}.app}"
  if [[ ! -d "$app" ]]; then
    echo "ios-ci: Xcode $XCODE_VERSION not found at $app; installed:" >&2
    ls -d /Applications/Xcode*.app >&2 2>/dev/null || true
    return 1
  fi
  export DEVELOPER_DIR="$app/Contents/Developer"
  xcodebuild -version
}

# A verified download of the pinned XcodeGen release, never an unpinned `brew install`.
install_xcodegen() {
  if [[ -n "${IOS_CI_XCODEGEN:-}" ]]; then
    XCODEGEN="$IOS_CI_XCODEGEN"
    return 0
  fi
  local dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/xcodegen-$XCODEGEN_VERSION"
  local zip="$dir/xcodegen.zip"
  mkdir -p "$dir"
  curl -fsSL --retry 3 -o "$zip" \
    "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip"
  echo "$XCODEGEN_SHA256  $zip" | shasum -a 256 -c -
  unzip -q -o "$zip" -d "$dir"
  XCODEGEN="$dir/xcodegen/bin/xcodegen"
  "$XCODEGEN" --version
}

main() {
  if [[ -n "${IOS_CI_CHANGED_FILES:-}" ]] && ! ios_ci_relevant <"$IOS_CI_CHANGED_FILES"; then
    echo "ios-ci: skipped — this change touches nothing under ios/ or .github/workflows/ios-ci.yml"
    return 0
  fi

  local out="${IOS_CI_OUTPUT:-$IOS_DIR/build}"
  local result="$out/Later.xcresult"
  mkdir -p "$out"
  rm -rf "$result"

  select_xcode
  install_xcodegen
  "$XCODEGEN" generate --spec "$IOS_DIR/project.yml" --project "$IOS_DIR"

  local sdk udid
  sdk="$(xcrun --sdk iphonesimulator --show-sdk-version)"
  xcrun simctl list devices available --json >"$out/simulators.json"
  udid="$(node "$SCRIPTS_DIR/pick-simulator.mjs" --max-version "$sdk" <"$out/simulators.json")"

  local -a xcodebuild_args=(
    -project "$IOS_DIR/Later.xcodeproj"
    -scheme Later
    -destination "platform=iOS Simulator,id=$udid"
    -derivedDataPath "$out/DerivedData"
    -enableCodeCoverage YES
    CODE_SIGNING_ALLOWED=NO
  )
  xcodebuild build-for-testing "${xcodebuild_args[@]}"
  xcodebuild test-without-building "${xcodebuild_args[@]}" -resultBundlePath "$result"

  xcrun xccov view --report --json "$result" >"$out/coverage.json"
  node "$SCRIPTS_DIR/check-coverage.mjs" xccov Later "$out/coverage.json"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
