from pathlib import Path
import json, zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
out = root/'release'
out.mkdir(exist_ok=True)
for suffix, folders in [('Chrome', ['extension']), ('source', ['extension', 'cloud', 'tests', 'scripts', 'dev', 'docs'])]:
    with zipfile.ZipFile(out/f'shitou-baodian-{version}-{suffix}.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for folder in folders:
            for p in sorted((root/folder).rglob('*')):
                if p.is_file() and '__pycache__' not in p.parts and 'screenshots' not in p.parts and p.name != 'deployed-endpoint.txt' and not p.name.startswith('.env'):
                    z.write(p, p.relative_to(root))
        for name in ['README.md', 'LICENSE', 'package.json', '.gitignore']:
            z.write(root/name, name)
with zipfile.ZipFile(out/f'shitou-baodian-{version}-aliyun-function.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.write(root/'cloud/index.py', 'index.py')
print('Public release packages created.')
