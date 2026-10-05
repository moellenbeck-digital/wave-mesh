#!/usr/bin/env bash
set -euo pipefail

# Builds the client for every platform it targets.
#
# One definition of the build, used three ways: CI builds the host binary to
# prove it still compiles, a release builds and packages all six, and anyone
# can run the same thing locally. A second command with flags of its own is
# exactly how the two would drift apart.
#
# Two flags are deliberately absent and have to stay absent. With --minify or
# --sourcemap the binary starts, registers no tray and then hangs silently:
# dbus-next relies on runtime names and module identity that a transformed
# build destroys.

cd "$(dirname "$0")/.."
root="$PWD"
out="$root/dist"

# bun's target name -> the name we publish it under. bun says x64 where this
# project and the docker platforms both say amd64; one vocabulary is worth the
# translation. Windows on arm64 is included because bun can target it -- if a
# future bun drops that, this list is the one place to say so.
TARGETS=(
  "bun-linux-x64:linux-amd64"
  "bun-linux-arm64:linux-arm64"
  "bun-darwin-x64:darwin-amd64"
  "bun-darwin-arm64:darwin-arm64"
  "bun-windows-x64:windows-amd64"
  "bun-windows-arm64:windows-arm64"
)

# The tunnel's dependencies travel in the archive, because the daemon runs as
# root or LocalSystem and sees neither the user's PATH nor their GOPATH -- a
# dependency they installed themselves is one it cannot find. `wave install`
# looks beside the unpacked binary first, which is what these end up as.
#
# Both are pinned rather than tracked: a release has to be the same bytes when
# it is rebuilt, and "@latest" is not a version. To bump, put the new one here
# -- `go list -m -versions golang.zx2c4.com/wireguard` and wintun.net say what
# is on offer.
WIREGUARD_GO_VERSION="v0.0.0-20260522210424-ecfc5a8d5446"
WINTUN_VERSION="0.14.1"
# From wintun.net; checked before the zip is opened, because this is the one
# file here that is downloaded prebuilt rather than compiled from source.
WINTUN_SHA256="07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51"

host=false
package=false
for arg in "$@"; do
  case "$arg" in
    --host) host=true ;;
    --package) package=true ;;
    *)
      echo "usage: $0 [--host] [--package]" >&2
      exit 2
      ;;
  esac
done

# The version goes into the binary, so it can say which one it is -- in `wave
# version`, in the status and to the control server, which offers updates on
# that basis (D13). From the root package.json, which the release workflow has
# already checked against the tag. A host build says "+local": build metadata
# is ignored when versions are compared, so it sits at the release it was built
# from instead of looking older than it (and being "updated" back to it).
version="${WAVE_BUILD_VERSION:-$(bun -e 'console.log(require("./package.json").version)')}"
if $host && [[ -z "${WAVE_BUILD_VERSION:-}" ]]; then version="$version+local"; fi

# x11 is a path inside dbus-next taken only on a machine with an X display and
# no bus address in the environment. Bundling it would make an optional package
# a build dependency of every platform, including the ones with no X at all.
build() { # <bun target, empty for the host> <outfile>
  local target="$1" outfile="$2"
  bun build --compile --external x11 ${target:+--target="$target"} \
    --define "WAVE_BUILD_VERSION=\"$version\"" \
    "$root/apps/client/src/cli.ts" --outfile "$outfile"
}

vendor="$out/vendor"

# A throwaway module, because `go build <module path>` needs one and
# `go install pkg@version` refuses to cross-compile with GOBIN set. Set up
# once; the module cache makes the six builds after it cheap.
prepare_wireguard_go() {
  [[ -f "$vendor/wgsrc/go.sum" ]] && return 0
  mkdir -p "$vendor/wgsrc"
  cat > "$vendor/wgsrc/go.mod" <<EOF
module wave-mesh/wireguard-go-build

go 1.23
EOF
  (cd "$vendor/wgsrc" && GOFLAGS=-mod=mod go get "golang.zx2c4.com/wireguard@$WIREGUARD_GO_VERSION")
}

build_wireguard_go() { # <goos> <goarch> <outfile>
  local goos="$1" goarch="$2" outfile="$3"
  prepare_wireguard_go
  # CGO off on purpose: it is what lets one runner produce all six, and
  # wireguard-go needs no C on any of them.
  (cd "$vendor/wgsrc" && GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
    go build -trimpath -o "$outfile" golang.zx2c4.com/wireguard)
}

# Prepares the module itself rather than assuming someone already built: the
# licence lives in the module cache, and on a fresh runner nothing has put it
# there yet. Getting this order wrong only fails on a cold machine.
wireguard_go_license() {
  prepare_wireguard_go >&2
  echo "$(go env GOMODCACHE)/golang.zx2c4.com/wireguard@$WIREGUARD_GO_VERSION/LICENSE"
}

# Wintun ships as signed prebuilt DLLs and says so: they are "the only
# supported way of distributing Wintun". Its licence forbids redistribution
# except alongside software that uses it through the documented API, which is
# what wireguard-go does -- and it forbids dropping the notice, so LICENSE.txt
# goes into the archive with the DLL.
fetch_wintun() {
  [[ -d "$vendor/wintun/bin" ]] && return 0
  mkdir -p "$vendor"
  local zip="$vendor/wintun-$WINTUN_VERSION.zip"
  [[ -f "$zip" ]] || curl -sSLf -o "$zip" "https://www.wintun.net/builds/wintun-$WINTUN_VERSION.zip"
  local got
  # sha256sum on the runner, shasum where coreutils is not the default.
  if command -v sha256sum > /dev/null; then
    got="$(sha256sum "$zip" | cut -d' ' -f1)"
  else
    got="$(shasum -a 256 "$zip" | cut -d' ' -f1)"
  fi
  if [[ "$got" != "$WINTUN_SHA256" ]]; then
    echo "wintun-$WINTUN_VERSION.zip is not what we pinned:" >&2
    echo "  expected $WINTUN_SHA256" >&2
    echo "  got      $got" >&2
    exit 1
  fi
  (cd "$vendor" && rm -rf wintun && unzip -q "$zip")
}

mkdir -p "$out"

if $host; then
  build "" "$out/wave"
  echo "dist/wave"
  exit 0
fi

archives=()
for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  name="wave-${entry##*:}"
  exe=""
  if [[ "$target" == *windows* ]]; then exe=".exe"; fi

  build "$target" "$out/$name$exe"
  echo "dist/$name$exe"

  $package || continue

  # "linux-amd64" is both halves of what Go wants to be told.
  pair="${entry##*:}"
  goos="${pair%%-*}"
  goarch="${pair##*-}"

  # What comes out of the archive is called `wave`, not `wave-linux-amd64`:
  # the platform is on the file you downloaded, not on the command you run.
  stage="$(mktemp -d)"
  cp "$out/$name$exe" "$stage/wave$exe"
  cp "$root/LICENSE" "$stage/LICENSE"
  cp "$(wireguard_go_license)" "$stage/LICENSE.wireguard-go"
  contents=("wave$exe" LICENSE LICENSE.wireguard-go)

  # The file names are the ones `wave install` looks for beside itself; see
  # binaryNames and WINTUN_DLL in apps/client/src/wireguard-go.ts.
  if [[ -n "$exe" ]]; then
    build_wireguard_go "$goos" "$goarch" "$stage/wireguard.exe"
    fetch_wintun
    cp "$vendor/wintun/bin/$goarch/wintun.dll" "$stage/wintun.dll"
    cp "$vendor/wintun/LICENSE.txt" "$stage/LICENSE.wintun"
    contents+=(wireguard.exe wintun.dll LICENSE.wintun)
    (cd "$stage" && zip -q "$out/$name.zip" "${contents[@]}")
    archives+=("$name.zip")
  else
    build_wireguard_go "$goos" "$goarch" "$stage/wireguard-go"
    contents+=(wireguard-go)
    # macOS otherwise adds AppleDouble files that the updater does not need.
    COPYFILE_DISABLE=1 tar -czf "$out/$name.tar.gz" -C "$stage" "${contents[@]}"
    archives+=("$name.tar.gz")
  fi
  rm -rf "$stage"
done

if $package; then
  # Relative names, so the file verifies from wherever it was downloaded to.
  (cd "$out" && shasum -a 256 "${archives[@]}" > SHA256SUMS)
  echo "dist/SHA256SUMS"
fi
