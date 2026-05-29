import { getSetting, setSetting } from '../utils/config.js';
import {
  checkApiKeyExistsForProvider,
  getProviderDisplayName,
  saveApiKeyForProvider,
} from '../utils/env.js';
import {
  getDefaultModelForProvider,
  getModelsForProvider,
  type Model,
} from '../utils/model.js';
import { getOllamaModels } from '../utils/ollama.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../model/llm.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { loginCodex } from '../auth/codex-oauth.js';
import { fetchCodexModels } from '../model/codex-client.js';

const SELECTION_STATES = [
  'provider_select',
  'model_select',
  'model_input',
  'api_key_confirm',
  'api_key_input',
  'oauth_confirm',
  'oauth_login',
  // Shown after a model is picked when a key/OAuth token already exists for
  // the provider. Lets the user reuse stored credentials or overwrite them
  // (re-enter API key / re-run OAuth) — useful when the existing credential
  // has expired or been rotated and we'd otherwise silently use the dead one.
  'reauth_confirm',
] as const;

export type SelectionState = (typeof SELECTION_STATES)[number];
export type AppState = 'idle' | SelectionState;

export interface ModelSelectionState {
  appState: AppState;
  pendingProvider: string | null;
  pendingModels: Model[];
}

type ChangeListener = () => void;

export class ModelSelectionController {
  private providerValue: string;
  private modelValue: string;
  private appStateValue: AppState = 'idle';
  private pendingProviderValue: string | null = null;
  private pendingModelsValue: Model[] = [];
  private pendingSelectedModelId: string | null = null;
  private readonly onError: (message: string) => void;
  private readonly onChange?: ChangeListener;
  private readonly chatHistory = new InMemoryChatHistory(DEFAULT_MODEL);

  constructor(onError: (message: string) => void, onChange?: ChangeListener) {
    this.onError = onError;
    this.onChange = onChange;
    this.providerValue = getSetting('provider', DEFAULT_PROVIDER);
    const savedModel = getSetting('modelId', null) as string | null;
    this.modelValue =
      savedModel ?? getDefaultModelForProvider(this.providerValue) ?? DEFAULT_MODEL;
    this.chatHistory.setModel(this.modelValue);
  }

  get state(): ModelSelectionState {
    return {
      appState: this.appStateValue,
      pendingProvider: this.pendingProviderValue,
      pendingModels: this.pendingModelsValue,
    };
  }

  get provider(): string {
    return this.providerValue;
  }

  get model(): string {
    return this.modelValue;
  }

  get inMemoryChatHistory(): InMemoryChatHistory {
    return this.chatHistory;
  }

  isInSelectionFlow(): boolean {
    return this.appStateValue !== 'idle';
  }

  startSelection() {
    this.appStateValue = 'provider_select';
    this.emitChange();
  }

  cancelSelection() {
    this.resetPendingState();
  }

  async handleProviderSelect(providerId: string | null) {
    if (!providerId) {
      this.appStateValue = 'idle';
      this.emitChange();
      return;
    }

    this.pendingProviderValue = providerId;
    if (providerId === 'openrouter') {
      this.pendingModelsValue = [];
      this.appStateValue = 'model_input';
      this.emitChange();
      return;
    }

    if (providerId === 'ollama') {
      const ollamaModelIds = await getOllamaModels();
      this.pendingModelsValue = ollamaModelIds.map((id) => ({ id, displayName: id }));
      this.appStateValue = 'model_select';
      this.emitChange();
      return;
    }

    // Codex authenticates via OAuth — if no token yet, ask for consent before
    // opening a browser. Models are loaded after the login succeeds.
    if (providerId === 'codex' && !checkApiKeyExistsForProvider('codex')) {
      this.pendingModelsValue = [];
      this.appStateValue = 'oauth_confirm';
      this.emitChange();
      return;
    }

    if (providerId === 'codex') {
      this.pendingModelsValue = await this.loadCodexModels();
      this.appStateValue = 'model_select';
      this.emitChange();
      return;
    }

    this.pendingModelsValue = getModelsForProvider(providerId);
    this.appStateValue = 'model_select';
    this.emitChange();
  }

  /**
   * Pull the Codex model catalog from `/codex/models` and fall back to the
   * hardcoded list (gpt-5.4+) when the request fails. Always filtered to
   * gpt-5.4+ so older models never sneak in.
   */
  private async loadCodexModels(): Promise<Model[]> {
    const remote = await fetchCodexModels();
    if (remote && remote.length > 0) return remote;
    return getModelsForProvider('codex');
  }

  handleModelSelect(modelId: string | null) {
    if (!modelId || !this.pendingProviderValue) {
      this.pendingProviderValue = null;
      this.pendingModelsValue = [];
      this.pendingSelectedModelId = null;
      this.appStateValue = 'provider_select';
      this.emitChange();
      return;
    }

    if (this.pendingProviderValue === 'ollama') {
      this.completeModelSwitch(this.pendingProviderValue, `ollama:${modelId}`);
      return;
    }

    // Codex doesn't accept a typed API key — if somehow auth was lost between
    // provider select and now, route to the OAuth flow instead of api_key_confirm.
    if (this.pendingProviderValue === 'codex') {
      if (checkApiKeyExistsForProvider('codex')) {
        this.pendingSelectedModelId = modelId;
        this.appStateValue = 'reauth_confirm';
        this.emitChange();
      } else {
        this.pendingSelectedModelId = modelId;
        this.appStateValue = 'oauth_confirm';
        this.emitChange();
      }
      return;
    }

    if (checkApiKeyExistsForProvider(this.pendingProviderValue)) {
      this.pendingSelectedModelId = modelId;
      this.appStateValue = 'reauth_confirm';
      this.emitChange();
      return;
    }

    this.pendingSelectedModelId = modelId;
    this.appStateValue = 'api_key_confirm';
    this.emitChange();
  }

  /**
   * User confirmed (or declined) opening the browser to log in via Codex OAuth.
   * On accept, kicks off `loginCodex()` asynchronously and parks the UI in
   * `oauth_login` state until the flow finishes.
   */
  handleOauthConfirm(wantsToLogin: boolean) {
    if (!wantsToLogin || this.pendingProviderValue !== 'codex') {
      this.resetPendingState();
      return;
    }

    this.appStateValue = 'oauth_login';
    this.emitChange();

    void this.runCodexOauth();
  }

  private async runCodexOauth() {
    try {
      await loginCodex();
    } catch (e) {
      // If the user pressed Esc while the OAuth tab was open, suppress the
      // error — they already abandoned the flow.
      if (this.appStateValue !== 'oauth_login') return;
      const msg = e instanceof Error ? e.message : String(e);
      this.onError(`Codex login failed: ${msg}`);
      this.resetPendingState();
      return;
    }

    // User cancelled while we were waiting on the browser — don't drag them
    // back into the picker.
    if (this.appStateValue !== 'oauth_login') return;

    // After successful login, advance: either complete (if a model was already
    // chosen) or show the codex model picker.
    if (this.pendingSelectedModelId) {
      this.completeModelSwitch('codex', this.pendingSelectedModelId);
      return;
    }
    this.pendingModelsValue = await this.loadCodexModels();
    this.appStateValue = 'model_select';
    this.emitChange();
  }

  handleModelInputSubmit(modelName: string | null) {
    if (!modelName || !this.pendingProviderValue) {
      this.pendingProviderValue = null;
      this.pendingModelsValue = [];
      this.pendingSelectedModelId = null;
      this.appStateValue = 'provider_select';
      this.emitChange();
      return;
    }

    const fullModelId = `${this.pendingProviderValue}:${modelName}`;
    if (checkApiKeyExistsForProvider(this.pendingProviderValue)) {
      this.pendingSelectedModelId = fullModelId;
      this.appStateValue = 'reauth_confirm';
      this.emitChange();
      return;
    }

    this.pendingSelectedModelId = fullModelId;
    this.appStateValue = 'api_key_confirm';
    this.emitChange();
  }

  /**
   * After the picker reaches `reauth_confirm`, the user chose whether to
   * keep the stored credential or overwrite it. "Keep" just completes the
   * model switch; "overwrite" routes to the OAuth login (codex) or API key
   * input (everyone else).
   */
  handleReauthConfirm(wantsReauth: boolean) {
    if (!this.pendingProviderValue || !this.pendingSelectedModelId) {
      this.resetPendingState();
      return;
    }

    if (!wantsReauth) {
      this.completeModelSwitch(this.pendingProviderValue, this.pendingSelectedModelId);
      return;
    }

    if (this.pendingProviderValue === 'codex') {
      this.appStateValue = 'oauth_login';
      this.emitChange();
      void this.runCodexOauth();
      return;
    }

    this.appStateValue = 'api_key_input';
    this.emitChange();
  }

  /**
   * Auto-prompt entry point: agent calls this when the Codex backend rejects
   * the stored token (typically `CodexRefreshTokenReusedError` or a 401 that
   * survived the in-client refresh retry). Pre-fills the current provider /
   * model so the OAuth flow doesn't bounce the user into a model picker —
   * after a successful login it completes back to where they were.
   *
   * No-ops if a picker flow is already in progress (don't yank the UI).
   */
  startCodexReauth() {
    if (this.appStateValue !== 'idle') return;
    this.pendingProviderValue = 'codex';
    this.pendingSelectedModelId = this.modelValue;
    this.appStateValue = 'oauth_login';
    this.emitChange();
    void this.runCodexOauth();
  }

  handleApiKeyConfirm(wantsToSet: boolean) {
    if (wantsToSet) {
      this.appStateValue = 'api_key_input';
      this.emitChange();
      return;
    }

    if (
      this.pendingProviderValue &&
      this.pendingSelectedModelId &&
      checkApiKeyExistsForProvider(this.pendingProviderValue)
    ) {
      this.completeModelSwitch(this.pendingProviderValue, this.pendingSelectedModelId);
      return;
    }

    this.onError(
      `Cannot use ${
        this.pendingProviderValue ? getProviderDisplayName(this.pendingProviderValue) : 'provider'
      } without an API key.`,
    );
    this.resetPendingState();
  }

  handleApiKeySubmit(apiKey: string | null) {
    if (!this.pendingSelectedModelId) {
      this.onError('No model selected.');
      this.resetPendingState();
      return;
    }

    if (apiKey && this.pendingProviderValue) {
      const saved = saveApiKeyForProvider(this.pendingProviderValue, apiKey);
      if (saved) {
        this.completeModelSwitch(this.pendingProviderValue, this.pendingSelectedModelId);
      } else {
        this.onError('Failed to save API key.');
        this.resetPendingState();
      }
      return;
    }

    if (
      !apiKey &&
      this.pendingProviderValue &&
      checkApiKeyExistsForProvider(this.pendingProviderValue)
    ) {
      this.completeModelSwitch(this.pendingProviderValue, this.pendingSelectedModelId);
      return;
    }

    this.onError('API key not set. Provider unchanged.');
    this.resetPendingState();
  }

  private completeModelSwitch(newProvider: string, newModelId: string) {
    this.providerValue = newProvider;
    this.modelValue = newModelId;
    setSetting('provider', newProvider);
    setSetting('modelId', newModelId);
    this.chatHistory.setModel(newModelId);
    this.pendingProviderValue = null;
    this.pendingModelsValue = [];
    this.pendingSelectedModelId = null;
    this.appStateValue = 'idle';
    this.emitChange();
  }

  private resetPendingState() {
    this.pendingProviderValue = null;
    this.pendingModelsValue = [];
    this.pendingSelectedModelId = null;
    this.appStateValue = 'idle';
    this.emitChange();
  }

  private emitChange() {
    this.onChange?.();
  }
}
