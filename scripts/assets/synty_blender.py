"""
O que as miniaturas do catálogo (thumbs_synty.py) e a conversão para o jogo (convert_model.py)
fazem igual no Blender, para o jogo mostrar o que o catálogo descreve: limpar o FBX (LODs e malhas
de colisão), dar a cada material a sua textura (synty_textures) com recorte, tom das folhas
cinzentas e tronco separado da folha, e renomear os ossos dos personagens para o esqueleto das
animações.
"""

import hashlib
import os
import re
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synty_textures import ROOT, cutouts, slot_list, textures_for, tinted, trunks_for  # noqa: E402

CUTOUTS = cutouts()
TINTED = tinted()
# Verde de folhagem para as folhas cinzentas que o Unity tinge.
LEAF_GREEN = (0.42, 0.58, 0.26, 1)

# Esqueleto antigo dos personagens POLYGON (Pelvis, spine_01, UpperArm_L…) → nomes do esqueleto
# das animações (Hips, Spine_01, Shoulder_L…). Os dedos da mão direita levam o sufixo _1.
BONES = {'pelvis': 'Hips', 'spine_01': 'Spine_01', 'spine_02': 'Spine_02', 'spine_03': 'Spine_03', 'neck_01': 'Neck', 'head': 'Head', 'eyes': 'Eyes', 'eyebrows': 'Eyebrows'}
for _side, _suffix in (('l', ''), ('r', '_1')):
    _S = _side.upper()
    BONES.update({
        f'clavicle_{_side}': f'Clavicle_{_S}', f'upperarm_{_side}': f'Shoulder_{_S}', f'lowerarm_{_side}': f'Elbow_{_S}', f'hand_{_side}': f'Hand_{_S}',
        f'thigh_{_side}': f'UpperLeg_{_S}', f'calf_{_side}': f'LowerLeg_{_S}', f'foot_{_side}': f'Ankle_{_S}', f'ball_{_side}': f'Ball_{_S}', f'toes_{_side}': f'Toes_{_S}',
    })
    for _i in (1, 2, 3):
        BONES[f'thumb_0{_i}_{_side}'] = f'Thumb_0{_i}{_suffix}'
    for _i in (1, 2, 3, 4):
        BONES[f'indexfinger_0{_i}_{_side}'] = f'IndexFinger_0{_i}{_suffix}'
        BONES[f'finger_0{_i}_{_side}'] = f'Finger_0{_i}{_suffix}'


def texture_key(path):
    """Nome curto e estável de uma textura (pelo caminho em assets/synty), ou "liso" sem textura."""
    return hashlib.sha1(os.path.relpath(path, ROOT).encode()).hexdigest()[:12] if path else 'liso'


def material(path, made):
    """Material com a textura, ou cinza liso para material sem textura (vidro, cor chapada); um
    por textura, chamado tex_<chave da textura>. Textura com recorte usa o alfa."""
    if path not in made:
        mat = bpy.data.materials.new(f'tex_{texture_key(path)}')
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


def clean(scene):
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
    Blender; quando a lista tem um objeto só e o FBX também, valem como o mesmo. Devolve os
    materiais criados, pela textura de cada um."""
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
    return made


def rename_bones(arm):
    for bone in arm.data.bones:
        new = BONES.get(bone.name.lower())
        if new:
            bone.name = new  # o Blender renomeia junto os grupos de vértices das malhas
