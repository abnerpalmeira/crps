"""
Mede os modelos da Synty (largura, altura e profundidade em metros), para o jogo saber o que cabe
na mão: cada FBX importado no Blender, sem os LODs maiores e as colisões, como na conversão
(convert_model.py), e medido pela caixa das malhas, sem pintar nem exportar.

Uso: blender -b --python scripts/assets/measure_synty.py -- LISTA SAIDA

LISTA tem uma linha por modelo, "id<TAB>caminho em assets/synty" (o id é o do catálogo,
pacote:Arquivo). SAIDA recebe uma linha JSON por modelo, {"id": ..., "size": [x, y, z]}, com y
para cima como no jogo; os ids que já estão nela são pulados, então dá para retomar e dividir a
lista entre vários processos.
"""

import json
import os
import sys
import time

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synty_blender import clean  # noqa: E402
from synty_textures import ROOT  # noqa: E402


def bounds(objects):
    pts = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def measure(rel):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Sem procurar as texturas: a medida não precisa delas, e a busca do importador varre pastas
    # vizinhas atrás da imagem que falta (chegou ao iCloud do usuário e parou num pedido de acesso).
    bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, rel), use_image_search=False)
    clean(bpy.context.scene)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        return None
    # Peça dez vezes maior que as outras é defeito do arquivo, e a conversão também a tira.
    boxes = [bounds([o]) for o in meshes]
    diagonals = sorted((hi - lo).length for lo, hi in boxes)
    median = diagonals[len(diagonals) // 2]
    kept = [(lo, hi) for lo, hi in boxes if len(boxes) <= 2 or (hi - lo).length <= 10 * median]
    lo = Vector((min(b[0].x for b in kept), min(b[0].y for b in kept), min(b[0].z for b in kept)))
    hi = Vector((max(b[1].x for b in kept), max(b[1].y for b in kept), max(b[1].z for b in kept)))
    size = hi - lo
    # Pacotes em centímetros (heist, dungeon): menos de 5 cm é um modelo que veio 100 vezes pequeno.
    if max(size) < 0.05:
        size *= 100
    # Blender é Z para cima; no jogo (Y para cima) a largura é x, a altura z e a profundidade y.
    return [round(size.x, 3), round(size.z, 3), round(size.y, 3)]


def main():
    listfile, out = sys.argv[sys.argv.index('--') + 1:]
    done = set()
    if os.path.exists(out):
        with open(out, encoding='utf-8') as f:
            done = {json.loads(line)['id'] for line in f if line.strip()}
    with open(listfile, encoding='utf-8') as f:
        todo = [line.rstrip('\n').split('\t') for line in f if line.strip()]
    todo = [(i, rel) for i, rel in todo if i not in done]
    start = time.time()
    with open(out, 'a', encoding='utf-8') as f:
        for n, (model_id, rel) in enumerate(todo, 1):
            try:
                size = measure(rel)
            except Exception as err:  # noqa: BLE001 - um FBX quebrado não para o lote
                print(f'[medida] {model_id}: {err}', flush=True)
                size = None
            f.write(json.dumps({'id': model_id, 'size': size}) + '\n')
            f.flush()
            if n % 200 == 0:
                print(f'[medida] {n}/{len(todo)} em {time.time() - start:.0f} s', flush=True)
    print(f'[medida] fim: {len(todo)} modelos em {time.time() - start:.0f} s', flush=True)


main()
