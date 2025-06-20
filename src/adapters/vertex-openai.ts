import { OpenAIAdapter } from './openai.js';
import { GoogleAuth } from 'google-auth-library';
import type { AdapterConfig, Model, StandardRequest } from '../types/index.js';

/**
 * Adapter pour les modèles OpenAI-compatible sur Vertex AI (comme Gemini)
 */
export class VertexOpenAIAdapter extends OpenAIAdapter {
  private projectId: string;
  private region: string;
  private googleAuth?: GoogleAuth;

  constructor(config: AdapterConfig = {}) {
    super(config);
    this.name = 'vertex-openai';
    this.projectId = '';
    this.region = '';
  }

  configure(config: Partial<AdapterConfig>, model?: Model): void {
    super.configure(config, model);
    
    if (model?.extra_param) {
      this.projectId = model.extra_param.project_id || process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
      this.region = model.extra_param.region || process.env.VERTEX_REGION || process.env.GOOGLE_CLOUD_REGION || 'us-central1';
    }

    if (this.projectId && this.region) {
        this.setupGoogleAuth();
    }
  }

  private setupGoogleAuth(): void {
    try {
        const hasEnvCredentials = process.env.GOOGLE_CLOUD_CLIENT_EMAIL && 
                                  process.env.GOOGLE_CLOUD_PRIVATE_KEY && 
                                  process.env.GOOGLE_CLOUD_PROJECT;

        if (hasEnvCredentials) {
            const credentials = {
                client_email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_CLOUD_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                project_id: process.env.GOOGLE_CLOUD_PROJECT,
                client_id: process.env.GOOGLE_CLOUD_CLIENT_ID,
                type: 'service_account'
            };
            this.googleAuth = new GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/cloud-platform'],
                projectId: this.projectId
            });
        } else {
            this.googleAuth = new GoogleAuth({
                scopes: ['https://www.googleapis.com/auth/cloud-platform'],
                projectId: this.projectId,
            });
        }
    } catch (error) {
        console.error('Failed to setup Google Auth for Vertex OpenAI:', error);
        throw this.createError(
            `Failed to setup Google Auth: ${error instanceof Error ? error.message : 'Unknown error'}`,
            500,
            'API_ERROR'
        );
    }
  }

  isConfigured(): boolean {
    return !!(this.googleAuth && this.projectId && this.region);
  }

  async buildHeaders(request: StandardRequest): Promise<Record<string, string>> {
    if (!this.googleAuth) {
        throw this.createError('Google Auth not initialized', 500, 'CONFIGURATION_ERROR');
    }
    
    const token = await this.googleAuth.getAccessToken();
    if (!token) {
        throw this.createError('Unable to retrieve Google Auth token', 401, 'AUTHENTICATION_ERROR');
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'LLM-Gateway-Vertex-OpenAI/1.0'
    };

    return this.validateHeaders(headers);
  }

  getEndpoint(model: string): string {
    // L'endpoint pour les modèles OpenAI-compatible sur Vertex est diffrent
    return `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${model}:streamGenerateContent`;
  }
  
  // Override makeRequest pour utiliser les headers asynchrones
  async makeRequest(
    request: StandardRequest, 
    model: string, 
    isStreaming: boolean = false
  ): Promise<any> {
    const startTime = Date.now();
    const endpoint = this.getEndpoint(request.modelInfo?.provider_model_id || model);
    const headers = await this.buildHeaders(request); // Headers asynchrones
    const data = this.transformRequest(request);

    // Vertex pour Gemini a un format de requête légèrement différent
    // Il ne faut pas envoyer le modèle dans le corps, il est dans l'URL
    const { model: _model, ...vertexData } = data;

    const config = {
      method: 'POST' as const,
      url: endpoint,
      headers,
      data: vertexData,
      timeout: this.config.timeout || 30000,
      responseType: isStreaming ? 'stream' as const : 'json' as const
    };

    try {
      const axios = (await import('axios')).default;
      const response = await axios(config);
      const duration = Date.now() - startTime;
      
      this.logMetrics('makeRequest', duration, true);
      
      if (isStreaming) {
        return response;
      } else {
        return this.transformResponse(response);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logMetrics('makeRequest', duration, false);
      
      throw this.handleError(error);
    }
  }
}
