import { OpenAIAdapter } from './openai.js';
import { BedrockAdapter } from './bedrock.js';
import { BaseAdapter, AdapterError } from './base.js';
import { AzureOpenAIAdapter } from './azure-openai.js';
import { VertexAnthropicAdapter } from './vertex-anthropic.js';
import type { AdapterType, AdapterConfig, AdapterInterface } from '../types/index.js';

/**
 * Registry des adapters disponibles
 * Chaque adapter peut être utilisé par plusieurs providers
 */
export const adapters: Record<AdapterType, new (config?: AdapterConfig) => BaseAdapter> = {
  openai: OpenAIAdapter,
  bedrock: BedrockAdapter,
  'azure-openai': AzureOpenAIAdapter,
  'vertex-anthropic': VertexAnthropicAdapter
};


/**
 * Crée une instance d'adapter basée sur le type
 * @param adapterType - Type d'adapter (openai, etc.)
 * @param config - Configuration de l'adapter
 * @returns Instance de l'adapter
 */
export function createAdapter(adapterType: string, config: AdapterConfig = {}): BaseAdapter {
  const normalizedType = adapterType.toLowerCase() as AdapterType;
  const AdapterClass = adapters[normalizedType];
  
  if (!AdapterClass) {
    const availableTypes = Object.keys(adapters).join(', ');
    throw new AdapterError(
      `Unknown adapter type: ${adapterType}. Available types: ${availableTypes}`,
      400,
      'VALIDATION_ERROR',
      'factory'
    );
  }
  
  try {
    return new AdapterClass(config);
  } catch (error) {
    throw new AdapterError(
      `Failed to create adapter ${adapterType}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      500,
      'UNKNOWN_ERROR',
      'factory',
      error
    );
  }
}

/**
 * Retourne la liste des adapters disponibles
 * @returns Liste des types d'adapters
 */
export function getAvailableAdapters(): AdapterType[] {
  return Object.keys(adapters) as AdapterType[];
}

/**
 * Vérifie si un adapter est disponible
 * @param adapterType - Type d'adapter
 * @returns true si l'adapter est disponible
 */
export function isAdapterAvailable(adapterType: string): boolean {
  const normalizedType = adapterType.toLowerCase() as AdapterType;
  return normalizedType in adapters;
}

/**
 * Obtient des informations sur un adapter sans l'instancier
 * @param adapterType - Type d'adapter
 * @returns Informations sur l'adapter
 */
export function getAdapterInfo(adapterType: string): { 
  name: string; 
  available: boolean; 
  description: string 
} {
  const normalizedType = adapterType.toLowerCase() as AdapterType;
  const available = isAdapterAvailable(normalizedType);
  
  const descriptions: Record<AdapterType, string> = {
    openai: 'OpenAI compatible API adapter (works with OpenAI, Together, Azure OpenAI, etc.)',
    bedrock: 'AWS Bedrock adapter for Claude and other Bedrock models',
    'azure-openai': 'Azure OpenAI adapter with proper authentication and endpoints',
    'vertex-anthropic': 'Google Vertex AI adapter for Anthropic models',
  };


  return {
    name: normalizedType,
    available,
    description: descriptions[normalizedType] || 'Unknown adapter'
  };
}

/**
 * Valide la configuration d'un adapter
 * @param adapterType - Type d'adapter
 * @param config - Configuration à valider
 * @returns Résultat de la validation
 */
export function validateAdapterConfig(
  adapterType: string, 
  config: AdapterConfig
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isAdapterAvailable(adapterType)) {
    errors.push(`Adapter type '${adapterType}' is not available`);
    return { valid: false, errors };
  }

  // Validation générale
  if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) {
    errors.push('timeout must be a positive number');
  }

  if (config.maxRetries !== undefined && (typeof config.maxRetries !== 'number' || config.maxRetries < 0)) {
    errors.push('maxRetries must be a non-negative number');
  }

  if (config.baseURL !== undefined && (typeof config.baseURL !== 'string' || !config.baseURL.trim())) {
    errors.push('baseURL must be a non-empty string');
  }

  if (config.apiKey !== undefined && (typeof config.apiKey !== 'string' || !config.apiKey.trim())) {
    errors.push('apiKey must be a non-empty string');
  }

  // Validation spécifique par adapter
  const normalizedType = adapterType.toLowerCase() as AdapterType;
  
  if (normalizedType === 'openai') {
    if (config.baseURL && !config.baseURL.startsWith('http')) {
      errors.push('OpenAI baseURL must start with http:// or https://');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Crée un adapter avec validation automatique
 * @param adapterType - Type d'adapter
 * @param config - Configuration de l'adapter
 * @returns Instance de l'adapter validée
 */
export function createValidatedAdapter(adapterType: string, config: AdapterConfig = {}): BaseAdapter {
  const validation = validateAdapterConfig(adapterType, config);
  
  if (!validation.valid) {
    throw new AdapterError(
      `Invalid adapter configuration: ${validation.errors.join(', ')}`,
      400,
      'VALIDATION_ERROR',
      'factory'
    );
  }

  return createAdapter(adapterType, config);
}

/**
 * Teste si un adapter peut se connecter à son service
 * @param adapter - Instance de l'adapter à tester
 * @returns Résultat du test de connexion
 */
export async function testAdapterConnection(adapter: BaseAdapter): Promise<{
  success: boolean;
  error?: string;
  latency?: number;
}> {
  if (!adapter.isConfigured()) {
    return {
      success: false,
      error: 'Adapter is not properly configured'
    };
  }

  const startTime = Date.now();

  try {
    // Test avec une requête minimale
    const testRequest = {
      messages: [{ role: 'user' as const, content: 'test' }],
      max_tokens: 1,
      stream: false
    };

    // Essayer de faire une requête (qui peut échouer mais nous donne des infos sur la connectivité)
    await adapter.makeRequest(testRequest, 'test-model', false);
    
    return {
      success: true,
      latency: Date.now() - startTime
    };
  } catch (error) {
    let errorMessage = 'Unknown error';
    
    if (error instanceof AdapterError) {
      // Si c'est une erreur d'authentification ou de validation, la connexion fonctionne
      if (error.code === 'AUTHENTICATION_ERROR' || error.code === 'VALIDATION_ERROR') {
        return {
          success: true,
          latency: Date.now() - startTime
        };
      }
      errorMessage = error.message;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    return {
      success: false,
      error: errorMessage,
      latency: Date.now() - startTime
    };
  }
}

// Exports individuels pour faciliter l'import
export { OpenAIAdapter };
export { BedrockAdapter };
export { AzureOpenAIAdapter };
export { BaseAdapter, AdapterError } from './base.js';

// Types réexportés
export type { AdapterInterface, AdapterConfig, AdapterType } from '../types/index.js';