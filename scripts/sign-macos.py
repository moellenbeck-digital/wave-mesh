"""Sign and notarize release binaries before the updater manifest is hashed."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tarfile
import tempfile


FILES = ("wave", "wireguard-go", "LICENSE", "LICENSE.wireguard-go")
ARCHIVES = ("wave-darwin-amd64.tar.gz", "wave-darwin-arm64.tar.gz")


def run(args):
    result = subprocess.run([str(arg) for arg in args], capture_output=True,
                            env={**os.environ, "COPYFILE_DISABLE": "1"})
    if result.returncode:
        # Never include credential arguments in diagnostics.
        detail = result.stderr.decode(errors="replace").strip()
        for name, value in os.environ.items():
            if name.startswith(("APPLE_", "MACOS_", "OP_")) and value:
                detail = detail.replace(value, "[REDACTED]")
        raise RuntimeError(f"{args[0]} {args[1]} failed (exit {result.returncode}): {detail}")
    return result.stdout


def validate_signature(details, team):
    if (f"TeamIdentifier={team}" not in details.splitlines()
            or "Authority=Developer ID Application:" not in details
            or not re.search(r"^Timestamp=.+", details, re.M)
            or not re.search(r"^CodeDirectory .*flags=.*\bruntime\b", details, re.M)):
        raise RuntimeError("Expected timestamped Developer ID signature with Hardened Runtime and release team")


def verify(binary, team, jit):
    run(["codesign", "--verify", "--strict", "--verbose=2", binary])
    result = subprocess.run(["codesign", "-dv", "--verbose=4", str(binary)], capture_output=True)
    if result.returncode:
        raise RuntimeError("Cannot inspect code signature")
    validate_signature(result.stderr.decode(), team)
    xml = run(["codesign", "-d", "--entitlements", ":-", binary])
    entitlements = plistlib.loads(xml) if xml.strip() else {}
    expected = {"com.apple.security.cs.allow-jit": True} if jit else {}
    if entitlements != expected:
        raise RuntimeError("Unexpected release entitlements")


def extract(archive, destination):
    # Release archives contain only four regular files, never links or paths.
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if (sorted(member.name for member in members) != sorted(FILES)
                or any(not member.isfile() for member in members)):
            raise RuntimeError("Unexpected macOS archive contents")
        source.extractall(destination, members=members, filter="data")


def accepted_submission(output):
    result = json.loads(output)
    if result.get("status") != "Accepted" or not result.get("id"):
        raise RuntimeError(f"Notarization not accepted: {result.get('status')} (submission {result.get('id')})")
    return result["id"]


def sha256(path):
    with path.open("rb") as source:
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


# The Synology packages are built before this step and are not signed by it, but
# they belong in the same SHA256SUMS: this file is rewritten here after the macOS
# archives changed, and a rewrite that only knew the six archives would drop them.
DSM_PACKAGE = re.compile(r"wave-\d+\.\d+\.\d+(-(insiders|develop)\.\d+)?-dsm7-(x86_64|armv8)\.spk")


def checksum_listing(dist):
    archives = sorted(path for path in dist.iterdir()
                      if re.fullmatch(r"wave-(linux|darwin|windows)-(amd64|arm64)\.(tar\.gz|zip)", path.name))
    if len(archives) != 6:
        raise RuntimeError("Expected all six release archives")
    packages = sorted(path for path in dist.iterdir() if DSM_PACKAGE.fullmatch(path.name))
    return "".join(f"{sha256(path)}  {path.name}\n" for path in archives + packages)


def sign_archives(dist):
    if sys.platform != "darwin":
        raise RuntimeError("Apple signing requires macOS")
    required = ("MACOS_DEVELOPER_ID", "MACOS_SIGNING_KEYCHAIN", "APPLE_TEAM_ID",
                "APPLE_API_KEY_PATH", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID")
    for name in required:
        if not os.environ.get(name):
            raise RuntimeError(f"Missing {name}")
    team = os.environ["APPLE_TEAM_ID"]
    identity = os.environ["MACOS_DEVELOPER_ID"]
    if not identity.startswith("Developer ID Application: ") or not identity.endswith(f"({team})"):
        raise RuntimeError("Signing identity does not match release team")
    for name in ARCHIVES:
        if not (dist / name).is_file():
            raise RuntimeError(f"Missing {name}")
    evidence = []
    for name in ARCHIVES:
        with tempfile.TemporaryDirectory(prefix="wave-notary-") as temporary:
            root = Path(temporary)
            stage = root / "payload"
            stage.mkdir()
            extract(dist / name, stage)
            entitlements = root / "entitlements.plist"
            entitlements.write_bytes(plistlib.dumps({"com.apple.security.cs.allow-jit": True}))
            for binary in ("wave", "wireguard-go"):
                args = ["codesign", "--force", "--sign", identity, "--keychain",
                        os.environ["MACOS_SIGNING_KEYCHAIN"], "--timestamp", "--options", "runtime",
                        "--identifier", f"org.wavecenter.{binary}"]
                if binary == "wave":
                    args += ["--entitlements", entitlements]
                run([*args, stage / binary])
                verify(stage / binary, team, binary == "wave")
            upload = root / "notarization.zip"
            run(["ditto", "-c", "-k", stage, upload])
            # Submit once. A timeout fails the release rather than submitting again.
            submission = accepted_submission(run([
                "xcrun", "notarytool", "submit", upload,
                "--key", os.environ["APPLE_API_KEY_PATH"],
                "--key-id", os.environ["APPLE_API_KEY_ID"],
                "--issuer", os.environ["APPLE_API_ISSUER_ID"],
                "--wait", "--timeout", "30m", "--output-format", "json",
            ]))
            candidate = root / name
            run(["tar", "-czf", candidate, "-C", stage, *FILES])
            unpacked = root / "verify"
            unpacked.mkdir()
            extract(candidate, unpacked)
            for binary in ("wave", "wireguard-go"):
                if sha256(unpacked / binary) != sha256(stage / binary):
                    raise RuntimeError("Packaged binary differs from notarized binary")
                verify(unpacked / binary, team, binary == "wave")
                run(["codesign", "--verify", "--strict", "--check-notarization", unpacked / binary])
            # Replace only after the exact distributable passes every check.
            (dist / name).write_bytes(candidate.read_bytes())
            evidence.append({"archive": name, "sha256": sha256(dist / name),
                             "submissionId": submission, "status": "Accepted"})
            print(f"{name}: signed, notarized and verified ({submission})", flush=True)
    (dist / "SHA256SUMS").write_text(checksum_listing(dist))
    report = {"teamId": team, "gitSha": run(["git", "rev-parse", "HEAD"]).decode().strip(),
              "workingTreeDirty": bool(run(["git", "status", "--porcelain"]).strip()),
              "version": json.loads(Path("package.json").read_text())["version"],
              "stapling": "Standalone binaries do not support stapling; Gatekeeper requires online ticket lookup.",
              "archives": evidence}
    (dist / "macos-signing-evidence.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    try:
        sign_archives(Path(sys.argv[1] if len(sys.argv) > 1 else "dist").resolve())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
