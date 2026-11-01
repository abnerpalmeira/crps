"""
Converte os modelos da Synty (FBX em assets/synty, fora do git) em GLB leves para o 3D.

Uso: blender -b --python scripts/assets/convert_synty.py -- <catalogo.json> <assets/synty> <public/models> [partes]

- Móveis: um GLB só com a geometria, em metros, com a origem no centro da base.
- Personagens: malha e esqueleto, com os ossos renomeados para os nomes do esqueleto das animações.
- Animações: um GLB por clipe e por sexo, transferido para o esqueleto dos personagens; o cliente
  carrega cada clipe quando precisa dele.

A cor vem da textura-paleta do pacote, que o cliente aplica (uma por pacote e variante). O
catalog.json gerado diz arquivo, pacote e tamanho de cada modelo e com que peças cada tipo de
móvel do motor é montado.

`partes` (opcional, separadas por vírgula: props, characters, anims) refaz só essas e mantém o resto
do catalog.json anterior; assar as animações leva minutos e não precisa refazer os móveis.
"""

import json
import math
import os
import shutil
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synty_blender import rename_bones  # noqa: E402

args = sys.argv[sys.argv.index('--') + 1 :]
catalog_path, src_root, out_root = args[:3]
sections = set(args[3].split(',')) if len(args) > 3 else {'props', 'characters', 'anims'}
catalog = json.load(open(catalog_path, encoding='utf-8'))
previous_path = os.path.join(out_root, 'catalog.json')
previous = json.load(open(previous_path, encoding='utf-8')) if os.path.exists(previous_path) and len(args) > 3 else {}
# Texturas acompanham os móveis e os personagens, que as usam.
for sub in [s for s in ('props', 'characters', 'anims') if s in sections] + (['textures'] if sections & {'props', 'characters'} else []):
    shutil.rmtree(os.path.join(out_root, sub), ignore_errors=True)
    os.makedirs(os.path.join(out_root, sub), exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(rel):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(src_root, rel), use_image_search=False)
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
        # Só a ação ativa: cada clipe vai num arquivo. Chaves repetidas (dedos parados) saem.
        **({'export_animation_mode': 'ACTIVE_ACTIONS', 'export_force_sampling': True, 'export_optimize_animation_size': True} if animations else {}),
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


def depth_levels(arm):
    """Ossos agrupados por profundidade: os de um nível só dependem dos níveis de cima."""
    def depth(b):
        return 0 if b.parent is None else 1 + depth(b.parent)
    levels = {}
    for b in arm.data.bones:
        levels.setdefault(depth(b), []).append(b.name)
    return [levels[d] for d in sorted(levels)]


def pose_from(target, source, tpose_source, tpose_target, levels, hips_ratio):
    """Copia a pose do esqueleto `source` para `target` em espaço de mundo, usando a pose em T de
    cada um como referência comum (os arquivos de animação têm outra pose de repouso). Um nível
    de ossos por vez: cada osso precisa da pose já calculada do pai."""
    for level in levels:
        for name in level:
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


# O esqueleto olha para -Y no Blender: a direita é -X e o eixo lateral (para erguer o que aponta
# para a frente) é X.
FORWARD, RIGHT, UP = Vector((0, -1, 0)), Vector((-1, 0, 0)), Vector((0, 0, 1))


def world_rotate(target, name, rotation):
    """Gira o osso no espaço do mundo em volta da própria cabeça; os filhos acompanham."""
    bone = target.pose.bones[name]
    current = target.matrix_world @ bone.matrix
    bone.matrix = target.matrix_world.inverted() @ Matrix.LocRotScale(current.to_translation(), rotation @ current.to_quaternion(), current.to_scale())
    bpy.context.view_layer.update()


def point_bone(target, name, child, direction):
    """Gira o osso pelo menor caminho até o membro (da cabeça dele à do filho) apontar para
    `direction`, no mundo. A ponta dos ossos da Synty não segue o membro: o ombro aponta para o lado."""
    head = target.matrix_world @ target.pose.bones[name].head
    current = (target.matrix_world @ target.pose.bones[child].head) - head
    world_rotate(target, name, current.normalized().rotation_difference(direction.normalized()))


def set_hips(target, rotation=None, height=None, drop=0.0):
    hips = target.pose.bones['Hips']
    current = target.matrix_world @ hips.matrix
    position = current.to_translation()
    if height is not None:
        position.z = height
    position.z -= drop
    turned = (rotation @ current.to_quaternion()) if rotation else current.to_quaternion()
    hips.matrix = target.matrix_world.inverted() @ Matrix.LocRotScale(position, turned, current.to_scale())
    bpy.context.view_layer.update()


def op_sit(target, rig, k, n, args):
    """Sentado num assento: coxas para a frente, canelas para baixo, quadril no assento."""
    for name, angle in (('UpperLeg_L', -90), ('UpperLeg_R', -90), ('LowerLeg_L', 90), ('LowerLeg_R', 90)):
        world_rotate(target, name, Quaternion((1, 0, 0), math.radians(angle)))
    set_hips(target, drop=rig['drop'])


def op_floor(target, rig, k, n, args):
    """Sentado no chão: pernas esticadas para a frente, quadril quase no chão."""
    for name in ('UpperLeg_L', 'UpperLeg_R'):
        world_rotate(target, name, Quaternion((1, 0, 0), math.radians(-88)))
    set_hips(target, height=args.get('height', 0.13))


def op_lie(target, rig, k, n, args):
    """Deitado de costas: o corpo todo deita para trás, com o quadril na altura do colchão."""
    set_hips(target, rotation=Quaternion((1, 0, 0), math.radians(-90)), height=args.get('height', 0.14))


def op_hands_up(target, rig, k, n, args):
    """Mãos ao alto: braços abertos para cima, antebraços na vertical."""
    for side, sign, suffix in (('R', 1, '_1'), ('L', -1, '')):
        point_bone(target, f'Shoulder_{side}', f'Elbow_{side}', RIGHT * (0.8 * sign) + UP * 0.55 + FORWARD * 0.12)
        point_bone(target, f'Elbow_{side}', f'Hand_{side}', UP + FORWARD * 0.08 + RIGHT * (0.12 * sign))
        point_bone(target, f'Hand_{side}', f'Finger_01{suffix}', UP + RIGHT * (0.05 * sign))


def op_recoil(target, rig, k, n, args):
    """Coice do tiro: os ossos erguem de uma vez até `angle` graus no quadro `peak` e voltam até `end`."""
    peak, end, angle = args.get('peak', 2), args.get('end', 10), args.get('angle', 12)
    a = angle * (k / peak if k <= peak else max(0.0, 1 - (k - peak) / (end - peak)))
    for name in args.get('bones', ['Shoulder_R']):
        world_rotate(target, name, Quaternion((1, 0, 0), math.radians(-a)))


OPS = {'sit': op_sit, 'floor': op_floor, 'lie': op_lie, 'hands_up': op_hands_up, 'recoil': op_recoil}


def anim_index():
    """Arquivo de cada clipe pelo nome, nos pacotes de animação; a versão Polygon (a do esqueleto
    dos personagens) ganha das outras."""
    index = {}
    for pack in sorted(d for d in os.listdir(src_root) if d.startswith('anim_')):
        for root, _, files in os.walk(os.path.join(src_root, pack)):
            for f in files:
                if not f.lower().endswith('.fbx'):
                    continue
                rel = os.path.relpath(os.path.join(root, f), src_root)
                stem = f[:-4]
                if stem not in index or ('/Polygon/' in rel and '/Polygon/' not in index[stem]):
                    index[stem] = rel
    return index


def resolve(name, Sex, Sx, index):
    """Caminho do arquivo de um clipe: um caminho com {Sex}/{Sx} ou só o nome do arquivo."""
    name = name.replace('{Sex}', Sex).replace('{Sx}', Sx)
    if name.lower().endswith('.fbx'):
        return name
    if name not in index:
        raise RuntimeError(f'{name} não está nos pacotes de animação')
    return index[name]


def setup_rig():
    """Esqueleto dos personagens, sem malha, pronto para receber clipes."""
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

    def rest_z(name):
        return (target.matrix_world @ target.data.bones[name].head_local).z

    target.animation_data_create()
    return target, {
        'tpose_source': tpose_source,
        'tpose_target': world_rest(target),
        'levels': depth_levels(target),
        'hips_ratio': rest_z('Hips') / ref_hips,
        'drop': rest_z('UpperLeg_L') - rest_z('LowerLeg_L'),
    }


def retarget(target, rig, source):
    for bone in target.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    pose_from(target, source, rig['tpose_source'], rig['tpose_target'], rig['levels'], rig['hips_ratio'])


def bake_clip(target, rig, clip, spec, Sex, Sx, index, outdir):
    """Um clipe no esqueleto dos personagens, gravado sozinho em outdir/clip.glb.

    spec: o arquivo (nome ou caminho) ou {src, hold, length, range, over, op, args}. `hold` congela
    um quadro (pose parada, `length` quadros); `range` corta um trecho; `over` copia, de um quadro de
    outro clipe, a rotação de alguns ossos (o braço que mira por cima do corpo que respira); `op`
    monta a pose a partir da transferida (sentar, deitar, mãos ao alto, coice)."""
    spec = {'src': spec} if isinstance(spec, str) else spec
    scene = bpy.context.scene
    overlay = {}
    if spec.get('over'):
        over = spec['over']
        objs = import_fbx(resolve(over['src'], Sex, Sx, index))
        scene.frame_set(over['frame'])
        retarget(target, rig, armature_of(objs))
        overlay = {name: target.pose.bones[name].matrix_basis.copy() for name in over['bones']}
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
    objs = import_fbx(resolve(spec['src'], Sex, Sx, index))
    source = armature_of(objs)
    start, end = (int(round(f)) for f in source.animation_data.action.frame_range)
    if 'hold' in spec:
        frames = [spec['hold']] * spec.get('length', 30)
    elif 'range' in spec:
        frames = list(range(spec['range'][0], spec['range'][1] + 1))
    else:
        frames = list(range(start, end + 1))
    action = bpy.data.actions.new(clip)
    target.animation_data.action = action
    op = OPS[spec['op']] if spec.get('op') else None
    for k, frame in enumerate(frames, start=1):
        scene.frame_set(frame)
        retarget(target, rig, source)
        if overlay:
            for name, basis in overlay.items():
                target.pose.bones[name].matrix_basis = basis
            bpy.context.view_layer.update()
        if op:
            op(target, rig, k, len(frames), spec.get('args', {}))
        keyframe(target, k)
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    export_glb(os.path.join(outdir, f'{clip}.glb'), animations=True)
    target.animation_data.action = None
    bpy.data.actions.remove(action)
    return len(frames)


def keyframe(target, frame):
    for bone in target.pose.bones:
        bone.keyframe_insert('rotation_quaternion', frame=frame)
    target.pose.bones['Hips'].keyframe_insert('location', frame=frame)


def bake_clips(sex, index):
    """Os clipes de um sexo, um arquivo por clipe em anims/<sexo>/; o GLB não tem malha."""
    Sex, Sx = ('Masculine', 'Masc') if sex == 'masc' else ('Feminine', 'Femn')
    target, rig = setup_rig()
    outdir = os.path.join(out_root, 'anims', sex)
    os.makedirs(outdir, exist_ok=True)
    done, failed = {}, []
    for clip, spec in catalog['clips'].items():
        try:
            done[clip] = bake_clip(target, rig, clip, spec, Sex, Sx, index, outdir)
        except Exception as err:  # um clipe ruim não derruba os outros
            failed.append(clip)
            print(f'[synty] ERRO no clipe {clip} ({sex}): {err}')
    size = sum(os.path.getsize(os.path.join(outdir, f'{c}.glb')) for c in done)
    print(f'[synty] animações {sex}: {len(done)} clipes, {size // 1024} KB{f"; falharam {failed}" if failed else ""}')
    return {'dir': f'anims/{sex}', 'clips': sorted(done), 'bytes': size}


result = {'textures': {}, 'props': {}, 'fixtures': {}, 'characters': {}, 'anims': {}}
for key in ('textures', 'props', 'fixtures', 'characters', 'anims'):
    result[key] = previous.get(key, result[key])
if sections & {'props', 'characters'}:
    result['textures'] = {}
    for pack, variants in catalog['textures'].items():
        result['textures'][pack] = []
        for i, rel in enumerate(variants):
            name = f'textures/{pack}_{i}.png'
            shutil.copyfile(os.path.join(src_root, rel), os.path.join(out_root, name))
            result['textures'][pack].append(name)

for section, convert in (('props', convert_prop), ('characters', convert_character)):
    if section not in sections:
        continue
    result[section] = {}
    for entry in catalog.get(section, []):
        try:
            result[section][entry['id']] = convert(entry)
            print(f"[synty] {entry['id']}: {result[section][entry['id']]}")
        except Exception as err:  # um modelo ruim não derruba o resto
            print(f"[synty] ERRO em {entry['id']}: {err}")

result['seats'] = catalog.get('seats', {})
result['fixtures'] = {}
for kind, parts in catalog.get('fixtures', {}).items():
    # Uma lista de listas são variantes do mesmo tipo de objeto.
    flat = [p for v in parts for p in v] if parts and isinstance(parts[0], list) else parts
    missing = [p['model'] for p in flat if p['model'] not in result['props']]
    if missing:
        print(f"[synty] ERRO: {kind} usa modelos que não converteram: {', '.join(missing)}")
        continue
    result['fixtures'][kind] = parts

if catalog.get('clips') and 'anims' in sections:
    result['anims'] = {}
    index = anim_index()
    for sex in ('masc', 'femn'):
        try:
            result['anims'][sex] = bake_clips(sex, index)
        except Exception as err:
            print(f'[synty] ERRO nas animações {sex}: {err}')

with open(os.path.join(out_root, 'catalog.json'), 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"[synty] {len(result['props'])} móveis, {len(result['characters'])} personagens, {len(result['anims'])} conjuntos de animação em {out_root}")
