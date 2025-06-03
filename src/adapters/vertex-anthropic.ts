// vertex-anthropic-native.ts
import { BaseAdapter, AdapterError } from './base.js';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk'; // SDK natif Anthropic pour Vertex
import { Readable } from 'stream';
import type { AxiosResponse } from 'axios';
import type {
  StandardRequest,
  ChatCompletion,
  ChatCompletionChunk,
  AdapterConfig,
  Model,
  ToolCall,
  Tool,
  ToolChoice,
  AdapterErrorCode
} from '../types/index.js';

/**
 * Adapter Vertex AI utilisant le SDK natif Anthropic
 * Architecture similaire à Bedrock avec streaming optimisé
 */
export class VertexAnthropicAdapter extends BaseAdapter {
  private client?: AnthropicVertex;
  private projectId: string;
  private region: string;
  private modelInfo?: Model;

  constructor(config: AdapterConfig = {}) {
    super(config);
    this.name = 'vertex-anthropic';
    this.projectId = '';
    this.region = '';
  }

  configure(config: Partial<AdapterConfig>, model?: Model): void {
    super.configure(config);
    this.modelInfo = model;

    if (model?.extra_param) {
      this.projectId = model.extra_param.project_id || process.env.VERTEX_PROJECT_ID || '';
      this.region = model.extra_param.region || process.env.VERTEX_REGION || 'us-central1';
    }

    console.log('Configuring VertexAnthropicAdapter:', {
      projectId: this.projectId,
      region: this.region
    });

    this.setupNativeClient();
  }

  private setupNativeClient(): void {
    try {
      if (this.projectId && this.region) {
        // Utilisation du SDK natif Anthropic pour Vertex
        this.client = new AnthropicVertex({
          projectId: this.projectId,
          region: this.region,
          // L'authentification est gérée automatiquement par Google Cloud SDK
        });
      }
    } catch (error) {
      console.error('Failed to setup Anthropic Vertex client:', error);
      throw this.createError(
        `Failed to setup Vertex client: ${error instanceof Error ? error.message : 'Unknown error'}`,
        500,
        'API_ERROR'
      );
    }
  }

  isConfigured(): boolean {
    return !!(this.client && this.projectId && this.region);
  }

  buildHeaders(request: StandardRequest): Record<string, string> {
    return {
      'Content-Type': 'application/json',
              'User-Agent': 'LLM-Gateway-Vertex/1.0'
    };
  }

  getEndpoint(modelIdentifier: string): string {
    return `vertex-ai:${this.region}:${modelIdentifier}`;
  }

  transformRequest(standardRequest: StandardRequest): any {
    const messages = standardRequest.messages || [];

    // Séparer les messages système
    let systemMessage = '';
    const conversationMessages = messages.filter(msg => {
      if (msg.role === 'system') {
        systemMessage += (typeof msg.content === 'string' ? msg.content :
          Array.isArray(msg.content) ? msg.content.find(c => c.type === 'text')?.text || '' : '');
        return false;
      }
      return true;
    });

    const vertexRequest: any = {
      messages: this.convertMessagesToVertexFormat(conversationMessages),
      max_tokens: standardRequest.max_tokens || 4096,
    };

    if (systemMessage) {
      vertexRequest.system = systemMessage;
    }

    if (standardRequest.temperature !== undefined) {
      vertexRequest.temperature = standardRequest.temperature;
    }
    if (standardRequest.top_p !== undefined) {
      vertexRequest.top_p = standardRequest.top_p;
    }

    if (standardRequest.stop) {
      vertexRequest.stop_sequences = Array.isArray(standardRequest.stop)
        ? standardRequest.stop
        : [standardRequest.stop];
    }

    if (standardRequest.tools && standardRequest.tools.length > 0) {
      vertexRequest.tools = this.convertToolsToVertexFormat(standardRequest.tools);
    }

    return this.cleanParams(vertexRequest);
  }

  private convertMessagesToVertexFormat(messages: StandardRequest['messages']): any[] {
    const convertedMessages: any[] = [];
    if (!messages) return convertedMessages;

    for (const message of messages) {
      if (message.role === 'system') continue;

      if (message.role === 'tool') {
        const toolResultContent = {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: [{ 
            type: 'text', 
            text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) 
          }],
        };
        convertedMessages.push({
          role: 'user',
          content: [toolResultContent]
        });
        continue;
      }

      let contentArray: any[];
      if (typeof message.content === 'string') {
        contentArray = [{ type: 'text', text: message.content }];
      } else if (Array.isArray(message.content)) {
        contentArray = message.content.map((item: any) => {
          if (item.type === 'text') {
            return { type: 'text', text: item.text };
          } else if (item.type === 'image_url' && item.image_url?.url) {
            const urlData = item.image_url.url;
            let mediaType = 'image/jpeg';
            let base64Data = urlData;

            if (urlData.startsWith('data:')) {
              const parts = urlData.split(';');
              if (parts.length === 2 && parts[0].startsWith('data:') && parts[1].startsWith('base64,')) {
                mediaType = parts[0].slice(5);
                base64Data = parts[1].slice(7);
              }
            }
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            };
          }
          return null;
        }).filter(Boolean) as any[];
      } else {
        contentArray = [];
      }

      if (message.role === 'assistant' && message.tool_calls) {
        message.tool_calls.forEach((toolCall: ToolCall) => {
          contentArray.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments)
          });
        });
      }
      
      if (contentArray.length > 0) {
        convertedMessages.push({ role: message.role, content: contentArray });
      }
    }
    return convertedMessages;
  }

  private convertToolsToVertexFormat(tools: StandardRequest['tools']): any[] {
    if (!tools) return [];
    return tools.map(tool => {
      if (tool.type !== 'function') {
        throw this.createError("Vertex/Anthropic adapter only supports 'function' tools.", 400, 'VALIDATION_ERROR');
      }
      return {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters
      };
    });
  }

  transformResponse(response: any): ChatCompletion {
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    if (response.content && Array.isArray(response.content)) {
      response.content.forEach((item: any) => {
        if (item.type === 'text') {
          textContent += item.text;
        } else if (item.type === 'tool_use' && item.id && item.name && item.input) {
          toolCalls.push({
            id: item.id,
            type: 'function',
            function: {
              name: item.name,
              arguments: JSON.stringify(item.input),
            },
          });
        }
      });
    }

    const completion: ChatCompletion = {
      id: response.id || `vertex-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.modelInfo?.model_id || response.model || 'vertex-anthropic-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: this.mapFinishReason(response.stop_reason),
      }],
      usage: {
        prompt_tokens: response.usage?.input_tokens,
        completion_tokens: response.usage?.output_tokens,
        total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      }
    };
    return completion;
  }

  /**
   * Crée un stream optimisé similaire à Bedrock
   * Utilise le streaming du SDK Anthropic
   */
  private createVertexStream(anthropicStream: any): Readable {
    const readable = new Readable({
      read() {
        // Méthode vide, contrôlée par les événements
      }
    });

    (async () => {
      try {
        // Utilisation du stream natif Anthropic (similaire à Bedrock)
        for await (const event of anthropicStream) {
          try {
            // Convertir l'événement Anthropic en format SSE
            const sseData = `data: ${JSON.stringify(event)}\n\n`;
            readable.push(sseData);
          } catch (parseError) {
            console.error('Error processing Vertex chunk:', parseError);
          }
        }
        
        readable.push('data: [DONE]\n\n');
        readable.push(null);
      } catch (error) {
        console.error('Error processing Vertex stream:', error);
        readable.destroy(error as Error);
      }
    })();

    return readable;
  }

  transformStreamChunk(chunk: string): ChatCompletionChunk | null {
    if (!chunk || chunk.trim() === '' || chunk.trim().toLowerCase() === '[done]') {
      return null;
    }

    try {
      const event = JSON.parse(chunk);
      const timestamp = Math.floor(Date.now() / 1000);
      const modelId = this.modelInfo?.model_id || event.message?.model || 'vertex-anthropic-model';

      // Logique de transformation similaire à l'adapter original
      // mais optimisée pour le SDK natif
      if (event.type === 'message_start' && event.message) {
        return {
          id: event.message.id,
          object: 'chat.completion.chunk' as const,
          created: timestamp,
          model: modelId,
          choices: [{
            index: 0,
            delta: { role: 'assistant' as const },
            finish_reason: null
          }],
          usage: event.message.usage ? {
            prompt_tokens: event.message.usage.input_tokens,
          } : undefined
        };
      }

      if (event.type === 'content_block_delta' && event.delta) {
        if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
          return {
            id: event.message?.id || `vertex-${Date.now()}`,
            object: 'chat.completion.chunk' as const,
            created: timestamp,
            model: modelId,
            choices: [{
              index: 0,
              delta: { content: event.delta.text },
              finish_reason: null
            }]
          };
        }
      }

      // Gestion des autres types d'événements...
      return null;

    } catch (error) {
      console.error('Failed to parse Vertex stream chunk:', chunk, error);
      return null;
    }
  }

  protected mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
    if (!reason) return null;
    const mappings: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'end_turn': 'stop',
      'stop_sequence': 'stop',
      'max_tokens': 'length',
      'tool_use': 'tool_calls',
    };
    return mappings[reason.toLowerCase()] || 'stop';
  }

  handleError(error: unknown): AdapterError {
    // Gestion des erreurs spécifiques au SDK Anthropic Vertex
    if (error && typeof error === 'object' && 'status' in error) {
      const anthropicError = error as any;
      
      let errorMessage = 'Vertex Anthropic SDK error';
      let adapterErrorCode: AdapterErrorCode = 'API_ERROR';

      switch (anthropicError.status) {
        case 400:
          adapterErrorCode = 'VALIDATION_ERROR';
          errorMessage = `Vertex Bad Request: ${anthropicError.message || 'Invalid request'}`;
          break;
        case 401:
        case 403:
          adapterErrorCode = 'AUTHENTICATION_ERROR';
          errorMessage = `Vertex Authentication Error: ${anthropicError.message || 'Check credentials'}`;
          break;
        case 429:
          adapterErrorCode = 'RATE_LIMIT_ERROR';
          errorMessage = `Vertex Rate Limit: ${anthropicError.message || 'Too many requests'}`;
          break;
        case 500:
        case 503:
          adapterErrorCode = 'API_ERROR';
          errorMessage = `Vertex Service Error: ${anthropicError.message || 'Service unavailable'}`;
          break;
      }

      return new AdapterError(errorMessage, anthropicError.status || 500, adapterErrorCode, this.name, error);
    }

    return new AdapterError(
      error instanceof Error ? error.message : 'Unknown Vertex error',
      500,
      'UNKNOWN_ERROR',
      this.name,
      error
    );
  }

  async makeRequest(
    request: StandardRequest,
    modelIdentifier: string,
    isStreaming: boolean = false
  ): Promise<AxiosResponse | ChatCompletion> {
    if (!this.client) {
      throw this.createError('Vertex Anthropic client not configured', 500, 'VALIDATION_ERROR');
    }

    const startTime = Date.now();

    try {
      const vertexRequest = this.transformRequest(request);

      if (isStreaming) {
        // Utilisation du streaming natif du SDK Anthropic
        const stream = await this.client.messages.stream({
          model: modelIdentifier,
          ...vertexRequest
        });

        const streamData = this.createVertexStream(stream);
        
        const duration = Date.now() - startTime;
        this.logMetrics('makeStreamRequest', duration, true);
        
        // Retourner un objet compatible AxiosResponse pour le streaming
        return {
          data: streamData,
          status: 200,
          statusText: 'OK',
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive'
          },
          config: {
            method: 'POST',
            url: this.getEndpoint(modelIdentifier),
            headers: this.buildHeaders(request)
          },
          request: {}
        } as unknown as AxiosResponse;
        
      } else {
        // Requête standard (non-streaming)
        const response = await this.client.messages.create({
          model: modelIdentifier,
          ...vertexRequest
        });
        
        const duration = Date.now() - startTime;
        this.logMetrics('makeRequest', duration, true);
        
        return this.transformResponse(response);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logMetrics(isStreaming ? 'makeStreamRequest' : 'makeRequest', duration, false);
      
      throw this.handleError(error);
    }
  }

  protected performValidation(request: StandardRequest, model: Model) {
    const baseValidation = super.performValidation(request, model);
    const vertexErrors: string[] = [];

    if (!this.projectId) {
      vertexErrors.push('Vertex Project ID is required');
    }
    if (!this.region) {
      vertexErrors.push('Vertex Region is required');
    }

    // Validation similaire à l'adapter original...

    return {
      valid: baseValidation.valid && vertexErrors.length === 0,
      errors: [...baseValidation.errors, ...vertexErrors]
    };
  }
}
