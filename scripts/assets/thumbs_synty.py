"""
Miniaturas dos modelos da Synty para catalogar olhando: cada FBX renderizado no Blender, com a
textura de cada material que o MaterialList do pacote e o próprio FBX dão (synty_textures.py), de
frente e um pouco de lado e de cima. Só o LOD0 entra; os outros LODs ficam no mesmo lugar e sujam
a imagem.

Uso: blender -b --python scripts/assets/thumbs_synty.py -- LISTA SAIDA

LISTA tem uma linha por modelo, "pacote<TAB>caminho em assets/synty". Cada miniatura vai para
SAIDA/<caminho com / trocado por __>.jpg; as que já existem são puladas, então dá para retomar
e dividir a lista entre vários processos.
"""

import os
import re
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synty_textures import ROOT, cutouts, slot_list, textures_for, tinted, trunks_for  # noqa: E402

SIZE = 176
CUTOUTS = cutouts()
TINTED = tinted()
# Verde de folhagem para as folhas cinzentas que o Unity tinge.
LEAF_GREEN = (0.42, 0.58, 0.26, 1)


def material(path, made):
    """Material com a textura, ou cinza liso para material sem textura (vidro, cor chapada); um
    por textura em cada render. Textura com recorte usa o alfa."""
    if path not in made:
        mat = bpy.data.materials.new('atlas')
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Roughness'].default_value = 0.8
        if path:
            tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
            tex.image = bpy.data.images.load(path, check_existing=True)
            mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
            if path in TINTED:
                mix = mat.node_tree.nodes.new('ShaderNodeMix')
                mix.data_type, mix.blend_type = 'RGBA', 'MULTIPLY'
                mix.inputs['Factor'].default_value = 1
                mix.inputs['B'].default_value = LEAF_GREEN
                mat.node_tree.links.new(tex.outputs['Color'], mix.inputs['A'])
                mat.node_tree.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
            if path in CUTOUTS:
                mat.node_tree.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
        else:
            bsdf.inputs['Base Color'].default_value = (0.6, 0.62, 0.66, 1)
        made[path] = mat
    return made[path]


def lod0(scene):
    """Tira os LODs maiores que 0 quando o LOD0 está no arquivo, e as malhas de colisão do Unreal
    (UCX_, UBX_...), que não aparecem no jogo e esticam o enquadramento."""
    names = {o.name for o in scene.objects}
    for o in list(scene.objects):
        m = re.match(r'(.*)_LOD([1-9])$', o.name)
        if (m and f'{m.group(1)}_LOD0' in names) or re.match(r'U(CX|BX|SP|CP)_|.*collision', o.name, re.I):
            bpy.data.objects.remove(o)


def diffuse(mat):
    """Arquivo da imagem que o FBX liga à cor base do material, ou None."""
    if not mat or not mat.node_tree:
        return None
    for link in mat.node_tree.links:
        if link.to_socket.name == 'Base Color' and link.from_node.type == 'TEX_IMAGE' and link.from_node.image:
            return os.path.basename(link.from_node.image.filepath.replace('\\', '/')) or link.from_node.image.name
    return None


def split_trunk(o, k, leaf, trunk, made):
    """Material de vegetação com folha e tronco: as faces do material k cujo UV cai todo no
    transparente da textura de folha (centro e cantos) são do tronco e passam para um material com
    a textura do tronco. Basta um ponto opaco para a face ser folha: o centro de um cartão de folhas
    às vezes cai num vão entre elas. Quando mais de 70% das faces iriam para o tronco, são os
    cartões de folha que caem no vazio (árvore frutífera, arbusto tropical), e nada muda."""
    img = bpy.data.images.load(leaf, check_existing=True)
    w, h = img.size
    uv = o.data.uv_layers.active
    if not w or not h or not uv:
        return
    pixels = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(pixels)
    alpha = pixels[3::4].reshape(h, w)
    faces = [p for p in o.data.polygons if p.material_index == k]
    bare = []
    for poly in faces:
        us = [(u.x, u.y) for u in (uv.data[i].uv for i in poly.loop_indices)]
        points = us + [(sum(x for x, _ in us) / len(us), sum(y for _, y in us) / len(us))]
        if all(alpha[int((y % 1) * (h - 1)), int((x % 1) * (w - 1))] < 0.5 for x, y in points):
            bare.append(poly)
    if not bare or len(bare) > 0.7 * len(faces):
        return
    o.data.materials.append(material(trunk, made))
    for poly in bare:
        poly.material_index = len(o.material_slots) - 1


def paint(pack, model, meshes):
    """Cada material de cada objeto com a sua textura (synty_textures.slot_path), juntando o que a
    lista e o próprio FBX dizem. O nome do objeto no FBX é o da lista, tirando o sufixo .001 do
    Blender; quando a lista tem um objeto só e o FBX também, valem como o mesmo."""
    listed = slot_list(pack).get(model, {})
    names = {}
    for o in meshes:
        name = re.sub(r'\.\d+$', '', o.name)
        names[o.name] = next(iter(listed)) if name not in listed and len(listed) == 1 and len(meshes) == 1 else name
    slots, main = textures_for(pack, model, {names[o.name]: [diffuse(s.material) for s in o.material_slots] for o in meshes})
    trunks = trunks_for(pack, model)
    made = {}
    for o in meshes:
        paths, trunk = slots.get(names[o.name], []), trunks.get(names[o.name], [])
        if not o.material_slots:
            o.data.materials.append(None)
        for k, slot in enumerate(list(o.material_slots)):
            path = paths[k] if k < len(paths) else main
            slot.material = material(path, made)
            if path in CUTOUTS and k < len(trunk) and trunk[k] and trunk[k] != path:
                split_trunk(o, k, path, trunk[k], made)


def render(pack, rel, out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = 85
    bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, rel))
    lod0(scene)
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
