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
  index?: number;
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
  provider?: string | string[]; // Provider(s) to use for this request
  _routingInfo?: RoutingInfo; // AJOUTÉ pour Family Model Routing
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
  cost?: number;
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
 * Extended model info for v1/models endpoint
 */
export interface ExtendedModelInfo {
  id: string;
  model_id: string;
  organisation: string;
  price_per_input_token: number | null;
  price_per_output_token: number | null;
  price_per_input_token_cached: number | null;
  quantisation: string | null;
  context: number | null;
  assistant_ready: boolean;
  support_input_cache: boolean | null;
  support_vision: boolean | null;
  display_name: string;
  providers_available: string[];
}

export interface ExtendedModelsList {
  object: 'list';
  data: ExtendedModelInfo[];
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

// Dans src/types/requests.ts, AJOUTER ces interfaces après ProviderCombination :

/**
 * Métriques de performance d'un modèle
 */
export interface ModelPerformanceMetrics {
  throughput_median: number | null;  // tokens/seconde
  latency_median: number | null;     // millisecondes (time_to_first_chunk)
  sample_count: number;              // nombre de mesures
}

/**
 * Score vectoriel 3D d'un modèle
 */
export interface ModelVectorScore {
  model: Model;
  score: number;                     // distance euclidienne (plus bas = meilleur)
  normalizedPrice: number;           // 0-1
  normalizedThroughput: number;      // 0-1 
  normalizedLatency: number;         // 0-1
  cachingBoost: boolean;             // true si caching détecté
  hasSufficientMetrics: boolean;     // true si assez de données perf
}

interface FilterOptions {
  requireToolCalling?: boolean;
  requireVision?: boolean;
  maxCostPerToken?: number;
  providers?: string[];
  ratio_sp?: number;                 // AJOUTER cette ligne
  metricsWindowSize?: number;        // AJOUTER cette ligne
}

/**
 * Types pour Family Model Routing
 */
export interface FamilyConfig {
  family_id: string;
  display_name: string;
  description?: string;
  evaluation_model_id: string;
  evaluation_provider: string;
  is_active: boolean;
  routing_config: {
    score_ranges: Array<{
      min_score: number;
      max_score: number;
      target_model: string;
      reason: string;
    }>;
    fallback_model: string;
    fallback_provider: string;
    cache_duration_minutes: number;
    evaluation_timeout_ms: number;
    evaluation_prompt?: string;
  };
}

export interface RoutingResult {
  selectedModel: string;
  selectedProvider: string;
  complexityScore: number;
  reasoning: string;
  evaluationCost: number;
  evaluationTokens: number;
  fromCache: boolean;
}

export interface RoutingInfo {
  originalFamily: string;
  selectedModel: string;
  selectedProvider: string;
  complexityScore: number;
  evaluationCost: number;
  evaluationTokens: number;
  reasoning: string;
}

export interface ComplexityEvaluation {
  score: number;
  cost: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
}
