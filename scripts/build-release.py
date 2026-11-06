"""Build a local marketplace archive, without dependencies, runtime profiles or tokens."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parent.parent
output = root / 'dist' / 'isolated-computer-linux-preview.zip'
output.parent.mkdir(exist_ok=True)
directories = ['src','desktop','extension','tests','public','scripts','examples','artifacts','assets','test-results','dist/extensions']
files = ['package.json','pnpm-lock.yaml','plugin.json','mcp.json','README.md','VERIFY.md','ACCEPTANCE.md','FIREFOX-EVALUATION.md','SCENARIOS.md','GUIDE.zh-CN.md','LICENSE','.gitignore']
paths = [root / name for name in files]
for name in directories:
    paths.extend(p for p in (root / name).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix not in ('.pyc','.token'))
prefix = 'isolated-computer-local'
with ZipFile(output,'w',ZIP_DEFLATED) as archive:
    archive.write(root / 'distribution/.agents/plugins/marketplace.json', prefix + '/.agents/plugins/marketplace.json')
    archive.writestr(prefix + '/README.txt', 'Linux verified development preview.\nOpen plugins/isolated-computer/README.md for manual dependency installation and MCP setup.\nSee VERIFY.md for browser/OS limitations.\nNo global installation is performed by this archive.\n')
    for path in sorted(set(paths)):
        archive.write(path, prefix + '/plugins/isolated-computer/' + path.relative_to(root).as_posix())
with ZipFile(output) as archive:
    assert archive.testzip() is None
    for name in archive.namelist():
        assert not any(part in ('node_modules','.runtime','__pycache__') for part in Path(name).parts)
        assert not name.endswith(('.token','.pyc'))
    for variant in ('chrome','firefox','safari'):
        manifest = prefix + '/plugins/isolated-computer/dist/extensions/' + variant + '/manifest.json'
        parsed = json.loads(archive.read(manifest))
        assert parsed['manifest_version'] == (2 if variant == 'firefox' else 3)
        if variant == 'firefox':
            assert parsed['background']['persistent'] is True
print(str(output))
print(f'Archive checked; {output.stat().st_size} bytes')
