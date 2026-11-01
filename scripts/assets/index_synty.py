"""
Repertório dos modelos da Synty extraídos em assets/synty: o que existe, de que pacote e de que tipo.

Uso: python3 -I scripts/assets/index_synty.py

Classifica pelo nome do arquivo FBX, pelo prefixo que a Synty usa (SK_Chr = personagem, SM_Prop =
objeto, SM_Veh = veículo…) e por palavras inteiras do nome (Dog, Horse, Shark… = animal). Quando
há descrições de quem olhou as miniaturas (assets/synty/_catalogo/descricoes/*.jsonl, feitas a
partir das grades de sheets_synty.py), elas valem por cima: o que o modelo é (desc), a categoria
corrigida e, para personagens e animais, o corpo (figure) e o visual (look); sensivel marca símbolo
de ódio ou conteúdo sexual explícito, e sem_imagem, o que foi descrito só pelo nome porque a
miniatura não saiu. As medidas de measure_synty.py (assets/synty/_catalogo/medidas/*.jsonl) entram
como size, largura, altura e profundidade em metros: é por elas que o jogo sabe o que cabe na mão.
Escreve assets/synty/repertorio.json, com um item por modelo, e
assets/synty/REPERTORIO.md, o resumo por categoria e pacote. Os dois ficam fora do git, junto
dos arquivos-fonte, e são só texto: é o que pode chegar ao mestre.
"""

import json
import os
import re
from collections import Counter, defaultdict

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'synty'))

ANIMALS = {
    'dog', 'puppy', 'cat', 'kitten', 'horse', 'pony', 'donkey', 'mule', 'cow', 'bull', 'calf', 'ox', 'pig', 'piglet',
    'boar', 'chicken', 'hen', 'rooster', 'chick', 'sheep', 'lamb', 'goat', 'deer', 'stag', 'doe', 'elk', 'moose',
    'wolf', 'bear', 'fox', 'rabbit', 'bunny', 'hare', 'squirrel', 'mouse', 'rat', 'bird', 'parrot', 'crow', 'raven',
    'pigeon', 'seagull', 'gull', 'eagle', 'hawk', 'owl', 'vulture', 'duck', 'goose', 'swan', 'penguin', 'flamingo',
    'fish', 'shark', 'whale', 'dolphin', 'crab', 'lobster', 'octopus', 'squid', 'jellyfish', 'turtle', 'tortoise',
    'frog', 'toad', 'snake', 'lizard', 'crocodile', 'alligator', 'gecko', 'spider', 'scorpion', 'bat', 'bee', 'butterfly',
    'camel', 'elephant', 'giraffe', 'lion', 'tiger', 'leopard', 'panther', 'monkey', 'ape', 'gorilla', 'zebra', 'hippo',
    'rhino', 'kangaroo', 'koala', 'panda', 'raccoon', 'skunk', 'badger', 'beaver', 'otter', 'seal', 'walrus', 'yak',
    'llama', 'alpaca', 'buffalo', 'bison', 'hyena', 'jackal', 'coyote', 'cheetah', 'meerkat', 'sloth', 'dragon', 'raptor',
    'dinosaur', 'trex', 'mammoth', 'kraken', 'griffin', 'wyvern', 'hound', 'boar', 'chihuahua', 'pug', 'poodle',
    'retriever', 'shepherd', 'husky', 'dalmatian', 'beagle', 'corgi', 'terrier', 'bulldog', 'labrador', 'greyhound',
    'animal', 'animals', 'creature', 'beast',
}
# Palavras que fazem do bicho um enfeite, uma fantasia ou outra coisa: máscara de raposa, macacão de gato, bife.
NOT_ANIMAL = {'mask', 'onesie', 'tail', 'hat', 'costume', 'suit', 'kid', 'statue', 'sign', 'toy', 'plush', 'plushie',
              'trap', 'bed', 'bowl', 'food', 'cage', 'kennel', 'house', 'head', 'skull', 'sticker', 'poster', 'print',
              'painting', 'balloon', 'figure', 'ornament', 'trophy', 'meat', 'steak', 'hotdog', 'leash', 'collar',
              'kebab', 'icon', 'decal', 'logo', 'bone', 'carcass', 'pen', 'barn', 'saddle', 'shoe', 'cart', 'emblem',
              'attach', 'vest', 'tunnel', 'feeder', 'door', 'flag', 'banner', 'weathervane', 'carving', 'rug', 'pelt',
              'web', 'cobweb', 'hide', 'dead', 'gun', 'bars', 'butcher', 'medusa', 'man', 'woman', 'male', 'female',
              'boy', 'girl', 'rider', 'knight', 'warrior'}

# Peças de personagem modular (braço, olhos, sobrancelhas): o nome começa pela parte do corpo.
PARTS = {'arm', 'arms', 'leg', 'legs', 'hand', 'hands', 'hips', 'torso', 'head', 'eyebrow', 'eyebrows', 'eye', 'eyes',
         'ear', 'ears', 'hair', 'facial', 'teeth', 'mouth', 'shoulder', 'shoulders', 'elbow', 'knee', 'knees', 'chest',
         'foot', 'feet', 'body', 'face', 'beard', 'mustache', 'helmet'}

CATEGORY = [
    (re.compile(r'^a_|^anim_', re.I), 'animacao'),
    (re.compile(r'^sm_chr_attach|^sm_chr_', re.I), 'acessorio'),
    (re.compile(r'^(sk_chr|sk_character|sk_zombie|character|chr_|sk_kid|sk_bean)', re.I), 'personagem'),
    (re.compile(r'^(sm_|sk_)?wep|^sm_wep|^sk_wep', re.I), 'arma'),
    (re.compile(r'^(sm|sk)_veh', re.I), 'veiculo'),
    (re.compile(r'^sm_(bld|buildings?)', re.I), 'construcao'),
    (re.compile(r'^sm_env', re.I), 'ambiente'),
    (re.compile(r'^(sm|sk)_(prop|item|gen|generic|gerneric|tool|rune|easter|casino|obstacle|base|gib)', re.I), 'objeto'),
    (re.compile(r'^sk_br_|^(polygon|sidekick)syntycharacter|^sm_(deadbody|bean|char)_', re.I), 'personagem'),
    (re.compile(r'^sm_(plant|rubble)', re.I), 'ambiente'),
    (re.compile(r'^fx|^sm_(lightray|flame|particle|decal)|^env_', re.I), 'efeito'),
]

LABEL = {
    'personagem': 'Personagens', 'animal': 'Animais', 'objeto': 'Objetos', 'construcao': 'Construções',
    'ambiente': 'Ambiente e natureza', 'veiculo': 'Veículos', 'arma': 'Armas', 'acessorio': 'Acessórios e partes de personagem',
    'animacao': 'Animações', 'efeito': 'Efeitos', 'outro': 'Outros',
}


def words(name):
    spaced = re.sub(r'([a-z])([A-Z])', r'\1 \2', name)
    return [w.lower() for w in re.split(r'[_\s\-.]+', spaced) if w and not w.isdigit()]


def classify(stem, folders=()):
    # Prefixos de exportação que não dizem nada: Unity_SK_Animals_Dog_01, _POLYGON_Dog_Bark.
    stem = re.sub(r'^(_+|unity_|unreal_)+', '', stem, flags=re.I)
    tokens = words(stem)
    parts = {f.lower() for f in folders}
    if parts & {'animations', 'animation', 'anims'}:
        return 'animacao', [t for t in tokens if t != 'polygon']
    category = 'acessorio' if parts & {'attachments', 'attachment'} else next((c for pattern, c in CATEGORY if pattern.search(stem)), 'outro')
    # Bicho é o modelo animado (SK_), o que a pasta ou o nome dizem ser animal, ou o do cenário (SM_Env).
    # Objeto com nome de bicho (peixe assado, rede de pesca) continua objeto.
    animal = any(t in ANIMALS or (t.endswith('s') and t[:-1] in ANIMALS) for t in tokens)
    living = re.match(r'sk_', stem, re.I) or parts & {'animals', 'animal', 'creatures'} or {'animal', 'animals'} & set(tokens)
    if animal and category in ('personagem', 'ambiente', 'objeto', 'outro') and (living or category in ('personagem', 'ambiente', 'outro')) and not NOT_ANIMAL.intersection(tokens):
        category = 'animal'
    # O prefixo (SM, SK, Prop, Chr…) e o número não descrevem o modelo.
    tags = [t for t in tokens if t not in {'sm', 'sk', 'prop', 'chr', 'bld', 'env', 'veh', 'wep', 'item', 'gen', 'generic', 'fbx'}]
    if category == 'personagem' and tags and tags[0] in PARTS:
        category = 'acessorio'
    return category, tags


def seen():
    """Descrições de quem olhou as miniaturas, pelo caminho do FBX."""
    out = {}
    folder = os.path.join(ROOT, '_catalogo', 'descricoes')
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        with open(os.path.join(folder, name), encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    row = json.loads(line)
                    out[row['src']] = row
    return out


def measured():
    """Medidas de measure_synty.py, pelo id do catálogo (pacote:Arquivo)."""
    out = {}
    folder = os.path.join(ROOT, '_catalogo', 'medidas')
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if not name.endswith('.jsonl'):
            continue
        with open(os.path.join(folder, name), encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    row = json.loads(line)
                    if row.get('size'):
                        out[row['id']] = row['size']
    return out


def main():
    items = []
    looked = seen()
    sizes = measured()
    for pack in sorted(os.listdir(ROOT)):
        base = os.path.join(ROOT, pack)
        if not os.path.isdir(base) or pack.startswith('_'):
            continue
        for folder, _dirs, files in os.walk(base):
            for f in files:
                if not f.lower().endswith('.fbx'):
                    continue
                rel = os.path.relpath(os.path.join(folder, f), ROOT)
                folders = rel.split(os.sep)[1:-1]
                # Malhas de colisão são para física, não para ver.
                if 'collision' in f.lower() or any(d.lower() == 'collision' for d in folders):
                    continue
                stem = f[:-4]
                category, tags = classify(stem, folders)
                item = {'id': stem, 'pack': pack, 'src': rel, 'category': category, 'tags': tags}
                view = looked.get(rel)
                if view:
                    item.update({k: view[k] for k in ('desc', 'category', 'figure', 'look', 'sensivel', 'sem_imagem') if view.get(k)})
                if f'{pack}:{stem}' in sizes:
                    item['size'] = sizes[f'{pack}:{stem}']
                items.append(item)

    with open(os.path.join(ROOT, 'repertorio.json'), 'w', encoding='utf-8') as out:
        json.dump({'count': len(items), 'items': items}, out, ensure_ascii=False, indent=0)

    by_cat = defaultdict(list)
    for item in items:
        by_cat[item['category']].append(item)
    lines = ['# Repertório Synty', '', f'{len(items)} modelos em {len({i["pack"] for i in items})} pacotes. Gerado por scripts/assets/index_synty.py, pelos nomes dos arquivos e pelas descrições de quem olhou as miniaturas.', '']
    lines += ['| Categoria | Modelos | Pacotes |', '|---|---:|---:|']
    for cat in sorted(by_cat, key=lambda c: -len(by_cat[c])):
        lines.append(f'| {LABEL[cat]} | {len(by_cat[cat])} | {len({i["pack"] for i in by_cat[cat]})} |')
    for cat in ['personagem', 'animal', 'objeto', 'construcao', 'ambiente', 'veiculo', 'arma', 'acessorio', 'efeito', 'animacao', 'outro']:
        group = by_cat.get(cat)
        if not group:
            continue
        lines += ['', f'## {LABEL[cat]} ({len(group)})', '']
        per_pack = defaultdict(list)
        for item in group:
            per_pack[item['pack']].append(item)
        for pack, ids in sorted(per_pack.items(), key=lambda kv: -len(kv[1])):
            # O que quem olhou viu; sem isso, o nome sem prefixo e sem número (SM_Prop_Chair_01 → Chair).
            names = sorted({i.get('desc') or ' '.join(w.capitalize() for w in classify(i['id'])[1]) for i in ids} - {''})
            shown = ', '.join(names[:40]) + (f' … (+{len(names) - 40})' if len(names) > 40 else '')
            lines.append(f'- **{pack}** ({len(ids)}): {shown}')
    with open(os.path.join(ROOT, 'REPERTORIO.md'), 'w', encoding='utf-8') as out:
        out.write('\n'.join(lines) + '\n')

    described = sum(1 for i in items if i.get('desc'))
    print(f'[repertório] {len(items)} modelos ({described} olhados): ' + ', '.join(f'{LABEL[c]} {len(v)}' for c, v in sorted(by_cat.items(), key=lambda kv: -len(kv[1]))))


if __name__ == '__main__':
    main()
