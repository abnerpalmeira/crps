"""
Grades de miniaturas para catalogar olhando: cada grade junta modelos da mesma categoria, com o
número e o nome embaixo de cada um, e um JSON ao lado diz qual modelo é cada número.

Uso: python3 scripts/assets/sheets_synty.py

Lê assets/synty/_catalogo/fila.json (a ordem dos modelos) e as miniaturas de
_catalogo/miniaturas, e escreve _catalogo/grades/NNNN.jpg e NNNN.json. Personagens e animais vão
48 por grade, maiores, porque a roupa importa; o resto, 100 por grade. Grade pronta é pulada, a não
ser que alguma miniatura dela tenha sido refeita depois; grade com miniatura faltando espera a
próxima rodada.
"""

import json
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'synty', '_catalogo'))
BIG = {'personagem', 'animal'}
PREFIXES = ('SK_Chr_', 'SK_Character_', 'SM_Prop_', 'SM_Env_', 'SM_Bld_', 'SM_Veh_', 'SM_Wep_', 'SM_Item_', 'SM_Chr_', 'SM_Gen_', 'SK_')


def thumb(item):
    return os.path.join(ROOT, 'miniaturas', item['src'].replace('/', '__')[:-4] + '.jpg')


def stale(items, sheet):
    """Grade montada antes de alguma das suas miniaturas, que foi refeita depois dela."""
    t = os.path.getmtime(sheet)
    return any(os.path.exists(thumb(i)) and os.path.getmtime(thumb(i)) > t for i in items)


def groups(queue):
    """Fatias da fila: cada uma de uma categoria só, com 48 ou 100 modelos."""
    out, start = [], 0
    while start < len(queue):
        cat = queue[start]['category']
        size = 48 if cat in BIG else 100
        end = start
        while end < len(queue) and end - start < size and queue[end]['category'] == cat:
            end += 1
        out.append((cat, queue[start:end]))
        start = end
    return out


def compose(items, cat, out):
    cols, tile = (8, 176) if cat in BIG else (10, 128)
    label = 26
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * tile, rows * (tile + label)), (40, 42, 48))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 11)
    except OSError:
        font = ImageFont.load_default()
    for n, item in enumerate(items):
        x, y = (n % cols) * tile, (n // cols) * (tile + label)
        if os.path.exists(thumb(item)):
            sheet.paste(Image.open(thumb(item)).convert('RGB').resize((tile, tile)), (x, y))
        name = item['id'].split(':', 1)[1]
        name = next((name[len(p):] for p in PREFIXES if name.startswith(p)), name)
        draw.text((x + 3, y + tile + 2), str(n), fill=(240, 179, 90), font=font)
        draw.text((x + 3, y + tile + 13), name[: 22 if tile == 128 else 30], fill=(220, 220, 220), font=font)
    sheet.save(out, quality=85)


def main():
    queue = json.load(open(os.path.join(ROOT, 'fila.json'), encoding='utf-8'))
    os.makedirs(os.path.join(ROOT, 'grades'), exist_ok=True)
    made = waiting = 0
    for k, (cat, items) in enumerate(groups(queue)):
        base = os.path.join(ROOT, 'grades', f'{k:04d}')
        if os.path.exists(base + '.jpg') and not stale(items, base + '.jpg'):
            continue
        if not all(os.path.exists(thumb(i)) or os.path.exists(thumb(i) + '.vazio') for i in items):
            waiting += 1
            continue
        if os.path.exists(os.path.join(ROOT, 'descricoes', f'{k:04d}.jsonl')):
            print(f'[grades] {k:04d} foi descrita com miniaturas antigas: olhe de novo')
        compose(items, cat, base + '.jpg')
        with open(base + '.json', 'w', encoding='utf-8') as f:
            json.dump({'category': cat, 'items': [{'n': n, **i} for n, i in enumerate(items)]}, f, ensure_ascii=False)
        made += 1
    print(f'[grades] {made} novas, {waiting} esperando miniaturas, {len(groups(queue))} no total')


main()
