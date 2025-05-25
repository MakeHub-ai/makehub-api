/**
 * Classe de base abstraite pour tous les providers LLM
 * Définit l'interface commune que tous les providers doivent implémenter
 */
export class BaseProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = this.constructor.name.toLowerCase().replace('provider', '');
  }

  /**
   * Transforme une requête standardisée vers le format du provider
   * @param {Object} standardRequest - Requête au format OpenAI standard
   * @returns {Object} Requête au format du provider
   */
  transformRequest(standardRequest) {
    throw new Error('transformRequest must be implemented by provider');
  }

  /**
   * Transforme une réponse du provider vers le format standard
   * @param {Object} response - Réponse du provider
   * @returns {Object} Réponse au format OpenAI standard
   */
  transformResponse(response) {
    throw new Error('transformResponse must be implemented by provider');
  }

  /**
   * Transforme un chunk de streaming du provider vers le format standard
   * @param {Object} chunk - Chunk du provider
   * @returns {Object} Chunk au format OpenAI standard
   */
  transformStreamChunk(chunk) {
    throw new Error('transformStreamChunk must be implemented by provider');
  }

  /**
   * Construit les headers HTTP pour les requêtes
   * @param {Object} request - Requête
   * @returns {Object} Headers HTTP
   */
  buildHeaders(request) {
    throw new Error('buildHeaders must be implemented by provider');
  }

  /**
   * Retourne l'endpoint pour un modèle donné
   * @param {string} model - ID du modèle
   * @returns {string} URL de l'endpoint
   */
  getEndpoint(model) {
    throw new Error('getEndpoint must be implemented by provider');
  }

  /**
   * Gère les erreurs spécifiques au provider
   * @param {Error} error - Erreur originale
   * @param {Object} response - Réponse HTTP (optionnel)
   * @returns {Error} Erreur standardisée
   */
  handleError(error, response) {
    throw new Error('handleError must be implemented by provider');
  }

  /**
   * Vérifie si une erreur est une APIError (erreur métier vs erreur technique)
   * @param {Error} error 
   * @returns {boolean}
   */
  isAPIError(error) {
    // Par défaut, considérer les erreurs 4xx comme des erreurs API
    return error.status && error.status >= 400 && error.status < 500;
  }

  /**
   * Extrait les métriques de performance d'une réponse
   * @param {Object} response - Réponse HTTP
   * @param {number} startTime - Timestamp de début
   * @returns {Object} Métriques
   */
  extractMetrics(response, startTime) {
    const endTime = Date.now();
    return {
      total_duration_ms: endTime - startTime,
      throughput_tokens_s: null,
      queue_time_ms: null,
      processing_time_ms: null
    };
  }

  /**
   * Valide qu'une requête est compatible avec ce provider
   * @param {Object} request - Requête standardisée
   * @param {Object} model - Configuration du modèle
   * @returns {boolean}
   */
  validateRequest(request, model) {
    // Validation de base
    if (!request.messages || !Array.isArray(request.messages)) {
      return false;
    }

    // Vérifier le support des tools si nécessaire
    if (request.tools && request.tools.length > 0 && !model.support_tool_calling) {
      return false;
    }

    return true;
  }

  /**
   * Prépare les paramètres de requête spécifiques au provider
   * @param {Object} standardRequest 
   * @param {Object} model 
   * @returns {Object}
   */
  prepareRequestParams(standardRequest, model) {
    return {
      model: model.provider_model_id,
      messages: standardRequest.messages,
      stream: standardRequest.stream || false,
      max_tokens: standardRequest.max_tokens,
      temperature: standardRequest.temperature,
      top_p: standardRequest.top_p,
      tools: standardRequest.tools,
      tool_choice: standardRequest.tool_choice,
      ...model.extra_param
    };
  }

  /**
   * Nettoie les paramètres en supprimant les valeurs undefined/null
   * @param {Object} params 
   * @returns {Object}
   */
  cleanParams(params) {
    const cleaned = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  /**
   * Crée une erreur standardisée
   * @param {string} message 
   * @param {number} status 
   * @param {string} code 
   * @param {Object} details 
   * @returns {Error}
   */
  createError(message, status = 500, code = 'PROVIDER_ERROR', details = {}) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.provider = this.name;
    error.details = details;
    return error;
  }

  /**
   * Log une erreur avec contexte
   * @param {Error} error 
   * @param {Object} context 
   */
  logError(error, context = {}) {
    console.error(`[${this.name.toUpperCase()}] Error:`, {
      message: error.message,
      status: error.status,
      code: error.code,
      provider: this.name,
      context
    });
  }

  /**
   * Vérifie si le provider est configuré correctement
   * @returns {boolean}
   */
  isConfigured() {
    return true; // À surcharger dans les providers spécifiques
  }

  /**
   * Retourne les informations de santé du provider
   * @returns {Object}
   */
  getHealthInfo() {
    return {
      provider: this.name,
      configured: this.isConfigured(),
      status: 'unknown'
    };
  }
}

/**
 * Erreur spécifique aux providers
 */
export class ProviderError extends Error {
  constructor(message, status = 500, code = 'PROVIDER_ERROR', provider = 'unknown') {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.provider = provider;
  }
}

/**
 * Erreur de timeout
 */
export class TimeoutError extends ProviderError {
  constructor(message, provider) {
    super(message, 408, 'TIMEOUT_ERROR', provider);
    this.name = 'TimeoutError';
  }
}

/**
 * Erreur de rate limiting
 */
export class RateLimitError extends ProviderError {
  constructor(message, provider, retryAfter = null) {
    super(message, 429, 'RATE_LIMIT_ERROR', provider);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Erreur d'authentification
 */
export class AuthenticationError extends ProviderError {
  constructor(message, provider) {
    super(message, 401, 'AUTHENTICATION_ERROR', provider);
    this.name = 'AuthenticationError';
  }
}
