"""
Extrai os zips de "Source Files" da Synty em assets/synty/<pacote>/, só com o que o conversor usa.

Uso: python3 -I scripts/assets/unpack_synty.py [--delete] [--force] ZIP...

Ficam os modelos FBX, as texturas (png, tga, jpg) e a lista de materiais (txt). Saem os OBJ e as
cenas de outros programas (pasta Unsupported, .ma, .blend, .max) e os PSD. O nome do pacote vem
do zip: POLYGON_Town_SourceFiles_v7.zip → town; ANIMATION_Bow_Combat_SourceFiles_v1.zip →
anim_bow_combat. Pacote já extraído fica como está, salvo com --force. --delete apaga o zip depois
de extrair (ele pode ser baixado de novo na biblioteca da Synty).
"""

import io
import os
import re
import shutil
import sys
import zipfile
from collections import Counter
from pathlib import PurePosixPath

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'synty')
KEEP = {'fbx', 'png', 'tga', 'jpg', 'jpeg', 'txt'}


def slug(zip_path):
    stem = re.sub(r'\.zip$', '', os.path.basename(zip_path), flags=re.I)
    stem = re.split(r'_?source_?files', stem, flags=re.I)[0]
    m = re.match(r'(POLYGON|ANIMATION)_(.+)', stem, flags=re.I)
    line, rest = (m.group(1).upper(), m.group(2)) if m else ('', stem)
    name = re.sub(r'_pack$', '', rest, flags=re.I).lower()
    return f'anim_{name}' if line == 'ANIMATION' else name


def safe(member):
    path = PurePosixPath(member)
    return not (member.endswith('/') or path.is_absolute() or '..' in path.parts or 'Unsupported' in path.parts)


def wanted(member):
    return safe(member) and PurePosixPath(member).suffix.lower().lstrip('.') in KEEP


def extract(z, dest, kept, prefix=()):
    """Copia os arquivos úteis de um zip aberto; zips dentro do zip são abertos também."""
    for member in z.namelist():
        path = PurePosixPath(member)
        if member.lower().endswith('.zip') and safe(member):
            with zipfile.ZipFile(io.BytesIO(z.read(member))) as inner:
                extract(inner, dest, kept, prefix + (path.stem,))
            continue
        if not wanted(member):
            continue
        target = os.path.join(dest, *prefix, *path.parts)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with z.open(member) as src, open(target, 'wb') as out:
            shutil.copyfileobj(src, out)
        kept[path.suffix.lower().lstrip('.')] += 1


def unpack(zip_path, force=False):
    pack = slug(zip_path)
    dest = os.path.normpath(os.path.join(ROOT, pack))
    if os.path.isdir(dest) and not force:
        return pack, None
    kept = Counter()
    with zipfile.ZipFile(zip_path) as z:
        extract(z, dest, kept)
    return pack, kept


def main(args):
    delete = '--delete' in args
    force = '--force' in args
    zips = [a for a in args if not a.startswith('--')]
    if not zips:
        sys.exit(__doc__)
    for zip_path in zips:
        pack, kept = unpack(zip_path, force)
        if kept is None:
            print(f'[synty] {pack}: já extraído, pulando ({os.path.basename(zip_path)})')
            continue
        if not kept:
            # Nada aproveitável: o zip fica para alguém olhar, e a pasta vazia não conta como extraída.
            with zipfile.ZipFile(zip_path) as z:
                found = Counter(PurePosixPath(n).suffix.lower() or '(pasta)' for n in z.namelist())
            print(f'[synty] {pack}: NADA extraído; o zip tem {dict(found.most_common(6))}')
            continue
        print(f'[synty] {pack}: ' + ', '.join(f'{n} {ext}' for ext, n in kept.most_common()))
        if delete:
            os.remove(zip_path)


if __name__ == '__main__':
    main(sys.argv[1:])
