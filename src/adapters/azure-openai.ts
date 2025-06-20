import { BaseAdapter, AdapterError } from './base.js';
import axios, { type AxiosResponse, type AxiosError } from 'axios';
import type { 
  StandardRequest, 
  ChatCompletion, 
  ChatCompletionChunk,
  OpenAIRequest,
  OpenAIResponse,
  AdapterConfig,
  Model
} from '../types/index.js';
import { logger } from 'hono/logger';

/**
 * Adapter pour Azure OpenAI
 * Compatible avec l'API OpenAI mais avec authentification et endpoints Azure
 */
export class AzureOpenAIAdapter extends BaseAdapter {
  private azureApiKey?: string;
  private azureEndpoint?: string;
  private apiVersion: string = '2024-02-15-preview';
  private deploymentName?: string;
  private modelInfo?: Model;

  constructor(config: AdapterConfig = {}) {
    super(config);
    // Pour Azure, on utilise pas apiKey et baseURL de la même façon
    this.azureApiKey = config.apiKey;
    this.azureEndpoint = config.baseURL;
  }

  /**
   * Configure l'adapter avec les informations du modèle Azure
   */
  configure(config: Partial<AdapterConfig>, model?: Model): void {
    super.configure(config);
    this.modelInfo = model;
    
    if (model?.extra_param) {
      // Récupérer les paramètres Azure depuis extra_param
      this.apiVersion = model.extra_param.api_version || this.apiVersion;
      this.deploymentName = model.extra_param.deployment_name;
      this.azureEndpoint = model.extra_param.endpoint;
      
      // Récupérer les credentials depuis les variables d'environnement
      const apiKeyEnv = model.extra_param.api_key_env;
      const endpointEnv = model.extra_param.endpoint_env;
      const apiVersionEnv = model.extra_param.api_version_env;
      
      if (apiKeyEnv) {
        const apiKey = process.env[apiKeyEnv];
        if (apiKey) {
          this.azureApiKey = apiKey;
        }
        else {
          console.warn(`Azure API key environment variable ${apiKeyEnv} is not set`);
          throw this.createError(`Azure API key environment variable ${apiKeyEnv} is not set`, 500, 'CONFIGURATION_ERROR');
        }
      }
      
      if (endpointEnv) {
        const endpoint = process.env[endpointEnv];
        if (endpoint) {
          this.azureEndpoint = endpoint;
        }
        else {
          console.warn(`Azure endpoint environment variable ${endpointEnv} is not set`);
          throw this.createError(`Azure endpoint environment variable ${endpointEnv} is not set`, 500, 'CONFIGURATION_ERROR');
        }
      }
      
      if (apiVersionEnv) {
        const apiVersion = process.env[apiVersionEnv];
        if (apiVersion) {
          this.apiVersion = apiVersion;
        }
        else {
          console.warn(`Azure API version environment variable ${apiVersionEnv} is not set, using default ${this.apiVersion}`);
        }
      }
    }
  }

  isConfigured(): boolean {
    return !!(this.azureApiKey && this.azureEndpoint && this.deploymentName);
  }

  buildHeaders(request: StandardRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'api-key': this.azureApiKey!, // Azure utilise 'api-key' au lieu de 'Authorization'
      'Content-Type': 'application/json',
      'User-Agent': 'LLM-Gateway-Azure/1.0'
    };

    return this.validateHeaders(headers);
  }

  getEndpoint(model: string): string {
    if (!this.azureEndpoint || !this.deploymentName) {
      throw this.createError('Azure endpoint or deployment name not configured', 500, 'VALIDATION_ERROR');
    }

    // Format Azure: {endpoint}/openai/deployments/{deployment}/chat/completions?api-version={version}
    const cleanEndpoint = this.azureEndpoint.endsWith('/') 
      ? this.azureEndpoint.slice(0, -1) 
      : this.azureEndpoint;
    
    return `${cleanEndpoint}/openai/deployments/${this.deploymentName}/chat/completions?api-version=${this.apiVersion}`;
  }

  transformRequest(standardRequest: StandardRequest): OpenAIRequest {
    // Azure OpenAI utilise le même format que OpenAI
    const modelInfo = standardRequest.model;
    const deploymentName = this.deploymentName || 'unknown-deployment';
    
    const openaiRequest: OpenAIRequest = {
      model: deploymentName, // Azure utilise le deployment name, pas le model ID
      messages: standardRequest.messages,
      stream: standardRequest.stream || false,
      max_tokens: standardRequest.max_tokens,
      temperature: standardRequest.temperature,
      top_p: standardRequest.top_p,
      frequency_penalty: standardRequest.frequency_penalty,
      presence_penalty: standardRequest.presence_penalty,
      stop: standardRequest.stop,
      tools: standardRequest.tools,
      tool_choice: standardRequest.tool_choice
    };
    
    // Ajouter stream_options pour les requêtes streaming Azure
    if (openaiRequest.stream) {
      openaiRequest.stream_options = {
        include_usage: true
      };
    }

    // Nettoyer les paramètres et s'assurer que model reste défini
    const cleanedParams = this.cleanParams(openaiRequest);
    return {
      ...cleanedParams,
      model: deploymentName, // S'assurer que model est toujours présent
      messages: standardRequest.messages // S'assurer que messages est toujours présent
    } as OpenAIRequest;
  }

  transformResponse(response: AxiosResponse<OpenAIResponse>): ChatCompletion {
    // Azure OpenAI retourne le même format qu'OpenAI
    const data = response.data;

    if (data.usage) {
      console.log('Azure response usage:', data.usage);
    }
    
    // Validation de base de la réponse
    if (!data.id || !data.choices || !Array.isArray(data.choices)) {
      throw this.createError('Invalid Azure OpenAI response format', 500, 'API_ERROR');
    }

    return {
      id: data.id,
      object: 'chat.completion',
      created: data.created,
      model: data.model,
      choices: data.choices.map(choice => ({
        index: choice.index,
        message: {
          role: 'assistant',
          content: choice.message?.content || null,
          tool_calls: choice.message?.tool_calls
        },
        finish_reason: this.mapFinishReason(choice.finish_reason)
      })),
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
        cached_tokens: data.usage.prompt_tokens_details?.cached_tokens
      } : undefined,
      system_fingerprint: (data as any).system_fingerprint
    };
  }

  transformStreamChunk(chunk: string): ChatCompletionChunk | null {
    // Format Azure OpenAI: "data: {json}\n\n" (identique à OpenAI)
    if (!chunk || chunk === '[DONE]' || chunk.trim() === '') {
      return null;
    }

    try {
      // Si le chunk commence par "data: ", on enlève ce préfixe
      let jsonStr = chunk;
      if (chunk.startsWith('data: ')) {
        jsonStr = chunk.slice(6);
      }
      
      const data = JSON.parse(jsonStr);
      
      // Azure envoie des chunks de métadonnées (filtres de contenu) qu'on peut ignorer
      if (data.prompt_filter_results || data.content_filter_results) {
        return null; // Ignorer silencieusement les chunks de filtres
      }
      
      // Validation de base du chunk
      if (!data.id || !data.choices || !Array.isArray(data.choices)) {
        // Ne pas logger si c'est juste un chunk vide/métadonnées
        if (data.id || data.choices?.length > 0) {
          console.warn('Invalid Azure OpenAI stream chunk format:', chunk);
        }
        return null;
      }

      return {
        id: data.id,
        object: 'chat.completion.chunk',
        created: data.created,
        model: data.model,
        choices: data.choices.map((choice: any) => ({
          index: choice.index,
          delta: {
            role: choice.delta?.role,
            content: choice.delta?.content,
            tool_calls: choice.delta?.tool_calls
          },
          finish_reason: this.mapFinishReason(choice.finish_reason)
        })),
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
          cached_tokens: data.usage.prompt_tokens_details?.cached_tokens
        } : undefined,
        system_fingerprint: (data as any).system_fingerprint
      };
    } catch (error) {
      console.warn('Failed to parse Azure OpenAI stream chunk:', chunk, error);
      return null;
    }
  }

  handleError(error: unknown): AdapterError {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data as any;
        
        // Mapper les codes d'erreur Azure OpenAI (similaires à OpenAI)
        let code: AdapterError['code'] = 'API_ERROR';
        if (status === 401) code = 'AUTHENTICATION_ERROR';
        else if (status === 429) code = 'RATE_LIMIT_ERROR';
        else if (status === 404) code = 'CONFIGURATION_ERROR'; // 404 = configuration error, permettre fallback
        else if (status >= 400 && status < 500) code = 'VALIDATION_ERROR';
        else if (status >= 500) code = 'API_ERROR';
        
        // Messages d'erreur spécifiques à Azure
        let message = data?.error?.message || `Azure OpenAI API error: ${status}`;
        if (status === 401) {
          message = 'Azure OpenAI authentication failed - check your api-key';
        } else if (status === 404) {
          message = `Azure OpenAI deployment not found: ${this.deploymentName}`;
        }
        
        return new AdapterError(
          message,
          status,
          code,
          'azure-openai',
          error
        );
      } else if (axiosError.code === 'ECONNABORTED') {
        return new AdapterError(
          'Request timeout to Azure OpenAI',
          408,
          'TIMEOUT_ERROR',
          'azure-openai',
          error
        );
      } else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
        return new AdapterError(
          'Network connection failed to Azure OpenAI',
          503,
          'NETWORK_ERROR',
          'azure-openai',
          error
        );
      }
    }

    // Erreur générique
    return new AdapterError(
      error instanceof Error ? error.message : 'Unknown Azure OpenAI error',
      500,
      'UNKNOWN_ERROR',
      'azure-openai',
      error
    );
  }

  async makeRequest(
    request: StandardRequest, 
    model: string, 
    isStreaming: boolean = false
  ): Promise<AxiosResponse | ChatCompletion> {
    const startTime = Date.now();
    const endpoint = this.getEndpoint(model);
    const headers = this.buildHeaders(request);
    const data = this.transformRequest(request);

    const config = {
      method: 'POST' as const,
      url: endpoint,
      headers,
      data,
      timeout: this.config.timeout || 500000,
      responseType: isStreaming ? 'stream' as const : 'json' as const
    };

    try {
      const response = await axios(config);
      const duration = Date.now() - startTime;
      
      this.logMetrics('makeRequest', duration, true);
      
      if (isStreaming) {
        return response; // Retourner le stream directement
      } else {
        return this.transformResponse(response);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logMetrics('makeRequest', duration, false);
      
      throw this.handleError(error);
    }
  }

  /**
   * Valide spécifiquement les requêtes Azure OpenAI
   */
  protected validateAzureSpecifics(request: StandardRequest): string[] {
    const errors: string[] = [];

    // Vérifications spécifiques à Azure OpenAI
    if (!this.azureEndpoint) {
      errors.push('Azure endpoint is required');
    }

    if (!this.deploymentName) {
      errors.push('Azure deployment name is required');
    }

    if (!this.azureApiKey) {
      errors.push('Azure API key is required');
    }

    // Validation de l'endpoint Azure
    if (this.azureEndpoint && !this.azureEndpoint.includes('.openai.azure.com')) {
      errors.push('Azure endpoint must be a valid Azure OpenAI endpoint');
    }

    // Même validations qu'OpenAI pour les paramètres
    if (request.frequency_penalty !== undefined && 
        (request.frequency_penalty < -2 || request.frequency_penalty > 2)) {
      errors.push('frequency_penalty must be between -2 and 2');
    }

    if (request.presence_penalty !== undefined && 
        (request.presence_penalty < -2 || request.presence_penalty > 2)) {
      errors.push('presence_penalty must be between -2 and 2');
    }

    return errors;
  }

  /**
   * Override de la validation pour inclure les spécificités Azure
   */
  protected performValidation(request: StandardRequest, model: Model) {
    const baseValidation = super.performValidation(request, model);
    const azureErrors = this.validateAzureSpecifics(request);

    return {
      valid: baseValidation.valid && azureErrors.length === 0,
      errors: [...baseValidation.errors, ...azureErrors]
    };
  }

  /**
   * Obtient les informations de configuration Azure
   */
  getAzureInfo(): {
    endpoint?: string;
    deploymentName?: string;
    apiVersion: string;
    region?: string;
  } {
    return {
      endpoint: this.azureEndpoint,
      deploymentName: this.deploymentName,
      apiVersion: this.apiVersion,
      region: this.modelInfo?.extra_param?.region
    };
  }
}
