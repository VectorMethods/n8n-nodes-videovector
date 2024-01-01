#!/usr/bin/env python3
"""Immutable npm-only release support, dispatched by Public Repo Bot."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen
import zipfile

REPO = "VectorMethods/n8n-nodes-videovector"
PACKAGE = "@vectormethods/n8n-nodes-videovector"
PREFIX = "videovector-n8n-v"
BUNDLE = Path("release-bundle")
CONTROL = ("release-bundle.zip", "release-manifest.json", "registry-metadata.json")
MAX_BYTES = 256 * 1024 * 1024


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def github(path, *, method="GET", payload=None, content_type="application/json"):
    url = path if path.startswith("https://uploads.github.com/") else f"https://api.github.com/repos/{REPO}/{path}"
    data = json.dumps(payload).encode() if isinstance(payload, dict) else payload
    headers = {"Authorization": f"Bearer {os.environ['GH_TOKEN']}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if data is not None:
        headers["Content-Type"] = content_type
    with urlopen(Request(url, data=data, headers=headers, method=method), timeout=60) as response:
        return json.load(response)


def version():
    tag = os.environ["RELEASE_TAG"]
    assert tag.startswith(PREFIX), "Invalid n8n release tag"
    value = tag[len(PREFIX):]
    assert re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", value), "Invalid semantic version"
    return value


def guard():
    assert os.environ["GITHUB_REPOSITORY"] == REPO
    assert os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch"
    assert os.environ["GITHUB_ACTOR"] == "vectormethods-public-bot[bot]"
    assert os.environ.get("GITHUB_TRIGGERING_ACTOR") == "vectormethods-public-bot[bot]"
    assert os.environ["GITHUB_RUN_ATTEMPT"] == "1", "Dispatch a new bot attempt instead of rerunning"
    tag = os.environ["RELEASE_TAG"]
    target = os.environ["EXPECTED_TARGET_SHA"]
    assert re.fullmatch(r"[0-9a-f]{40}", target)
    assert os.environ["GITHUB_REF"] == f"refs/tags/{tag}"
    assert run("git", "cat-file", "-t", f"refs/tags/{tag}") == "commit"
    assert run("git", "rev-parse", "HEAD") == target
    assert run("git", "rev-parse", f"refs/tags/{tag}") == target
    body_hash = os.environ["RELEASE_BODY_SHA256"]
    assert re.fullmatch(r"[0-9a-f]{64}", body_hash)
    identity = {"body_sha256": body_hash, "repo": REPO.split("/")[1], "tag": tag, "tag_commit_sha": target, "tag_object_sha": target}
    assert sha(canonical(identity)) == os.environ["OPERATION_NONCE"], "Release operation identity differs"
    assert os.environ["DRAFT_RELEASE_ID"].isdigit()
    package = json.loads(Path("package.json").read_text())
    lock = json.loads(Path("package-lock.json").read_text())
    for item in [package, lock, lock["packages"][""]]:
        assert item["name"] == PACKAGE and item["version"] == version()
    release = github(f"releases/{os.environ['DRAFT_RELEASE_ID']}")
    assert release["draft"] and release["tag_name"] == tag
    assert release["author"]["login"] == "vectormethods-public-bot[bot]"
    assert sha((release.get("body") or "").encode()) == body_hash


def verify_bundle():
    manifest = json.loads((BUNDLE / "release-manifest.json").read_bytes())
    metadata_bytes = (BUNDLE / "registry-metadata.json").read_bytes()
    metadata = json.loads(metadata_bytes)
    assert manifest["repository"] == REPO and manifest["package"] == {"name": PACKAGE, "version": version()}
    assert manifest["source_sha"] == os.environ["EXPECTED_TARGET_SHA"] == manifest["tag_sha"]
    assert manifest["tag"] == os.environ["RELEASE_TAG"]
    assert manifest["release_body_sha256"] == os.environ["RELEASE_BODY_SHA256"]
    assert manifest["registry_metadata_sha256"] == sha(metadata_bytes)
    assert manifest["tool_versions"] == {"node": "24.21.0", "npm": "11.15.0"}
    descriptors = manifest["artifacts"]
    assert len(descriptors) == 1
    descriptor = descriptors[0]
    filename = f"vectormethods-n8n-nodes-videovector-{version()}.tgz"
    assert descriptor["path"] == f"npm/{filename}" and descriptor["kind"] == "npm-tarball"
    payload = (BUNDLE / descriptor["path"]).read_bytes()
    expected = metadata["npm"]["tarball"]
    assert 0 < len(payload) <= MAX_BYTES
    assert descriptor["sha256"] == expected["sha256"] == sha(payload)
    assert descriptor["size"] == expected["size"] == len(payload)
    assert expected["sha1"] == hashlib.sha1(payload).hexdigest()
    assert expected["sha512"] == base64.b64encode(hashlib.sha512(payload).digest()).decode()
    return manifest, metadata


def build():
    assert run("node", "--version") == "v24.21.0"
    assert run("npm", "--version") == "11.15.0"
    package = json.loads(Path("package.json").read_text())
    (BUNDLE / "npm").mkdir(parents=True, exist_ok=True)
    packed = json.loads(run("npm", "pack", "--ignore-scripts", "--json", "--pack-destination", str(BUNDLE / "npm")))
    assert len(packed) == 1
    filename = packed[0]["filename"]
    payload = (BUNDLE / "npm" / filename).read_bytes()
    metadata = {"schema_version": "1.0.0", "npm": {key: package[key] for key in ["name", "version", "engines", "n8n"]}}
    metadata["npm"]["tarball"] = {"filename": filename, "sha1": hashlib.sha1(payload).hexdigest(), "sha256": sha(payload), "sha512": base64.b64encode(hashlib.sha512(payload).digest()).decode(), "size": len(payload)}
    metadata_bytes = canonical(metadata)
    (BUNDLE / "registry-metadata.json").write_bytes(metadata_bytes)
    target = os.environ["EXPECTED_TARGET_SHA"]
    epoch = int(run("git", "show", "-s", "--format=%ct", target))
    manifest = {"schema_version": "1.1.0", "repository": REPO, "package": {"name": PACKAGE, "version": version()}, "source_sha": target, "tag_sha": target, "tag": os.environ["RELEASE_TAG"], "source_date_epoch": epoch, "release_body_sha256": os.environ["RELEASE_BODY_SHA256"], "image_digest": None, "registry_metadata_path": "registry-metadata.json", "registry_metadata_sha256": sha(metadata_bytes), "tool_versions": {"node": "24.21.0", "npm": "11.15.0"}, "artifacts": [{"kind": "npm-tarball", "path": f"npm/{filename}", "sha256": sha(payload), "size": len(payload)}]}
    (BUNDLE / "release-manifest.json").write_bytes(canonical(manifest))
    files = ["release-manifest.json", "registry-metadata.json", f"npm/{filename}"]
    stamp = time.gmtime(max(epoch, 315532800))[:6]
    stamp = (*stamp[:5], stamp[5] - stamp[5] % 2)
    with zipfile.ZipFile(BUNDLE / "release-bundle.zip", "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, stamp)
            info.create_system = 3
            info.create_version = info.extract_version = 20
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, (BUNDLE / name).read_bytes())
    verify_bundle()


def restore():
    source = os.environ["BUNDLE_SOURCE_ASSET_ID"]
    assert source.isdigit() and os.environ["BUNDLE_SOURCE_RELEASE_ID"] == os.environ["DRAFT_RELEASE_ID"]
    assets = github(f"releases/{os.environ['DRAFT_RELEASE_ID']}/assets?per_page=100")
    asset = next(item for item in assets if str(item["id"]) == source)
    assert asset["name"] == "release-bundle.zip" and 0 < asset["size"] <= MAX_BYTES
    request = Request(f"https://api.github.com/repos/{REPO}/releases/assets/{source}", headers={"Authorization": f"Bearer {os.environ['GH_TOKEN']}", "Accept": "application/octet-stream"})
    with urlopen(request, timeout=60) as response:
        payload = response.read(MAX_BYTES + 1)
    assert len(payload) <= MAX_BYTES and sha(payload) == os.environ["BUNDLE_SOURCE_SHA256"]
    BUNDLE.mkdir(exist_ok=True)
    (BUNDLE / "release-bundle.zip").write_bytes(payload)
    unpack()


def unpack():
    with zipfile.ZipFile(BUNDLE / "release-bundle.zip") as archive:
        names = [entry.filename for entry in archive.infolist()]
        expected = {"release-manifest.json", "registry-metadata.json", f"npm/vectormethods-n8n-nodes-videovector-{version()}.tgz"}
        assert len(names) == len(expected) and set(names) == expected
        for entry in archive.infolist():
            assert entry.file_size <= MAX_BYTES and entry.compress_type == zipfile.ZIP_STORED
            destination = BUNDLE / entry.filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(entry))
    verify_bundle()


def stage():
    verify_bundle()
    release_id = os.environ["DRAFT_RELEASE_ID"]
    release = github(f"releases/{release_id}")
    assert release["draft"] and release["tag_name"] == os.environ["RELEASE_TAG"]
    assert release["author"]["login"] == "vectormethods-public-bot[bot]"
    assert sha((release.get("body") or "").encode()) == os.environ["RELEASE_BODY_SHA256"]
    assets = github(f"releases/{release_id}/assets?per_page=100")
    for name in CONTROL:
        payload = (BUNDLE / name).read_bytes()
        existing = [item for item in assets if item["name"] == name]
        assert len(existing) <= 1
        if existing:
            assert existing[0]["size"] == len(payload) and existing[0].get("digest") == f"sha256:{sha(payload)}", "Existing immutable asset differs"
            continue
        github(f"https://uploads.github.com/repos/{REPO}/releases/{release_id}/assets?name={quote(name)}", method="POST", payload=payload, content_type="application/octet-stream")


def npm_json(*args, absent_ok=False):
    result = subprocess.run(["npm", *args, "--json"], capture_output=True, text=True)
    if result.returncode:
        if absent_ok and 'E404' in result.stderr:
            return None
        raise RuntimeError("npm registry operation failed")
    return json.loads(result.stdout or "null")


def wait_for_npm_version(package_version):
    # npm acknowledges a new package before its asynchronous processing exposes
    # the version. Only an absent version is retried; auth and registry failures
    # remain explicit, and an expired wait leaves the staged bundle for recovery.
    for attempt in range(120):
        observed = npm_json("view", package_version, absent_ok=True)
        if observed is not None:
            return observed
        if attempt < 119:
            time.sleep(5)
    raise RuntimeError("Published npm version is still processing; recover the staged release after registry visibility")


def semver_key(value):
    core, _, pre = value.partition("-")
    parts = tuple(int(part) for part in core.split("."))
    assert len(parts) == 3
    identifiers = tuple((0, int(part)) if part.isdigit() else (1, part) for part in pre.split(".")) if pre else ()
    return (*parts, 0 if pre else 1, identifiers)


def publish():
    assert run("npm", "--version") == "11.21.0", "Use the reviewed publisher with OIDC dist-tag support"
    manifest, metadata = verify_bundle()
    npm = metadata["npm"]
    wanted = npm["tarball"]
    package_version = f"{PACKAGE}@{version()}"
    temporary = "vv-release-" + sha(version().encode())
    target = "next" if "-" in version() else "latest"
    observed = npm_json("view", package_version, absent_ok=True)
    if observed is None:
        subprocess.run(["npm", "publish", str((BUNDLE / manifest["artifacts"][0]["path"]).resolve()), "--access", "public", "--ignore-scripts", "--provenance", "--tag", temporary], check=True)
        observed = wait_for_npm_version(package_version)
    assert observed["dist"]["integrity"] == f"sha512-{wanted['sha512']}" and observed["dist"]["shasum"] == wanted["sha1"], "Published npm bytes differ"
    for field in ["name", "version", "engines", "n8n"]:
        assert observed[field] == npm[field], "Published npm metadata differs"
    tags = npm_json("view", PACKAGE, "dist-tags")
    current = tags.get(target)
    if current is None or semver_key(current) < semver_key(version()):
        subprocess.run(["npm", "dist-tag", "add", package_version, target], check=True)
    if temporary in tags:
        assert tags[temporary] == version(), "Temporary tag belongs to another version"
        subprocess.run(["npm", "dist-tag", "rm", PACKAGE, temporary], check=True)


if __name__ == "__main__":
    commands = {"guard": guard, "build": build, "verify": verify_bundle, "restore": restore, "unpack": unpack, "stage": stage, "publish": publish}
    commands[sys.argv[1]]()
