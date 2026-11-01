/**
 * Serviços compatíveis com a API de chat da OpenAI que podem ser o mestre (provider em openai.ts).
 * O modelo de um deles tem id com o prefixo do serviço ("venice/deepseek-v4-1-flash-uncensored");
 * sem prefixo, o modelo é do Claude. Outro serviço compatível entra aqui, com a URL e a variável
 * da chave; `extra` vai no corpo de toda chamada.
 */
export interface Service {
  label: string;
  baseUrl: string;
  keyEnv: string;
  extra: Record<string, unknown>;
}

export const SERVICES: Record<string, Service> = {
  venice: {
    label: 'Venice',
    baseUrl: 'https://api.venice.ai/api/v1',
    keyEnv: 'VENICE_API_KEY',
    // Sem o prompt de sistema da própria Venice, que viria junto do nosso, e sem o raciocínio do
    // modelo misturado ao texto (ele vem à parte, em reasoning_content).
    extra: { venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true } },
  },
};

/** O serviço de um id de modelo ("venice/…"), ou null para o Claude. */
export function serviceOf(model: string): { id: string; service: Service; model: string } | null {
  const slash = model.indexOf('/');
  const id = slash > 0 ? model.slice(0, slash) : '';
  return SERVICES[id] ? { id, service: SERVICES[id], model: model.slice(slash + 1) } : null;
}

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
  {
    id: 'venice/deepseek-v4-1-flash-uncensored',
    name: 'DeepSeek V4.1 Flash Uncensored',
    // Por turno, o raciocínio e o verificador no mesmo modelo levam a uns 7× (US$ 0,024 contra 0,003).
    note: 'pela Venice, sem censura; 3× o preço do Haiku, ~7× por turno',
    fallback: false,
  },
];

export function modelChoice(id: string): ModelChoice | undefined {
  return MODEL_CHOICES.find((m) => m.id === id);
}

/** O modelo pode ser usado agora: Claude sempre; o de um serviço, se a chave dele está no ambiente. */
export function modelAvailable(id: string): boolean {
  const s = serviceOf(id);
  return !s || Boolean(process.env[s.service.keyEnv]);
}
