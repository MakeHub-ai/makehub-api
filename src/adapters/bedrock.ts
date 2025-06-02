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
  Model
} from '../types/index.js';

/**
 * Interface pour les requêtes Bedrock (format Anthropic)
 */
interface BedrockAnthropicRequest {
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<{
      type: 'text' | 'image';
      text?: string;
      source?: {
        type: 'base64';
        media_type: string;
        data: string;
      };
    }>;
  }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  system?: string;
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
    type: 'text';
    text: string;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
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
    type: 'text';
    text: string;
  };
  delta?: {
    type: 'text_delta';
    text?: string;
    stop_reason?: string;
    stop_sequence?: string;
  };
  usage?: {
    output_tokens: number;
  };
}

/**
 * Adapter pour AWS Bedrock
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
    // Essayer d'extraire depuis baseURL ou defaulter
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
      
      // Configurer les credentials depuis les variables d'environnement
      const accessKeyEnv = model.extra_param.aws_access_key_env;
      const secretKeyEnv = model.extra_param.aws_secret_key_env;
      const regionEnv = model.extra_param.aws_region_env;

      // Vérifier les variables d'environnement
      if (!accessKeyEnv || !secretKeyEnv || !regionEnv) {
        console.warn('Missing AWS environment variables for Bedrock configuration. Using default credentials.');
      }
      
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
    // Bedrock n'utilise pas d'endpoint HTTP classique
    return `bedrock:${this.region}:${model}`;
  }

  transformRequest(standardRequest: StandardRequest): BedrockAnthropicRequest {
    const modelInfo = standardRequest.model;
    const messages = standardRequest.messages || [];
    
    // Séparer les messages système des autres
    let systemMessage = '';
    const conversationMessages: BedrockAnthropicRequest['messages'] = [];
    
    for (const message of messages) {
      if (message.role === 'system') {
        systemMessage += (typeof message.content === 'string' ? message.content : '');
      } else if (message.role === 'user' || message.role === 'assistant') {
        // Convertir le contenu
        let content: string | Array<any>;
        
        if (typeof message.content === 'string') {
          content = message.content;
        } else if (Array.isArray(message.content)) {
          // Gérer le contenu multimodal
          content = message.content.map(item => {
            if (item.type === 'text') {
              return { type: 'text', text: item.text };
            } else if (item.type === 'image_url') {
              // Convertir l'image URL en format Bedrock
              // Note: Bedrock nécessite des images en base64
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg', // Assumption par défaut
                  data: item.image_url?.url || ''
                }
              };
            }
            return item;
          });
        } else {
          content = '';
        }
        
        conversationMessages.push({
          role: message.role,
          content
        });
      }
    }
    
    const bedrockRequest: BedrockAnthropicRequest = {
      messages: conversationMessages,
      max_tokens: standardRequest.max_tokens || 4096,
      anthropic_version: 'bedrock-2023-05-31' // Version Bedrock pour Anthropic
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
    
    if (systemMessage) {
      bedrockRequest.system = systemMessage;
    }
    
    return bedrockRequest;
  }

  transformResponse(response: BedrockAnthropicResponse): ChatCompletion {
    const content = response.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('');
    
    return {
      id: response.id || `bedrock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model || 'bedrock-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: content
        },
        finish_reason: this.mapFinishReason(response.stop_reason)
      }],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens
      }
    };
  }

  transformStreamChunk(chunk: string): ChatCompletionChunk | null {
    
    try {
      const event: BedrockStreamEvent = JSON.parse(chunk);
      const timestamp = Math.floor(Date.now() / 1000);
      
      
      // Message start - premier chunk avec les métadonnées
      if (event.type === 'message_start' && event.message) {
        const chunkResult = {
          id: event.message.id,
          object: 'chat.completion.chunk' as const,
          created: timestamp,
          model: event.message.model,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant' as const
            },
            finish_reason: null
          }],
          usage: {
            prompt_tokens: event.message.usage.input_tokens,
            completion_tokens: event.message.usage.output_tokens,
            total_tokens: undefined
          }
        };
        return chunkResult;
      }
      
      // Content block start - début du contenu (optionnel, juste pour info)
      if (event.type === 'content_block_start') {
        return null; // On peut ignorer cet événement ou retourner un chunk vide
      }
      
      // Content block delta - contenu du message
      if (event.type === 'content_block_delta' && event.delta?.text) {
        const chunkResult = {
          id: `bedrock-stream-${Date.now()}`,
          object: 'chat.completion.chunk' as const,
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
        return chunkResult;
      }
      
      // Message delta - mise à jour avec finish_reason
      if (event.type === 'message_delta' && event.delta) {
        const chunkResult = {
          id: `bedrock-stream-${Date.now()}`,
          object: 'chat.completion.chunk' as const,
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
        return chunkResult;
      }
      
      // Message stop - fin du stream
      if (event.type === 'message_stop') {
        const chunkResult = {
          id: `bedrock-stream-${Date.now()}`,
          object: 'chat.completion.chunk' as const,
          created: timestamp,
          model: 'bedrock-model',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop' as const
          }]
        };
        return chunkResult;
      }
      
      // Content block stop - fin d'un bloc de contenu (optionnel)
      if (event.type === 'content_block_stop') {
        return null; // On peut ignorer cet événement
      }
      
      return null;
    } catch (error) {
      console.error('❌ Failed to parse Bedrock stream chunk:', chunk, error);
      return null;
    }
  }

  handleError(error: unknown): AdapterError {
    if (error && typeof error === 'object' && 'name' in error) {
      const awsError = error as any;
      
      // Erreurs AWS spécifiques
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

    // Traiter le stream AWS
    (async () => {
      try {
        for await (const event of responseStream) {
          
          // Les événements AWS Bedrock ont différents types
          if (event.chunk && event.chunk.bytes) {
            try {
              // Décoder le chunk depuis AWS
              const decoder = new TextDecoder();
              const chunkText = decoder.decode(event.chunk.bytes);
              
              // Pousser l'événement AWS brut au format SSE
              // Le request-handler appellera transformStreamChunk pour la transformation
              const sseData = `data: ${chunkText}\n\n`;
              readable.push(sseData);
              
            } catch (parseError) {
              console.error('Error processing AWS chunk:', parseError);
              console.error('Raw chunk:', new TextDecoder().decode(event.chunk.bytes));
            }
          }
        }
        
        // Marquer la fin du stream
        readable.push('data: [DONE]\n\n');
        readable.push(null);
      } catch (error) {
        console.error('Error processing Bedrock stream:', error);
        readable.destroy(error as Error);
      }
    })();

    return readable;
  }

  async makeRequest(
    request: StandardRequest, 
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
        // Requête streaming
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

        // Créer un stream compatible avec le format attendu
        const streamData = this.createBedrockStream(response.body);
        
        const duration = Date.now() - startTime;
        this.logMetrics('makeStreamRequest', duration, true);
        
        // Retourner un objet qui ressemble à une AxiosResponse
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
            method: 'POST' as const,
            url: `bedrock:${this.region}:${model}`,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'LLM-Gateway-Bedrock/1.0'
            }
          },
          request: {}
        } as unknown as AxiosResponse;

        
      } else {
        // Requête non-streaming
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

        // Décoder la réponse
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
   * Validation spécifique à Bedrock
   */
  protected performValidation(request: StandardRequest, model: Model) {
    const baseValidation = super.performValidation(request, model);
    const bedrockErrors: string[] = [];

    // Vérifier que max_tokens est défini (requis par Bedrock)
    if (!request.max_tokens) {
      bedrockErrors.push('max_tokens is required for Bedrock models');
    }

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

    return {
      valid: baseValidation.valid && bedrockErrors.length === 0,
      errors: [...baseValidation.errors, ...bedrockErrors]
    };
  }
}