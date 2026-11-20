#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# ruff: noqa: E501, S603, S607  (Markdown table rows and a fixed uv/python invocation)
"""Regenerate THIRD-PARTY-NOTICES.md from what Trio actually ships.

What ships, and where the list comes from:

* the web client bundle (served by the server, loaded by browsers and by the
  desktop app): the production dependencies in web/package-lock.json;
* the desktop installer: the production dependencies in
  desktop/package-lock.json, plus Electron itself (a dev dependency in the
  lock, but its runtime is what electron-builder packs);
* the server image: every package pinned in server/requirements.lock except
  the build backend (requirements-build.in).

Licence texts are read from the installed packages, so before running:

    (cd web && npm ci) && (cd desktop && npm ci)

The server packages are installed from the lock into a throwaway Python 3.12
virtualenv with uv (network needed), or pass --server-python PATH for an
interpreter that already has exactly the lock installed.

    python3 scripts/third-party-notices.py            # rewrite the file
    python3 scripts/third-party-notices.py --check    # exit 1 if it is stale

The script fails when an installed package's version differs from its lock,
so the file always describes the locked versions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "THIRD-PARTY-NOTICES.md"

# Licences that need nothing beyond keeping the notice (permissive, OSI
# approved). Anything else is listed under "Needs attention".
PERMISSIVE = {
    "MIT",
    "MIT-0",
    "ISC",
    "0BSD",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "BlueOak-1.0.0",
    "Python-2.0",
    "PSF-2.0",
    "Unlicense",
}

# Facts about what ships that no lock file can tell. Kept here, in one place,
# so a regeneration cannot drop them. Keyed by package name.
NOTES: dict[str, str] = {
    "uiohook-napi": (
        "The package's own code is MIT, but its prebuilt native module "
        "(`prebuilds/*/uiohook_napi.node`, unpacked next to app.asar in the "
        "installer) statically contains **libuiohook** by Alexander Barker, "
        "licensed **LGPL-3.0-or-later** (see the headers in "
        "`node_modules/uiohook-napi/libuiohook/src`; the package ships no "
        "LGPL text, so `licenses/LGPL-3.0.txt` and `licenses/GPL-3.0.txt` are "
        "reproduced below). LGPL is compatible with "
        "shipping it inside an MIT application: the library stays a separate, "
        "replaceable file, its source is public "
        "(https://github.com/kwhat/libuiohook, and in the npm package), and "
        "this notice and the licence text travel with the installer. Trio "
        "does not modify it and never signs that file as its own."
    ),
    "electron": (
        "Electron is MIT. Its runtime bundles Chromium, Node.js, FFmpeg and "
        "many other components under their own licences (BSD, LGPL-2.1 for "
        "FFmpeg, MPL, …). electron-builder copies Electron's `LICENSE` "
        "(as `LICENSE.electron.txt`) and `LICENSES.chromium.html` into every "
        "installed app; that file is the authoritative list for the runtime."
    ),
    "@sapphi-red/web-noise-suppressor": (
        "MIT. Trio loads only its RNNoise build (`rnnoise.wasm`, "
        "`rnnoise_simd.wasm`), compiled from xiph/rnnoise (BSD-3-Clause) via "
        "shiguredo/rnnoise-wasm; the package ships no separate RNNoise "
        "licence file, so the RNNoise notice is reproduced below."
    ),
    "certifi": (
        "MPL-2.0 (file-level copyleft). Shipped unmodified inside the server "
        "image; MPL only asks that the source of the covered files stays "
        "available, which PyPI provides. Compatible with MIT."
    ),
    "argparse": (
        "Python-2.0 (the PSF licence; permissive, OSI approved). A dependency "
        "of js-yaml inside electron-updater."
    ),
}

# Licence texts a package relies on but does not ship.
EXTRA_TEXTS = {
    "uiohook-napi": [
        ("libuiohook: GNU Lesser General Public License v3", "licenses/LGPL-3.0.txt"),
        (
            "libuiohook: GNU General Public License v3 (which the LGPL extends)",
            "licenses/GPL-3.0.txt",
        ),
    ],
    # The text of xiph/rnnoise's COPYING (current upstream, which lists every
    # holder of the older revisions too).
    "@sapphi-red/web-noise-suppressor": [
        ("RNNoise (xiph/rnnoise), BSD-3-Clause", "licenses/rnnoise-BSD-3-Clause.txt"),
    ],
}


# Assets in this repository that are not code dependencies.
ASSETS = """\
| what | where | status |
|---|---|---|
| Brand artwork: app and tray icons, favicon, web manifest icons, join and empty-state illustrations, the Open Graph image, logo concepts, mockups | `desktop/build/`, `desktop/assets/`, `web/public/` (`icon-*.png`, `favicon.*`, `apple-touch-icon.png`, `art/`, `og/`), `design/` | Owner-supplied: generated with an image model for the project owner from `design/CODEX-BRIEF.md`, then resized by `design/tools/`. No third-party licence; part of this repository under its MIT licence. Screenshots in `design/screens/` show Trio's own UI. |
| Fonts | none bundled | The UI names Inter and the system UI fonts in CSS (`web/src/theme.css`), but no font file is shipped: the browser uses an installed copy or falls back to the system font. |
| Sounds | none bundled | Ring and notification sounds are synthesised in code (Web Audio). |
| Server base image | `Dockerfile` (`python:3.12-slim`, `node:22-alpine` for the build stage) | Debian / Alpine packages under their own licences; the image is built and run by the owner (Railway) and is not distributed as a file. |
"""

LICENSE_FILE = re.compile(r"^(licen[cs]e|copying|notice)([.-].*)?$", re.I)


@dataclass
class Package:
    name: str
    version: str
    license: str
    url: str
    texts: list[tuple[str, str]] = field(default_factory=list)  # (title, text)


def npm_packages(directory: str, include_dev: set[str]) -> list[Package]:
    base = ROOT / directory
    lock = json.loads((base / "package-lock.json").read_text(encoding="utf-8"))
    result = []
    for key, meta in sorted(lock["packages"].items()):
        if not key:
            continue
        name = key.split("node_modules/")[-1]
        if (meta.get("dev") or meta.get("devOptional")) and name not in include_dev:
            continue
        pkg_dir = base / key
        pkg_json = pkg_dir / "package.json"
        if not pkg_json.is_file():
            sys.exit(f"{directory}: {name} is not installed; run `npm ci` in {directory}/ first")
        installed = json.loads(pkg_json.read_text(encoding="utf-8"))
        if installed.get("version") != meta.get("version"):
            sys.exit(
                f"{directory}: {name} is {installed.get('version')} on disk but "
                f"{meta.get('version')} in the lock; run `npm ci` in {directory}/"
            )
        repo = installed.get("repository")
        if isinstance(repo, dict):
            repo = repo.get("url")
        url = normalise_url(
            repo or installed.get("homepage") or f"https://www.npmjs.com/package/{name}"
        )
        texts = []
        for f in sorted(pkg_dir.iterdir(), key=lambda p: p.name.lower()):
            if f.is_file() and LICENSE_FILE.match(f.name):
                texts.append((f.name, f.read_text(encoding="utf-8", errors="replace")))
        result.append(Package(name, meta["version"], meta.get("license") or "UNKNOWN", url, texts))
    return result


def normalise_url(url: str) -> str:
    url = re.sub(r"^git\+", "", url)
    url = re.sub(r"^git://", "https://", url)
    url = re.sub(r"^git@github\.com:", "https://github.com/", url)
    url = re.sub(r"^ssh://git@github\.com/", "https://github.com/", url)
    url = re.sub(r"\.git$", "", url)
    if re.fullmatch(r"[\w.-]+/[\w.-]+", url):
        url = f"https://github.com/{url}"
    return url


DUMP = r"""
import importlib.metadata as m, json, sys
names = json.loads(sys.argv[1])
out = []
for name in names:
    d = m.distribution(name)
    md = d.metadata
    classifiers = [c.split(" :: ")[-1] for c in (md.get_all("Classifier") or []) if c.startswith("License ::")]
    texts = []
    for f in sorted(d.files or [], key=str):
        p = str(f)
        if ".dist-info/" in p and "/licenses/" in p or (".dist-info/" in p and p.rsplit("/", 1)[-1].upper().startswith(("LICEN", "COPYING", "NOTICE"))):
            texts.append((p.split(".dist-info/", 1)[1], f.read_text()))
    urls = md.get_all("Project-URL") or []
    home = md.get("Home-page") or ""
    for u in urls:
        label, _, link = u.partition(",")
        if label.strip().lower() in ("source", "source code", "repository", "homepage", "home", "code"):
            home = home or link.strip()
    if not home and urls:
        home = urls[0].partition(",")[2].strip()
    out.append({"name": md["Name"], "version": md["Version"], "expr": md.get("License-Expression"),
                "license": md.get("License") or "", "classifiers": classifiers,
                "url": home or f"https://pypi.org/project/{md['Name']}/", "texts": texts})
print(json.dumps(out))
"""

CLASSIFIER_SPDX = {
    "MIT License": "MIT",
    "BSD License": "BSD-3-Clause",
    "Apache Software License": "Apache-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "ISC License (ISCL)": "ISC",
    "Python Software Foundation License": "PSF-2.0",
}


def server_packages(python: str | None) -> list[Package]:
    lock = (ROOT / "server/requirements.lock").read_text(encoding="utf-8")
    pins: dict[str, str] = {}
    for block in re.split(r"\n(?=[A-Za-z0-9])", lock.split("\n", 1)[1]):
        m = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)", block)
        if not m:
            continue
        via = re.findall(r"#\s+(?:via\s+)?(\S.*)$", block, re.M)
        if via and all("requirements-build.in" in v for v in via if v != "via"):
            continue  # the build backend, not shipped as a runtime dependency
        pins[m.group(1)] = m.group(2)
    with tempfile.TemporaryDirectory() as tmp:
        if python is None:
            venv = Path(tmp) / "venv"
            subprocess.run(["uv", "venv", "-q", "--python", "3.12", str(venv)], check=True)
            python = str(venv / "bin" / "python")
            subprocess.run(
                [
                    "uv",
                    "pip",
                    "install",
                    "-q",
                    "--python",
                    python,
                    "--require-hashes",
                    "--no-deps",
                    "-r",
                    str(ROOT / "server/requirements.lock"),
                ],
                check=True,
            )
        raw = subprocess.run(
            [python, "-c", DUMP, json.dumps(sorted(pins))],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    result = []
    for d in json.loads(raw):
        want = next(v for k, v in pins.items() if canon(k) == canon(d["name"]))
        if d["version"] != want:
            sys.exit(f"server: {d['name']} is {d['version']} in {python} but {want} in the lock")
        lic = d["expr"]
        if not lic:
            short = d["license"].strip()
            if short and len(short) < 40 and "\n" not in short:
                lic = {"MIT License": "MIT"}.get(short, short)
            elif d["classifiers"]:
                lic = " OR ".join(sorted({CLASSIFIER_SPDX.get(c, c) for c in d["classifiers"]}))
            else:
                lic = "UNKNOWN"
        result.append(
            Package(d["name"], d["version"], lic, d["url"], [tuple(t) for t in d["texts"]])
        )
    return sorted(result, key=lambda p: p.name.lower())


def canon(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def is_permissive(expr: str) -> bool:
    # "A OR B": fine when one side is; "A AND B": every side must be.
    if " OR " in expr:
        return any(is_permissive(p.strip("() ")) for p in expr.split(" OR "))
    return all(p.strip("() ") in PERMISSIVE for p in expr.split(" AND "))


def render(sections: list[tuple[str, str, list[Package]]]) -> str:
    lines = [
        "<!-- Generated by scripts/third-party-notices.py; do not edit by hand. -->",
        "",
        "# Third-party notices",
        "",
        "Trio itself is MIT licensed (see `LICENSE`). It ships the third-party software",
        "below; each keeps its own licence, reproduced at the end of this file. The list",
        "is generated from the lock files, so it names exactly the locked versions.",
        "",
        "## Needs attention",
        "",
    ]
    flagged = []
    for _, _, pkgs in sections:
        for p in pkgs:
            if p.name in NOTES or not is_permissive(p.license):
                flagged.append(p)
    seen = set()
    for p in flagged:
        if p.name in seen:
            continue
        seen.add(p.name)
        note = NOTES.get(
            p.name, "Not in the permissive allowlist of scripts/third-party-notices.py: check it."
        )
        lines.append(f"- **{p.name} {p.version}** (`{p.license}`): {note}")
    lines += [
        "",
        "Every other package below is under a permissive licence (MIT, ISC, BSD,",
        "Apache-2.0, BlueOak-1.0.0, PSF) that only asks for its notice to be kept.",
        "",
    ]
    lines += ["## Assets that are not dependencies", "", ASSETS]
    for title, intro, pkgs in sections:
        lines += [
            f"## {title}",
            "",
            intro,
            "",
            "| package | version | licence | source |",
            "|---|---|---|---|",
        ]
        for p in pkgs:
            lines.append(f"| {p.name} | {p.version} | {p.license} | {p.url} |")
        lines.append("")
    lines += ["## Licence texts", ""]
    by_text: dict[str, tuple[str, list[str]]] = {}
    order: list[str] = []
    for _, _, pkgs in sections:
        for p in pkgs:
            texts = list(p.texts)
            for title, path in EXTRA_TEXTS.get(p.name, []):
                texts.append((title, (ROOT / path).read_text(encoding="utf-8")))
            if not texts:
                texts = [
                    (
                        "(no licence file in the package)",
                        f"Licensed {p.license} per its package metadata.",
                    )
                ]
            for title, text in texts:
                key = hashlib.sha256(text.strip().encode()).hexdigest()
                label = f"{p.name} {p.version} ({title})"
                if key not in by_text:
                    by_text[key] = (text.strip(), [])
                    order.append(key)
                if label not in by_text[key][1]:
                    by_text[key][1].append(label)
    for key in order:
        text, labels = by_text[key]
        lines.append("### " + "; ".join(labels))
        lines += ["", "```text", text.replace("```", "'''"), "```", ""]
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--check", action="store_true", help="fail if THIRD-PARTY-NOTICES.md is stale")
    ap.add_argument(
        "--server-python", help="an interpreter with server/requirements.lock installed"
    )
    args = ap.parse_args()
    sections = [
        (
            "Web client (the bundle in the server image and in browsers)",
            "Production dependencies of `web/` (`web/package-lock.json`).",
            npm_packages("web", set()),
        ),
        (
            "Desktop app (the installers)",
            "Production dependencies of `desktop/` (`desktop/package-lock.json`) and the Electron runtime. "
            "The desktop app loads the web client from the server, so the list above applies to it too.",
            npm_packages("desktop", {"electron"}),
        ),
        (
            "Server (the Docker image)",
            "Runtime packages pinned in `server/requirements.lock` (the build backend excluded).",
            server_packages(args.server_python),
        ),
    ]
    text = render(sections)
    if args.check:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print(
                f"{OUT.name} is stale; run python3 scripts/third-party-notices.py", file=sys.stderr
            )
            sys.exit(1)
        print(f"{OUT.name} is up to date")
        return
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
