#!/usr/bin/env python3
"""Write ONE portable source archive, excluding dependencies, builds and private state.
Usage: python3 scripts/source_zip.py /absolute/path/io-agent-source.zip
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXCLUDE_DIRS = {'.git', 'node_modules', 'dist', '.cache', 'coverage', '__pycache__', '.pytest_cache', 'prebuilds'}
ROOTS = {'src', 'tests', 'scripts', 'docs', 'patches', 'examples'}
FILES = {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts', '.gitignore', 'LICENSE', 'LICENSE-DEEPSEEK', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'AGENTS.md', 'ARCHITECTURE.md', 'CHANGELOG.md'}
EXCLUDE_SUFFIXES = {'.pyc', '.tsbuildinfo', '.node', '.so', '.dll', '.exe', '.zip', '.tgz', '.log'}

def main(destination: str) -> None:
    output = Path(destination).resolve()
    if output.is_relative_to(ROOT):
        raise ValueError('Put the archive outside the source tree.')
    output.parent.mkdir(parents=True, exist_ok=True)
    entries = []
    for path, dirs, names in os.walk(ROOT, followlinks=False):
        base = Path(path)
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS and (base != ROOT or d in ROOTS))
        for name in sorted(names):
            p = base / name
            if base == ROOT and name not in FILES:
                continue
            if p.suffix in EXCLUDE_SUFFIXES or name.startswith('.env'):
                continue
            mode = p.lstat().st_mode
            if stat.S_ISLNK(mode):
                target = p.resolve(strict=False)
                if not target.is_relative_to(ROOT):
                    raise ValueError(f'external symlink excluded: {p}')
                content = os.readlink(p).encode()
            elif stat.S_ISREG(mode):
                content = p.read_bytes()
            else:
                raise ValueError(f'unsupported source entry: {p}')
            if content.startswith(b'\x7fELF'):
                raise ValueError(f'native binary is not source: {p}')
            entries.append((p.relative_to(ROOT).as_posix(), content, mode))
    package = json.loads((ROOT / 'package.json').read_text())
    descriptor = {'format': 1, 'name': package['name'], 'version': package['version'],
                  'entryCount': len(entries), 'files': [{'path': n, 'bytes': len(b), 'mode': oct(m), 'sha256': hashlib.sha256(b).hexdigest()} for n,b,m in entries]}
    descriptor['sourceId'] = hashlib.sha256(json.dumps(descriptor['files'], separators=(',', ':'), sort_keys=True).encode()).hexdigest()
    fd, tmp = tempfile.mkstemp(prefix='io-agent-source-', suffix='.zip', dir=output.parent)
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for name, content, mode in entries:
                info = zipfile.ZipInfo('io-agent/' + name, date_time=(2026, 9, 23, 0, 0, 0))
                info.create_system = 3; info.external_attr = mode << 16; info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, content)
            z.writestr('SOURCE.json', json.dumps(descriptor, indent=2) + '\n')
        with zipfile.ZipFile(tmp) as z:
            if z.testzip() is not None:
                raise RuntimeError('archive CRC failed')
            for entry in descriptor['files']:
                if hashlib.sha256(z.read('io-agent/' + entry['path'])).hexdigest() != entry['sha256']:
                    raise RuntimeError(f'hash failed: {entry["path"]}')
        os.chmod(tmp, 0o644)
        os.replace(tmp, output)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    print(json.dumps({'path': str(output), 'bytes': output.stat().st_size, 'files': len(entries), 'sourceId': descriptor['sourceId'], 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}))

if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    main(sys.argv[1])
