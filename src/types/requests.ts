/**
 * Types pour les requêtes et réponses des LLM
 */

import type { Model } from './database.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ChatMessageContent[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatMessageContent {
  type: string;
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;
  };
}

export type ToolChoice = 
  | 'auto' 
  | 'none'
  | 'any'
  | 'required'
  | {
      type: 'function';
      function: {
        name: string;
      };
    };

/**
 * Requête standardisée pour tous les providers
 */
export interface StandardRequest {
  model?: string | Model;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  user?: string;
}

/**
 * Réponse standardisée format OpenAI
 */
export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
  system_fingerprint?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage;
  system_fingerprint?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
    tool_calls?: Partial<ToolCall>[];
  };
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Types pour les requêtes legacy completion
 */
export interface CompletionRequest {
  model?: string;
  prompt: string | string[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  logprobs?: number;
  echo?: boolean;
  best_of?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  suffix?: string;
}

export interface CompletionResponse {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: Usage;
}

export interface CompletionChoice {
  text: string;
  index: number;
  logprobs: any | null;
  finish_reason: 'stop' | 'length' | null;
}

/**
 * Types pour les modèles disponibles
 */
export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  permission: any[];
  root: string;
  parent: string | null;
}

export interface ModelsList {
  object: 'list';
  data: ModelInfo[];
}

/**
 * Types pour l'estimation de coût
 */
export interface CostEstimate {
  estimated_cost: number;
  currency: string;
  provider: string;
  model: string;
  alternatives: Array<{
    provider: string;
    model: string;
    estimated_cost: number;
  }>;
}

/**
 * Types d'erreur API
 */
export interface ApiError {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
    provider?: string;
    details?: any;
  };
}

/**
 * Types pour les combinaisons provider/model
 */
export interface ProviderCombination {
  model: Model;
  provider: string;
  modelId: string;
  providerModelId: string;
  baseUrl: string;
  ApiKeyName: string;
  adapter: string;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  contextWindow: number;
  pricing: {
    inputToken: number;
    outputToken: number;
  };
  extraParams: Record<string, any>;
}
