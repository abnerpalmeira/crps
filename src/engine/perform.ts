import { VERBS, actHint, describeAct, findFixtureRef, type MenuAct } from './actions';
import type { GameEngine } from './engine';
import { itemPlace } from './reading';
import { distanceToRect } from './text';
import { runTool, type ToolResult } from './tools';

/** Uma tool que o motor rodou para uma ação do menu, para a interface mostrar como as do mestre. */
export interface MenuTool {
  name: string;
  input: unknown;
  result: ToolResult;
}

/** O que aconteceu com uma ação do menu: feita pelo motor, recusada por ele ou passada ao mestre. */
export interface MenuOutcome {
  act: MenuAct;
  status: 'feito' | 'recusado' | 'mestre';
  /** A linha que o mestre recebe em "Como o jogador marcou". */
  line: string;
  tools: MenuTool[];
}

class Refused extends Error {}

/**
 * Faz uma ação física do menu pelo motor, com as mesmas tools do mestre (as mesmas regras de
 * alcance, caminho e ocupação). Se o alvo está longe, o personagem vai até ele antes. O resto
 * (entregar, ler, gestos, atacar, verbos dos objetos) vai ao mestre com os ids e a tool que resolve;
 * quando a ação pede estar perto (entregar, ler, tocar o piano), o motor já leva o jogador até lá.
 */
export function performMenuAct(engine: GameEngine, act: MenuAct): MenuOutcome {
  const label = describeAct(engine.state, act, true);
  const tools: MenuTool[] = [];
  const run = (name: string, input: unknown) => {
    const result = runTool(engine, name, input);
    tools.push({ name, input, result });
    if (!result.ok) throw new Refused(result.content);
  };
  const me = () => engine.player!;
  const delegate = (why?: string): MenuOutcome => {
    const moved = tools.length ? ` O motor já levou o jogador até lá (${tools.map((t) => t.result.summary).join('; ')}).` : '';
    return { act, status: 'mestre', line: `- ação do menu: ${label}; ${why ?? actHint(engine.state, act)}.${moved}`, tools };
  };
  if (!engine.player?.pos) return { act, status: 'recusado', line: `- ação do menu: ${label}; o jogador não está em cena.`, tools };
  /** Vai até perto do alvo, se ele está a mais de um passo. */
  const approach = (rect: { x: number; y: number; w: number; h: number }, near: { near: string } | { x: number; y: number }) => {
    if (distanceToRect(me().pos!, rect) > 1) run('move_character', { character_id: me().id, to: near });
  };
  const item = act.target ? engine.state.items[act.target] : undefined;
  const reachItem = () => {
    const place = item && itemPlace(engine.state, item);
    if (!item || !place) throw new Refused(`"${act.target}" não é um item em cena.`);
    const h = item.holder;
    if (h.kind === 'character' && h.id !== me().id) throw new Refused(`${item.name} está com outra pessoa.`);
    if (h.kind !== 'character') approach(place.rect, h.kind === 'fixture' ? { near: h.id } : { x: h.x, y: h.y });
  };
  try {
    switch (act.verb) {
      case 'ir':
        run('move_character', { character_id: me().id, to: item ? itemSpot(engine, item.id) : { near: act.target } });
        break;
      case 'sentar':
      case 'deitar':
        run('move_character', { character_id: me().id, to: { seat: act.target } });
        break;
      case 'levantar':
        if (me().seatId) run('move_character', { character_id: me().id, to: { near: me().seatId } });
        else run('update_character', { character_id: me().id, pose: 'de_pe' });
        break;
      case 'pose':
        run('update_character', { character_id: me().id, pose: act.target, ...(act.other ? { pose_target: act.other } : {}) });
        break;
      case 'mirar':
        run('update_character', { character_id: me().id, pose: 'mirando', pose_target: act.target });
        break;
      case 'pegar':
        reachItem();
        run('transfer_item', { item_id: act.target, to: { character_id: me().id } });
        break;
      case 'empunhar':
        reachItem();
        run('transfer_item', { item_id: act.target, to: { character_id: me().id, hand: 'direita' } });
        break;
      case 'guardar':
        run('transfer_item', { item_id: act.target, to: { character_id: me().id } });
        break;
      case 'largar':
        run('transfer_item', { item_id: act.target, to: { x: me().pos!.x, y: me().pos!.y } });
        break;
      case 'acender':
      case 'apagar':
        if (item?.holder.kind !== 'character') reachItem();
        run('update_item', { item_id: act.target, light_on: act.verb === 'acender' });
        break;
      case 'por': {
        const f = act.other ? findFixtureRef(engine.state, act.other) : null;
        if (!f) throw new Refused(`"${act.other}" não é um móvel em cena.`);
        approach(f, { near: f.id });
        run('transfer_item', { item_id: act.target, to: { fixture_id: f.id } });
        break;
      }
      case 'passar': {
        const f = act.target ? findFixtureRef(engine.state, act.target) : null;
        const exit = f ? engine.state.locations[f.locationId]?.exits?.[f.id] : undefined;
        // Porta que já leva a um lugar só: o motor leva; a que não leva a nada ainda, o mestre decide.
        if (!f || !exit || f.exit !== 'door' || exit.to.length !== 1 || !engine.state.locations[exit.to[0]]) {
          return delegate('para onde a saída leva é com você: crie o destino se preciso e mova com move_character (to.location_id e via)');
        }
        run('move_character', { character_id: me().id, to: { location_id: exit.to[0] }, via: f.id });
        break;
      }
      case 'entregar': {
        const to = act.other ? engine.state.characters[act.other] : undefined;
        if (to?.pos && to.locationId === me().locationId) approach({ ...to.pos, w: 1, h: 1 }, { near: to.id });
        return delegate();
      }
      case 'ler':
        if (item?.holder.kind !== 'character') reachItem();
        return delegate();
      default: {
        // Verbo de um objeto (tocar o piano, abrir o armário): primeiro chegar perto dele.
        const f = !VERBS[act.verb] && act.target ? findFixtureRef(engine.state, act.target) : null;
        if (f && f.locationId === me().locationId) approach(f, { near: f.id });
        return delegate();
      }
    }
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    return { act, status: 'recusado', line: `- o jogador tentou pelo menu: ${label}, e o motor recusou: ${err.message} Narre a tentativa.`, tools };
  }
  const done = tools.map((t) => t.result.summary).join('; ');
  return { act, status: 'feito', line: `- feito pelo motor (menu): ${label} (${done}). Narre; não refaça.`, tools };
}

/** Onde ficar para ir até um item: o tile dele no chão, ou perto de quem ou do que o tem. */
function itemSpot(engine: GameEngine, itemId: string): { x: number; y: number } | { near: string } {
  const h = engine.state.items[itemId].holder;
  return h.kind === 'ground' ? { x: h.x, y: h.y } : { near: h.id };
}
