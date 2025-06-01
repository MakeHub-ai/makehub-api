import { BaseAdapter, AdapterError } from './base.js';
import axios from 'axios';

/**
 * Adapter pour l'API Anthropic Claude
 */
export class AnthropicAdapter extends BaseAdapter {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.API_KEY_ANTHROPIC;
    this.baseURL = config.baseURL || 'https://api.anthropic.com';
  }

  isConfigured() {
    return !!this.apiKey;
  }

  buildHeaders(request) {
    return {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'LLM-Gateway/1.0'
    };
  }

  getEndpoint(model) {
    return `${this.baseURL}/v1/messages`;
  }

  transformRequest(standardRequest) {
    const messages = this.convertMessages(standardRequest.messages);
    
    const params = {
      model: standardRequest.model.provider_model_id,
      messages: messages.messages,
      max_tokens: standardRequest.max_tokens || 4096,
      stream: standardRequest.stream || false
    };

    // Ajouter le system prompt si présent
    if (messages.system) {
      params.system = messages.system;
    }

    // Ajouter les paramètres optionnels
    if (standardRequest.temperature !== undefined) {
      params.temperature = standardRequest.temperature;
    }
    if (standardRequest.top_p !== undefined) {
      params.top_p = standardRequest.top_p;
    }

    return this.cleanParams(params);
  }

  convertMessages(messages) {
    const result = {
      messages: [],
      system: null
    };

    for (const message of messages) {
      if (message.role === 'system') {
        // Anthropic utilise un paramètre system séparé
        result.system = message.content;
      } else {
        result.messages.push({
          role: message.role,
          content: message.content
        });
      }
    }

    return result;
  }

  transformResponse(response) {
    const data = response.data;
    
    // Convertir la réponse Anthropic vers le format OpenAI
    return {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: data.content[0]?.text || ''
        },
        finish_reason: this.mapStopReason(data.stop_reason)
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      }
    };
  }

  transformStreamChunk(chunk) {
    if (!chunk) return null;

    try {
      const data = JSON.parse(chunk);
      
      if (data.type === 'content_block_delta') {
        return {
          id: data.id || 'chatcmpl-anthropic',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'claude',
          choices: [{
            index: 0,
            delta: {
              content: data.delta?.text || ''
            },
            finish_reason: null
          }]
        };
      }

      if (data.type === 'message_stop') {
        return {
          id: data.id || 'chatcmpl-anthropic',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'claude',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        };
      }

      return null;
    } catch (error) {
      console.warn('Failed to parse Anthropic stream chunk:', chunk);
      return null;
    }
  }

  mapStopReason(stopReason) {
    switch (stopReason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'stop_sequence':
        return 'stop';
      default:
        return 'stop';
    }
  }

  handleError(error, response) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      
      return new AdapterError(
        data?.error?.message || 'Anthropic API error',
        status,
        'API_ERROR',
        'anthropic'
      );
    }

    return new AdapterError(
      error.message || 'Unknown Anthropic error',
      500,
      'UNKNOWN_ERROR',
      'anthropic'
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
