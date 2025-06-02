/**
 * Utilitaire pour envoyer des requêtes asynchrones au webhook
 */

import axios, { type AxiosError } from 'axios';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration du webhook
 */
interface WebhookConfig {
  secretKey: string;
  baseUrl: string;
  timeout: number;
}

/**
 * Réponse du webhook de calcul des tokens
 */
interface WebhookResponse {
  success: boolean;
  message: string;
  stats?: {
    processed: number;
    errors: number;
  };
  error?: string;
}

/**
 * Options pour le déclenchement du webhook
 */
interface TriggerOptions {
  delay?: number;
  timeout?: number;
  retries?: number;
  useAlternativeMethod?: boolean;
}

/**
 * Résultat du déclenchement du webhook
 */
interface TriggerResult {
  success: boolean;
  message: string;
  stats?: {
    processed: number;
    errors: number;
  };
  error?: string;
  method: 'axios' | 'fetch';
  duration?: number;
}

// Configuration par défaut
const defaultConfig: WebhookConfig = {
  secretKey: process.env.WEBHOOK_SECRET_KEY || 'default-webhook-secret-key',
  baseUrl: process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  timeout: 60000 // 60 secondes
};

/**
 * Valide la configuration du webhook
 * @param config - Configuration à valider
 */
function validateConfig(config: WebhookConfig): void {
  if (!config.secretKey || config.secretKey.length < 10) {
    throw new Error('Webhook secret key must be at least 10 characters long');
  }

  if (!config.baseUrl || !config.baseUrl.startsWith('http')) {
    throw new Error('Base URL must be a valid HTTP/HTTPS URL');
  }

  if (config.timeout <= 0 || config.timeout > 300000) {
    throw new Error('Timeout must be between 1ms and 300000ms (5 minutes)');
  }
}

/**
 * Construit l'URL complète du webhook
 * @param baseUrl - URL de base
 * @returns URL complète du webhook
 */
function buildWebhookUrl(baseUrl: string): string {
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${cleanBaseUrl}/webhook/calculate-tokens`;
}

/**
 * Gère les erreurs du webhook de manière typée
 * @param error - Erreur à traiter
 * @param method - Méthode utilisée
 * @returns Message d'erreur formaté
 */
function handleWebhookError(error: unknown, method: 'axios' | 'fetch'): string {
  if (method === 'axios' && axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<WebhookResponse>;
    
    if (axiosError.response) {
      const status = axiosError.response.status;
      const data = axiosError.response.data;
      
      if (status === 409) {
        return 'Webhook déjà en cours d\'exécution, requête ignorée';
      } else {
        return `Erreur webhook (${status}): ${data?.message || axiosError.response.statusText}`;
      }
    } else if (axiosError.code === 'ECONNREFUSED') {
      return 'Impossible de joindre le webhook (serveur non accessible)';
    } else if (axiosError.code === 'ETIMEDOUT' || axiosError.code === 'ECONNABORTED') {
      return 'Timeout lors de l\'appel au webhook';
    } else {
      return `Erreur réseau: ${axiosError.message}`;
    }
  }

  if (method === 'fetch' && error instanceof Error) {
    if (error.name === 'AbortError') {
      return 'Timeout lors de l\'appel au webhook';
    } else if (error.message.includes('fetch')) {
      return 'Erreur de connexion (fetch)';
    }
  }

  return error instanceof Error ? error.message : 'Erreur inconnue';
}

/**
 * Envoie une requête asynchrone vers le webhook de calcul des tokens avec axios
 * @param config - Configuration du webhook
 * @param options - Options de déclenchement
 * @returns Promesse du résultat
 */
async function executeWebhookAxios(
  config: WebhookConfig, 
  options: TriggerOptions
): Promise<TriggerResult> {
  const startTime = Date.now();
  
  try {
    const url = buildWebhookUrl(config.baseUrl);
    
    const response = await axios.post<WebhookResponse>(url, {}, {
      headers: {
        'X-Webhook-Secret': config.secretKey,
        'Content-Type': 'application/json'
      },
      timeout: options.timeout || config.timeout,
      maxRedirects: 0 // Ne pas suivre les redirections automatiquement
    });
    
    const duration = Date.now() - startTime;
    
    if (response.data.success) {
      return {
        success: true,
        message: `Webhook exécuté avec succès: ${response.data.stats?.processed || 0} requêtes traitées, ${response.data.stats?.errors || 0} erreurs`,
        stats: response.data.stats,
        method: 'axios',
        duration
      };
    } else {
      return {
        success: false,
        message: `Webhook terminé avec des problèmes: ${response.data.message}`,
        error: response.data.error,
        method: 'axios',
        duration
      };
    }
    
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = handleWebhookError(error, 'axios');
    
    return {
      success: false,
      message: errorMessage,
      error: errorMessage,
      method: 'axios',
      duration
    };
  }
}

/**
 * Envoie une requête asynchrone vers le webhook de calcul des tokens avec fetch
 * @param config - Configuration du webhook
 * @param options - Options de déclenchement
 * @returns Promesse du résultat
 */
async function executeWebhookFetch(
  config: WebhookConfig, 
  options: TriggerOptions
): Promise<TriggerResult> {
  const startTime = Date.now();
  
  try {
    const url = buildWebhookUrl(config.baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || config.timeout);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Webhook-Secret': config.secretKey,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;
    
    let data: WebhookResponse;
    try {
      data = await response.json() as WebhookResponse;
    } catch {
      throw new Error(`Invalid JSON response (${response.status})`);
    }
    
    if (response.ok && data.success) {
      return {
        success: true,
        message: `Webhook exécuté avec succès: ${data.stats?.processed || 0} requêtes traitées, ${data.stats?.errors || 0} erreurs`,
        stats: data.stats,
        method: 'fetch',
        duration
      };
    } else {
      return {
        success: false,
        message: `Webhook terminé avec des problèmes (${response.status}): ${data.message || response.statusText}`,
        error: data.error || response.statusText,
        method: 'fetch',
        duration
      };
    }
    
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = handleWebhookError(error, 'fetch');
    
    return {
      success: false,
      message: errorMessage,
      error: errorMessage,
      method: 'fetch',
      duration
    };
  }
}

/**
 * Envoie une requête asynchrone vers le webhook de calcul des tokens
 * Cette fonction n'attend pas la réponse et ne bloque pas le processus principal
 * @param delay - Délai en millisecondes avant d'envoyer la requête (défaut: 1000ms)
 * @param options - Options supplémentaires
 */
export async function triggerWebhookAsync(
  delay: number = 1000, 
  options: Omit<TriggerOptions, 'delay'> = {}
): Promise<void> {
  // Validation des paramètres
  if (delay < 0 || delay > 60000) {
    console.warn('Delay should be between 0 and 60000ms, using default 1000ms');
    delay = 1000;
  }

  // Programmer l'envoi de la requête de manière asynchrone
  setTimeout(async () => {
    try {
      console.log('🔄 Déclenchement asynchrone du webhook de calcul des tokens...');
      
      // Valider la configuration
      validateConfig(defaultConfig);
      
      // Choisir la méthode (axios par défaut, fetch en alternative)
      const method = options.useAlternativeMethod ? 'fetch' : 'axios';
      
      let result: TriggerResult;
      if (method === 'fetch') {
        result = await executeWebhookFetch(defaultConfig, options);
      } else {
        result = await executeWebhookAxios(defaultConfig, options);
      }
      
      // Logger le résultat
      if (result.success) {
        console.log(`✅ ${result.message} (${result.duration}ms via ${result.method})`);
      } else {
        if (result.error?.includes('déjà en cours')) {
          console.log(`ℹ️ ${result.message}`);
        } else {
          console.error(`❌ ${result.message} (${result.duration}ms via ${result.method})`);
        }
      }
      
    } catch (error) {
      console.error('❌ Erreur lors de l\'appel asynchrone au webhook:', error instanceof Error ? error.message : 'Unknown error');
    }
  }, delay);
  
  // Cette fonction retourne immédiatement sans attendre l'exécution du webhook
  console.log(`⏲️ Webhook programmé pour exécution dans ${delay}ms`);
}

/**
 * Version alternative utilisant fetch au lieu d'axios
 * Peut être utile si axios n'est pas disponible
 * @param delay - Délai en millisecondes avant d'envoyer la requête (défaut: 1000ms)
 * @param options - Options supplémentaires
 */
export async function triggerWebhookAsyncFetch(
  delay: number = 1000, 
  options: Omit<TriggerOptions, 'delay' | 'useAlternativeMethod'> = {}
): Promise<void> {
  return triggerWebhookAsync(delay, { ...options, useAlternativeMethod: true });
}

/**
 * Version synchrone pour les tests
 * @param options - Options de déclenchement
 * @returns Résultat du webhook
 */
export async function triggerWebhookSync(options: TriggerOptions = {}): Promise<TriggerResult> {
  try {
    validateConfig(defaultConfig);
    
    const method = options.useAlternativeMethod ? 'fetch' : 'axios';
    
    if (method === 'fetch') {
      return await executeWebhookFetch(defaultConfig, options);
    } else {
      return await executeWebhookAxios(defaultConfig, options);
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Configuration error',
      error: error instanceof Error ? error.message : 'Unknown error',
      method: 'axios'
    };
  }
}

/**
 * Teste la connectivité du webhook
 * @returns Résultat du test
 */
export async function testWebhookConnectivity(): Promise<{
  reachable: boolean;
  latency?: number;
  error?: string;
  config: {
    url: string;
    hasSecretKey: boolean;
  };
}> {
  try {
    validateConfig(defaultConfig);
    
    const url = buildWebhookUrl(defaultConfig.baseUrl);
    const startTime = Date.now();
    
    // Test simple de connectivité (HEAD request)
    const response = await axios.head(url, {
      timeout: 5000,
      headers: {
        'X-Webhook-Secret': defaultConfig.secretKey
      }
    });
    
    const latency = Date.now() - startTime;
    
    return {
      reachable: true,
      latency,
      config: {
        url,
        hasSecretKey: defaultConfig.secretKey.length > 0
      }
    };
  } catch (error) {
    const errorMessage = handleWebhookError(error, 'axios');
    
    return {
      reachable: false,
      error: errorMessage,
      config: {
        url: buildWebhookUrl(defaultConfig.baseUrl),
        hasSecretKey: defaultConfig.secretKey.length > 0
      }
    };
  }
}

/**
 * Obtient la configuration actuelle du webhook
 * @returns Configuration (avec clé secrète masquée)
 */
export function getWebhookConfig(): {
  baseUrl: string;
  timeout: number;
  secretKeyMasked: string;
  webhookUrl: string;
} {
  return {
    baseUrl: defaultConfig.baseUrl,
    timeout: defaultConfig.timeout,
    secretKeyMasked: `${defaultConfig.secretKey.substring(0, 4)}${'*'.repeat(defaultConfig.secretKey.length - 4)}`,
    webhookUrl: buildWebhookUrl(defaultConfig.baseUrl)
  };
}