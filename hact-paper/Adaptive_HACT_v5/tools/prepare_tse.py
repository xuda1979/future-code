#!/usr/bin/env python3
"""Package only the primary TSE article, supplement and cover-letter sources."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PAPER = ROOT / "paper"
ENTRYPOINTS = ("journal.tex", "tse_supplement.tex", "tse_cover_letter.tex")


def payload():
    files, origins = {}, {}
    pending = list(ENTRYPOINTS)
    visited = set()
    while pending:
        rel = pending.pop()
        path = (PAPER / rel).resolve()
        if not path.is_relative_to(PAPER.resolve()) or not path.is_file():
            raise ValueError("missing or unsafe manuscript dependency: " + rel)
        if path in visited:
            continue
        visited.add(path)
        raw = path.read_bytes()
        if path.suffix == ".tex":
            text = raw.decode("utf-8")
            scan = re.sub(r"(?<!\\)%.*", "", text)
            inputs = re.findall(r"\\input\{([^}]+)\}", scan)
            figures = re.findall(r"\\includegraphics(?:\[[^]]*\])?\{([^}]+)\}", scan)
            for child in inputs + figures:
                name = child
                if not Path(name).suffix:
                    suffixes = (".tex",) if child in inputs else (".pdf", ".png", ".jpg")
                    name = next((child + ext for ext in suffixes if (PAPER / (child + ext)).is_file()), "")
                    if not name:
                        raise ValueError("unresolved source dependency: " + child)
                pending.append(name)
                text = text.replace("{" + child + "}", "{" + Path(name).name + "}")
            raw = text.encode("utf-8")
        flat = path.name
        if flat in origins and origins[flat] != path:
            raise ValueError("flat source filename collision: " + flat)
        origins[flat] = path
        files[flat] = raw
    files["IEEEtran.cls"] = (PAPER / "IEEEtran.cls").read_bytes()
    files["README_TSE_SOURCE.txt"] = (
        "Adaptive HACT - TSE source package\n\n"
        "Primary article: journal.tex\n"
        "Technical supplement: tse_supplement.tex\n"
        "Cover letter: tse_cover_letter.tex (for editors only)\n\n"
        "Build each entry point with pdflatex three times in a clean directory.\n"
        "All referenced local inputs and figures are included at one folder level.\n"
        "The unmodified IEEEtran class is bundled; other packages are standard TeX Live packages.\n"
        "JSS variants and the historical full manuscript are outside this package.\n"
        "SOURCE_MANIFEST.json binds every other file by size and SHA-256.\n"
        "The source package contains no author approval or submission attestations.\n"
        "Final submission remains paused for author review.\n"
    ).encode()
    manifest = {
        "schema": "hact-tse-source-1",
        "entrypoints": list(ENTRYPOINTS),
        "files": {name: {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
                  for name, raw in sorted(files.items())},
    }
    files["SOURCE_MANIFEST.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    return files


def build(output):
    files = payload()
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".tse-source-", dir=output.parent)
    os.close(handle)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, raw in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, raw, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        os.replace(temporary, output)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {"files": len(files), "bytes": output.stat().st_size,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "submission/TSE_source.zip")
    print(json.dumps(build(parser.parse_args().output)))
