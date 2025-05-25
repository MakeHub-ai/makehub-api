import { BaseProvider, ProviderError, AuthenticationError, RateLimitError } from './base.js';
import axios from 'axios';

export class AnthropicProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.API_KEY_ANTHROPIC;
    this.baseURL = config.baseURL || 'https://api.anthropic.com';
    this.version = config.version || '2023-06-01';
  }

  isConfigured() {
    return !!this.apiKey;
  }

  buildHeaders(request) {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': this.version,
      'Content-Type': 'application/json',
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

    // Paramètres optionnels
    if (standardRequest.temperature !== undefined) {
      params.temperature = standardRequest.temperature;
    }
    if (standardRequest.top_p !== undefined) {
      params.top_p = standardRequest.top_p;
    }
    if (standardRequest.stop !== undefined) {
      params.stop_sequences = Array.isArray(standardRequest.stop) 
        ? standardRequest.stop 
        : [standardRequest.stop];
    }

    // Support des tools
    if (standardRequest.tools && standardRequest.tools.length > 0) {
      params.tools = this.convertTools(standardRequest.tools);
      if (standardRequest.tool_choice && standardRequest.tool_choice !== 'auto') {
        params.tool_choice = this.convertToolChoice(standardRequest.tool_choice);
      }
    }

    // Paramètres spécifiques au modèle
    if (standardRequest.model.extra_param) {
      Object.assign(params, standardRequest.model.extra_param);
    }

    return this.cleanParams(params);
  }

  convertMessages(messages) {
    const anthropicMessages = [];
    let systemPrompt = '';

    for (const message of messages) {
      if (message.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + message.content;
      } else if (message.role === 'user' || message.role === 'assistant') {
        const anthropicMessage = {
          role: message.role,
          content: this.convertContent(message.content)
        };

        // Support des tool_calls pour les messages assistant
        if (message.tool_calls && message.tool_calls.length > 0) {
          anthropicMessage.content = this.convertToolCalls(message.tool_calls);
        }

        anthropicMessages.push(anthropicMessage);
      } else if (message.role === 'tool') {
        // Convertir les réponses de tools
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: message.content
          }]
        });
      }
    }

    return {
      messages: anthropicMessages,
      system: systemPrompt || undefined
    };
  }

  convertContent(content) {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content.map(item => {
        if (item.type === 'text') {
          return { type: 'text', text: item.text };
        } else if (item.type === 'image_url') {
          // Anthropic utilise un format différent pour les images
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg', // À détecter automatiquement
              data: item.image_url.url.split(',')[1] // Enlever le préfixe data:
            }
          };
        }
        return item;
      });
    }

    return content;
  }

  convertTools(tools) {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters
    }));
  }

  convertToolChoice(toolChoice) {
    if (typeof toolChoice === 'string') {
      return { type: toolChoice };
    }
    if (toolChoice.type === 'function') {
      return {
        type: 'tool',
        name: toolChoice.function.name
      };
    }
    return toolChoice;
  }

  convertToolCalls(toolCalls) {
    return toolCalls.map(call => ({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: JSON.parse(call.function.arguments)
    }));
  }

  transformResponse(response) {
    const data = response.data;
    
    // Convertir au format OpenAI
    const openaiResponse = {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [{
        index: 0,
        message: this.convertAnthropicMessage(data.content),
        finish_reason: this.convertStopReason(data.stop_reason)
      }],
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens
      } : undefined
    };

    return openaiResponse;
  }

  convertAnthropicMessage(content) {
    const message = {
      role: 'assistant',
      content: ''
    };

    if (Array.isArray(content)) {
      const textParts = [];
      const toolCalls = [];

      for (const part of content) {
        if (part.type === 'text') {
          textParts.push(part.text);
        } else if (part.type === 'tool_use') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input)
            }
          });
        }
      }

      message.content = textParts.join('');
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
    } else {
      message.content = content;
    }

    return message;
  }

  convertStopReason(stopReason) {
    switch (stopReason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      case 'stop_sequence':
        return 'stop';
      default:
        return 'stop';
    }
  }

  transformStreamChunk(chunk) {
    if (!chunk || chunk.trim() === '') {
      return null;
    }

    try {
      const data = JSON.parse(chunk);
      
      // Convertir au format OpenAI stream
      if (data.type === 'content_block_delta') {
        return {
          id: data.id || 'anthropic-stream',
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
      } else if (data.type === 'message_stop') {
        return {
          id: data.id || 'anthropic-stream',
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

  handleError(error, response) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      
      switch (status) {
        case 401:
          return new AuthenticationError(
            data?.error?.message || 'Invalid API key',
            'anthropic'
          );
        case 429:
          return new RateLimitError(
            data?.error?.message || 'Rate limit exceeded',
            'anthropic',
            error.response.headers['retry-after']
          );
        case 400:
          return new ProviderError(
            data?.error?.message || 'Bad request',
            400,
            'BAD_REQUEST',
            'anthropic'
          );
        default:
          return new ProviderError(
            data?.error?.message || 'Anthropic API error',
            status,
            'API_ERROR',
            'anthropic'
          );
      }
    }

    if (error.code === 'ECONNABORTED') {
      return new ProviderError(
        'Request timeout',
        408,
        'TIMEOUT_ERROR',
        'anthropic'
      );
    }

    return new ProviderError(
      error.message || 'Unknown Anthropic error',
      500,
      'UNKNOWN_ERROR',
      'anthropic'
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
    const streamRequest = { ...request, stream: true };
    const response = await this.makeRequest(streamRequest, model, true);
    
    let buffer = '';
    
    for await (const chunk of response.data) {
      buffer += chunk.toString();
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          
          const parsed = this.transformStreamChunk(data);
          if (parsed) {
            yield parsed;
          }
        }
      }
    }
  }

  extractTokenUsage(response) {
    if (response.usage) {
      return {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens
      };
    }
    return null;
  }

  getHealthInfo() {
    return {
      ...super.getHealthInfo(),
      status: this.isConfigured() ? 'configured' : 'not_configured',
      baseURL: this.baseURL,
      version: this.version
    };
  }
}
