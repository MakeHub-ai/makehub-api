import { BaseAdapter, AdapterError } from './base.js';
import axios from 'axios';

/**
 * Adapter pour les APIs compatibles OpenAI
 * Peut être utilisé par plusieurs providers : OpenAI, Together, Replicate, Azure, etc.
 */
export class OpenAIAdapter extends BaseAdapter {
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
    // Extraire les paramètres de base
    const modelInfo = standardRequest.model; // Ceci devrait être l'objet model complet
    const modelId = typeof modelInfo === 'string' ? modelInfo : modelInfo.provider_model_id;
    
    const params = {
      model: modelId,
      messages: standardRequest.messages,
      stream: standardRequest.stream || false,
      max_tokens: standardRequest.max_tokens,
      temperature: standardRequest.temperature,
      top_p: standardRequest.top_p,
      tools: standardRequest.tools,
      tool_choice: standardRequest.tool_choice,
      ...(modelInfo.extra_param || {})
    };
    
    // Ajouter stream_options pour les requêtes streaming OpenAI
    if (params.stream) {
      params.stream_options = {
        ...(params.stream_options || {}), // Preserve other stream_options if any
        include_usage: true
      };
    }
    
    return this.cleanParams(params);
  }

  transformResponse(response) {
    // OpenAI retourne déjà le format standard
    return response.data;
  }

  transformStreamChunk(chunk) {
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
      
      return new AdapterError(
        data?.error?.message || 'OpenAI API error',
        status,
        'API_ERROR',
        'openai'
      );
    }

    return new AdapterError(
      error.message || 'Unknown OpenAI error',
      500,
      'UNKNOWN_ERROR',
      'openai'
    );
  }

  async makeRequest(request, model, isStreaming = false) {
    const endpoint = this.getEndpoint(model);
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
      
      if (isStreaming) {
        return response; // Retourner le stream directement
      } else {
        return this.transformResponse(response);
      }
    } catch (error) {
      throw this.handleError(error);
    }
  }
}
