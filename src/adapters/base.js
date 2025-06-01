/**
 * Classe de base abstraite pour tous les adapters LLM
 */
export class BaseAdapter {
  constructor(config = {}) {
    this.config = config;
    this.name = this.constructor.name.toLowerCase().replace('adapter', '');
  }

  transformRequest(standardRequest) {
    throw new Error('transformRequest must be implemented by adapter');
  }

  transformResponse(response) {
    throw new Error('transformResponse must be implemented by adapter');
  }

  transformStreamChunk(chunk) {
    throw new Error('transformStreamChunk must be implemented by adapter');
  }

  buildHeaders(request) {
    throw new Error('buildHeaders must be implemented by adapter');
  }

  getEndpoint(model) {
    throw new Error('getEndpoint must be implemented by adapter');
  }

  handleError(error, response) {
    throw new Error('handleError must be implemented by adapter');
  }

  isAPIError(error) {
    return error.status && error.status >= 400 && error.status < 500;
  }

  validateRequest(request, model) {
    if (!request.messages || !Array.isArray(request.messages)) {
      return false;
    }
    if (request.tools && request.tools.length > 0 && !model.support_tool_calling) {
      return false;
    }
    return true;
  }

  configure(config) {
    if (config.apiKey) {
      this.apiKey = config.apiKey;
    }
    if (config.baseURL) {
      this.baseURL = config.baseURL;
    }
  }

  isConfigured() {
    return true;
  }

  prepareRequestParams(standardRequest, modelId) {
    const modelInfo = standardRequest.model;
    const actualModelId = modelId || (typeof modelInfo === 'string' ? modelInfo : modelInfo?.provider_model_id);
    
    return {
      model: actualModelId,
      messages: standardRequest.messages,
      stream: standardRequest.stream || false,
      max_tokens: standardRequest.max_tokens,
      temperature: standardRequest.temperature,
      top_p: standardRequest.top_p,
      tools: standardRequest.tools,
      tool_choice: standardRequest.tool_choice,
      ...(modelInfo?.extra_param || {})
    };
  }

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
   * Effectue une requête HTTP via l'adapter
   * @param {Object} request - Requête standardisée
   * @param {Object} model - Configuration du modèle
   * @param {boolean} isStreaming - Si la requête est en streaming
   * @returns {Promise<Object>} Réponse standardisée
   */
  async makeRequest(request, model, isStreaming = false) {
    throw new Error('makeRequest must be implemented by adapter');
  }
}

export class AdapterError extends Error {
  constructor(message, status = 500, code = 'ADAPTER_ERROR', adapter = 'unknown') {
    super(message);
    this.name = 'AdapterError';
    this.status = status;
    this.code = code;
    this.adapter = adapter;
  }
}
