/** Modelos que podem ser o mestre. O id é o da API; nome e nota são para o seletor da interface. */
export interface ModelChoice {
  id: string;
  name: string;
  note: string;
  /** Aceita o fallback no servidor quando recusa (o Haiku 5.5 não tem, e a lista dá 400). */
  fallback: boolean;
}

export const MODEL_CHOICES: ModelChoice[] = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', note: 'o mais capaz; 100× o preço do Haiku', fallback: true },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'narra melhor; 40× o preço do Haiku', fallback: true },
  { id: 'claude-opus-5', name: 'Opus 5', note: 'o Opus anterior; 50× o preço do Haiku', fallback: true },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', note: 'meio-termo; 20× o preço do Haiku', fallback: true },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: 'o padrão: o mais barato e o mais rápido', fallback: false },
];

export function modelChoice(id: string): ModelChoice | undefined {
  return MODEL_CHOICES.find((m) => m.id === id);
}
