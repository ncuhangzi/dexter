import { PROVIDERS as PROVIDER_DEFS } from '@/providers';

export interface Model {
  id: string;
  displayName: string;
}

interface Provider {
  displayName: string;
  providerId: string;
  models: Model[];
}

const PROVIDER_MODELS: Record<string, Model[]> = {
  openai: [
    { id: 'gpt-5.4', displayName: 'GPT 5.4' },
    { id: 'gpt-4.1', displayName: 'GPT 4.1' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
    { id: 'claude-opus-4-7', displayName: 'Opus 4.7' },
  ],
  google: [
    { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash' },
    { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro' },
  ],
  xai: [
    { id: 'grok-4-0709', displayName: 'Grok 4' },
    { id: 'grok-4-1-fast-reasoning', displayName: 'Grok 4.1 Fast Reasoning' },
  ],
  moonshot: [{ id: 'kimi-k2-5', displayName: 'Kimi K2.5' }],
  deepseek: [
    { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
  ],
  // Hardcoded fallback — used when the /codex/models endpoint can't be
  // reached. Locked to GPT-5.4+ per project policy. Update when OpenAI
  // ships newer flagship models that are also available on ChatGPT login.
  codex: [
    { id: 'codex:gpt-5.5', displayName: 'GPT-5.5 (ChatGPT 訂閱)' },
    { id: 'codex:gpt-5.4', displayName: 'GPT-5.4 (ChatGPT 訂閱)' },
    { id: 'codex:gpt-5.4-mini', displayName: 'GPT-5.4 mini (ChatGPT 訂閱)' },
  ],
};

/**
 * Project policy: only expose Codex models at version 5.4 or newer in the
 * picker. Filters dynamic responses from `/codex/models` to enforce this
 * regardless of what OpenAI returns.
 *
 * Accepts ids with or without the `codex:` prefix.
 */
export function isCodexModelAllowed(modelId: string): boolean {
  const id = modelId.replace(/^codex:/, '');
  // Match the leading version number after "gpt-" (e.g., "gpt-5.4-mini" -> 5.4).
  const match = id.match(/^gpt-(\d+(?:\.\d+)?)/i);
  if (!match) return false;
  return parseFloat(match[1]) >= 5.4;
}

export const PROVIDERS: Provider[] = PROVIDER_DEFS.map((provider) => ({
  displayName: provider.displayName,
  providerId: provider.id,
  models: PROVIDER_MODELS[provider.id] ?? [],
}));

export function getModelsForProvider(providerId: string): Model[] {
  const provider = PROVIDERS.find((entry) => entry.providerId === providerId);
  return provider?.models ?? [];
}

export function getModelIdsForProvider(providerId: string): string[] {
  return getModelsForProvider(providerId).map((model) => model.id);
}

export function getDefaultModelForProvider(providerId: string): string | undefined {
  const models = getModelsForProvider(providerId);
  return models[0]?.id;
}

export function getModelDisplayName(modelId: string): string {
  const normalizedId = modelId.replace(/^(ollama|openrouter):/, '');

  for (const provider of PROVIDERS) {
    const model = provider.models.find((entry) => entry.id === normalizedId || entry.id === modelId);
    if (model) {
      return model.displayName;
    }
  }

  return normalizedId;
}
