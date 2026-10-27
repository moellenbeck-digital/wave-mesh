import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent.parent
signing = load("signing", ROOT / "scripts/sign-macos.py")
keychain = load("keychain", ROOT / ".github/scripts/macos-signing-keychain.py")


class SigningTests(unittest.TestCase):
    def test_rejected_submission_keeps_original_archive_and_checksums(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in signing.ARCHIVES:
                with tarfile.open(root / name, "w:gz") as archive:
                    for file in signing.FILES:
                        archive.addfile(tarfile.TarInfo(file), io.BytesIO())
            original = (root / signing.ARCHIVES[0]).read_bytes()
            (root / "SHA256SUMS").write_text("original checksums")
            env = {"MACOS_DEVELOPER_ID": "Developer ID Application: Owner (TEAM)",
                   "MACOS_SIGNING_KEYCHAIN": "temporary.keychain-db", "APPLE_TEAM_ID": "TEAM",
                   "APPLE_API_KEY_PATH": "AuthKey.p8", "APPLE_API_KEY_ID": "KEY",
                   "APPLE_API_ISSUER_ID": "ISSUER"}

            def reject(args):
                if args[:3] == ["xcrun", "notarytool", "submit"]:
                    return b'{"status":"Invalid","id":"rejected"}'
                return b""

            with patch.dict(os.environ, env), patch.object(signing.sys, "platform", "darwin"), \
                    patch.object(signing, "verify"), patch.object(signing, "run", side_effect=reject):
                with self.assertRaisesRegex(RuntimeError, "Notarization not accepted"):
                    signing.sign_archives(root)
            self.assertEqual((root / signing.ARCHIVES[0]).read_bytes(), original)
            self.assertEqual((root / "SHA256SUMS").read_text(), "original checksums")
            self.assertFalse((root / "macos-signing-evidence.json").exists())

    def test_checksums_keep_the_synology_packages_next_to_the_archives(self):
        names = ("wave-darwin-amd64.tar.gz", "wave-darwin-arm64.tar.gz", "wave-linux-amd64.tar.gz",
                 "wave-linux-arm64.tar.gz", "wave-windows-amd64.zip", "wave-windows-arm64.zip")
        packages = ("wave-0.12.0-dsm7-armv8.spk", "wave-0.12.0-dsm7-x86_64.spk")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in names + packages:
                (root / name).write_bytes(name.encode())
            # Not release files, and not to be listed.
            (root / "manifest.json").write_text("{}")
            (root / "wave-0.12.0-dsm7-ppc.spk").write_text("not one of ours")
            listed = [line.split("  ")[1] for line in signing.checksum_listing(root).splitlines()]
            self.assertEqual(listed, list(names + packages))
            self.assertIn(f"{signing.sha256(root / packages[0])}  {packages[0]}", signing.checksum_listing(root))

    def test_checksums_still_need_all_six_archives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "wave-linux-amd64.tar.gz").write_bytes(b"x")
            with self.assertRaisesRegex(RuntimeError, "all six"):
                signing.checksum_listing(root)

    def test_rejects_wrong_team_adhoc_missing_timestamp_and_runtime(self):
        valid = "TeamIdentifier=TEAM\nAuthority=Developer ID Application: Owner (TEAM)\nTimestamp=Oct 5\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=1\n"
        signing.validate_signature(valid, "TEAM")
        for invalid in (valid.replace("TeamIdentifier=TEAM", "TeamIdentifier=OTHER"),
                        valid.replace("Authority=Developer ID Application:", "Signature=adhoc"),
                        valid.replace("Timestamp=Oct 5", "Timestamp="),
                        valid.replace("flags=0x10000(runtime)", "flags=0x0(none)")):
            with self.subTest(invalid=invalid), self.assertRaises(RuntimeError):
                signing.validate_signature(invalid, "TEAM")

    def test_requires_accepted_notarization(self):
        for status in ("Invalid", "Rejected", "In Progress", None):
            with self.subTest(status=status), self.assertRaises(RuntimeError):
                signing.accepted_submission(json.dumps({"status": status, "id": "submission"}))
        with self.assertRaises(RuntimeError):
            signing.accepted_submission('{"status":"Accepted"}')
        self.assertEqual(signing.accepted_submission('{"status":"Accepted","id":"submission"}'), "submission")

    def test_extract_rejects_links_paths_and_duplicates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for attack in ("link", "path", "duplicate"):
                archive = root / f"{attack}.tar.gz"
                with tarfile.open(archive, "w:gz") as target:
                    for name in signing.FILES:
                        member = tarfile.TarInfo(name)
                        if name == "wave" and attack == "link":
                            member.type = tarfile.SYMTYPE
                            member.linkname = "/tmp/wave"
                        if name == "wave" and attack == "path":
                            member.name = "../wave"
                        target.addfile(member, io.BytesIO())
                    if attack == "duplicate":
                        target.addfile(tarfile.TarInfo("wave"), io.BytesIO())
                with self.subTest(attack=attack), self.assertRaises(RuntimeError):
                    signing.extract(archive, root / "output")

    def test_cleanup_removes_credentials_even_if_keychain_delete_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "credentials"
            root.mkdir()
            (root / "original-keychains.json").write_text('["original.keychain-db"]')
            (root / "signing.keychain-db").touch()
            (root / "AuthKey.p8").write_text("private")
            with patch.object(keychain, "run", side_effect=["", RuntimeError("delete failed")]) as run:
                with self.assertRaises(RuntimeError):
                    keychain.cleanup(root)
                self.assertEqual(run.call_args_list[0].args[0],
                                 ["security", "list-keychains", "-d", "user", "-s", "original.keychain-db"])
            self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
