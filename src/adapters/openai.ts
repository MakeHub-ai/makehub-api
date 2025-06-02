import { BaseAdapter, AdapterError } from './base.js';
import axios, { type AxiosResponse, type AxiosError } from 'axios';
import type { 
  StandardRequest, 
  ChatCompletion, 
  ChatCompletionChunk,
  OpenAIRequest,
  OpenAIResponse,
  AdapterConfig
} from '../types/index.js';

/**
 * Adapter pour les APIs compatibles OpenAI
 * Peut être utilisé par plusieurs providers : OpenAI, Together, Replicate, Azure, etc.
 */
export class OpenAIAdapter extends BaseAdapter {
  constructor(config: AdapterConfig = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.API_KEY_OPENAI;
    this.baseURL = config.baseURL || 'https://api.openai.com/v1';
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  buildHeaders(request: StandardRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'LLM-Gateway/1.0'
    };

    return this.validateHeaders(headers);
  }

  getEndpoint(model: string): string {
    return `${this.baseURL}/chat/completions`;
  }

  transformRequest(standardRequest: StandardRequest): OpenAIRequest {
    // Extraire les paramètres de base
    const modelInfo = standardRequest.model;
    const modelId = typeof modelInfo === 'string' ? modelInfo : modelInfo?.provider_model_id;
    
    if (!modelId) {
      throw this.createError('Model ID is required', 400, 'VALIDATION_ERROR');
    }

    const baseParams = this.prepareRequestParams(standardRequest, modelId);
    
    const openaiRequest: OpenAIRequest = {
      model: modelId,
      messages: standardRequest.messages,
      stream: standardRequest.stream || false,
      max_tokens: standardRequest.max_tokens,
      temperature: standardRequest.temperature,
      top_p: standardRequest.top_p,
      frequency_penalty: standardRequest.frequency_penalty,
      presence_penalty: standardRequest.presence_penalty,
      stop: standardRequest.stop,
      tools: standardRequest.tools,
      tool_choice: standardRequest.tool_choice
    };
    
    // Ajouter stream_options pour les requêtes streaming OpenAI
    if (openaiRequest.stream) {
      openaiRequest.stream_options = {
        include_usage: true
      };
    }

    
    // Nettoyer les paramètres et s'assurer que model reste défini
    const cleanedParams = this.cleanParams(openaiRequest);
    return {
      ...cleanedParams,
      model: modelId, // S'assurer que model est toujours présent
      messages: standardRequest.messages // S'assurer que messages est toujours présent
    } as OpenAIRequest;
  }

  transformResponse(response: AxiosResponse<OpenAIResponse>): ChatCompletion {
    // OpenAI retourne déjà le format standard
    const data = response.data;
    
    // Validation de base de la réponse
    if (!data.id || !data.choices || !Array.isArray(data.choices)) {
      throw this.createError('Invalid OpenAI response format', 500, 'API_ERROR');
    }

    return {
      id: data.id,
      object: 'chat.completion',
      created: data.created,
      model: data.model,
      choices: data.choices.map(choice => ({
        index: choice.index,
        message: {
          role: 'assistant',
          content: choice.message?.content || null,
          tool_calls: choice.message?.tool_calls
        },
        finish_reason: this.mapFinishReason(choice.finish_reason)
      })),
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
        cached_tokens: data.usage.cached_tokens
      } : undefined,
      system_fingerprint: (data as any).system_fingerprint
    };
  }

  transformStreamChunk(chunk: string): ChatCompletionChunk | null {
    // Format OpenAI: "data: {json}\n\n"
    if (!chunk || chunk === '[DONE]' || chunk.trim() === '') {
      return null;
    }

    try {
      // Si le chunk commence par "data: ", on enlève ce préfixe
      let jsonStr = chunk;
      if (chunk.startsWith('data: ')) {
        jsonStr = chunk.slice(6);
      }
      
      const data = JSON.parse(jsonStr);
      
      // Validation de base du chunk
      if (!data.id || !data.choices || !Array.isArray(data.choices)) {
        console.warn('Invalid OpenAI stream chunk format:', chunk);
        return null;
      }

      return {
        id: data.id,
        object: 'chat.completion.chunk',
        created: data.created,
        model: data.model,
        choices: data.choices.map((choice: any) => ({
          index: choice.index,
          delta: {
            role: choice.delta?.role,
            content: choice.delta?.content,
            tool_calls: choice.delta?.tool_calls
          },
          finish_reason: this.mapFinishReason(choice.finish_reason)
        })),
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
          cached_tokens: data.usage.cached_tokens
        } : undefined,
        system_fingerprint: (data as any).system_fingerprint
      };
    } catch (error) {
      console.warn('Failed to parse OpenAI stream chunk:', chunk, error);
      return null;
    }
  }

  handleError(error: unknown): AdapterError {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data as any;
        
        // Mapper les codes d'erreur OpenAI
        let code: AdapterError['code'] = 'API_ERROR';
        if (status === 401) code = 'AUTHENTICATION_ERROR';
        else if (status === 429) code = 'RATE_LIMIT_ERROR';
        else if (status >= 400 && status < 500) code = 'VALIDATION_ERROR';
        else if (status >= 500) code = 'API_ERROR';
        
        return new AdapterError(
          data?.error?.message || `OpenAI API error: ${status}`,
          status,
          code,
          'openai',
          error
        );
      } else if (axiosError.code === 'ECONNABORTED') {
        return new AdapterError(
          'Request timeout',
          408,
          'TIMEOUT_ERROR',
          'openai',
          error
        );
      } else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
        return new AdapterError(
          'Network connection failed',
          503,
          'NETWORK_ERROR',
          'openai',
          error
        );
      }
    }

    // Erreur générique
    return new AdapterError(
      error instanceof Error ? error.message : 'Unknown OpenAI error',
      500,
      'UNKNOWN_ERROR',
      'openai',
      error
    );
  }

  async makeRequest(
    request: StandardRequest, 
    model: string, 
    isStreaming: boolean = false
  ): Promise<AxiosResponse | ChatCompletion> {
    const startTime = Date.now();
    const endpoint = this.getEndpoint(model);
    const headers = this.buildHeaders(request);
    const data = this.transformRequest(request);

    const config = {
      method: 'POST' as const,
      url: endpoint,
      headers,
      data,
      timeout: this.config.timeout || 30000,
      responseType: isStreaming ? 'stream' as const : 'json' as const
    };

    try {
      const response = await axios(config);
      const duration = Date.now() - startTime;
      
      this.logMetrics('makeRequest', duration, true);
      
      if (isStreaming) {
        return response; // Retourner le stream directement
      } else {
        return this.transformResponse(response);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logMetrics('makeRequest', duration, false);
      
      throw this.handleError(error);
    }
  }

  /**
   * Valide spécifiquement les requêtes OpenAI
   */
  protected validateOpenAISpecifics(request: StandardRequest): string[] {
    const errors: string[] = [];

    // Vérifications spécifiques à OpenAI
    if (request.frequency_penalty !== undefined && 
        (request.frequency_penalty < -2 || request.frequency_penalty > 2)) {
      errors.push('frequency_penalty must be between -2 and 2');
    }

    if (request.presence_penalty !== undefined && 
        (request.presence_penalty < -2 || request.presence_penalty > 2)) {
      errors.push('presence_penalty must be between -2 and 2');
    }

    // Validation des tool calls
    if (request.tools) {
      request.tools.forEach((tool, index) => {
        if (tool.type !== 'function') {
          errors.push(`Tool ${index}: only 'function' type is supported`);
        }
        if (!tool.function.name) {
          errors.push(`Tool ${index}: function name is required`);
        }
        if (!tool.function.parameters) {
          errors.push(`Tool ${index}: function parameters are required`);
        }
      });
    }

    return errors;
  }

  /**
   * Override de la validation pour inclure les spécificités OpenAI
   */
  protected performValidation(request: StandardRequest, model: any) {
    const baseValidation = super.performValidation(request, model);
    const openaiErrors = this.validateOpenAISpecifics(request);

    return {
      valid: baseValidation.valid && openaiErrors.length === 0,
      errors: [...baseValidation.errors, ...openaiErrors]
    };
  }
}
