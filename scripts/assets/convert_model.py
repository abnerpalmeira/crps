"""
Converte um modelo da Synty (FBX em assets/synty) em GLB para o jogo, sob demanda: o servidor chama
quando o 3D pede um modelo do catálogo que ainda não foi convertido.

Uso: blender -b --python scripts/assets/convert_model.py -- SRC PACOTE TIPO SAIDA CHAVE

TIPO é prop (móvel, em metros, com a origem no centro da base) ou character (malha e esqueleto,
com os ossos renomeados para os das animações). Escreve SAIDA/CHAVE.glb, só a geometria, e
SAIDA/CHAVE.json com o tamanho e a textura de cada material (tex_<chave>), se ela é recorte e o tom
das folhas cinzentas. As texturas ficam uma vez só em SAIDA/textures, em PNG de até 2048 px, para
todos os modelos que as usam. Os materiais seguem as regras das miniaturas do catálogo
(synty_blender.paint): o jogo mostra o que o catálogo descreve.
"""

import json
import os
import shutil
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synty_blender import CUTOUTS, LEAF_GREEN, TINTED, clean, paint, rename_bones, texture_key  # noqa: E402
from synty_textures import ROOT  # noqa: E402

MAX_TEXTURE = 2048


def export_texture(path, outdir):
    """A textura em PNG de até 2048 px, gravada uma vez; o nome de arquivo pronto para o cliente."""
    name = f'textures/{texture_key(path)}.png'
    out = os.path.join(outdir, name)
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        # Dois servidores (ou duas conversões) podem gravar a mesma textura: grava ao lado e troca.
        tmp = f'{out}.{os.getpid()}.png'
        img = bpy.data.images.load(path, check_existing=True)
        w, h = img.size
        if path.lower().endswith('.png') and max(w, h) <= MAX_TEXTURE:
            shutil.copyfile(path, tmp)
        else:
            if max(w, h) > MAX_TEXTURE:
                f = MAX_TEXTURE / max(w, h)
                img.scale(max(1, round(w * f)), max(1, round(h * f)))
            img.filepath_raw = tmp
            img.file_format = 'PNG'
            img.save()
        os.replace(tmp, out)
    return name


def bounds(objects):
    pts = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def export(path, skins):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=not skins,
        export_materials='EXPORT',
        export_image_format='NONE',
        export_cameras=False,
        export_lights=False,
        export_skins=skins,
        export_animations=False,
    )


def variants(meshes):
    """Tira as variantes sobrepostas: arquivos como o do cavalo trazem as cinco pelagens no mesmo
    lugar, e juntas elas brigam na tela. Fica a primeira de cada lugar."""
    kept, seen = [], []
    for o in meshes:
        lo, hi = bounds([o])
        size = max((hi - lo).length, 1e-6)
        if any((lo - a).length < size * 0.01 and (hi - b).length < size * 0.01 for a, b in seen):
            bpy.data.objects.remove(o)
            continue
        seen.append((lo, hi))
        kept.append(o)
    return kept


def prop(meshes):
    """Uma malha só, em metros, com a origem no centro da base. Há pacotes em centímetros (heist,
    dungeon): um modelo com menos de 5 cm é um que veio 100 vezes pequeno."""
    # Móvel com esqueleto (bicho, carrinho de compras) fica na pose de repouso, sem o esqueleto.
    for o in meshes:
        for m in [m for m in o.modifiers if m.type == 'ARMATURE']:
            o.modifiers.remove(m)
    meshes = variants(meshes)
    # Solta as peças do pai antes de aplicar a escala: aplicada no pai e no filho ao mesmo tempo,
    # ela se soma no filho (a copa da árvore saía com quilômetros).
    for o in meshes:
        world = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = world
        o.select_set(True)
    for o in list(bpy.context.scene.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    lo, hi = bounds([obj])
    if max(hi - lo) < 0.05:
        obj.data.transform(Matrix.Scale(100, 4))
        obj.data.update()
        bpy.context.view_layer.update()
        lo, hi = bounds([obj])
    obj.data.transform(Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))))
    obj.location = (0, 0, 0)
    return hi - lo


def character(meshes):
    """Malha e esqueleto, com os ossos das animações; a altura da cabeça diz o tamanho."""
    arm = next((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), None)
    if arm:
        rename_bones(arm)
        arm.animation_data_clear()
    lo, hi = bounds(meshes)
    head = arm.data.bones.get('Head') if arm else None
    return hi - lo, (arm.matrix_world @ head.head_local).z if head else hi.z * 0.93


def main():
    src, pack, kind, outdir, key = sys.argv[sys.argv.index('--') + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, src))
    clean(scene)
    # Câmeras e luzes do arquivo não vão para o jogo; os nós vazios ficam até o móvel ser soltado
    # deles, porque às vezes são eles que levam a escala (o esqueleto do cavalo pendura num vazio).
    for o in list(scene.objects):
        if o.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(o)
    meshes = [o for o in scene.objects if o.type == 'MESH']
    if not meshes:
        raise SystemExit(f'{src}: nenhuma malha')
    made = paint(pack, os.path.splitext(os.path.basename(src))[0], meshes)
    meta = {'file': f'{key}.glb', 'kind': kind, 'materials': {}}
    for path, mat in made.items():
        meta['materials'][mat.name] = {
            'texture': export_texture(path, outdir) if path else None,
            **({'cutout': True} if path in CUTOUTS else {}),
            **({'tint': [round(c, 3) for c in LEAF_GREEN[:3]]} if path in TINTED else {}),
        }
    if kind == 'character':
        size, head = character(meshes)
        meta['head'] = round(head, 3)
    else:
        size = prop(meshes)
    # Blender é Z para cima; no glTF (Y para cima) a largura é x, a altura z e a profundidade y.
    meta['size'] = [round(size.x, 3), round(size.z, 3), round(size.y, 3)]
    os.makedirs(outdir, exist_ok=True)
    export(os.path.join(outdir, f'{key}.glb'), skins=kind == 'character')
    with open(os.path.join(outdir, f'{key}.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False)
    print(f'[modelo] {key}: {meta["size"]}, {len(meta["materials"])} materiais', flush=True)


main()
