"""
Converte os modelos da Synty (FBX em assets/synty, fora do git) em GLB leves para o 3D.

Uso: blender -b --python scripts/assets/convert_synty.py -- <catalogo.json> <assets/synty> <public/models>

- Móveis: um GLB só com a geometria, em metros, com a origem no centro da base.
- Personagens: malha e esqueleto, com os ossos renomeados para os nomes do esqueleto das animações.
- Animações: um GLB por sexo, com os clipes transferidos para o esqueleto dos personagens.

A cor vem da textura-paleta do pacote, que o cliente aplica (uma por pacote e variante). O
catalog.json gerado diz arquivo, pacote e tamanho de cada modelo e com que peças cada tipo de
móvel do motor é montado.
"""

import json
import math
import os
import shutil
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

catalog_path, src_root, out_root = sys.argv[sys.argv.index('--') + 1 :][:3]
catalog = json.load(open(catalog_path, encoding='utf-8'))
for sub in ('props', 'characters', 'anims', 'textures'):
    shutil.rmtree(os.path.join(out_root, sub), ignore_errors=True)
    os.makedirs(os.path.join(out_root, sub), exist_ok=True)

# Esqueleto antigo dos personagens POLYGON (Pelvis, spine_01, UpperArm_L…) → nomes do esqueleto
# das animações (Hips, Spine_01, Shoulder_L…). Os dedos da mão direita levam o sufixo _1.
BONES = {'pelvis': 'Hips', 'spine_01': 'Spine_01', 'spine_02': 'Spine_02', 'spine_03': 'Spine_03', 'neck_01': 'Neck', 'head': 'Head', 'eyes': 'Eyes', 'eyebrows': 'Eyebrows'}
for side, suffix in (('l', ''), ('r', '_1')):
    S = side.upper()
    BONES.update({
        f'clavicle_{side}': f'Clavicle_{S}', f'upperarm_{side}': f'Shoulder_{S}', f'lowerarm_{side}': f'Elbow_{S}', f'hand_{side}': f'Hand_{S}',
        f'thigh_{side}': f'UpperLeg_{S}', f'calf_{side}': f'LowerLeg_{S}', f'foot_{side}': f'Ankle_{S}', f'ball_{side}': f'Ball_{S}', f'toes_{side}': f'Toes_{S}',
    })
    for i in (1, 2, 3):
        BONES[f'thumb_0{i}_{side}'] = f'Thumb_0{i}{suffix}'
    for i in (1, 2, 3, 4):
        BONES[f'indexfinger_0{i}_{side}'] = f'IndexFinger_0{i}{suffix}'
        BONES[f'finger_0{i}_{side}'] = f'Finger_0{i}{suffix}'


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(rel):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(src_root, rel))
    return [o for o in bpy.data.objects if o not in before]


def armature_of(objects):
    return next(o for o in objects if o.type == 'ARMATURE')


def export_glb(path, animations=False, skins=False):
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
        export_animations=animations,
        **({'export_animation_mode': 'ACTIONS', 'export_force_sampling': True} if animations else {}),
    )


def drop_extras():
    # Malhas de colisão e LODs extras não vão para o jogo.
    for o in list(bpy.data.objects):
        name = o.name.lower()
        if o.type == 'MESH' and ('collision' in name or '_lod' in name):
            bpy.data.objects.remove(o, do_unlink=True)


def set_material(meshes, pack):
    material = bpy.data.materials.new(f'atlas_{pack}')
    for o in meshes:
        o.data.materials.clear()
        o.data.materials.append(material)


def convert_prop(entry):
    reset()
    import_fbx(entry['src'])
    drop_extras()
    for o in list(bpy.data.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    meshes = list(bpy.context.scene.objects)
    if not meshes:
        raise RuntimeError(f"{entry['src']}: nenhuma malha")
    set_material(meshes, entry['pack'])
    for o in meshes:
        # Só nas peças-raiz: as filhas (rodas da carroceria) já herdam a escala do pai.
        if o.parent is None:
            o.scale *= entry.get('scale', 1)
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    # Origem no centro da base: o cliente só precisa pôr o modelo no chão do tile.
    obj.data.transform(Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))))
    obj.location = (0, 0, 0)
    obj.name = entry['id']
    out = os.path.join(out_root, 'props', f"{entry['id']}.glb")
    export_glb(out)
    size = hi - lo
    if max(size) < 0.05:
        print(f"[synty] AVISO: {entry['id']} mede {max(size):.3f} m; falta \"scale\" no catálogo?")
    # Blender é Z para cima; no glTF (Y para cima) a largura é x, a altura z e a profundidade y.
    return {'file': f"props/{entry['id']}.glb", 'pack': entry['pack'], 'size': [round(size.x, 3), round(size.z, 3), round(size.y, 3)], 'bytes': os.path.getsize(out)}


def rename_bones(arm):
    for bone in arm.data.bones:
        new = BONES.get(bone.name.lower())
        if new:
            bone.name = new  # o Blender renomeia junto os grupos de vértices das malhas


def convert_character(entry):
    reset()
    objects = import_fbx(entry['src'])
    drop_extras()
    arm = armature_of(objects)
    rename_bones(arm)
    arm.animation_data_clear()
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    set_material(meshes, entry['pack'])
    head = arm.matrix_world @ arm.data.bones['Head'].head_local
    out = os.path.join(out_root, 'characters', f"{entry['id']}.glb")
    export_glb(out, skins=True)
    return {
        'file': f"characters/{entry['id']}.glb",
        'pack': entry['pack'],
        'figure': entry['figure'],
        'look': entry.get('look', ''),
        'head': round(head.z, 3),
        'bytes': os.path.getsize(out),
    }


def world_rest(arm):
    return {b.name: (arm.matrix_world @ b.matrix_local).to_quaternion() for b in arm.data.bones}


def depth_order(arm):
    def depth(b):
        return 0 if b.parent is None else 1 + depth(b.parent)
    return [b.name for b in sorted(arm.data.bones, key=depth)]


def pose_from(target, source, tpose_source, tpose_target, order, hips_ratio):
    """Copia a pose do esqueleto `source` para `target` em espaço de mundo, usando a pose em T de
    cada um como referência comum (os arquivos de animação têm outra pose de repouso)."""
    for name in order:
        src = source.pose.bones.get(name)
        if src is None or name not in tpose_source:
            continue
        bone = target.pose.bones[name]
        world_src = source.matrix_world @ src.matrix
        rotation = world_src.to_quaternion() @ tpose_source[name].inverted() @ tpose_target[name]
        current = target.matrix_world @ bone.matrix
        position = world_src.to_translation() * hips_ratio if name == 'Hips' else current.to_translation()
        bone.matrix = target.matrix_world.inverted() @ Matrix.LocRotScale(position, rotation, current.to_scale())
        bpy.context.view_layer.update()


def sit(target, drop):
    """Pose sentada a partir da pose atual: coxas para a frente, canelas para baixo, quadril no assento."""
    for name, angle in (('UpperLeg_L', -90), ('UpperLeg_R', -90), ('LowerLeg_L', 90), ('LowerLeg_R', 90)):
        bone = target.pose.bones[name]
        current = target.matrix_world @ bone.matrix
        rotation = Quaternion((1, 0, 0), math.radians(angle)) @ current.to_quaternion()
        bone.matrix = target.matrix_world.inverted() @ Matrix.LocRotScale(current.to_translation(), rotation, current.to_scale())
        bpy.context.view_layer.update()
    hips = target.pose.bones['Hips']
    current = target.matrix_world @ hips.matrix
    hips.matrix = target.matrix_world.inverted() @ Matrix.LocRotScale(current.to_translation() - Vector((0, 0, drop)), current.to_quaternion(), current.to_scale())
    bpy.context.view_layer.update()


def keyframe(target, frame):
    for bone in target.pose.bones:
        bone.keyframe_insert('rotation_quaternion', frame=frame)
    target.pose.bones['Hips'].keyframe_insert('location', frame=frame)


def bake_clips(sex):
    """Esqueleto dos personagens com os clipes de um sexo; o GLB não tem malha."""
    Sex, Sx = ('Masculine', 'Masc') if sex == 'masc' else ('Feminine', 'Femn')
    reset()
    reference = import_fbx(catalog['reference'])
    ref_arm = armature_of(reference)
    tpose_source = world_rest(ref_arm)
    ref_hips = (ref_arm.matrix_world @ ref_arm.data.bones['Hips'].head_local).z
    for o in reference:
        bpy.data.objects.remove(o, do_unlink=True)
    rig = import_fbx(catalog['rig'])
    target = armature_of(rig)
    rename_bones(target)
    target.animation_data_clear()
    for o in rig:
        if o.type == 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    target.name = 'Rig'
    for bone in target.pose.bones:
        bone.rotation_mode = 'QUATERNION'
    tpose_target = world_rest(target)
    order = depth_order(target)

    def rest_z(name):
        return (target.matrix_world @ target.data.bones[name].head_local).z

    hips_ratio = rest_z('Hips') / ref_hips
    drop = rest_z('UpperLeg_L') - rest_z('LowerLeg_L')
    target.animation_data_create()
    clips = dict(catalog['clips'])
    clips['sit'] = clips['idle']
    lengths = {}
    for clip, pattern in clips.items():
        source_objs = import_fbx(pattern.replace('{Sex}', Sex).replace('{Sx}', Sx))
        source = armature_of(source_objs)
        start, end = (int(round(f)) for f in source.animation_data.action.frame_range)
        action = bpy.data.actions.new(clip)
        action.use_fake_user = True
        target.animation_data.action = action
        for frame in range(start, end + 1):
            bpy.context.scene.frame_set(frame)
            for bone in target.pose.bones:
                bone.matrix_basis = Matrix.Identity(4)
            bpy.context.view_layer.update()
            pose_from(target, source, tpose_source, tpose_target, order, hips_ratio)
            if clip == 'sit':
                sit(target, drop)
            keyframe(target, frame - start + 1)
        lengths[clip] = end - start + 1
        for o in source_objs:
            bpy.data.objects.remove(o, do_unlink=True)
    target.animation_data.action = None
    out = os.path.join(out_root, 'anims', f'{sex}.glb')
    export_glb(out, animations=True)
    print(f"[synty] animações {sex}: {lengths}")
    return {'file': f'anims/{sex}.glb', 'clips': sorted(clips), 'bytes': os.path.getsize(out)}


result = {'textures': {}, 'props': {}, 'fixtures': {}, 'characters': {}, 'anims': {}}
for pack, variants in catalog['textures'].items():
    result['textures'][pack] = []
    for i, rel in enumerate(variants):
        name = f'textures/{pack}_{i}.png'
        shutil.copyfile(os.path.join(src_root, rel), os.path.join(out_root, name))
        result['textures'][pack].append(name)

for section, convert in (('props', convert_prop), ('characters', convert_character)):
    for entry in catalog.get(section, []):
        try:
            result[section][entry['id']] = convert(entry)
            print(f"[synty] {entry['id']}: {result[section][entry['id']]}")
        except Exception as err:  # um modelo ruim não derruba o resto
            print(f"[synty] ERRO em {entry['id']}: {err}")

result['seats'] = catalog.get('seats', {})
for kind, parts in catalog.get('fixtures', {}).items():
    # Uma lista de listas são variantes do mesmo tipo de objeto.
    flat = [p for v in parts for p in v] if parts and isinstance(parts[0], list) else parts
    missing = [p['model'] for p in flat if p['model'] not in result['props']]
    if missing:
        print(f"[synty] ERRO: {kind} usa modelos que não converteram: {', '.join(missing)}")
        continue
    result['fixtures'][kind] = parts

if catalog.get('clips'):
    for sex in ('masc', 'femn'):
        try:
            result['anims'][sex] = bake_clips(sex)
        except Exception as err:
            print(f'[synty] ERRO nas animações {sex}: {err}')

with open(os.path.join(out_root, 'catalog.json'), 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"[synty] {len(result['props'])} móveis, {len(result['characters'])} personagens, {len(result['anims'])} conjuntos de animação em {out_root}")
