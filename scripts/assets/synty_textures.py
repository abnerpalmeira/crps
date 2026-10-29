"""
Que texturas cada modelo da Synty usa, lidas do MaterialList_*.txt do pacote: para cada objeto do
FBX, o albedo de cada material, na mesma ordem dos materiais do FBX (as listas vêm em dois
formatos, com o albedo numa linha própria ou entre parênteses). A lista usa os nomes do Unity,
e os arquivos-fonte às vezes têm outro: PolygonCity_01_A.png na lista pode ser
PolygonCity_Texture_01_A.png no disco, PolygonDungeon_01.png pode ser Dungeons_Texture_01.png, e
pacotes de mapa usam texturas de outro pacote. Por isso a busca vai do nome exato no pacote ao
exato em qualquer pacote e, por fim, ao nome mais parecido com os mesmos números.

Rodado direto (python3 scripts/assets/synty_textures.py), grava em _catalogo/recortes.json as
texturas com recorte de verdade (folhas, flores, grades), que o Blender não descobre sozinho.
"""

import difflib
import glob
import json
import os
import re
from collections import Counter

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'synty'))
CUTOUTS = os.path.join(ROOT, '_catalogo', 'recortes.json')
GRAY_LEAVES = os.path.join(ROOT, '_catalogo', 'folhas_cinza.json')
# Texturas que não são a paleta principal, para o palpite de quem não tem lista.
NOT_ATLAS = re.compile(r'emissive|normal|sign|fx|decal|mask|alpha|glass|sky|water|poster|graffiti|ui|icon|face', re.I)
# Texturas que não são cor, para a busca por semelhança.
NOT_ALBEDO = re.compile(r'normal|emissi|emmisi|mask|metallic|rough|height|specular|occlusion|_ao$', re.I)
_images, _slots, _trunks, _leaves, _lists, _guess, _found, _all = {}, {}, {}, {}, {}, {}, {}, {}


def norm(name):
    stem = os.path.splitext(os.path.basename(name))[0].lower()
    return re.sub(r'_?texture', '', stem)


def key(name):
    """Nome reduzido para comparar por semelhança: sem "polygon", "texture" e pontuação."""
    return re.sub(r'[^a-z0-9]', '', norm(name).replace('polygon', ''))


def images(pack):
    """Imagens do pacote pelo nome normalizado; png antes de tga e jpg, e caminho curto antes de
    alternativas em subpastas. O nome exato do arquivo, com extensão, também é chave: Grass_01.tga
    (o recorte da grama) e Grass_01.png (o terreno) existem no mesmo pacote."""
    if pack not in _images:
        found = {}
        for ext in ('png', 'tga', 'jpg'):
            for path in sorted(glob.glob(os.path.join(ROOT, pack, '**', f'*.{ext}'), recursive=True), key=len):
                found.setdefault(norm(path), path)
                found.setdefault(os.path.basename(path).lower(), path)
        _images[pack] = found
    return _images[pack]


def in_pack(pack, name):
    """Caminho da imagem do pacote com esse nome: o exato primeiro, depois o normalizado."""
    return images(pack).get(os.path.basename(name).lower()) or images(pack).get(norm(name))


def all_images():
    """Imagens de todos os pacotes, para texturas emprestadas de outro pacote."""
    if not _all:
        for pack in sorted(os.listdir(ROOT)):
            if not pack.startswith('_') and os.path.isdir(os.path.join(ROOT, pack)):
                for name, path in images(pack).items():
                    _all.setdefault(name, path)
    return _all


def slot_texture(line):
    """Textura de uma linha "Slot:". As listas mais novas põem o albedo na linha seguinte; as
    mais velhas, entre parênteses: "Slot: Mat_01 (Texture_01)", "(No texture)" ou "(Uses custom
    shader)", em que o nome do material costuma ser o da textura."""
    m = re.match(r'Slot:\s*(.*?)\s*(?:\((.*)\))?$', line)
    name, inside = m.group(1), (m.group(2) or '').strip()
    if not inside or re.match(r'no\b', inside, re.I):
        return None
    return name if 'custom shader' in inside.lower() else inside


# Propriedades de textura que dão a cor de um material, da mais à menos direta: shaders da Synty
# chamam o albedo de Albedo, _Texture_Map ou _Main_Texture; a vegetação usa folha e tronco; o
# triplanar projeta uma textura de lado (rocha) e outra de cima (grama, musgo, neve).
COLOR_KEYS = ('Albedo', '_Texture_Map', '_Main_Texture', '_Leaf_Texture', '_Trunk_Texture', '_Triplanar_Texture_Side', '_Triplanar_Texture_Top')
# Chão, grama e musgo se veem de cima: aí a textura de cima vem antes da de lado.
SEEN_FROM_ABOVE = re.compile(r'ground|grass|moss|floor|terrain|snow|lawn|field', re.I)


def color_rank(key, prefab):
    if prefab and SEEN_FROM_ABOVE.search(prefab) and key.startswith('_Triplanar_Texture_'):
        return COLOR_KEYS.index('_Triplanar_Texture_Side') + (key != '_Triplanar_Texture_Top')
    return COLOR_KEYS.index(key)


def slot_list(pack):
    """Por modelo: {objeto: [albedo de cada material, ou None quando o material não tem textura]}."""
    if pack not in _slots:
        out, trunks, leaves = {}, {}, set()
        for path in sorted(glob.glob(os.path.join(ROOT, pack, '**', 'MaterialList*.txt'), recursive=True)):
            prefab = mesh = None
            rank = len(COLOR_KEYS)
            with open(path, encoding='utf-8', errors='ignore') as f:
                for line in f:
                    line = line.strip()
                    key = line.split(':', 1)[0]
                    value = line.split(':', 1)[-1].split('(')[0].strip()
                    if key == '_Leaf_Texture':
                        leaves.add(value)
                    if key == '_Trunk_Texture' and prefab and mesh and trunks[prefab][mesh]:
                        trunks[prefab][mesh][-1] = value
                    if line.startswith('Prefab Name:'):
                        prefab, mesh = line.split(':', 1)[1].strip(), None
                        # Prefab repetido em outra lista: vale o primeiro.
                        prefab = None if prefab in out else prefab
                        if prefab:
                            out[prefab], trunks[prefab] = {}, {}
                    elif line.startswith('Mesh Name:') and prefab:
                        mesh = line.split(':', 1)[1].strip()
                        out[prefab].setdefault(mesh, [])
                        trunks[prefab].setdefault(mesh, [])
                    elif line.startswith('Slot:') and prefab and mesh:
                        out[prefab][mesh].append(slot_texture(line))
                        trunks[prefab][mesh].append(None)
                        rank = len(COLOR_KEYS)
                    elif key in COLOR_KEYS and color_rank(key, prefab) < rank and prefab and mesh and out[prefab][mesh]:
                        out[prefab][mesh][-1] = value
                        rank = color_rank(key, prefab)
        _slots[pack], _trunks[pack], _leaves[pack] = out, trunks, leaves
    return _slots[pack]


def trunk_list(pack):
    """Por modelo: {objeto: [textura de tronco de cada material, ou None]}. O shader de vegetação
    da Synty usa folha e tronco no mesmo material."""
    slot_list(pack)
    return _trunks[pack]


def material_list(pack):
    """Albedo do primeiro material de cada modelo, e o mais usado no pacote."""
    if pack not in _lists:
        per_model, count = {}, Counter()
        for prefab, meshes in slot_list(pack).items():
            names = [name for slots in meshes.values() for name in slots if name]
            count.update(names)
            if names:
                per_model[prefab] = names[0]
        _lists[pack] = (per_model, count.most_common(1)[0][0] if count else None)
    return _lists[pack]


def find(pack, name):
    """Caminho da textura que a lista chama de name, ou None."""
    if (pack, name) not in _found:
        n, digits = norm(name), re.findall(r'\d+', norm(name))
        path = in_pack(pack, name) or all_images().get(os.path.basename(name).lower()) or all_images().get(n)
        # Por semelhança, só entre texturas de cor com os mesmos números (ou sem número nenhum,
        # como Leaves_Generic_Texture para Leaves_Generic_01): no pacote, com folga; em outro
        # pacote, só quase igual.
        for pool, cutoff in ((images(pack), 0.6), (all_images(), 0.8)):
            if path:
                break
            cands = {key(p): p for m, p in pool.items() if not NOT_ALBEDO.search(m) and re.findall(r'\d+', m)[:len(digits)] in (digits, [])}
            best = difflib.get_close_matches(key(name), list(cands), n=1, cutoff=cutoff)
            path = cands[best[0]] if best else None
        _found[pack, name] = path
    return _found[pack, name]


def guess(pack):
    """Palpite pelo nome do arquivo, para pacotes sem MaterialList."""
    if pack not in _guess:
        pngs = [p for p in glob.glob(os.path.join(ROOT, pack, '**', '*.png'), recursive=True) if not NOT_ATLAS.search(os.path.basename(p))]
        rank = lambda p: (0 if re.search(r'Texture_01_A|_01_A', p) else 1 if re.search(r'Texture_01', p) else 2, len(p))
        _guess[pack] = min(pngs, key=rank) if pngs else None
    return _guess[pack]


def character_texture(pack):
    """Textura própria de personagem do pacote (Characters_Texture_Blue, por exemplo), ou None."""
    found = [p for n, p in images(pack).items() if 'character' in n and not NOT_ALBEDO.search(n)]
    return min(found, key=lambda p: (len(p), p)) if found else None


def texture_for(pack, model):
    """Textura principal do modelo (nome do FBX sem extensão), ou None. Personagem que a lista não
    cita fica com a textura de personagem do pacote, quando há uma, e não com a paleta do cenário."""
    per_model, main = material_list(pack)
    if model not in per_model and re.search(r'chr|character', model, re.I) and character_texture(pack):
        return character_texture(pack)
    for name in (per_model.get(model), main):
        if name and find(pack, name):
            return find(pack, name)
    return guess(pack) or only_image(pack)


UNLISTED = object()


def slot_path(pack, listed, fbx, main):
    """Textura de um material. listed é o nome que a lista dá a ele (None quando a lista diz que
    não tem textura; UNLISTED quando a lista não fala dele) e fbx, a imagem de cor que o próprio FBX
    dá ao material. Vale, nesta ordem: o nome da lista, se existe no pacote; a imagem do FBX, se
    existe no pacote (a lista diz Signs_01.png, que só existe no pacote apocalipse, e o FBX da placa
    da fazenda usa PolygonFarm_Signs.png); o nome da lista em outro pacote ou por semelhança; em
    pacote sem lista nenhuma, cuja textura principal é só um palpite, a imagem do FBX em outro
    pacote (o armazém militar usa a paleta do pacote military); e a textura principal do modelo."""
    if listed is None:
        return None
    if listed is not UNLISTED and in_pack(pack, listed):
        return in_pack(pack, listed)
    if fbx and in_pack(pack, fbx) and not NOT_ALBEDO.search(norm(fbx)):
        return in_pack(pack, fbx)
    if listed is not UNLISTED and find(pack, listed):
        return find(pack, listed)
    if fbx and not slot_list(pack) and find(pack, fbx) and not NOT_ALBEDO.search(norm(fbx)):
        return find(pack, fbx)
    return main


def only_image(pack):
    """A única textura de cor do pacote, quando ele só tem uma (as máscaras de Halloween, cuja
    textura se chama Polygon_Mask_Texture e escapa do palpite)."""
    colors = {p for n, p in images(pack).items() if not re.search(r'normal|emissi|emmisi|metallic|rough', n)}
    return colors.pop() if len(colors) == 1 else None


def textures_for(pack, model, fbx=None):
    """Textura de cada material de cada objeto do modelo, {objeto: [caminho ou None]}, e a
    principal. fbx, {objeto: [imagem de cor de cada material]}, é o que o próprio FBX diz, lido no
    Blender; objetos que só o FBX cita entram também."""
    fbx = fbx or {}
    main = texture_for(pack, model)
    listed = slot_list(pack).get(model, {})
    out = {}
    for obj in list(listed) + [o for o in fbx if o not in listed]:
        names, given = listed.get(obj, []), fbx.get(obj, [])
        out[obj] = [slot_path(pack, names[k] if k < len(names) else UNLISTED, given[k] if k < len(given) else None, main)
                    for k in range(max(len(names), len(given)))]
    return out, main


def trunks_for(pack, model):
    """Textura de tronco dos materiais que misturam folha e tronco, {objeto: [caminho ou None]}."""
    return {obj: [find(pack, name) if name else None for name in names] for obj, names in trunk_list(pack).get(model, {}).items() if any(names)}


def cutouts():
    """Texturas com recorte, de recortes.json (vazio enquanto ele não foi gerado)."""
    try:
        with open(CUTOUTS, encoding='utf-8') as f:
            return set(json.load(f))
    except OSError:
        return set()


def tinted():
    """Texturas de folha cinzentas, que o shader de vegetação do Unity tinge de verde, de
    folhas_cinza.json (vazio enquanto ele não foi gerado)."""
    try:
        with open(GRAY_LEAVES, encoding='utf-8') as f:
            return set(json.load(f))
    except OSError:
        return set()


def _is_gray(path):
    """Pouca saturação nas partes opacas: folha feita para ser tingida."""
    from PIL import Image
    try:
        im = Image.open(path).convert('RGBA').resize((96, 96), Image.NEAREST)
    except Exception:
        return False
    hsv = Image.merge('RGB', im.convert('RGB').split()).convert('HSV')
    sat = [s for (_, s, _), (_, _, _, a) in zip(hsv.getdata(), im.getdata()) if a > 128]
    return bool(sat) and sum(sat) / len(sat) < 40


def _is_cutout(path):
    """Recorte é alfa quase só zero ou cheio, com um bom pedaço transparente; alfa usado como
    brilho tem muito tom intermediário."""
    from PIL import Image
    try:
        im = Image.open(path)
        if im.mode not in ('RGBA', 'LA', 'P'):
            return False
        alpha = list(im.convert('RGBA').getchannel('A').resize((128, 128), Image.NEAREST).getdata())
    except Exception:
        return False
    clear = sum(1 for a in alpha if a < 16) / len(alpha)
    middle = sum(1 for a in alpha if 16 <= a < 240) / len(alpha)
    return clear > 0.05 and middle < 0.3


def main():
    from multiprocessing import Pool
    packs = [p for p in sorted(os.listdir(ROOT)) if not p.startswith('_') and os.path.isdir(os.path.join(ROOT, p))]
    paths = sorted({find(pack, name) for pack in packs for meshes in slot_list(pack).values() for names in meshes.values() for name in names if name} - {None})
    with Pool() as pool:
        flags = pool.map(_is_cutout, paths)
    with open(CUTOUTS, 'w', encoding='utf-8') as f:
        json.dump(sorted(p for p, cut in zip(paths, flags) if cut), f, indent=0)
    print(f'[recortes] {sum(flags)} de {len(paths)} texturas citadas têm recorte')
    leaves = sorted({find(pack, name) for pack in packs for name in _leaves[pack]} - {None})
    with Pool() as pool:
        gray = pool.map(_is_gray, leaves)
    with open(GRAY_LEAVES, 'w', encoding='utf-8') as f:
        json.dump(sorted(p for p, g in zip(leaves, gray) if g), f, indent=0)
    print(f'[folhas] {sum(gray)} de {len(leaves)} texturas de folha são cinzentas')


if __name__ == '__main__':
    main()
