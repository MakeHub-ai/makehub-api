import { BaseAdapter, AdapterError } from './base.js';
import axios, { type AxiosResponse, type AxiosError } from 'axios';
import type { 
  StandardRequest, 
  ChatCompletion, 
  ChatCompletionChunk,
  AdapterConfig,
  Model,
  ToolCall,
  Tool,
  ToolChoice,
  AdapterErrorCode,
  ChatMessage,
  ChatMessageContent
} from '../types/index.js';

/**
 * Interface pour les requêtes Anthropic
 */
interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream?: boolean;
  system?: string | Array<{
    type: 'text';
    text: string;
    cache_control?: {
      type: 'ephemeral';
    };
  }>;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}

interface AnthropicContent {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: AnthropicContent[];
  cache_control?: {
    type: 'ephemeral';
  };
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, any>;
  cache_control?: {
    type: 'ephemeral';
  };
}

/**
 * Interface pour les candidats au cache
 */
interface CacheTarget {
  type: 'system' | 'user' | 'assistant' | 'tools';
  messageIndex?: number;
  blockIndex?: number;
  text: string;
  size: number;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContent[];
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
 * Adapter pour l'API Anthropic Claude
 * Convertit les requêtes OpenAI vers le format natif Anthropic
 */
export class AnthropicAdapter extends BaseAdapter {
  private currentStreamTokens?: {
    input_tokens: number;
    cached_tokens?: number;
  };

  constructor(config: AdapterConfig = {}) {
    super(config);
    this.name = 'anthropic';
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || process.env.API_KEY_ANTHROPIC;
    this.baseURL = config.baseURL || 'https://api.anthropic.com/v1';
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  buildHeaders(request: StandardRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey!, // Anthropic utilise x-api-key, pas Authorization Bearer
      'Content-Type': 'application/json',
      'User-Agent': 'LLM-Gateway-Anthropic/1.0',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31' // Pour le cache control
    };

    return this.validateHeaders(headers);
  }

  getEndpoint(model: string): string {
    return `${this.baseURL}/messages`;
  }

  transformRequest(standardRequest: StandardRequest): AnthropicRequest {
    const messages = standardRequest.messages || [];
    const modelInfo = standardRequest.model;
    const modelId = typeof modelInfo === 'string' ? modelInfo : modelInfo?.provider_model_id;
    
    if (!modelId) {
      throw this.createError('Model ID is required', 400, 'VALIDATION_ERROR');
    }

    // Collecter tous les candidats au cache AVANT la transformation
    const cacheTargets: CacheTarget[] = [];

    // 🆕 ANALYSER LES TOOLS EN PREMIER (priorité Anthropic)
    let toolsContent = '';
    if (standardRequest.tools && standardRequest.tools.length > 0) {
      // Calculer la taille totale des tools
      toolsContent = JSON.stringify(standardRequest.tools);
      
      // Ajouter aux candidats cache
      cacheTargets.push({
        type: 'tools',
        text: toolsContent,
        size: toolsContent.length
      });
    }

    // Analyser le système et séparer les messages système des autres messages
    let systemMessage = '';
    let systemCacheControl: any = null;
    const conversationMessages = messages.filter((msg, msgIndex) => {
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
      } else {
        // Analyser les messages de conversation pour les candidats au cache
        if (typeof msg.content === 'string') {
          cacheTargets.push({
            type: msg.role as 'user' | 'assistant',
            messageIndex: msgIndex,
            blockIndex: 0,
            text: msg.content,
            size: msg.content.length
          });
        } else if (Array.isArray(msg.content)) {
          msg.content.forEach((item, blockIndex) => {
            if (item.type === 'text' && item.text) {
              cacheTargets.push({
                type: msg.role as 'user' | 'assistant',
                messageIndex: msgIndex,
                blockIndex,
                text: item.text,
                size: item.text.length
              });
            }
          });
        }
        return true;
      }
    });

    // Ajouter le système aux candidats
    if (systemMessage && !systemCacheControl) {
      cacheTargets.push({
        type: 'system',
        text: systemMessage,
        size: systemMessage.length
      });
    }

    // Déterminer quels blocs cacher (max 4) - INCLUANT tools
    const blocksToCache = this.applyCacheWithAnthropicLimits(cacheTargets, 4);

    const anthropicRequest: AnthropicRequest = {
      model: modelId,
      messages: this.convertMessagesToAnthropicFormatWithLimitedCache(conversationMessages, blocksToCache),
      max_tokens: standardRequest.max_tokens || 4096, // max_tokens est obligatoire pour Anthropic
      stream: standardRequest.stream || false
    };

    // Gérer le système avec cache limité
    if (systemMessage.trim()) {
      if (systemCacheControl) {
        anthropicRequest.system = [{
          type: 'text',
          text: systemMessage.trim(),
          cache_control: systemCacheControl
        }];
      } else if (blocksToCache.has('system')) {
        anthropicRequest.system = [{
          type: 'text',
          text: systemMessage.trim(),
          cache_control: { type: 'ephemeral' }
        }];
        console.log(`🎯 Auto-cache activé pour message système (${systemMessage.length} caractères)`);
      } else {
        anthropicRequest.system = systemMessage.trim();
      }
    }

    // Ajouter les paramètres optionnels
    if (standardRequest.temperature !== undefined) {
      anthropicRequest.temperature = standardRequest.temperature;
    }
    if (standardRequest.top_p !== undefined) {
      anthropicRequest.top_p = standardRequest.top_p;
    }

    // Convertir stop en stop_sequences
    if (standardRequest.stop) {
      anthropicRequest.stop_sequences = Array.isArray(standardRequest.stop)
        ? standardRequest.stop
        : [standardRequest.stop];
    }

    // 🆕 GÉRER LES TOOLS AVEC CACHE
    if (standardRequest.tools && standardRequest.tools.length > 0) {
      const anthropicTools = this.convertToolsToAnthropicFormatWithCache(standardRequest.tools, blocksToCache.has('tools'));
      anthropicRequest.tools = anthropicTools;
      
      if (blocksToCache.has('tools')) {
        console.log(`🎯 Auto-cache activé pour tools (${toolsContent.length} caractères)`);
      }
    }

    // Convertir tool_choice
    if (standardRequest.tool_choice && standardRequest.tool_choice !== 'auto') {
      if (standardRequest.tool_choice === 'none') {
        // Anthropic n'a pas de "none", on retire les tools
        delete anthropicRequest.tools;
      } else if (standardRequest.tool_choice === 'any' || standardRequest.tool_choice === 'required') {
        anthropicRequest.tool_choice = { type: 'any' };
      } else if (typeof standardRequest.tool_choice === 'object' && standardRequest.tool_choice.function) {
        anthropicRequest.tool_choice = {
          type: 'tool',
          name: standardRequest.tool_choice.function.name
        };
      }
    }

    return this.cleanParams(anthropicRequest) as AnthropicRequest;
  }

  private convertMessagesToAnthropicFormat(messages: ChatMessage[]): AnthropicMessage[] {
    const anthropicMessages: AnthropicMessage[] = [];
    
    for (const message of messages) {
      if (message.role === 'system') continue; // Déjà traité

      if (message.role === 'tool') {
        // Message tool → content tool_result dans le message user précédent ou nouveau message user
        const toolResultContent: AnthropicContent = {
          type: 'tool_result',
          tool_use_id: message.tool_call_id!,
          content: typeof message.content === 'string' 
            ? [{ type: 'text', text: message.content }]
            : [{ type: 'text', text: JSON.stringify(message.content) }]
        };

        // Ajouter à un nouveau message user ou au dernier message user
        const lastMessage = anthropicMessages[anthropicMessages.length - 1];
        if (lastMessage && lastMessage.role === 'user') {
          lastMessage.content.push(toolResultContent);
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [toolResultContent]
          });
        }
        continue;
      }

      // Convertir le contenu
      let content: AnthropicContent[] = [];

      if (typeof message.content === 'string') {
        const textBlock: AnthropicContent = { type: 'text', text: message.content };
        
        // Préserver cache_control du message ou ajouter cache automatique
        if ((message as any).cache_control) {
          textBlock.cache_control = (message as any).cache_control;
        } else if (this.shouldAutoCache(message.content)) {
          textBlock.cache_control = { type: 'ephemeral' };
          console.log(`🎯 Auto-cache activé pour message ${message.role} (${message.content.length} caractères)`);
        }
        
        content = [textBlock];
      } else if (Array.isArray(message.content)) {
        content = message.content.map((item: ChatMessageContent) => {
          if (item.type === 'text') {
            const textBlock: AnthropicContent = { type: 'text', text: item.text! };
            
            // Préserver cache_control de l'item ou ajouter cache automatique
            if ((item as any).cache_control) {
              textBlock.cache_control = (item as any).cache_control;
            } else if (this.shouldAutoCache(item.text!)) {
              textBlock.cache_control = { type: 'ephemeral' };
              console.log(`🎯 Auto-cache activé pour bloc texte ${message.role} (${item.text!.length} caractères)`);
            }
            
            return textBlock;
          } else if (item.type === 'image_url' && item.image_url?.url) {
            return this.convertImageToAnthropicFormat(item.image_url.url, (item as any).cache_control);
          }
          return null;
        }).filter(Boolean) as AnthropicContent[];
      }

      // Ajouter les tool calls pour les messages assistant
      if (message.role === 'assistant' && message.tool_calls) {
        message.tool_calls.forEach((toolCall: ToolCall) => {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments)
          });
        });
      }

      if (content.length > 0) {
        anthropicMessages.push({
          role: message.role as 'user' | 'assistant',
          content
        });
      }
    }

    return anthropicMessages;
  }

  private convertImageToAnthropicFormat(imageUrl: string, cacheControl?: any): AnthropicContent {
    let mediaType = 'image/jpeg';
    let base64Data = imageUrl;

    // Parser data URL si nécessaire
    if (imageUrl.startsWith('data:')) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mediaType = match[1];
        base64Data = match[2];
      }
    }

    const imageBlock: AnthropicContent = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64Data
      }
    };

    // Préserver cache_control
    if (cacheControl) {
      imageBlock.cache_control = cacheControl;
    }

    return imageBlock;
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
   * Applique le cache en respectant la limite de 4 blocs pour Anthropic
   * Priorise les plus gros blocs pour maximiser l'efficacité
   * Respecte l'ordre de priorité Anthropic: tools → system → messages
   */
  private applyCacheWithAnthropicLimits(cacheTargets: CacheTarget[], maxBlocks: number = 4): Set<string> {
    // Filtrer les candidats éligibles (seuil minimum de taille)
    const eligibleTargets = cacheTargets.filter(target => this.shouldAutoCache(target.text));
    
    // Trier selon l'ordre de priorité Anthropic: tools → system → messages
    const priorityOrder = { 'tools': 0, 'system': 1, 'user': 2, 'assistant': 3 };
    const sortedTargets = eligibleTargets
      .sort((a, b) => {
        // D'abord par priorité de type
        const priorityDiff = priorityOrder[a.type] - priorityOrder[b.type];
        if (priorityDiff !== 0) return priorityDiff;
        // Ensuite par taille décroissante à priorité égale
        return b.size - a.size;
      })
      .slice(0, maxBlocks); // Limiter au nombre maximum

    // Créer un Set des identifiants à cacher
    const cacheKeys = new Set<string>();
    sortedTargets.forEach(target => {
      if (target.type === 'system') {
        cacheKeys.add('system');
      } else if (target.type === 'tools') {
        cacheKeys.add('tools');
      } else {
        cacheKeys.add(`${target.type}-${target.messageIndex}-${target.blockIndex || 0}`);
      }
    });

    console.log(`🎯 Auto-cache Anthropic: ${sortedTargets.length}/${cacheTargets.length} blocs sélectionnés (limite: ${maxBlocks})`);
    sortedTargets.forEach(target => {
      console.log(`   - ${target.type} (${target.size} caractères)`);
    });

    return cacheKeys;
  }

  /**
   * Version modifiée qui respecte la liste des blocs à cacher
   */
  private convertMessagesToAnthropicFormatWithLimitedCache(
    messages: ChatMessage[], 
    blocksToCache: Set<string>
  ): AnthropicMessage[] {
    const anthropicMessages: AnthropicMessage[] = [];
    
    for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
      const message = messages[msgIndex];
      
      if (message.role === 'system') continue; // Déjà traité

      if (message.role === 'tool') {
        // Message tool → content tool_result dans le message user précédent ou nouveau message user
        const toolResultContent: AnthropicContent = {
          type: 'tool_result',
          tool_use_id: message.tool_call_id!,
          content: typeof message.content === 'string' 
            ? [{ type: 'text', text: message.content }]
            : [{ type: 'text', text: JSON.stringify(message.content) }]
        };

        // Ajouter à un nouveau message user ou au dernier message user
        const lastMessage = anthropicMessages[anthropicMessages.length - 1];
        if (lastMessage && lastMessage.role === 'user') {
          lastMessage.content.push(toolResultContent);
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [toolResultContent]
          });
        }
        continue;
      }

      // Convertir le contenu
      let content: AnthropicContent[] = [];

      if (typeof message.content === 'string') {
        const textBlock: AnthropicContent = { type: 'text', text: message.content };
        const cacheKey = `${message.role}-${msgIndex}-0`;
        
        // Préserver cache_control du message ou appliquer cache intelligent
        if ((message as any).cache_control) {
          textBlock.cache_control = (message as any).cache_control;
        } else if (blocksToCache.has(cacheKey)) {
          textBlock.cache_control = { type: 'ephemeral' };
          console.log(`🎯 Auto-cache activé pour ${message.role} (${message.content.length} caractères)`);
        }
        
        content = [textBlock];
      } else if (Array.isArray(message.content)) {
        content = message.content.map((item: ChatMessageContent, blockIndex: number) => {
          if (item.type === 'text') {
            const textBlock: AnthropicContent = { type: 'text', text: item.text! };
            const cacheKey = `${message.role}-${msgIndex}-${blockIndex}`;
            
            // Préserver cache_control de l'item ou appliquer cache intelligent
            if ((item as any).cache_control) {
              textBlock.cache_control = (item as any).cache_control;
            } else if (blocksToCache.has(cacheKey)) {
              textBlock.cache_control = { type: 'ephemeral' };
              console.log(`🎯 Auto-cache activé pour bloc ${message.role} (${item.text!.length} caractères)`);
            }
            
            return textBlock;
          } else if (item.type === 'image_url' && item.image_url?.url) {
            return this.convertImageToAnthropicFormat(item.image_url.url, (item as any).cache_control);
          }
          return null;
        }).filter(Boolean) as AnthropicContent[];
      }

      // Ajouter les tool calls pour les messages assistant
      if (message.role === 'assistant' && message.tool_calls) {
        message.tool_calls.forEach((toolCall: ToolCall) => {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments)
          });
        });
      }

      if (content.length > 0) {
        anthropicMessages.push({
          role: message.role as 'user' | 'assistant',
          content
        });
      }
    }

    return anthropicMessages;
  }

  private convertToolsToAnthropicFormat(tools: Tool[]): AnthropicTool[] {
    return tools.map((tool, index) => {
      if (tool.type !== 'function') {
        throw this.createError("Anthropic adapter only supports 'function' tools.", 400, 'VALIDATION_ERROR');
      }

      const anthropicTool: AnthropicTool = {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters
      };

      // Préserver cache_control existant
      if ((tool as any).cache_control) {
        anthropicTool.cache_control = (tool as any).cache_control;
      } else if (index === tools.length - 1) {
        // Cache automatique sur le dernier outil (cache tous les outils d'un coup)
        anthropicTool.cache_control = { type: 'ephemeral' };
        console.log(`🎯 Auto-cache activé pour tous les outils (${tools.length} outils)`);
      }

      return anthropicTool;
    });
  }

  /**
   * Version avec cache intelligent basé sur la sélection
   */
  private convertToolsToAnthropicFormatWithCache(tools: Tool[], shouldCache: boolean): AnthropicTool[] {
    return tools.map((tool, index) => {
      if (tool.type !== 'function') {
        throw this.createError("Anthropic adapter only supports 'function' tools.", 400, 'VALIDATION_ERROR');
      }

      const anthropicTool: AnthropicTool = {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters
      };

      // Préserver cache_control existant
      if ((tool as any).cache_control) {
        anthropicTool.cache_control = (tool as any).cache_control;
      } else if (shouldCache && index === tools.length - 1) {
        // Appliquer cache_control au dernier tool (selon format Anthropic)
        anthropicTool.cache_control = { type: 'ephemeral' };
      }

      return anthropicTool;
    });
  }

  transformResponse(response: AxiosResponse<AnthropicResponse>): ChatCompletion {
    const data = response.data;
    
    // Validation de base
    if (!data.id || !data.content || !Array.isArray(data.content)) {
      throw this.createError('Invalid Anthropic response format', 500, 'API_ERROR');
    }

    // Si il y a usage dans la réponse, on affiche la réponse brut dans les logs
    if (data.usage) {
      console.log('Anthropic response usage:', data.usage);
    }


    let textContent = '';
    const toolCalls: ToolCall[] = [];

    // Parser le contenu de la réponse
    data.content.forEach((item: AnthropicContent) => {
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

    // Calculer les prompt_tokens avec le coût de création du cache
    const inputTokens = data.usage.input_tokens || 0;
    const cacheCreationTokens = data.usage.cache_creation_input_tokens || 0;
    const promptTokens = inputTokens + Math.round(cacheCreationTokens * 1.25);

    const completion: ChatCompletion = {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        },
        finish_reason: this.mapFinishReason(data.stop_reason)
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: promptTokens + data.usage.output_tokens,
        cached_tokens: data.usage.cache_read_input_tokens || undefined
      }
    };

    return completion;
  }

  transformStreamChunk(chunk: string): ChatCompletionChunk | null {
    if (!chunk || chunk.trim() === '' || chunk.trim().toLowerCase() === '[done]') {
      return null;
    }

    try {
      // Parser les données SSE
      let jsonStr = chunk;
      if (chunk.startsWith('data: ')) {
        jsonStr = chunk.slice(6);
      }

      const event = JSON.parse(jsonStr);
      const timestamp = Math.floor(Date.now() / 1000);

      // Message start - stocker les input_tokens mais ne pas renvoyer d'usage
      if (event.type === 'message_start' && event.message) {
        // Stocker les tokens d'input pour les combiner plus tard avec output_tokens
        if (event.message.usage) {
          this.currentStreamTokens = {
            input_tokens: event.message.usage.input_tokens || 0,
            cached_tokens: event.message.usage.cache_read_input_tokens || undefined
          };
        }
        
        return {
          id: event.message.id,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: event.message.model,
          choices: [{
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null
          }]
          // Pas d'usage ici car output_tokens n'est pas fiable dans message_start
        };
      }

      // Content block start - début d'un bloc de contenu
      if (event.type === 'content_block_start' && event.content_block) {
        if (event.content_block.type === 'tool_use') {
          // Début d'un tool call
          return {
            id: event.message?.id || `anthropic-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: timestamp,
            model: event.message?.model || 'claude-3',
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

      // Content block delta - contenu incrémental
      if (event.type === 'content_block_delta' && event.delta) {
        if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
          // Texte normal
          return {
            id: event.message?.id || `anthropic-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: timestamp,
            model: event.message?.model || 'claude-3',
            choices: [{
              index: 0,
              delta: { content: event.delta.text },
              finish_reason: null
            }]
          };
        } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
          // Arguments des tool calls
          return {
            id: event.message?.id || `anthropic-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: timestamp,
            model: event.message?.model || 'claude-3',
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

      // Message delta - finish_reason et usage final complet
      if (event.type === 'message_delta' && event.delta) {
        // Construire l'usage complet en combinant les tokens stockés et les finaux
        let finalUsage: any = undefined;
        if (event.usage || this.currentStreamTokens) {
          console.log('🎯 Anthropic message delta usage:', event.usage);
          console.log('🎯 Anthropic tokens stockés:', this.currentStreamTokens);
          
          // Combiner les input_tokens du message_start avec les output_tokens du message_delta
          const inputTokens = this.currentStreamTokens?.input_tokens || 0;
          const outputTokens = event.usage?.output_tokens || 0;
          const cachedTokens = this.currentStreamTokens?.cached_tokens || 
                              event.usage?.cache_read_input_tokens || 0;
          
          finalUsage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cached_tokens: cachedTokens > 0 ? cachedTokens : undefined,
            input_tokens: inputTokens,
            output_tokens: outputTokens
          };
          
          console.log('🎯 Anthropic final usage calculated:', finalUsage);
        }

        return {
          id: event.message?.id || `anthropic-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: event.message?.model || 'claude-3',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: this.mapFinishReason(event.delta.stop_reason)
          }],
          usage: finalUsage
        };
      }

      // Message stop - fin du stream
      if (event.type === 'message_stop') {
        // Nettoyer les tokens stockés pour le prochain stream
        this.currentStreamTokens = undefined;
        console.log('🎯 Anthropic tokens nettoyés à la fin du stream');
        
        return {
          id: event.message?.id || `anthropic-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: event.message?.model || 'claude-3',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        };
      }

      return null;

    } catch (error) {
      console.warn('Failed to parse Anthropic stream chunk:', chunk, error);
      return null;
    }
  }

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
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data as any;
        
        // Mapper les codes d'erreur Anthropic
        let code: AdapterErrorCode = 'API_ERROR';
        let message = 'Anthropic API error';

        switch (status) {
          case 400:
            code = 'VALIDATION_ERROR';
            message = `Anthropic Bad Request: ${data?.error?.message || 'Invalid request'}`;
            break;
          case 401:
            code = 'AUTHENTICATION_ERROR';
            message = `Anthropic Authentication Error: ${data?.error?.message || 'Invalid API key'}`;
            break;
          case 403:
            code = 'AUTHENTICATION_ERROR';
            message = `Anthropic Permission Error: ${data?.error?.message || 'Access forbidden'}`;
            break;
          case 429:
            code = 'RATE_LIMIT_ERROR';
            message = `Anthropic Rate Limit: ${data?.error?.message || 'Too many requests'}`;
            break;
          case 500:
            code = 'API_ERROR';
            message = `Anthropic Server Error: ${data?.error?.message || 'Internal server error'}`;
            break;
          case 529:
            code = 'API_ERROR';
            message = `Anthropic Overloaded: ${data?.error?.message || 'Service temporarily overloaded'}`;
            break;
          default:
            message = `Anthropic API Error ${status}: ${data?.error?.message || 'Unknown error'}`;
        }

        return new AdapterError(message, status, code, this.name, error);
      } else if (axiosError.code === 'ECONNABORTED') {
        return new AdapterError(
          'Request timeout',
          408,
          'TIMEOUT_ERROR',
          this.name,
          error
        );
      } else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
        return new AdapterError(
          'Network connection failed',
          503,
          'NETWORK_ERROR',
          this.name,
          error
        );
      }
    }

    // Erreur générique
    return new AdapterError(
      error instanceof Error ? error.message : 'Unknown Anthropic error',
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
    if (!this.isConfigured()) {
      throw this.createError('Anthropic adapter not configured', 500, 'CONFIGURATION_ERROR');
    }

    const startTime = Date.now();
    const endpoint = this.getEndpoint(modelIdentifier);
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
      
      this.logMetrics(isStreaming ? 'makeStreamRequest' : 'makeRequest', duration, true);
      
      if (isStreaming) {
        return response; // Retourner le stream directement
      } else {
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
    const anthropicErrors: string[] = [];

    // Validation spécifique Anthropic
    if (!request.max_tokens) {
      // max_tokens est obligatoire pour Anthropic, on l'ajoute automatiquement
      console.warn('max_tokens is required for Anthropic, defaulting to 4096');
    }

    // Anthropic ne supporte pas frequency_penalty ni presence_penalty
    if (request.frequency_penalty !== undefined) {
      console.warn('frequency_penalty is not supported by Anthropic, ignoring');
    }
    if (request.presence_penalty !== undefined) {
      console.warn('presence_penalty is not supported by Anthropic, ignoring');
    }

    // Validation des tools
    if (request.tools && request.tools.length > 0) {
      if (!model.support_tool_calling) {
        anthropicErrors.push('Model does not support tool calling');
      } else {
        request.tools.forEach((tool, index) => {
          if (tool.type !== 'function') {
            anthropicErrors.push(`Tool ${index}: only 'function' type is supported in Anthropic`);
          }
          if (!tool.function.name) {
            anthropicErrors.push(`Tool ${index}: function name is required`);
          }
          if (!tool.function.parameters || typeof tool.function.parameters !== 'object') {
            anthropicErrors.push(`Tool ${index}: function parameters must be an object (input_schema)`);
          }
        });
      }
    }

    // Validation des messages - alternance user/assistant
    if (request.messages && request.messages.length > 0) {
      const conversationMessages = request.messages.filter(msg => msg.role !== 'system');
      
      for (let i = 0; i < conversationMessages.length; i++) {
        const message = conversationMessages[i];
        
        // Validation alternance (sauf pour tool messages)
        if (message.role !== 'tool' && i > 0) {
          const prevMessage = conversationMessages[i - 1];
          if (prevMessage.role !== 'tool' && prevMessage.role === message.role) {
            anthropicErrors.push(`Messages must alternate between user and assistant roles (index ${i})`);
          }
        }

        // Validation tool calls et tool results
        if (message.role === 'tool' && !message.tool_call_id) {
          anthropicErrors.push(`Tool message at index ${i} must have tool_call_id`);
        }
      }
    }

    return {
      valid: baseValidation.valid && anthropicErrors.length === 0,
      errors: [...baseValidation.errors, ...anthropicErrors]
    };
  }
}
