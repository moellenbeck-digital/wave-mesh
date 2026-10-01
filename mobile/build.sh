#!/usr/bin/env bash
set -euo pipefail

# Binds the Go core for the phones.
#
# One definition of the build, used both ways: `./build.sh ios` produces the
# xcframework the Xcode project links, `./build.sh android` the .aar Gradle
# consumes, and `./build.sh check` does neither -- it only proves the core still
# compiles and passes its tests, which is the part that works on any machine.
#
# Neither artefact is in the repo. They are 30 MB of compiled Go each and both
# are reproducible from the source beside them; what is pinned is the input, in
# core/go.mod.

cd "$(dirname "$0")"
root="$PWD"
core="$root/core"

# gomobile is pinned in core/go.mod, as a tool dependency rather than a version
# repeated here. A build has to produce the same bytes when it is repeated, and
# "@latest" is not a version; a number in this file as well would be a second
# place to forget. `go list -m -versions golang.org/x/mobile` says what is on
# offer, and `go get -tool golang.org/x/mobile/cmd/gomobile@<version>` moves it.
#
# A tool dependency is not compiled into the binding -- nothing in wavemobile
# imports it -- so this does not put x/mobile on the phones.

usage() {
  echo "usage: $0 <ios|android|check|clean>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage

have() { command -v "$1" >/dev/null 2>&1; }

require_go() {
  if ! have go; then
    echo "no go toolchain on PATH. The core is Go; there is no way round it." >&2
    echo "  https://go.dev/dl/ , or your package manager" >&2
    exit 1
  fi
}

# `gomobile bind` shells out to a `gobind` binary it expects on PATH, so both
# are built out of the module -- at the version go.mod pins -- and put where it
# will find them.
install_gomobile() {
  local bin="$root/.tools/bin"
  mkdir -p "$bin"
  ( cd "$core" && GOBIN="$bin" go build -o "$bin/gomobile" golang.org/x/mobile/cmd/gomobile )
  ( cd "$core" && GOBIN="$bin" go build -o "$bin/gobind" golang.org/x/mobile/cmd/gobind )
  export PATH="$bin:$PATH"
  # gomobile keeps a toolchain cache of its own; init is idempotent and quick
  # once it has one.
  gomobile init
}

case "$1" in
  check)
    require_go
    # Everything that can be checked without a phone, which is deliberately
    # almost everything: the platform hosts are thin because this is where the
    # work is.
    # -race because the core is almost entirely concurrent -- read loops,
    # queues, timers -- and a race there does not crash, it makes a tunnel go
    # quiet now and then, which is the hardest kind of report to act on.
    ( cd "$core" && gofmt -l . && go vet ./... && go test -race ./... )
    # And that the surface still binds. gobind is the type checker for the
    # boundary: a parameter gomobile cannot carry is an error here rather than
    # a mystery in Xcode, and this is the only part of the phone side that can
    # be checked on a machine that is not one.
    ( cd "$core" && go tool gobind -lang=go,java,objc -outdir="$(mktemp -d)" \
        github.com/moellenbeck-digital/wave-mesh/mobile/core/wavemobile )
    echo "core ok"
    ;;

  ios)
    require_go
    if [[ "$(uname -s)" != "Darwin" ]]; then
      echo "an xcframework can only be built on macOS: gomobile needs Xcode's clang and SDKs." >&2
      exit 1
    fi
    have xcrun || { echo "no xcode command line tools" >&2; exit 1; }
    install_gomobile
    mkdir -p "$root/ios/Frameworks"
    # Both the device and the simulator, in one xcframework: a project that
    # links only the device slice cannot be run on a simulator at all, and that
    # is where most of the work happens.
    ( cd "$core" && gomobile bind \
        -target=ios,iossimulator \
        -iosversion=15.0 \
        -o "$root/ios/Frameworks/Wavemobile.xcframework" \
        ./wavemobile )
    echo "built ios/Frameworks/Wavemobile.xcframework"
    ;;

  android)
    require_go
    if [[ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ]]; then
      echo "ANDROID_HOME is not set; gomobile needs the SDK and the NDK." >&2
      exit 1
    fi
    install_gomobile
    mkdir -p "$root/android/app/libs"
    # All four ABIs. gomobile puts them in one .aar, and Gradle picks per
    # device -- there is no second artefact to keep in step.
    ( cd "$core" && gomobile bind \
        -target=android/arm64,android/arm,android/amd64,android/386 \
        -androidapi 29 \
        -o "$root/android/app/libs/wavemobile.aar" \
        ./wavemobile )
    echo "built android/app/libs/wavemobile.aar"
    ;;

  clean)
    rm -rf "$root/.tools" "$root/ios/Frameworks" "$root/android/app/libs"
    echo "cleaned"
    ;;

  *)
    usage
    ;;
esac
