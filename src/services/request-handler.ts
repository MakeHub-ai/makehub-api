import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../config/database.js';
import { createAdapter } from '../adapters/index.js';
import { filterProviders, estimateRequestCost } from './models.js';
import { updateApiKeyUsage } from '../middleware/auth.js';
import { cacheUtils } from '../config/cache.js';
import axios from 'axios';
import type { 
  StandardRequest, 
  ChatCompletion, 
  ChatCompletionChunk,
  AuthData,
  ProviderCombination,
  Usage
} from '../types/index.js';
import { BaseAdapter, AdapterError } from '../adapters/base.js';

/**
 * Interface pour les métriques de streaming
 */
interface StreamingMetrics {
  timeToFirstChunk: number | null;
  firstChunkTime: number | null;
  lastChunkTime: number | null;
  hasStarted: boolean;
  responseChunks: ChatCompletionChunk[];
}

/**
 * Interface pour les statistiques de traitement
 */
interface ProcessingStats {
  processed: number;
  errors: number;
}

/**
 * Service principal pour gérer les requêtes LLM avec fallback
 */
export class RequestHandler {
  private ntfyUrl: string | undefined;

  constructor() {
    this.ntfyUrl = process.env.NTFY_ERROR_URL;
  }

  /**
   * Point d'entrée principal pour traiter une requête de chat completion
   * @param request - Requête standardisée
   * @param authData - Données d'authentification
   * @returns Réponse ou stream
   */
  async handleChatCompletion(
    request: StandardRequest, 
    authData: AuthData
  ): Promise<ChatCompletion | AsyncGenerator<ChatCompletionChunk>> {
    const requestId = uuidv4();
    const startTime = Date.now();
    
    try {
      // Validation de base de la requête
      this.validateRequest(request);
      
      // 1. Obtenir les combinaisons model/provider disponibles
      const providerCombinations = await filterProviders(request, authData.userPreferences);
      
      if (providerCombinations.length === 0) {
        throw new Error('No compatible providers found for this request');
      }

      // 2. Exécuter avec fallback
      const result = await this.executeWithFallback(
        request,
        providerCombinations,
        requestId,
        authData,
        startTime
      );

      return result;

    } catch (error) {
      // Log l'erreur finale si aucun provider n'a fonctionné
      await this.logFailedRequest(requestId, authData.user.id, request, error, startTime);
      throw error;
    }
  }

  /**
   * Valide une requête de base
   * @param request - Requête à valider
   */
  private validateRequest(request: StandardRequest): void {
    if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
      throw new Error('Messages array is required and must not be empty');
    }

    for (const [index, message] of request.messages.entries()) {
      if (!message.role || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
        throw new Error(`Invalid role at message ${index}: ${message.role}`);
      }

      if (!message.content && !message.tool_calls) {
        throw new Error(`Message ${index} must have either content or tool_calls`);
      }
    }

    if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 2)) {
      throw new Error('Temperature must be between 0 and 2');
    }

    if (request.top_p !== undefined && (request.top_p < 0 || request.top_p > 1)) {
      throw new Error('Top_p must be between 0 and 1');
    }

    if (request.max_tokens !== undefined && request.max_tokens <= 0) {
      throw new Error('Max_tokens must be positive');
    }
  }

  /**
   * Exécute la requête avec fallback sur plusieurs providers
   * @param request - Requête standardisée
   * @param providerCombinations - Liste des combinaisons provider/model
   * @param requestId - ID unique de la requête
   * @param authData - Données d'authentification
   * @param startTime - Timestamp de début
   * @returns Réponse ou générateur de stream
   */
  async executeWithFallback(
    request: StandardRequest, 
    providerCombinations: ProviderCombination[], 
    requestId: string, 
    authData: AuthData, 
    startTime: number
  ): Promise<ChatCompletion | AsyncGenerator<ChatCompletionChunk>> {
    let lastError: unknown = null;

    // Pour le streaming, on doit implémenter le fallback différemment
    if (request.stream) {
      return this.executeStreamingWithFallback(
        request,
        providerCombinations,
        requestId,
        authData,
        startTime
      );
    }

    // Pour les requêtes non-streaming, on garde la logique existante
    for (let i = 0; i < providerCombinations.length; i++) {
      const combination = providerCombinations[i];
      let adapter: BaseAdapter | undefined;
      
      try {
        console.log(`Trying provider ${combination.provider} with model ${combination.modelId} (attempt ${i + 1}/${providerCombinations.length})`);
        
        // Créer l'adapter avec la configuration appropriée
        const adapterConfig = {
          apiKey: process.env[combination.ApiKeyName],
          baseURL: combination.baseUrl
        };

        adapter = createAdapter(combination.adapter, adapterConfig);

        // Configurer l'adapter avec les informations du modèle
        if (typeof adapter.configure === 'function') {
          adapter.configure(adapterConfig, combination.model);
        }
        
        // Vérifier que l'adapter est configuré
        if (!adapter.isConfigured()) {
          console.warn(`Adapter ${combination.adapter} is not properly configured`);
          continue;
        }
        
        // Valider la requête pour ce provider
        if (!adapter.validateRequest(request, combination.model)) {
          console.warn(`Request validation failed for ${combination.provider}`);
          console.warn('Request object:', JSON.stringify(request, null, 2));
          console.warn('Model object:', JSON.stringify(combination.model, null, 2));
          console.warn('Provider model ID:', combination.providerModelId);
          continue;
        }

        return await this.handleNonStreamingRequest(
          request,
          adapter,
          combination,
          requestId,
          authData,
          startTime
        );

      } catch (error) {
        lastError = error;
        
        // Si c'est une APIError (erreur métier), on la retourne directement
        if (adapter && adapter.isAPIError(error)) {
          await this.logFailedRequest(requestId, authData.user.id, request, error, startTime, combination);
          throw error;
        }
        // Sinon, c'est une erreur technique, on notifie et on continue
        console.error(`Provider ${combination.provider} failed:`, error instanceof Error ? error.message : 'Unknown error');
        
        // Envoyer notification d'erreur (asynchrone)
        this.notifyError(error, combination, request).catch(console.error);
        
        // Continuer avec le provider suivant
        continue;
      }
    }

    // Si on arrive ici, aucun provider n'a fonctionné
    throw lastError || new Error('All providers failed');
  }

  /**
   * Exécute une requête streaming avec fallback
   */
  async executeStreamingWithFallback(
    request: StandardRequest, 
    providerCombinations: ProviderCombination[], 
    requestId: string, 
    authData: AuthData, 
    startTime: number
  ): Promise<AsyncGenerator<ChatCompletionChunk>> {
    const self = this;
    let lastError: unknown = null;

    async function* streamGeneratorWithFallback(): AsyncGenerator<ChatCompletionChunk> {
      for (let i = 0; i < providerCombinations.length; i++) {
        const combination = providerCombinations[i];
        let adapter: BaseAdapter | undefined;
        
        try {
          console.log(`Trying provider ${combination.provider} with model ${combination.modelId} (streaming attempt ${i + 1}/${providerCombinations.length})`);
          
          // Créer l'adapter avec la configuration appropriée
          const adapterConfig = {
            apiKey: process.env[combination.ApiKeyName],
            baseURL: combination.baseUrl
          };

          adapter = createAdapter(combination.adapter, adapterConfig);

          // Configurer l'adapter avec les informations du modèle
          if (typeof adapter.configure === 'function') {
            adapter.configure(adapterConfig, combination.model);
          }
          
          // Vérifier que l'adapter est configuré
          if (!adapter.isConfigured()) {
            console.warn(`Adapter ${combination.adapter} is not properly configured`);
            continue;
          }
          
          // Valider la requête pour ce provider
          if (!adapter.validateRequest(request, combination.model)) {
            console.warn(`Request validation failed for ${combination.provider}`);
            continue;
          }

          // Tenter la requête streaming
          const generator = await self.handleStreamingRequest(
            request,
            adapter,
            combination,
            requestId,
            authData,
            startTime
          );

          // Si on arrive ici, la requête a réussi, yield tous les chunks
          yield* generator;
          return; // Succès, on sort de la boucle

        } catch (error) {
          lastError = error;
          
          // Si c'est une APIError (erreur métier), on la retourne directement
          if (adapter && adapter.isAPIError(error)) {
            await self.logFailedRequest(requestId, authData.user.id, request, error, startTime, combination);
            throw error;
          }
          
          // Sinon, c'est une erreur technique, on notifie et on continue
          console.error(`Streaming provider ${combination.provider} failed:`, error instanceof Error ? error.message : 'Unknown error');
          
          // Envoyer notification d'erreur (asynchrone)
          self.notifyError(error, combination, request).catch(console.error);
          
          // Si c'est le dernier provider, on lance l'erreur
          if (i === providerCombinations.length - 1) {
            throw lastError || new Error('All streaming providers failed');
          }
          
          // Sinon, on continue avec le provider suivant
          continue;
        }
      }
      
      // Si on arrive ici, aucun provider n'a fonctionné
      throw lastError || new Error('All streaming providers failed');
    }

    return streamGeneratorWithFallback();
  }

  /**
   * Gère une requête en mode streaming
   */
  async handleStreamingRequest(
    request: StandardRequest, 
    adapter: BaseAdapter, 
    combination: ProviderCombination, 
    requestId: string, 
    authData: AuthData, 
    startTime: number
  ): Promise<AsyncGenerator<ChatCompletionChunk>> {
    const metrics: StreamingMetrics = {
      timeToFirstChunk: null,
      firstChunkTime: null,
      lastChunkTime: null,
      hasStarted: false,
      responseChunks: []
    };

    const self = this;

    async function* streamGenerator(): AsyncGenerator<ChatCompletionChunk> {
      try {
        // Enrichir la requête avec les informations du modèle
        const enrichedRequest: StandardRequest = {
          ...request,
          model: combination.model // Passer l'objet model complet
        };

        // Utiliser l'adapter pour faire la requête streaming
        const response = await adapter.makeRequest(enrichedRequest, combination.providerModelId, true);
        
        if (!('data' in response)) {
          throw new Error('Invalid response format for streaming');
        }
        
        // Créer un stream personnalisé pour gérer les chunks
        const chunkQueue: ChatCompletionChunk[] = [];
        let buffer = '';
        let isStreamComplete = false;
        let streamError: Error | null = null;
        let resolveNextChunk: ((chunk: ChatCompletionChunk | null) => void) | null = null;

        // Fonction pour attendre le prochain chunk
        const waitForNextChunk = (): Promise<ChatCompletionChunk | null> => {
          return new Promise((resolve) => {
            if (chunkQueue.length > 0) {
              resolve(chunkQueue.shift()!);
            } else if (isStreamComplete) {
              resolve(null); // Fin du stream
            } else {
              resolveNextChunk = resolve;
            }
          });
        };

        // Fonction pour ajouter un chunk à la queue
        const addChunk = (chunk: ChatCompletionChunk): void => {
          chunkQueue.push(chunk);
          if (resolveNextChunk) {
            const resolve = resolveNextChunk;
            resolveNextChunk = null;
            resolve(chunkQueue.shift()!);
          }
        };

        // Traiter les données du stream
        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Garder la ligne incomplète dans le buffer
          
          for (const line of lines) {
            if (line.trim() === '') continue;
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                return;
              }
              
              const transformedChunk = adapter.transformStreamChunk(data);
              if (!transformedChunk) continue;
              
              const now = Date.now();
              
              if (!metrics.hasStarted) {
                metrics.hasStarted = true;
                metrics.timeToFirstChunk = now - startTime;
                metrics.firstChunkTime = now;
                
                // Vérifier si le premier chunk contient une erreur
                if (transformedChunk.choices && transformedChunk.choices[0] && 
                    transformedChunk.choices[0].finish_reason === 'content_filter') {
                  streamError = new Error('Content filtered by provider');
                  return;
                }
              }
              
              metrics.lastChunkTime = now;
              metrics.responseChunks.push(transformedChunk);
              addChunk(transformedChunk);
            }
          }
        });

        response.data.on('end', () => {
          isStreamComplete = true;
          if (resolveNextChunk) {
            const resolve = resolveNextChunk;
            resolveNextChunk = null;
            resolve(null);
          }
        });

        response.data.on('error', (error: Error) => {
          streamError = error;
          isStreamComplete = true;
          if (resolveNextChunk) {
            const resolve = resolveNextChunk;
            resolveNextChunk = null;
            resolve(null);
          }
        });

        // Générer les chunks un par un
        let chunk: ChatCompletionChunk | null;
        while ((chunk = await waitForNextChunk()) !== null) {
          if (streamError) {
            throw streamError;
          }
          yield chunk;
        }

        // Vérifier s'il y a eu une erreur après la fin du stream
        if (streamError) {
          throw streamError;
        }

        // Log de la requête réussie (asynchrone)
        const dtFirstLastChunk = metrics.lastChunkTime && metrics.firstChunkTime ? 
          metrics.lastChunkTime - metrics.firstChunkTime : null;
        
        setImmediate(() => {
          self.logSuccessfulRequest(
            requestId,
            authData,
            request,
            combination,
            startTime,
            metrics.timeToFirstChunk,
            dtFirstLastChunk,
            true, // streaming
            metrics.responseChunks
          );
        });

      } catch (error) {
        // Re-lancer l'erreur pour que le fallback puisse la gérer
        throw error;
      }
    }

    return streamGenerator();
  }
  
  /**
   * Gère une requête en mode non-streaming
   */
  async handleNonStreamingRequest(
    request: StandardRequest, 
    adapter: BaseAdapter, 
    combination: ProviderCombination, 
    requestId: string, 
    authData: AuthData, 
    startTime: number
  ): Promise<ChatCompletion> {
    // Enrichir la requête avec les informations du modèle
    const enrichedRequest: StandardRequest = {
      ...request,
      model: combination.model // Passer l'objet model complet
    };

    console.log(`Executing non-streaming request for provider ${combination.provider} with model_id ${combination.providerModelId}`);

    const response = await adapter.makeRequest(enrichedRequest, combination.providerModelId, false);

    // Vérifier que c'est une ChatCompletion et non un AxiosResponse
    let chatCompletion: ChatCompletion;
    if ('data' in response) {
      throw new Error('Unexpected streaming response for non-streaming request');
    } else {
      chatCompletion = response;
    }

    // Log de la requête réussie (asynchrone)
    setImmediate(() => {
      this.logSuccessfulRequest(
        requestId,
        authData,
        request,
        combination,
        startTime,
        null, // timeToFirstChunk
        null, // dtFirstLastChunk
        false, // streaming
        chatCompletion
      );
    });

    return chatCompletion;
  }

  /**
   * Log une requête réussie dans la base de données (asynchrone)
   */
  async logSuccessfulRequest(
    requestId: string, 
    authData: AuthData, 
    request: StandardRequest, 
    combination: ProviderCombination, 
    startTime: number, 
    timeToFirstChunk: number | null, 
    dtFirstLastChunk: number | null, 
    isStreaming: boolean, 
    responseDataOrChunks: ChatCompletion | ChatCompletionChunk[]
  ): Promise<void> {
    try {
      let responseJson: ChatCompletion | null = null;
      let usage: Usage | null = null;

      if (!isStreaming && !Array.isArray(responseDataOrChunks)) {
        // For non-streaming, use the response data directly
        responseJson = responseDataOrChunks;
        usage = responseDataOrChunks.usage || null;
      } else if (isStreaming && Array.isArray(responseDataOrChunks) && responseDataOrChunks.length > 0) {
        // For streaming, reconstruct the complete response from chunks
        let reconstructedContent = '';
        let finalChunk: ChatCompletionChunk | null = null;
        let responseId: string | null = null;
        let model = combination.modelId;
        
        // Process all chunks to reconstruct the response
        for (const chunk of responseDataOrChunks) {
          if (chunk.id) {
            responseId = chunk.id;
          }
          if (chunk.model) {
            model = chunk.model;
          }
          
          // Extract content from chunk
          if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
            const delta = chunk.choices[0].delta;
            if (delta.content) {
              reconstructedContent += delta.content;
            }
          }
          
          // Check if this is the final chunk (contains usage or finish_reason)
          if (chunk.choices && chunk.choices[0] && 
              (chunk.choices[0].finish_reason || chunk.usage)) {
            finalChunk = chunk;
          }
          
          // Extract usage from chunk if present
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }
        
        // Reconstruct a complete chat completion response
        responseJson = {
          id: responseId || `chatcmpl-${requestId}`,
          object: 'chat.completion',
          created: Math.floor(startTime / 1000),
          model: model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: reconstructedContent
            },
            finish_reason: finalChunk?.choices?.[0]?.finish_reason || 'stop'
          }],
          usage: usage || {
            prompt_tokens: undefined,
            completion_tokens: undefined,
            total_tokens: undefined
          }
        };
      }

      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      // Extraire les tokens depuis les données d'usage collectées
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let cachedTokens: number | null = null;

      if (usage) {
        inputTokens = usage.prompt_tokens || usage.input_tokens || null;
        outputTokens = usage.completion_tokens || usage.output_tokens || null;
        cachedTokens = usage.cached_tokens || null;
      }

      // 1. Insérer dans la table requests
      const { data: requestData, error: requestError } = await supabase
        .from('requests')
        .insert({
          request_id: requestId,
          user_id: authData.user.id,
          api_key_name: authData.apiKey?.name || null,
          provider: combination.provider,
          model: combination.modelId,
          created_at: new Date(startTime).toISOString(),
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cached_tokens: cachedTokens,
          status: 'ready_to_compute',
          streaming: isStreaming
        })
        .select()
        .single();

      if (requestError) {
        console.error(`Failed to insert into requests table for ${requestId}:`, requestError);
        return; 
      }

      // 2. Insérer le contenu de la requête avec la réponse complète
      try {
        await supabase
          .from('requests_content')
          .insert({
            request_id: requestId,
            request_json: request,
            response_json: responseJson
          });
      } catch (contentError) {
        console.error(`Failed to insert into requests_content for ${requestId}:`, contentError);
      }
      
      // 3. Insérer les métriques seulement si c'est en streaming
      if (isStreaming) {
        let calculated_throughput_tokens_s: number | null = null;
        let is_metrics_actually_calculated = false;

        const can_attempt_calculation = totalDuration != null && timeToFirstChunk != null && dtFirstLastChunk != null;

        if (can_attempt_calculation) {
          if (outputTokens != null && dtFirstLastChunk > 0) {
            calculated_throughput_tokens_s = parseFloat((outputTokens / (dtFirstLastChunk / 1000)).toFixed(2));
            is_metrics_actually_calculated = true;
          }
        }

        await supabase
          .from('metrics')
          .insert({
            request_id: requestId,
            created_at: new Date().toISOString(),
            total_duration_ms: totalDuration,
            time_to_first_chunk: timeToFirstChunk,
            dt_first_last_chunk: dtFirstLastChunk,
            is_metrics_calculated: is_metrics_actually_calculated,
            throughput_tokens_s: calculated_throughput_tokens_s
          });
      }

      // Mettre à jour l'usage de la clé API
      if (authData.apiKey?.name) {
        await updateApiKeyUsage(authData.user.id, authData.apiKey.name);
      }


    } catch (error) {
      console.error('Failed to log successful request:', error);
    }
  }

  /**
   * Log une requête échouée dans la base de données
   */
  async logFailedRequest(
    requestId: string, 
    userId: string, 
    request: StandardRequest, 
    error: unknown, 
    startTime: number, 
    combination?: ProviderCombination
  ): Promise<void> {
    try {
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await supabase
        .from('requests')
        .insert({
          request_id: requestId,
          user_id: userId,
          provider: combination?.provider || 'unknown',
          model: combination?.modelId || (typeof request.model === 'string' ? request.model : 'unknown'),
          created_at: new Date(startTime).toISOString(),
          status: 'error',
          streaming: request.stream || false,
          error_message: errorMessage
        });

      await supabase
        .from('requests_content')
        .insert({
          request_id: requestId,
          request_json: request
        });

      await supabase
        .from('metrics')
        .insert({
          request_id: requestId,
          created_at: new Date().toISOString()
        });

    } catch (logError) {
      console.error('Failed to log failed request:', logError);
    }
  }

  /**
   * Envoie une notification d'erreur à ntfy (asynchrone)
   */
  async notifyError(error: unknown, combination: ProviderCombination, request: StandardRequest): Promise<void> {
    if (!this.ntfyUrl) {
      return;
    }

    try {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const status = error instanceof AdapterError ? error.status : 'unknown';

      const body = `Provider: ${combination.provider}\nModel: ${combination.modelId}\nError: ${errorMessage}\nStatus: ${status}`;

      await axios.post(this.ntfyUrl, body, {
        timeout: 5000,
        headers: {
          'Title': `LLM Gateway Error - ${combination.provider}`,
          'Priority': 'high',
          'Tags': `error,llm-gateway,${combination.provider}`
        }
      });

    } catch (notifyError) {
      console.error('Failed to send error notification:', notifyError instanceof Error ? notifyError.message : 'Unknown error');
    }
  }

  /**
   * Estime le coût d'une requête avant exécution
   */
  estimateRequestCost(request: StandardRequest, combination: ProviderCombination): number {
    return estimateRequestCost(request, combination);
  }
}

// Instance singleton
export const requestHandler = new RequestHandler();
