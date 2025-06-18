import { BaseAdapter, AdapterError } from './base.js';
import { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromEnv } from '@aws-sdk/credential-provider-env';
import { Readable } from 'stream';
import type { AxiosResponse } from 'axios';
import type { 
  StandardRequest, 
  ChatCompletion, 
  ChatCompletionChunk,
  AdapterConfig,
  Model,
  ToolCall,
  ChatMessage,
  ChatMessageContent
} from '../types/index.js';

/**
 * Interface pour les tools au format Anthropic/Bedrock
 */
interface BedrockTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * Interface pour les tool calls dans les réponses Bedrock
 */
interface BedrockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

/**
 * Interface pour les requêtes Bedrock (format Anthropic)
 */
interface BedrockAnthropicRequest {
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<{
      type: 'text' | 'image' | 'tool_use' | 'tool_result';
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, any>;
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string; }>;
      source?: {
        type: 'base64';
        media_type: string;
        data: string;
      };
      cache_control?: {
        type: 'ephemeral';
        ttl?: '5m' | '1h';
      };
    }>;
  }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  system?: string | Array<{
    type: 'text';
    text: string;
    cache_control?: {
      type: 'ephemeral';
      ttl?: '5m' | '1h';
    };
  }>;
  tools?: BedrockTool[];
  anthropic_version?: string;
}

/**
 * Interface pour les réponses Bedrock
 */
interface BedrockAnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, any>;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Interface pour les requêtes avec support du cache
 */
interface StandardRequestWithCache extends StandardRequest {
  messages: Array<ChatMessage & {
    cache_control?: {
      type: 'ephemeral';
      ttl?: '5m' | '1h';
    };
  }>;
}

/**
 * Interface pour les événements de streaming Bedrock
 */
interface BedrockStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  message?: {
    id: string;
    type: 'message';
    role: 'assistant';
    content: Array<any>;
    model: string;
    stop_reason: null;
    stop_sequence: null;
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  index?: number;
  content_block?: {
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, any>;
  };
  delta?: {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string;
  };
  usage?: {
    output_tokens: number;
  };
}

/**
 * Adapter pour AWS Bedrock avec support complet des tool calling
 * Supporte les modèles Claude et autres modèles disponibles sur Bedrock
 */
export class BedrockAdapter extends BaseAdapter {
  private client?: BedrockRuntimeClient;
  private region: string;
  private modelInfo?: Model;

  constructor(config: AdapterConfig = {}) {
    super(config);
    this.region = this.extractRegionFromConfig(config);
  }

  /**
   * Extrait la région depuis la configuration
   */
  private extractRegionFromConfig(config: AdapterConfig): string {
    const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    return envRegion || 'us-east-1';
  }

  /**
   * Configure l'adapter avec les informations du modèle
   */
  configure(config: Partial<AdapterConfig>, model?: Model): void {
    super.configure(config);
    this.modelInfo = model;
    
    if (model?.extra_param) {
      this.region = model.extra_param.region || this.region;
      
      const accessKeyEnv = model.extra_param.aws_access_key_env;
      const secretKeyEnv = model.extra_param.aws_secret_key_env;
      const regionEnv = model.extra_param.aws_region_env;

      if (accessKeyEnv && secretKeyEnv && regionEnv) {
        const accessKey = process.env[accessKeyEnv];
        const secretKey = process.env[secretKeyEnv];
        const region = process.env[regionEnv];
        
        if (accessKey && secretKey && region) {
          this.region = region;
          this.client = new BedrockRuntimeClient({
            region: this.region,
            credentials: {
              accessKeyId: accessKey,
              secretAccessKey: secretKey
            }
          });
        }
      }
    }
    
    // Fallback: utiliser les credentials par défaut
    if (!this.client) {
      this.client = new BedrockRuntimeClient({
        region: this.region,
        credentials: fromEnv()
      });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  buildHeaders(request: StandardRequest): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'LLM-Gateway-Bedrock/1.0'
    };
  }

  getEndpoint(model: string): string {
    return `bedrock:${this.region}:${model}`;
  }

  /**
   * Convertit les tools OpenAI vers le format Bedrock/Anthropic
   */
  private convertToolsToBedrockFormat(tools: any[]): BedrockTool[] {
    return tools.map(tool => {
      if (tool.type !== 'function') {
        throw this.createError('Only function tools are supported in Bedrock', 400, 'VALIDATION_ERROR');
      }

      const bedrockTool: BedrockTool = {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: {
          type: 'object',
          properties: tool.function.parameters?.properties || {},
          required: tool.function.parameters?.required || []
        }
      };

      return bedrockTool;
    });
  }

  /**
   * Détermine si un texte doit être automatiquement mis en cache
   * Seuil : 1024 tokens ≈ 4096 caractères (1 token ≈ 4 caractères)
   */
  private shouldAutoCache(text: string): boolean {
    const MIN_CACHE_CHARACTERS = 4096; // 1024 tokens * 4 chars/token
    return text.length >= MIN_CACHE_CHARACTERS;
  }

  /**
   * Convertit les tool calls Bedrock vers le format OpenAI
   */
  private convertBedrockToolCallsToOpenAI(content: BedrockAnthropicResponse['content']): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    content.forEach((item: BedrockAnthropicResponse['content'][0]) => {
      if (item.type === 'tool_use' && item.id && item.name && item.input) {
        toolCalls.push({
          id: item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input)
          }
        });
      }
    });

    return toolCalls;
  }

  /**
   * Convertit les messages avec tool results et cache control vers le format Bedrock
   */
  private convertMessagesToBedrockFormatWithCache(messages: any[]): BedrockAnthropicRequest['messages'] {
    const convertedMessages: BedrockAnthropicRequest['messages'] = [];
    
    for (const message of messages) {
      if (message.role === 'system') {
        continue; // Géré séparément
      }

      if (message.role === 'tool') {
        // Convertir le message tool en format Bedrock tool_result
        const lastMessage = convertedMessages[convertedMessages.length - 1];
        if (lastMessage && lastMessage.role === 'user') {
          // Ajouter le tool_result au dernier message user
          if (typeof lastMessage.content === 'string') {
            lastMessage.content = [{ type: 'text', text: lastMessage.content }];
          }
          (lastMessage.content as any[]).push({
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: message.content
          });
        } else {
          // Créer un nouveau message user avec le tool_result
          convertedMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content: message.content
            }]
          });
        }
        continue;
      }

      if (message.role === 'user' || message.role === 'assistant') {
        let content: string | Array<any>;
        
        // Détecter si le message a un cache_control au niveau du message
        const messageCacheControl = (message as any).cache_control;
        
        if (typeof message.content === 'string') {
          // Si on a du cache control au niveau du message, convertir en array
          if (messageCacheControl) {
            content = [{
              type: 'text',
              text: message.content,
              cache_control: messageCacheControl
            }];
          } else if (this.shouldAutoCache(message.content)) {
            // Cache automatique pour les messages longs (>4096 caractères ≈ >1024 tokens)
            content = [{
              type: 'text',
              text: message.content,
              cache_control: { type: 'ephemeral' }
            }];
            console.log(`🎯 Auto-cache activé pour message ${message.role} (${message.content.length} caractères)`);
          } else {
            content = message.content;
          }
        } else if (Array.isArray(message.content)) {
          // Gérer le contenu multimodal avec préservation du cache_control et auto-cache
          content = message.content.map((item: any) => {
            if (item.type === 'text') {
              const textBlock: any = { type: 'text', text: item.text };
              // Préserver cache_control de l'item
              if (item.cache_control) {
                textBlock.cache_control = item.cache_control;
              } else if (this.shouldAutoCache(item.text)) {
                // Cache automatique pour les blocs de texte longs
                textBlock.cache_control = { type: 'ephemeral' };
                console.log(`🎯 Auto-cache activé pour bloc texte ${message.role} (${item.text.length} caractères)`);
              }
              return textBlock;
            } else if (item.type === 'image_url') {
              // Convertir l'image URL en format Bedrock avec cache control
              const imageBlock: any = {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: item.image_url?.url || ''
                }
              };
              // Préserver cache_control de l'image
              if (item.cache_control) {
                imageBlock.cache_control = item.cache_control;
              }
              return imageBlock;
            }
            return item;
          });
          
          // Si on a du cache control au niveau du message et pas encore d'array, ajouter au dernier text block
          if (messageCacheControl && Array.isArray(content) && content.length > 0) {
            const lastTextBlock = content.filter((item: any) => item.type === 'text').pop();
            if (lastTextBlock && !lastTextBlock.cache_control) {
              lastTextBlock.cache_control = messageCacheControl;
            }
          }
        } else {
          content = '';
        }

        // Ajouter les tool calls si présents (pour les messages assistant)
        if (message.role === 'assistant' && message.tool_calls) {
          if (typeof content === 'string') {
            content = content ? [{ type: 'text', text: content }] : [];
          }
          
          message.tool_calls.forEach((toolCall: ToolCall) => {
            (content as any[]).push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input: JSON.parse(toolCall.function.arguments)
            });
          });
        }
        
        convertedMessages.push({
          role: message.role,
          content
        });
      }
    }
    
    return convertedMessages;
  }

  /**
   * Ancienne méthode maintenue pour compatibilité
   */
  private convertMessagesToBedrockFormat(messages: any[]): BedrockAnthropicRequest['messages'] {
    return this.convertMessagesToBedrockFormatWithCache(messages);
  }

  transformRequest(standardRequest: StandardRequest): BedrockAnthropicRequest {
    const messages = standardRequest.messages || [];
    
    // Séparer les messages système des autres et gérer le cache_control
    let systemMessage = '';
    let systemCacheControl: any = null;
    const conversationMessages = messages.filter(msg => {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemMessage += msg.content;
        } else if (Array.isArray(msg.content)) {
          // Extraire le texte des content blocks système
          const textContent = msg.content
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join('');
          systemMessage += textContent;
          
          // Récupérer le cache_control du premier bloc texte qui en a un
          const cachedTextBlock = msg.content.find(item => item.type === 'text' && (item as any).cache_control);
          if (cachedTextBlock) {
            systemCacheControl = (cachedTextBlock as any).cache_control;
          }
        }
        
        // Vérifier si le message système a cache_control au niveau du message
        if ((msg as any).cache_control) {
          systemCacheControl = (msg as any).cache_control;
        }
        
        return false;
      }
      return true;
    });
    
    const bedrockRequest: BedrockAnthropicRequest = {
      messages: this.convertMessagesToBedrockFormatWithCache(conversationMessages),
      max_tokens: standardRequest.max_tokens || 4096,
      anthropic_version: 'bedrock-2023-05-31'
    };
    
    // Ajouter les paramètres optionnels
    if (standardRequest.temperature !== undefined) {
      bedrockRequest.temperature = standardRequest.temperature;
    }
    
    if (standardRequest.top_p !== undefined) {
      bedrockRequest.top_p = standardRequest.top_p;
    }
    
    if (standardRequest.stop) {
      bedrockRequest.stop_sequences = Array.isArray(standardRequest.stop) 
        ? standardRequest.stop 
        : [standardRequest.stop];
    }
    
    // Gérer le système avec cache_control et auto-cache
    if (systemMessage) {
      if (systemCacheControl) {
        bedrockRequest.system = [{
          type: 'text',
          text: systemMessage,
          cache_control: systemCacheControl
        }];
      } else if (this.shouldAutoCache(systemMessage)) {
        // Cache automatique pour les messages système longs
        bedrockRequest.system = [{
          type: 'text',
          text: systemMessage,
          cache_control: { type: 'ephemeral' }
        }];
        console.log(`🎯 Auto-cache activé pour message système (${systemMessage.length} caractères)`);
      } else {
        bedrockRequest.system = systemMessage;
      }
    }

    // Convertir les tools au format Bedrock
    if (standardRequest.tools && standardRequest.tools.length > 0) {
      bedrockRequest.tools = this.convertToolsToBedrockFormat(standardRequest.tools);
    }
    
    return bedrockRequest;
  }

  transformResponse(response: BedrockAnthropicResponse): ChatCompletion {
    // Extraire le texte et les tool calls
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    // Si il y a usage dans la réponse, on affiche la réponse brut dans les logs
    if (response.usage) {
      console.log(`Bedrock response usage: ${JSON.stringify(response.usage)}`);
    }

    response.content.forEach(item => {
      if (item.type === 'text' && item.text) {
        textContent += item.text;
      } else if (item.type === 'tool_use' && item.id && item.name && item.input) {
        toolCalls.push({
          id: item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input)
          }
        });
      }
    });

    const completion: ChatCompletion = {
      id: response.id || `bedrock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model || 'bedrock-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null
        },
        finish_reason: this.mapFinishReason(response.stop_reason)
      }],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        cached_tokens: response.usage.cache_read_input_tokens || 0,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        ...(response.usage.cache_creation_input_tokens && { cache_creation_tokens: response.usage.cache_creation_input_tokens }),
        ...(response.usage.cache_read_input_tokens && { cache_read_tokens: response.usage.cache_read_input_tokens })
      } as any
    };

    // Ajouter les tool calls si présents
    if (toolCalls.length > 0) {
      completion.choices[0].message.tool_calls = toolCalls;
      completion.choices[0].finish_reason = 'tool_calls';
    }

    return completion;
  }

  transformStreamChunk(chunk: string): ChatCompletionChunk | null {
    try {
      const event: BedrockStreamEvent = JSON.parse(chunk);
      const timestamp = Math.floor(Date.now() / 1000);
      
      // Message start - premier chunk avec les métadonnées
      if (event.type === 'message_start' && event.message) {
        return {
          id: event.message.id,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: event.message.model,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant'
            },
            finish_reason: null
          }],
          usage: {
            prompt_tokens: event.message.usage.input_tokens,
            completion_tokens: event.message.usage.output_tokens,
            total_tokens: undefined
          }
        };
      }
      
      // Content block start - début d'un bloc de contenu
      if (event.type === 'content_block_start' && event.content_block) {
        if (event.content_block.type === 'tool_use') {
          // Début d'un tool call
          return {
            id: `bedrock-stream-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: timestamp,
            model: 'bedrock-model',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: event.index || 0,
                  id: event.content_block.id || '',
                  type: 'function',
                  function: {
                    name: event.content_block.name || '',
                    arguments: ''
                  }
                }]
              },
              finish_reason: null
            }]
          };
        }
        return null; // Ignorer les autres types de content_block_start
      }
      
      // Content block delta - contenu du message ou arguments des tools
      if (event.type === 'content_block_delta' && event.delta) {
        if (event.delta.type === 'text_delta' && event.delta.text) {
          // Texte normal
          return {
            id: `bedrock-stream-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: timestamp,
            model: 'bedrock-model',
            choices: [{
              index: 0,
              delta: {
                content: event.delta.text
              },
              finish_reason: null
            }]
          };
        } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
          // Arguments des tool calls
          return {
            id: `bedrock-stream-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: timestamp,
            model: 'bedrock-model',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: event.index || 0,
                  function: {
                    name: '',
                    arguments: event.delta.partial_json
                  }
                }]
              },
              finish_reason: null
            }]
          };
        }
      }
      
      // Content block stop - fin d'un bloc de contenu
      if (event.type === 'content_block_stop') {
        return null; // Pas besoin de chunk spécial pour la fin d'un bloc
      }
      
      // Message delta - mise à jour avec finish_reason
      if (event.type === 'message_delta' && event.delta) {
        return {
          id: `bedrock-stream-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: 'bedrock-model',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: this.mapFinishReason(event.delta.stop_reason)
          }],
          usage: event.usage ? {
            completion_tokens: event.usage.output_tokens,
            prompt_tokens: undefined,
            total_tokens: undefined
          } : undefined
        };
      }
      
      // Message stop - fin du stream
      if (event.type === 'message_stop') {
        return {
          id: `bedrock-stream-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: 'bedrock-model',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        };
      }
      
      return null;
    } catch (error) {
      console.error('Failed to parse Bedrock stream chunk:', chunk, error);
      return null;
    }
  }

  /**
   * Mappe les raisons d'arrêt Bedrock vers le format OpenAI
   */
  protected mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
    if (!reason) return null;
    
    const mappings: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'end_turn': 'stop',
      'stop_sequence': 'stop',
      'max_tokens': 'length',
      'tool_use': 'tool_calls'
    };

    return mappings[reason.toLowerCase()] || 'stop';
  }

  handleError(error: unknown): AdapterError {
    if (error && typeof error === 'object' && 'name' in error) {
      const awsError = error as any;
      
      switch (awsError.name) {
        case 'ValidationException':
          return new AdapterError(
            `Bedrock validation error: ${awsError.message}`,
            400,
            'VALIDATION_ERROR',
            'bedrock',
            error
          );
        
        case 'ThrottlingException':
          return new AdapterError(
            'Bedrock rate limit exceeded',
            429,
            'RATE_LIMIT_ERROR',
            'bedrock',
            error
          );
        
        case 'AccessDeniedException':
          return new AdapterError(
            'Bedrock access denied - check your credentials and model access',
            403,
            'AUTHENTICATION_ERROR',
            'bedrock',
            error
          );
        
        case 'ModelNotReadyException':
        case 'ModelErrorException':
          return new AdapterError(
            `Bedrock model error: ${awsError.message}`,
            503,
            'API_ERROR',
            'bedrock',
            error
          );
        
        default:
          return new AdapterError(
            `Bedrock error: ${awsError.message || 'Unknown AWS error'}`,
            500,
            'API_ERROR',
            'bedrock',
            error
          );
      }
    }
    
    return new AdapterError(
      error instanceof Error ? error.message : 'Unknown Bedrock error',
      500,
      'UNKNOWN_ERROR',
      'bedrock',
      error
    );
  }

  /**
   * Crée un stream readable personnalisé pour Bedrock
   */
  private createBedrockStream(responseStream: any): Readable {
    const readable = new Readable({
      read() {
        // Méthode vide, le push sera fait par les événements
      }
    });

    (async () => {
      try {
        for await (const event of responseStream) {
          if (event.chunk && event.chunk.bytes) {
            try {
              const decoder = new TextDecoder();
              const chunkText = decoder.decode(event.chunk.bytes);
              
              // Pousser l'événement AWS brut au format SSE
              const sseData = `data: ${chunkText}\n\n`;
              readable.push(sseData);
              
            } catch (parseError) {
              console.error('Error processing AWS chunk:', parseError);
            }
          }
        }
        
        readable.push('data: [DONE]\n\n');
        readable.push(null);
      } catch (error) {
        console.error('Error processing Bedrock stream:', error);
        readable.destroy(error as Error);
      }
    })();

    return readable;
  }

  /**
   * Active le prompt caching sur une requête standard
   */
  enablePromptCaching(request: StandardRequest, options: {
    cacheSystem?: boolean;
    cacheLastUserMessage?: boolean;
    cacheAllUserMessages?: boolean;
    ttl?: '5m' | '1h';
  } = {}): StandardRequestWithCache {
    const {
      cacheSystem = false,
      cacheLastUserMessage = false,
      cacheAllUserMessages = false,
      ttl = '5m'
    } = options;

    // Créer une copie profonde de la requête
    const cachedRequest = JSON.parse(JSON.stringify(request)) as StandardRequestWithCache;

    // Cache système
    if (cacheSystem && cachedRequest.messages.length > 0) {
      for (let i = 0; i < cachedRequest.messages.length; i++) {
        const message = cachedRequest.messages[i];
        if (message.role === 'system') {
          // Ajouter cache_control au message système
          (message as any).cache_control = { type: 'ephemeral', ttl };
          break; // Cacher seulement le premier message système
        }
      }
    }

    // Cache des messages utilisateur
    if (cacheLastUserMessage || cacheAllUserMessages) {
      const userMessages: number[] = [];
      
      // Trouver tous les index des messages utilisateur
      cachedRequest.messages.forEach((message, index) => {
        if (message.role === 'user') {
          userMessages.push(index);
        }
      });

      if (userMessages.length > 0) {
        if (cacheLastUserMessage) {
          // Cacher seulement le dernier message utilisateur
          const lastUserIndex = userMessages[userMessages.length - 1];
          const lastUserMessage = cachedRequest.messages[lastUserIndex];
          
          // Convertir string en array si nécessaire
          if (typeof lastUserMessage.content === 'string') {
            (lastUserMessage as any).content = [{
              type: 'text',
              text: lastUserMessage.content,
              cache_control: { type: 'ephemeral', ttl }
            }];
          } else if (Array.isArray(lastUserMessage.content)) {
            // Ajouter cache_control au dernier bloc de texte
            const lastTextBlock = lastUserMessage.content
              .filter(item => item.type === 'text')
              .pop();
            if (lastTextBlock) {
              (lastTextBlock as any).cache_control = { type: 'ephemeral', ttl };
            }
          }
        } else if (cacheAllUserMessages) {
          // Cacher tous les messages utilisateur
          userMessages.forEach(userIndex => {
            const userMessage = cachedRequest.messages[userIndex];
            
            // Convertir string en array si nécessaire
            if (typeof userMessage.content === 'string') {
              (userMessage as any).content = [{
                type: 'text',
                text: userMessage.content,
                cache_control: { type: 'ephemeral', ttl }
              }];
            } else if (Array.isArray(userMessage.content)) {
              // Ajouter cache_control au dernier bloc de texte
              const lastTextBlock = userMessage.content
                .filter(item => item.type === 'text')
                .pop();
              if (lastTextBlock) {
                (lastTextBlock as any).cache_control = { type: 'ephemeral', ttl };
              }
            }
          });
        }
      }
    }

    return cachedRequest;
  }

  async makeRequest(
    request: StandardRequest | StandardRequestWithCache, 
    model: string, 
    isStreaming: boolean = false
  ): Promise<AxiosResponse | ChatCompletion> {
    if (!this.client) {
      throw this.createError('Bedrock client not configured', 500, 'API_ERROR');
    }

    const startTime = Date.now();
    const bedrockRequest = this.transformRequest(request);
    const requestBody = JSON.stringify(bedrockRequest);

    try {
      if (isStreaming) {
        const command = new InvokeModelWithResponseStreamCommand({
          modelId: model,
          body: requestBody,
          contentType: 'application/json',
          accept: 'application/json'
        });

        const response = await this.client.send(command);
        
        if (!response.body) {
          throw this.createError('Empty response from Bedrock', 500, 'API_ERROR');
        }

        const streamData = this.createBedrockStream(response.body);
        
        const duration = Date.now() - startTime;
        this.logMetrics('makeStreamRequest', duration, true);
        
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
            url: `bedrock:${this.region}:${model}`,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'LLM-Gateway-Bedrock/1.0'
            }
          },
          request: {}
        } as unknown as AxiosResponse;
        
      } else {
        const command = new InvokeModelCommand({
          modelId: model,
          body: requestBody,
          contentType: 'application/json',
          accept: 'application/json'
        });

        const response = await this.client.send(command);
        
        if (!response.body) {
          throw this.createError('Empty response from Bedrock', 500, 'API_ERROR');
        }

        const responseText = new TextDecoder().decode(response.body);
        const bedrockResponse: BedrockAnthropicResponse = JSON.parse(responseText);
        
        const duration = Date.now() - startTime;
        this.logMetrics('makeRequest', duration, true);
        
        return this.transformResponse(bedrockResponse);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logMetrics(isStreaming ? 'makeStreamRequest' : 'makeRequest', duration, false);
      
      throw this.handleError(error);
    }
  }

  /**
   * Validation spécifique à Bedrock avec support des tools
   */
  protected performValidation(request: StandardRequest, model: Model) {
    const baseValidation = super.performValidation(request, model);
    const bedrockErrors: string[] = [];

    // Vérifier les limites de tokens selon le modèle
    if (request.max_tokens && request.max_tokens > 8192) {
      bedrockErrors.push('max_tokens cannot exceed 8192 for most Bedrock models');
    }

    // Vérifier que le modèle est un ARN Bedrock valide ou un nom de modèle
    if (model.provider_model_id && 
        !model.provider_model_id.includes('arn:aws:bedrock') && 
        !model.provider_model_id.includes('anthropic.claude')) {
      console.warn(`Bedrock model ${model.provider_model_id} may not be a valid Bedrock model identifier`);
    }

    // Validation des tools
    if (request.tools && request.tools.length > 0) {
      if (!model.support_tool_calling) {
        bedrockErrors.push('Model does not support tool calling');
      } else {
        // Valider chaque tool
        request.tools.forEach((tool, index) => {
          if (tool.type !== 'function') {
            bedrockErrors.push(`Tool ${index}: only 'function' type is supported in Bedrock`);
          }
          if (!tool.function.name) {
            bedrockErrors.push(`Tool ${index}: function name is required`);
          }
          if (!tool.function.parameters || typeof tool.function.parameters !== 'object') {
            bedrockErrors.push(`Tool ${index}: function parameters must be an object`);
          }
          if (tool.function.parameters && !tool.function.parameters.type) {
            bedrockErrors.push(`Tool ${index}: function parameters must have a 'type' property`);
          }
        });
      }
    }

    // Validation des tool choice (Bedrock ne supporte pas tool_choice explicite)
    if (request.tool_choice && request.tool_choice !== 'auto') {
      console.warn('Bedrock does not support explicit tool_choice, using auto mode');
    }

    // Validation des messages avec tool calls et tool results
    if (request.messages) {
      let hasToolCalls = false;
      let hasToolResults = false;
      
      request.messages.forEach((message, index) => {
        if (message.tool_calls && message.tool_calls.length > 0) {
          hasToolCalls = true;
          if (message.role !== 'assistant') {
            bedrockErrors.push(`Message ${index}: tool_calls can only be in assistant messages`);
          }
        }
        if (message.role === 'tool') {
          hasToolResults = true;
          if (!message.tool_call_id) {
            bedrockErrors.push(`Message ${index}: tool message must have tool_call_id`);
          }
        }
      });
      
      // Si on a des tool calls, on doit soit avoir des tools définis, soit des tool results
      if (hasToolCalls && !request.tools && !hasToolResults) {
        bedrockErrors.push('Tool calls found in messages but no tools defined in request');
      }
    }

    return {
      valid: baseValidation.valid && bedrockErrors.length === 0,
      errors: [...baseValidation.errors, ...bedrockErrors]
    };
  }

  /**
   * Obtient les informations spécifiques à Bedrock
   */
  getBedrockInfo(): {
    region: string;
    modelInfo?: Model;
    supportsTools: boolean;
  } {
    return {
      region: this.region,
      modelInfo: this.modelInfo,
      supportsTools: this.modelInfo?.support_tool_calling || false
    };
  }
}
