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

    const self = this;

    async function* streamGenerator() {
      try {
        for await (const chunk of provider.streamRequest(request, combination)) {
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
            true // streaming
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
  async logSuccessfulRequest(requestId, authData, request, combination, startTime, timeToFirstChunk, dtFirstLastChunk, isStreaming, responseData = null) {
    try {
      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      // Extraire les tokens si disponibles dans la réponse
      let inputTokens = null;
      let outputTokens = null;
      let cachedTokens = null;

      if (responseData) {
        if (responseData.usage) {
          inputTokens = responseData.usage.prompt_tokens || responseData.usage.input_tokens;
          outputTokens = responseData.usage.completion_tokens || responseData.usage.output_tokens;
        } else if (responseData.token_usage) {
          inputTokens = responseData.token_usage.input_tokens;
          outputTokens = responseData.token_usage.output_tokens;
        }
        cachedTokens = responseData.cached_tokens; // Assuming it's a top-level field
      }
      
      // Pour le streaming, les tokens sont généralement calculés après ou pas du tout dans cette phase.
      // is_metrics_calculated sera false, et un autre processus pourrait les mettre à jour.
      // Si responseData est null (cas du streaming initial), inputTokens/outputTokens resteront null.

      // Insérer dans la table requests
      const { data: requestData, error: requestError } = await supabase
        .from('requests')
        .insert({
          request_id: requestId,
          user_id: authData.user.id,
          api_key_name: authData.apiKey?.name,
          provider: combination.provider,
          model: combination.modelId,
          timestamp: new Date(startTime).toISOString(),
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cached_tokens: cachedTokens,
          status: 'completed',
          streaming: isStreaming
        })
        .select()
        .single();

      if (requestError) {
        console.error('Failed to log request:', requestError);
        return;
      }

      // Insérer le contenu de la requête
      await supabase
        .from('requests_content')
        .insert({
          request_id: requestId,
          request_json: request,
          response_json: null // Sera mis à jour par le service de calcul
        });

      // Insérer les métriques seulement si c'est en streaming
      if (isStreaming) {
        await supabase
          .from('metrics')
          .insert({
            request_id: requestId,
            timestamp: new Date().toISOString(),
            total_duration_ms: totalDuration,
            time_to_first_chunk: timeToFirstChunk,
            dt_first_last_chunk: dtFirstLastChunk,
            is_metrics_calculated: !!(inputTokens || outputTokens) // True if we got any token info
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
          timestamp: new Date(startTime).toISOString(),
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
          timestamp: new Date().toISOString(),
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
