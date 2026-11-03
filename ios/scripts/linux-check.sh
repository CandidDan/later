#!/usr/bin/env bash
# linux-check.sh — the Linux half of iOS CI, run by the Flow gate as the `ios/` source root.
#
# Lints every Swift file under ios/, builds and tests LaterKit with coverage, enforces the
# LaterKit floor, and runs the node tests for ios/scripts/. Works on a clean ubuntu-latest and in
# the cloud worker container. Exits non-zero on any failure.
#
# LaterKit is Foundation-only; building it here is what proves that — an Apple-only import
# (SwiftUI, UIKit, AVFoundation, Combine) does not exist on Linux and fails this build.

set -euo pipefail

# The pinned toolchain. The preinstalled swift is used when it is this version; otherwise the
# official swift.org release is downloaded and checked against this hash (taken from a download
# whose swift.org signature verified).
SWIFT_VERSION="6.4.0"
SWIFT_SHA256_UBUNTU2404_X86_64="69f7b2b4dbce6090b6c92194b71149a057e16269093b5a9dded38afc4a05094e"

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(dirname "$SCRIPTS_DIR")"
KIT_DIR="$IOS_DIR/LaterKit"

# "Swift version 6.4 (swift-6.4-RELEASE)" → "6.4.0", so 6.4 and 6.4.0 compare equal.
installed_swift_version() {
  local v
  v="$(swift --version 2>/dev/null | sed -nE 's/.*Swift version ([0-9]+(\.[0-9]+)*).*/\1/p' | head -n1)"
  [[ -n "$v" ]] || return 1
  while [[ "$(tr -cd . <<<"$v" | wc -c)" -lt 2 ]]; do v="$v.0"; done
  echo "$v"
}

ensure_swift() {
  if command -v swift >/dev/null && [[ "$(installed_swift_version || true)" == "$SWIFT_VERSION" ]]; then
    echo "linux-check: using preinstalled Swift $SWIFT_VERSION ($(command -v swift))"
    return 0
  fi
  local os arch
  os="$(. /etc/os-release && echo "${ID}${VERSION_ID}")"
  arch="$(uname -m)"
  if [[ "$os" != "ubuntu24.04" || "$arch" != "x86_64" ]]; then
    echo "linux-check: no pinned Swift $SWIFT_VERSION download for $os/$arch" >&2
    return 1
  fi
  local name="swift-$SWIFT_VERSION-RELEASE-ubuntu24.04"
  local dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/$name"
  if [[ ! -x "$dir/usr/bin/swift" ]]; then
    echo "linux-check: downloading Swift $SWIFT_VERSION"
    mkdir -p "$dir"
    curl -fsSL --retry 3 -o "$dir.tar.gz" \
      "https://download.swift.org/swift-$SWIFT_VERSION-release/ubuntu2404/swift-$SWIFT_VERSION-RELEASE/$name.tar.gz"
    echo "$SWIFT_SHA256_UBUNTU2404_X86_64  $dir.tar.gz" | sha256sum -c -
    tar -xzf "$dir.tar.gz" -C "$dir" --strip-components=1
    rm -f "$dir.tar.gz"
  fi
  export PATH="$dir/usr/bin:$PATH"
  [[ "$(installed_swift_version)" == "$SWIFT_VERSION" ]] || {
    echo "linux-check: downloaded toolchain does not report Swift $SWIFT_VERSION" >&2
    return 1
  }
}

# Every Swift source under ios/, never a build directory.
swift_sources() {
  find "$IOS_DIR" \( -name .build -o -name build -o -name DerivedData -o -name '*.xcodeproj' \) -prune \
    -o -name '*.swift' -type f -print | sort
}

main() {
  ensure_swift
  swift --version

  echo "linux-check: swift format lint"
  local -a sources
  mapfile -t sources < <(swift_sources)
  [[ ${#sources[@]} -gt 0 ]] || { echo "linux-check: no Swift sources found" >&2; return 1; }
  swift format lint --strict --configuration "$IOS_DIR/.swift-format" "${sources[@]}"

  echo "linux-check: LaterKit build + test"
  swift build --package-path "$KIT_DIR"
  swift test --package-path "$KIT_DIR" --enable-code-coverage
  node "$SCRIPTS_DIR/check-coverage.mjs" llvm-cov LaterKit \
    "$(swift test --package-path "$KIT_DIR" --show-codecov-path)"

  echo "linux-check: ios/scripts node tests"
  node --test "$SCRIPTS_DIR/"'*.test.mjs'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
