import type { AxiosResponse } from 'axios';
import type { 
  StandardRequest, 
  ChatCompletion, 
  ChatCompletionChunk,
  Model
} from '../types/index.js';
import { 
  AdapterError, 
  type AdapterConfig, 
  type AdapterInterface,
  type ValidationResult,
  type AdapterErrorCode
} from '../types/index.js';

/**
 * Classe de base abstraite pour tous les adapters LLM
 */
export abstract class BaseAdapter implements AdapterInterface {
  protected config: AdapterConfig;
  protected name: string;
  protected apiKey?: string;
  protected baseURL?: string;

  constructor(config: AdapterConfig = {}) {
    this.config = config;
    this.name = this.constructor.name.toLowerCase().replace('adapter', '');
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL;
  }

  /**
   * Méthodes abstraites que chaque adapter doit implémenter
   */
  abstract transformRequest(standardRequest: StandardRequest): unknown;
  abstract transformResponse(response: unknown): ChatCompletion;
  abstract transformStreamChunk(chunk: string): ChatCompletionChunk | null;
  abstract buildHeaders(request: StandardRequest): Record<string, string>;
  abstract getEndpoint(model: string): string;
  abstract handleError(error: unknown): AdapterError;

  /**
   * Effectue une requête HTTP via l'adapter
   */
  abstract makeRequest(
    request: StandardRequest, 
    model: string, 
    isStreaming?: boolean
  ): Promise<AxiosResponse | ChatCompletion>;

  /**
   * Vérifie si l'adapter est correctement configuré
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Détermine si une erreur est une erreur API (4xx) qui ne devrait pas déclencher de fallback
   * Les erreurs de configuration permettent le fallback
   * Si on return false, cela signifie que le fallback est autorisé
   * Si on return true, cela signifie que le fallback n'est pas autorisé
   * On veut que toutes les erreurs fassent un fallback sauf les 400 Bad Request
   */
  isAPIError(error: unknown): boolean {
    let status: number | undefined;
    let errorDetails: { message?: string; code?: string; adapter?: string; provider?: string } = {};

    // ECONNRESET = erreur réseau → autoriser le fallback
    if (error instanceof Error && error.message.includes('ECONNRESET')) {
      return false; // Fallback autorisé
    }

    // Extraction du status et des détails selon le type d'erreur
    if (error instanceof AdapterError) {
      status = error.status;
      errorDetails = {
        message: error.message,
        code: error.code,
        adapter: error.adapter,
      };
      
      // Les erreurs de configuration permettent toujours le fallback
      if (error.code === 'CONFIGURATION_ERROR') {
        return false;
      }
    } else if (error && typeof error === 'object' && 'status' in error) {
      status = (error as any).status;
      if ('message' in error) {
        errorDetails.message = (error as any).message;
      }
    }

    // Si on a un status code
    if (typeof status === 'number') {
      // Seul le 400 Bad Request empêche le fallback
      if (status === 400) {
        console.error('Bad Request (400) - Erreur remontée à l\'utilisateur:', {
          status,
          ...errorDetails
        });
        return true; // Pas de fallback, erreur remontée à l'utilisateur
      }
      
      // Toutes les autres erreurs (401, 403, 404, 429, 5xx, etc.) permettent le fallback
      if (status >= 400) {
        console.warn(`Erreur ${status} - Fallback autorisé:`, {
          status,
          ...errorDetails
        });
        return false; // Fallback autorisé
      }
    }

    // Pour les erreurs sans status ou avec status < 400, on autorise le fallback
    return false;
  }

  /**
   * Valide une requête pour ce provider
   */
  validateRequest(request: StandardRequest, model: Model): boolean {
    const result = this.performValidation(request, model);
    return result.valid;
  }

  /**
   * Validation détaillée avec retour des erreurs
   */
  protected performValidation(request: StandardRequest, model: Model): ValidationResult {
    const errors: string[] = [];

    // Vérification des messages
    if (!request.messages || !Array.isArray(request.messages)) {
      errors.push('messages field is required and must be an array');
    } else if (request.messages.length === 0) {
      errors.push('messages array cannot be empty');
    } else {
      // Valider chaque message
      request.messages.forEach((message, index) => {
        if (!message.role || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
          errors.push(`Invalid role at message ${index}: ${message.role}`);
        }
        if (!message.content && !message.tool_calls) {
          errors.push(`Message ${index} must have either content or tool_calls`);
        }
      });
    }

    // Vérification du support des tool calls
    if (request.tools && request.tools.length > 0 && !model.support_tool_calling) {
      errors.push(`Model ${model.model_id} does not support tool calling`);
    }

    // Vérification du support de la vision
    const hasImages = request.messages?.some(m => 
      Array.isArray(m.content) && m.content.some(({ type }) => type === 'image_url')
    );

    if (hasImages && !this.modelSupportsVision(model)) {
      errors.push(`Model ${model.model_id} does not support vision/image inputs`);
    }

    // Vérification des paramètres
    if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 2)) {
      errors.push('temperature must be between 0 and 2');
    }

    if (request.top_p !== undefined && (request.top_p < 0 || request.top_p > 1)) {
      errors.push('top_p must be between 0 and 1');
    }

    if (request.max_tokens !== undefined && request.max_tokens <= 0) {
      errors.push('max_tokens must be positive');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Configure l'adapter avec de nouveaux paramètres
   */
  configure(config: Partial<AdapterConfig>, model?: Model): void {
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey;
    }
    if (config.baseURL !== undefined) {
      this.baseURL = config.baseURL;
    }
    this.config = { ...this.config, ...config };
    
    // La classe de base ne fait rien avec le modèle
    // Les adapters spécialisés (Bedrock, Azure) overrideront cette méthode
  }
  /**
   * Prépare les paramètres de base pour une requête
   */
  protected prepareRequestParams(standardRequest: StandardRequest, modelId?: string): Record<string, any> {
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
      frequency_penalty: standardRequest.frequency_penalty,
      presence_penalty: standardRequest.presence_penalty,
      stop: standardRequest.stop,
      user: standardRequest.user,
      ...(typeof modelInfo === 'object' && modelInfo?.extra_param ? modelInfo.extra_param : {})
    };
  }

  /**
   * Nettoie les paramètres en supprimant les valeurs undefined/null
   */
  protected cleanParams<T extends Record<string, any>>(params: T): Partial<T> {
    const cleaned: Partial<T> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        cleaned[key as keyof T] = value;
      }
    }
    return cleaned;
  }

  /**
   * Vérifie si un modèle supporte la vision
   */
  protected modelSupportsVision(model: Model): boolean {
    // Liste des modèles connus pour supporter la vision
    const visionModels = [
      'gpt-4o', 
      'gpt-4o-mini', 
      'gpt-4-vision-preview',
      'claude-3-5-sonnet',
      'claude-3-sonnet', 
      'claude-3-haiku',
      'gemini-1.5-pro',
      'gemini-1.5-flash'
    ];
    
    return model.model_id.includes('vision') || 
           visionModels.some(vm => model.model_id.includes(vm));
  }

  /**
   * Crée une erreur d'adapter standardisée
   */
  protected createError(
    message: string,
    status: number = 500,
    code: AdapterErrorCode = 'UNKNOWN_ERROR',
    originalError?: unknown
  ): AdapterError {
    return new AdapterError(message, status, code, this.name, originalError);
  }

  /**
   * Mappe les raisons d'arrêt vers le format OpenAI standard
   */
  protected mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
    if (!reason) return null;
    
    const mappings: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'stop': 'stop',
      'end_turn': 'stop',
      'stop_sequence': 'stop',
      'length': 'length',
      'max_tokens': 'length',
      'tool_calls': 'tool_calls',
      'function_call': 'tool_calls',
      'content_filter': 'content_filter',
      'safety': 'content_filter'
    };

    return mappings[reason.toLowerCase()] || 'stop';
  }

  /**
   * Valide et nettoie les headers HTTP
   */
  protected validateHeaders(headers: Record<string, string>): Record<string, string> {
    const validHeaders: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(headers)) {
      if (typeof key === 'string' && typeof value === 'string' && key.length > 0 && value.length > 0) {
        validHeaders[key] = value;
      }
    }

    return validHeaders;
  }

  /**
   * Log des métriques d'adapter (peut être overridé)
   */
  protected logMetrics(operation: string, duration: number, success: boolean): void {
    if (process.env.NODE_ENV === 'development') {
    }
  }

  /**
   * Retourne les informations de l'adapter
   */
  getInfo(): { name: string; configured: boolean; baseURL?: string } {
    return {
      name: this.name,
      configured: this.isConfigured(),
      baseURL: this.baseURL
    };
  }
}

export { AdapterError };
