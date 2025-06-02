/**
 * Types pour les adapters LLM
 */

import type { AxiosResponse } from 'axios';
import type { StandardRequest, ChatCompletion, ChatCompletionChunk } from './requests.js';
import type { Model } from './database.js';

export interface AdapterConfig {
  apiKey?: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface AdapterInterface {
  isConfigured(): boolean;
  validateRequest(request: StandardRequest, model: Model): boolean;
  transformRequest(standardRequest: StandardRequest): unknown;
  transformResponse(response: unknown): ChatCompletion;
  transformStreamChunk(chunk: string): ChatCompletionChunk | null;
  buildHeaders(request: StandardRequest): Record<string, string>;
  getEndpoint(model: string): string;
  handleError(error: unknown): AdapterError;
  isAPIError(error: unknown): boolean;
  makeRequest(
    request: StandardRequest, 
    model: string, 
    isStreaming?: boolean
  ): Promise<AxiosResponse | ChatCompletion>;
}

export type AdapterType = 'openai';

export type AdapterErrorCode = 
  | 'API_ERROR'
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'UNKNOWN_ERROR';

export class AdapterError extends Error {
  public readonly status: number;
  public readonly code: AdapterErrorCode;
  public readonly adapter: string;
  public readonly provider?: string;
  public readonly originalError?: unknown;

  constructor(
    message: string,
    status: number = 500,
    code: AdapterErrorCode = 'UNKNOWN_ERROR',
    adapter: string = 'unknown',
    originalError?: unknown
  ) {
    super(message);
    this.name = 'AdapterError';
    this.status = status;
    this.code = code;
    this.adapter = adapter;
    this.originalError = originalError;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      adapter: this.adapter,
      stack: this.stack
    };
  }
}

/**
 * Types spécifiques aux providers
 */

// OpenAI
export interface OpenAIRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: any[];
  tool_choice?: any;
  stream_options?: {
    include_usage?: boolean;
  };
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: any[];
  usage?: any;
}

// Anthropic
export interface AnthropicRequest {
  model: string;
  messages: any[];
  max_tokens: number;
  stream?: boolean;
  system?: string;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text: string;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Types pour les chunks de streaming
 */
export interface StreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: any[];
  usage?: any;
}

/**
 * Types pour la validation des requêtes
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Types pour les métriques d'adapter
 */
export interface AdapterMetrics {
  requestCount: number;
  errorCount: number;
  averageLatency: number;
  lastError?: AdapterError;
}