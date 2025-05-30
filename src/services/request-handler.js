import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../config/database.js';
import { getProvider } from '../providers/index.js';
import { filterProviders, estimateRequestCost } from './models.js';
import { updateApiKeyUsage } from '../middleware/auth.js';
import { cacheUtils } from '../config/cache.js';
import axios from 'axios';

/**
 * Service principal pour gérer les requêtes LLM avec fallback
 */
export class RequestHandler {
  constructor() {
    this.ntfyUrl = process.env.NTFY_ERROR_URL;
  }

  /**
   * Point d'entrée principal pour traiter une requête de chat completion
   * @param {Object} request - Requête standardisée
   * @param {Object} authData - Données d'authentification
   * @returns {Promise<Object|AsyncGenerator>} Réponse ou stream
   */
  async handleChatCompletion(request, authData) {
    const requestId = uuidv4();
    const startTime = Date.now();
    
    try {
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
   * Exécute la requête avec fallback sur plusieurs providers
   * @param {Object} request 
   * @param {Array} providerCombinations 
   * @param {string} requestId 
   * @param {Object} authData 
   * @param {number} startTime 
   * @returns {Promise<Object|AsyncGenerator>}
   */
  async executeWithFallback(request, providerCombinations, requestId, authData, startTime) {
    let lastError = null;

    for (let i = 0; i < providerCombinations.length; i++) {
      const combination = providerCombinations[i];
      let provider;
      
      try {
        console.log(`Trying provider ${combination.provider} with model ${combination.modelId} (attempt ${i + 1}/${providerCombinations.length})`);
        
        provider = getProvider(combination.provider);
        
        // Valider la requête pour ce provider
        if (!provider.validateRequest(request, combination.model)) {
          console.warn(`Request validation failed for ${combination.provider}`);
          continue;
        }

        // Préparer la requête avec les infos du modèle
        const enrichedRequest = {
          ...request,
          model: combination
        };

        // Exécuter selon le mode (streaming ou non)
        if (request.stream) {
          return await this.handleStreamingRequest(
            enrichedRequest,
            provider,
            combination,
            requestId,
            authData,
            startTime
          );
        } else {
          return await this.handleNonStreamingRequest(
            enrichedRequest,
            provider,
            combination,
            requestId,
            authData,
            startTime
          );
        }

      } catch (error) {
        lastError = error;
        
        // Si c'est une APIError (erreur métier), on la retourne directement
        if (provider && provider.isAPIError(error)) {
          await this.logFailedRequest(requestId, authData.user.id, request, error, startTime, combination);
          throw error;
        }

        // Sinon, c'est une erreur technique, on notifie et on continue
        console.error(`Provider ${combination.provider} failed:`, error.message);
        
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
   * Gère une requête en mode streaming
   */
  async handleStreamingRequest(request, provider, combination, requestId, authData, startTime) {
    let timeToFirstChunk = null;
    let firstChunkTime = null;
    let lastChunkTime = null;
    let hasStarted = false;
    let responseChunks = [];

    const self = this;

    async function* streamGenerator() {
      try {
        let payloadForProviderStream = { ...request }; // Start with a copy of the enriched request

        if (combination.provider === 'openai' && payloadForProviderStream.stream) {
          payloadForProviderStream.stream_options = {
            ...(payloadForProviderStream.stream_options || {}), // Preserve other stream_options if any
            include_usage: true
          };
        }

        for await (const chunk of provider.streamRequest(payloadForProviderStream, combination)) {
          const now = Date.now();
          
          if (!hasStarted) {
            hasStarted = true;
            timeToFirstChunk = now - startTime;
            firstChunkTime = now;
            
            // Vérifier si le premier chunk contient une erreur
            if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason === 'error') {
              throw new Error('Provider returned error in first chunk');
            }
          }
          
          lastChunkTime = now;
          responseChunks.push(chunk);
          yield chunk;
        }

        // Log de la requête réussie (asynchrone)
        const dtFirstLastChunk = lastChunkTime && firstChunkTime ? lastChunkTime - firstChunkTime : null;
        
        setImmediate(() => {
          self.logSuccessfulRequest(
            requestId,
            authData,
            request,
            combination,
            startTime,
            timeToFirstChunk,
            dtFirstLastChunk,
            true, // streaming
            responseChunks // Pass the response chunks
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
  async handleNonStreamingRequest(request, provider, combination, requestId, authData, startTime) {
    const response = await provider.makeRequest(request, combination, false);
    const transformedResponse = provider.transformResponse(response);

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
        transformedResponse // Pass the response data
      );
    });

    return transformedResponse;
  }

  /**
   * Log une requête réussie dans la base de données (asynchrone)
   */
  async logSuccessfulRequest(requestId, authData, request, combination, startTime, timeToFirstChunk, dtFirstLastChunk, isStreaming, responseDataOrChunks = null) {
    try {
      let responseJson = null;
      let usage = null;

      if (!isStreaming && responseDataOrChunks) {
        // For non-streaming, use the response data directly
        responseJson = responseDataOrChunks;
        usage = responseDataOrChunks.usage || responseDataOrChunks.token_usage;
      } else if (isStreaming && responseDataOrChunks && responseDataOrChunks.length > 0) {
        // For streaming, reconstruct the complete response from chunks
        let reconstructedContent = '';
        let finalChunk = null;
        let responseId = null;
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
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null
          }
        };
      }

      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      // Extraire les tokens depuis les données d'usage collectées
      let inputTokens = null;
      let outputTokens = null;
      let cachedTokens = null;

      if (usage) {
        // Utiliser les données d'usage extraites (streaming ou non-streaming)
        inputTokens = usage.prompt_tokens || usage.input_tokens;
        outputTokens = usage.completion_tokens || usage.output_tokens;
        cachedTokens = usage.cached_tokens;
      } else if (!isStreaming && responseDataOrChunks) {
        // Fallback pour les réponses non-streaming sans usage dans l'objet principal
        if (responseDataOrChunks.token_usage) {
          inputTokens = responseDataOrChunks.token_usage.input_tokens;
          outputTokens = responseDataOrChunks.token_usage.output_tokens;
        }
        cachedTokens = responseDataOrChunks.cached_tokens;
      }

      // 1. Insérer dans la table requests
      const { data: requestData, error: requestError } = await supabase
        .from('requests')
        .insert({
          request_id: requestId,
          user_id: authData.user.id,
          api_key_name: authData.apiKey?.name,
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
        // If this primary insert fails, we might not want to proceed with content/metrics
        return; 
      }
      console.log(`Successfully inserted into requests for ${requestId}`);

      // 2. Insérer le contenu de la requête avec la réponse complète
      try {
        await supabase
          .from('requests_content')
          .insert({
            request_id: requestId,
            request_json: request, // request object from function params
            response_json: responseJson // reconstructed responseJson
          });
        console.log(`Successfully inserted into requests_content for ${requestId}`);
      } catch (contentError) {
        console.error(`Failed to insert into requests_content for ${requestId}:`, contentError);
        // Decide if we should return or if logging the error is enough
      }
      
      // 3. Insérer les métriques seulement si c'est en streaming
      if (isStreaming) {
        let calculated_throughput_tokens_s = null;
        let is_metrics_actually_calculated = false;

        // Conditions based on user request: total_duration_ms, time_to_first_chunk, and dt_first_last_chunk must not be NULL
        // totalDuration is derived from startTime and endTime, so it should always be present.
        // timeToFirstChunk and dtFirstLastChunk are specific to streaming.
        const can_attempt_calculation = totalDuration != null && timeToFirstChunk != null && dtFirstLastChunk != null;

        if (can_attempt_calculation) {
          // Throughput calculation still requires outputTokens and a positive totalDuration.
          if (outputTokens != null && totalDuration > 0) {
            calculated_throughput_tokens_s = parseFloat((outputTokens / (dtFirstLastChunk / 1000)).toFixed(2));
            is_metrics_actually_calculated = true; // Metric was calculated
          }
          // If outputTokens is null or totalDuration is not positive, throughput remains null, and is_metrics_actually_calculated remains false.
        }
        // If can_attempt_calculation is false, both remain null/false.

        await supabase
          .from('metrics')
          .insert({
            request_id: requestId,
            created_at: new Date().toISOString(),
            total_duration_ms: totalDuration, // Logged regardless of calculation
            time_to_first_chunk: timeToFirstChunk, // Logged regardless of calculation
            dt_first_last_chunk: dtFirstLastChunk, // Logged regardless of calculation
            is_metrics_calculated: is_metrics_actually_calculated,
            throughput_tokens_s: calculated_throughput_tokens_s
          });
      }

      // Mettre à jour l'usage de la clé API
      if (authData.apiKey?.name) {
        await updateApiKeyUsage(authData.user.id, authData.apiKey.name);
      }

      console.log(`Request ${requestId} logged successfully`);

    } catch (error) {
      console.error('Failed to log successful request:', error);
    }
  }

  /**
   * Log une requête échouée dans la base de données
   */
  async logFailedRequest(requestId, userId, request, error, startTime, combination = null) {
    try {
      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      await supabase
        .from('requests')
        .insert({
          request_id: requestId,
          user_id: userId,
          provider: combination?.provider || 'unknown',
          model: combination?.modelId || request.model || 'unknown',
          created_at: new Date(startTime).toISOString(),
          status: 'error',
          streaming: request.stream || false,
          error_message: error.message
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
          created_at: new Date().toISOString(),
          // total_duration_ms: totalDuration
        });

    } catch (logError) {
      console.error('Failed to log failed request:', logError);
    }
  }

  /**
   * Envoie une notification d'erreur à ntfy (asynchrone)
   */
  async notifyError(error, combination, request) {
    if (!this.ntfyUrl) {
      return;
    }

    try {
      const message = {
        title: `LLM Gateway Error - ${combination.provider}`,
        message: `Provider: ${combination.provider}\nModel: ${combination.modelId}\nError: ${error.message}\nStatus: ${error.status || 'unknown'}`,
        priority: 3,
        tags: ['error', 'llm-gateway', combination.provider]
      };

      await axios.post(this.ntfyUrl, message, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

    } catch (notifyError) {
      console.error('Failed to send error notification:', notifyError.message);
    }
  }

  /**
   * Estime le coût d'une requête avant exécution
   */
  estimateRequestCost(request, combination) {
    return estimateRequestCost(request, combination);
  }
}

// Instance singleton
export const requestHandler = new RequestHandler();
