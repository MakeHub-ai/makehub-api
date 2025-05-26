import { BaseProvider, ProviderError, AuthenticationError, RateLimitError } from './base.js';
import axios from 'axios';

export class OpenAIProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.API_KEY_OPENAI;
    this.baseURL = config.baseURL || 'https://api.openai.com/v1';
  }

  isConfigured() {
    return !!this.apiKey;
  }

  buildHeaders(request) {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'LLM-Gateway/1.0'
    };
  }

  getEndpoint(model) {
    return `${this.baseURL}/chat/completions`;
  }

  transformRequest(standardRequest) {
    // OpenAI utilise déjà le format standard
    const params = this.prepareRequestParams(standardRequest, standardRequest.model);
    return this.cleanParams(params);
  }

  transformResponse(response) {
    // OpenAI retourne déjà le format standard
    return response.data;
  }

  transformStreamChunk(chunk) {
    // Format OpenAI: "data: {json}\n\n"
    if (!chunk || chunk === '[DONE]') {
      return null;
    }

    try {
      const data = JSON.parse(chunk);
      return data;
    } catch (error) {
      console.warn('Failed to parse OpenAI stream chunk:', chunk);
      return null;
    }
  }

  handleError(error, response) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      
      switch (status) {
        case 401:
          return new AuthenticationError(
            data?.error?.message || 'Invalid API key',
            'openai'
          );
        case 429:
          return new RateLimitError(
            data?.error?.message || 'Rate limit exceeded',
            'openai',
            error.response.headers['retry-after']
          );
        case 400:
          return new ProviderError(
            data?.error?.message || 'Bad request',
            400,
            'BAD_REQUEST',
            'openai'
          );
        case 404:
          return new ProviderError(
            data?.error?.message || 'Model not found',
            404,
            'MODEL_NOT_FOUND',
            'openai'
          );
        default:
          return new ProviderError(
            data?.error?.message || 'OpenAI API error',
            status,
            'API_ERROR',
            'openai'
          );
      }
    }

    if (error.code === 'ECONNABORTED') {
      return new ProviderError(
        'Request timeout',
        408,
        'TIMEOUT_ERROR',
        'openai'
      );
    }

    return new ProviderError(
      error.message || 'Unknown OpenAI error',
      500,
      'UNKNOWN_ERROR',
      'openai'
    );
  }

  async makeRequest(request, model, isStreaming = false) {
    const endpoint = this.getEndpoint(model.provider_model_id);
    const headers = this.buildHeaders(request);
    const data = this.transformRequest(request);

    const config = {
      method: 'POST',
      url: endpoint,
      headers,
      data,
      timeout: 30000,
      responseType: isStreaming ? 'stream' : 'json'
    };

    try {
      const response = await axios(config);
      return response;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async *streamRequest(request, model) {
    const providerStreamStartTime = Date.now();
    console.log(`[OpenAIProvider DEBUG ${providerStreamStartTime}] streamRequest started.`);

    const streamRequest = { ...request, stream: true };
    
    console.log(`[OpenAIProvider DEBUG ${providerStreamStartTime}] Calling this.makeRequest...`);
    const makeRequestStartTime = Date.now();
    const response = await this.makeRequest(streamRequest, model, true);
    const makeRequestEndTime = Date.now();
    console.log(`[OpenAIProvider DEBUG ${providerStreamStartTime}] this.makeRequest call took ${makeRequestEndTime - makeRequestStartTime}ms. Status: ${response.status}`);
    
    let buffer = '';
    let firstChunkReceivedTime = null;
    let firstChunkYieldedTime = null;
    
    console.log(`[OpenAIProvider DEBUG ${providerStreamStartTime}] Starting to iterate response.data stream...`);
    for await (const chunk of response.data) {
      if (firstChunkReceivedTime === null) {
        firstChunkReceivedTime = Date.now();
        console.log(`[OpenAIProvider DEBUG ${providerStreamStartTime}] First chunk received from upstream after ${firstChunkReceivedTime - makeRequestEndTime}ms (total ${firstChunkReceivedTime - providerStreamStartTime}ms from streamRequest start).`);
      }
      buffer += chunk.toString();
      
      // Traiter les lignes complètes
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Garder la ligne incomplète
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          
          if (data === '[DONE]') {
            return;
          }
          
          const parsed = this.transformStreamChunk(data);
          if (parsed) {
            if (firstChunkYieldedTime === null) {
              firstChunkYieldedTime = Date.now();
              console.log(`[OpenAIProvider DEBUG ${providerStreamStartTime}] First chunk yielded after ${firstChunkYieldedTime - firstChunkReceivedTime}ms from first chunk received (total ${firstChunkYieldedTime - providerStreamStartTime}ms from streamRequest start).`);
            }
            yield parsed;
          }
        }
      }
    }
    // Process any remaining data in the buffer after the loop
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.slice(buffer.indexOf('data: ') + 6).trim();
      if (data !== '[DONE]' && data !== '') {
        const parsed = this.transformStreamChunk(data);
        if (parsed) {
          if (firstChunkYieldedTime === null) { // Should have been set, but as a fallback
            firstChunkYieldedTime = Date.now();
             console.log(`[OpenAIProvider DEBUG ${providerStreamStartTime}] First chunk (from final buffer) yielded at ${firstChunkYieldedTime - providerStreamStartTime}ms from streamRequest start.`);
          }
          yield parsed;
        }
      }
    }
    const streamRequestEndTime = Date.now();
    console.log(`[OpenAIProvider DEBUG ${providerStreamStartTime}] streamRequest finished. Total duration: ${streamRequestEndTime - providerStreamStartTime}ms.`);
  }

  prepareRequestParams(standardRequest, model) { // 'model' here is the 'combination' object
    const params = {
      model: model.providerModelId, // Corrected to camelCase
      messages: standardRequest.messages,
      stream: standardRequest.stream || false
    };

    // Add stream_options if present
    if (standardRequest.stream_options) {
      params.stream_options = standardRequest.stream_options;
    }

    // Paramètres optionnels
    if (standardRequest.max_tokens !== undefined) {
      params.max_tokens = standardRequest.max_tokens;
    }
    if (standardRequest.temperature !== undefined) {
      params.temperature = standardRequest.temperature;
    }
    if (standardRequest.top_p !== undefined) {
      params.top_p = standardRequest.top_p;
    }
    if (standardRequest.frequency_penalty !== undefined) {
      params.frequency_penalty = standardRequest.frequency_penalty;
    }
    if (standardRequest.presence_penalty !== undefined) {
      params.presence_penalty = standardRequest.presence_penalty;
    }
    if (standardRequest.stop !== undefined) {
      params.stop = standardRequest.stop;
    }

    // Support des tools
    if (standardRequest.tools && standardRequest.tools.length > 0) {
      params.tools = standardRequest.tools;
      if (standardRequest.tool_choice) {
        params.tool_choice = standardRequest.tool_choice;
      }
    }

    // Support des fonctions (legacy)
    if (standardRequest.functions && standardRequest.functions.length > 0) {
      params.functions = standardRequest.functions;
      if (standardRequest.function_call) {
        params.function_call = standardRequest.function_call;
      }
    }

    // Paramètres spécifiques au modèle
    if (model.extra_param) {
      Object.assign(params, model.extra_param);
    }

    return params;
  }

  validateRequest(request, modelConfig) {
    console.log('[OpenAIProvider DEBUG] Validating request. API Key present:', !!this.apiKey);
    console.log('[OpenAIProvider DEBUG] modelConfig received:', JSON.stringify(modelConfig, null, 2));
    console.log('[OpenAIProvider DEBUG] Request messages:', JSON.stringify(request.messages, null, 2));


    const superValidationResult = super.validateRequest(request, modelConfig);
    console.log('[OpenAIProvider DEBUG] super.validateRequest result:', superValidationResult);
    if (!superValidationResult) {
      console.error('[OpenAIProvider DEBUG] super.validateRequest failed.');
      return false;
    }

    // Ensure model ID is specified
    // modelConfig here is the raw model object from the DB, so properties are snake_case
    if (!modelConfig?.provider_model_id) {
      console.error('[OpenAIProvider DEBUG] modelConfig.provider_model_id is missing or empty. modelConfig.provider_model_id:', modelConfig?.provider_model_id);
      return false;
    }
    console.log('[OpenAIProvider DEBUG] modelConfig.provider_model_id:', modelConfig.provider_model_id);

    // Check for vision support if images are present
    const hasImages = request.messages?.some(m => 
      Array.isArray(m.content) && m.content.some(({ type }) => type === 'image_url')
    );
    console.log('[OpenAIProvider DEBUG] Request has images:', hasImages);
    
    // modelConfig is the raw DB object. We need to use modelSupportsFeature to check vision.
    // The 'modelSupportsFeature' function needs to be imported or passed if not available in this scope.
    // For now, assuming it's available or we adjust. Let's assume it's not directly available.
    // We need to get this logic from models.js or replicate it.
    // Replicating the relevant part of modelSupportsFeature for vision for now:
    const modelActuallySupportsVision = modelConfig.model_id.includes('vision') || 
                                      ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'gemini-1.5-pro'].includes(modelConfig.model_id);

    console.log(`[OpenAIProvider DEBUG] Calculated modelActuallySupportsVision for ${modelConfig.model_id}:`, modelActuallySupportsVision);

    if (hasImages) {
      if (!modelActuallySupportsVision) { 
        console.warn(`[OpenAIProvider DEBUG] Vision request for model ${modelConfig.model_id} which does not support vision (calculated).`);
        return false;
      }
    }

    console.log('[OpenAIProvider DEBUG] Request validation successful.');
    return true;
  }

  extractTokenUsage(response) {
    if (response.usage) {
      return {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens
      };
    }
    return null;
  }

  getHealthInfo() {
    return {
      ...super.getHealthInfo(),
      status: this.isConfigured() ? 'configured' : 'not_configured',
      baseURL: this.baseURL
    };
  }
}
