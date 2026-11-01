"""
Converte um modelo da Synty (FBX em assets/synty) em GLB para o jogo, sob demanda: o servidor chama
quando o 3D pede um modelo do catálogo que ainda não foi convertido.

Uso: blender -b --python scripts/assets/convert_model.py -- SRC PACOTE TIPO SAIDA CHAVE

TIPO é prop (móvel, em metros, com a origem no centro da base), held (o mesmo objeto para ir na
mão: a origem fica onde o arquivo a pôs, que nas armas da Synty é o punho, e os eixos são os do
arquivo, com o cano em +Z e a lâmina em +Y) ou character (malha e esqueleto, com os ossos
renomeados para os das animações). Escreve SAIDA/CHAVE.glb, só a geometria, e
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


def variants(meshes, held=False):
    """Tira as variantes sobrepostas: arquivos como o do cavalo trazem as cinco pelagens no mesmo
    lugar, e o dos arcos traz oito arcos; juntas elas brigam na tela. Fica a primeira de cada lugar:
    outra peça com o centro ali e as duas maiores medidas quase iguais é variante (na mão, que é
    sempre um objeto só, basta a maior). Peça dez vezes maior que as outras (uma corda de 148 m num
    arco) é defeito do arquivo e sai também."""
    boxes = {o: bounds([o]) for o in meshes}
    diagonals = sorted((hi - lo).length for lo, hi in boxes.values())
    median = diagonals[len(diagonals) // 2]
    kept, seen = [], []
    for o in meshes:
        lo, hi = boxes[o]
        center, size = (lo + hi) / 2, sorted(hi - lo, reverse=True)
        diagonal = max((hi - lo).length, 1e-6)
        if len(meshes) > 2 and diagonal > 10 * median:
            bpy.data.objects.remove(o)
            continue

        def alike(c, s):
            near = (center - c).length < 0.1 * diagonal
            measures = 1 if held else 2
            return near and all(abs(a - b) <= 0.25 * max(a, b) + 0.02 * diagonal for a, b in zip(size[:measures], s[:measures]))

        if any(alike(c, s) for c, s in seen):
            bpy.data.objects.remove(o)
            continue
        seen.append((center, size))
        kept.append(o)
    return kept


def prop(meshes, held=False):
    """Uma malha só, em metros, com a origem no centro da base (ou, na mão, na origem do arquivo).
    Há pacotes em centímetros (heist, dungeon): um modelo com menos de 5 cm é um que veio 100
    vezes pequeno."""
    # Móvel com esqueleto (bicho, carrinho de compras) fica na pose de repouso, sem o esqueleto.
    for o in meshes:
        for m in [m for m in o.modifiers if m.type == 'ARMATURE']:
            o.modifiers.remove(m)
    meshes = variants(meshes, held)
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
    # Na mão, a posição de cada peça também entra na malha: a origem passa a ser a do arquivo.
    bpy.ops.object.transform_apply(location=held, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    lo, hi = bounds([obj])
    if max(hi - lo) < 0.05:
        obj.data.transform(Matrix.Scale(100, 4))
        obj.data.update()
        bpy.context.view_layer.update()
        lo, hi = bounds([obj])
    if not held:
        obj.data.transform(Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))))
        obj.location = (0, 0, 0)
    return lo, hi


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
    bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, src), use_image_search=False)
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
        lo, hi = prop(meshes, held=kind == 'held')
        size = hi - lo
        if kind == 'held':
            # Caixa no glTF (Y para cima): x, z e -y do Blender. É por ela que o 3D acha o cano.
            meta['bbox'] = [[round(lo.x, 3), round(lo.z, 3), round(-hi.y, 3)], [round(hi.x, 3), round(hi.z, 3), round(-lo.y, 3)]]
    # Blender é Z para cima; no glTF (Y para cima) a largura é x, a altura z e a profundidade y.
    meta['size'] = [round(size.x, 3), round(size.z, 3), round(size.y, 3)]
    os.makedirs(outdir, exist_ok=True)
    export(os.path.join(outdir, f'{key}.glb'), skins=kind == 'character')
    with open(os.path.join(outdir, f'{key}.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False)
    print(f'[modelo] {key}: {meta["size"]}, {len(meta["materials"])} materiais', flush=True)


main()
