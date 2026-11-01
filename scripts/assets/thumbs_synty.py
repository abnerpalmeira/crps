"""
Miniaturas dos modelos da Synty para catalogar olhando: cada FBX renderizado no Blender, de frente
e um pouco de lado e de cima, com a textura de cada material pelas mesmas regras da conversão para
o jogo (synty_blender.py).

Uso: blender -b --python scripts/assets/thumbs_synty.py -- LISTA SAIDA

LISTA tem uma linha por modelo, "pacote<TAB>caminho em assets/synty". Cada miniatura vai para
SAIDA/<caminho com / trocado por __>.jpg; as que já existem são puladas, então dá para retomar
e dividir a lista entre vários processos.
"""

import os
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synty_blender import clean, paint  # noqa: E402
from synty_textures import ROOT  # noqa: E402

SIZE = 176


def render(pack, rel, out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = 85
    bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, rel), use_image_search=False)
    clean(scene)
    meshes = [o for o in scene.objects if o.type == 'MESH']
    if not meshes:
        return False
    paint(pack, os.path.splitext(os.path.basename(rel))[0], meshes)
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    # Sem piso de tamanho: há armas do heist com 3 mm, e um piso de 1 cm as deixava minúsculas.
    center, size = (lo + hi) / 2, max((hi - lo).length, 1e-6)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    # A frente dos modelos da Synty é -Y no Blender.
    cam.location = center + Vector((size * 0.55, -size * 1.25, size * 0.55))
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    # Há pacotes em centímetros: o corte padrão de 10 cm some com um modelo desse tamanho.
    cam.data.clip_start, cam.data.clip_end = size * 0.01, size * 100
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.5
    sun.rotation_euler = (0.9, 0.2, 0.6)
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new('fundo')
    world.color = (0.45, 0.46, 0.5)
    scene.world = world
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    if blank(out):
        # Tudo transparente: o recorte veio de uma textura que não era a desse material (um
        # triplanar de grama que caiu num cartão de grama). Sem o alfa, ao menos a forma aparece.
        for mat in bpy.data.materials:
            for link in list(mat.node_tree.links) if mat.node_tree else []:
                if link.to_socket.name == 'Alpha':
                    mat.node_tree.links.remove(link)
        bpy.ops.render.render(write_still=True)
    return True


def blank(path):
    """Imagem só com o fundo: quase sem variação."""
    img = bpy.data.images.load(path)
    pixels = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(pixels)
    bpy.data.images.remove(img)
    return float(pixels.reshape(-1, 4)[:, :3].std()) < 0.01


def main():
    listfile, outdir = sys.argv[sys.argv.index('--') + 1:]
    os.makedirs(outdir, exist_ok=True)
    items = [line.split('\t') for line in open(listfile, encoding='utf-8').read().splitlines() if line.strip()]
    done, t0 = 0, time.time()
    for pack, rel in items:
        out = os.path.join(outdir, rel.replace('/', '__')[:-4] + '.jpg')
        if os.path.exists(out):
            continue
        try:
            ok = render(pack, rel, out)
        except Exception as err:
            ok = False
            print(f'[mini] erro {rel}: {err}', flush=True)
        if not ok:
            # Marca o que não tem malha, para não tentar de novo.
            open(out + '.vazio', 'w').close()
        done += 1
        if done % 200 == 0:
            print(f'[mini] {done} em {time.time() - t0:.0f}s', flush=True)
    print(f'[mini] fim: {done} novas em {time.time() - t0:.0f}s', flush=True)


main()
