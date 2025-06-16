import { supabase, supabaseAuth, dbConfig } from '../config/database.js';
import { apiKeysCache, balanceCache, cacheUtils } from '../config/cache.js';
import type { Context, Next } from 'hono';
import type { 
  AuthData, 
  User, 
  ApiKey, 
  HonoVariables,
  ApiKeyWithWallet
} from '../types/index.js';

/**
 * Interface pour les données d'authentification test
 */
interface TestAuthData {
  user: User;
  apiKey: ApiKey;
  authMethod: 'api_key';
}

/**
 * Authentifie l'utilisateur via clé API ou token Supabase
 * @param c - Context Hono
 * @returns Données d'authentification
 */
export async function authenticateUser(c: Context): Promise<AuthData> {
  const authHeader = c.req.header('Authorization');
  const apiKeyHeader = c.req.header('X-API-Key');
  
  // Méthode 1: Authentification par clé API
  if (apiKeyHeader) {
    return await authenticateWithApiKey(apiKeyHeader);
  }
  
  // Méthode 2: Authentification par token Supabase ou clé API via Bearer
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    // Détecter si c'est une clé API envoyée via Authorization au lieu d'un JWT
    if (looksLikeApiKey(token)) {
      return await authenticateWithApiKey(token);
    }
    
    return await authenticateWithSupabaseToken(token);
  }
  
  throw new Error('No valid authentication method provided');
}

/**
 * Authentification par clé API
 * @param apiKey - Clé API
 * @returns Données d'authentification
 */
async function authenticateWithApiKey(apiKey: string): Promise<AuthData> {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('API key must be a non-empty string');
  }

  // Mode test : accepter la clé de test directement (pour développement uniquement)
  // TODO: Supprimer cette section en production
  if (apiKey === 'test-api-key-123' && process.env.NODE_ENV !== 'production') {
    const testUserData: TestAuthData = {
      user: {
        id: '3dfeb923-1e33-4a3a-9473-ee9637446ae4',
        balance: 10.0
      },
      apiKey: {
        id: 'test-api-key-id',
        name: 'Test API Key',
        key: 'test-api-key-123'
      },
      authMethod: 'api_key'
    };
    
    // Mettre en cache pour les prochaines requêtes
    cacheUtils.setAuthData(apiKey, testUserData);
    cacheUtils.setBalance(testUserData.user.id, testUserData.user.balance);
    
    return testUserData;
  }
  
  // Vérifier le cache d'abord
  const cachedData = cacheUtils.getAuthData(apiKey);
  
  if (cachedData) {
    return cachedData;
  }
  
  
  // Requête combinée pour récupérer la clé API et les infos utilisateur
  const { data, error } = await supabase
    .from('api_keys')
    .select(`
      id,
      user_id,
      api_key,
      api_key_name,
      is_active,
      wallet!inner(user_id, balance)
    `)
    .eq('api_key', apiKey)
    .eq('is_active', true)
    .single();
  
  
  if (error || !data) {
    throw new Error('Invalid API key');
  }

  // Type guard pour vérifier la structure des données
  const apiKeyData = data as unknown as ApiKeyWithWallet;
  
  if (!apiKeyData.wallet) {
    throw new Error('User wallet not found');
  }

  const userData: AuthData = {
    user: {
      id: apiKeyData.user_id,
      balance: apiKeyData.wallet.balance
    },
    apiKey: {
      id: apiKeyData.id,
      name: apiKeyData.api_key_name,
      key: apiKeyData.api_key
    },
    authMethod: 'api_key'
  };
  
  // Mettre en cache
  cacheUtils.setAuthData(apiKey, userData);
  cacheUtils.setBalance(apiKeyData.user_id, apiKeyData.wallet.balance);
  
  return userData;
}

/**
 * Authentification par token Supabase
 * @param token - Token JWT Supabase
 * @returns Données d'authentification
 */
async function authenticateWithSupabaseToken(token: string): Promise<AuthData> {
  if (!token || typeof token !== 'string') {
    throw new Error('Supabase token must be a non-empty string');
  }

  // Vérifier la structure JWT basique avant d'envoyer à Supabase
  const tokenSegments = token.split('.');
  if (tokenSegments.length !== 3) {
    throw new Error(`Invalid JWT structure: expected 3 segments, got ${tokenSegments.length}`);
  }
  
  // Vérifier le token avec Supabase Auth
  const { data: authData, error: authError } = await supabaseAuth.auth.getUser(token);
  
  if (authError || !authData.user) {
    throw new Error(`Invalid Supabase token: ${authError?.message || 'Unknown error'}`);
  }

  const user = authData.user;
  
  // Récupérer les infos du wallet
  const { data: walletData, error: walletError } = await supabase
    .from('wallet')
    .select('balance')
    .eq('user_id', user.id)
    .single();
  
  if (walletError || !walletData) {
    throw new Error(`User wallet not found: ${walletError?.message || 'Unknown error'}`);
  }
  
  // Mettre en cache la balance
  cacheUtils.setBalance(user.id, walletData.balance);
  
  return {
    user: {
      id: user.id,
      email: user.email,
      balance: walletData.balance
    },
    apiKey: undefined,
    authMethod: 'supabase_token'
  };
}

/**
 * Vérifie si l'utilisateur a suffisamment de fonds
 * @param userId - ID de l'utilisateur
 * @returns Balance actuelle
 */
export async function checkUserBalance(userId: string): Promise<number> {
  if (!userId || typeof userId !== 'string') {
    throw new Error('User ID must be a non-empty string');
  }

  // Vérifier le cache d'abord
  const cachedBalance = cacheUtils.getBalance(userId);
  
  if (cachedBalance !== undefined) {
    // Si la balance est >= 1, le cache reste valide
    // Sinon, on re-vérifie pour éviter de donner des crédits inexistants
    if (cachedBalance >= 1) {
      return cachedBalance;
    }
  }
  
  // Récupérer la balance depuis la DB
  const { data, error } = await supabase
    .from('wallet')
    .select('balance')
    .eq('user_id', userId)
    .single();
  
  if (error || !data) {
    throw new Error(`Failed to fetch user balance: ${error?.message || 'Unknown error'}`);
  }
  
  const balance = parseFloat(data.balance.toString());
  
  if (isNaN(balance)) {
    throw new Error('Invalid balance value in database');
  }
  
  // Mettre en cache
  cacheUtils.setBalance(userId, balance);
  
  return balance;
}

/**
 * Vérifie si l'utilisateur peut effectuer une requête
 * @param userId - ID de l'utilisateur
 * @param estimatedCost - Coût estimé de la requête (optionnel)
 * @returns Informations sur la capacité de paiement
 */
export async function checkPaymentCapability(
  userId: string, 
  estimatedCost?: number
): Promise<{
  canPay: boolean;
  currentBalance: number;
  requiredBalance: number;
  estimatedCost?: number;
}> {
  const currentBalance = await checkUserBalance(userId);
  const requiredBalance = dbConfig.minimalFund;
  const canPayMinimal = currentBalance >= requiredBalance;
  
  if (estimatedCost !== undefined) {
    const canPayEstimated = currentBalance >= estimatedCost;
    return {
      canPay: canPayMinimal && canPayEstimated,
      currentBalance,
      requiredBalance: Math.max(requiredBalance, estimatedCost),
      estimatedCost
    };
  }
  
  return {
    canPay: canPayMinimal,
    currentBalance,
    requiredBalance
  };
}

/**
 * Interface pour les paramètres du middleware d'auth
 */
interface AuthMiddlewareOptions {
  checkBalance?: boolean;
  requiredBalance?: number;
  estimatedCost?: number;
}

/**
 * Middleware d'authentification et vérification des fonds pour Hono
 * @param options - Options du middleware
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  const { 
    checkBalance = true, 
    requiredBalance = dbConfig.minimalFund,
    estimatedCost 
  } = options;

  return async (c: Context<{ Variables: HonoVariables }>, next: Next) => {
    try {
      // 1. Authentification
      const authData = await authenticateUser(c);
      
      // 2. Vérification des fonds si demandée
      if (checkBalance) {
        const paymentCheck = await checkPaymentCapability(
          authData.user.id, 
          estimatedCost
        );
        
        if (!paymentCheck.canPay) {
          return c.json({
            error: {
              message: 'Insufficient funds',
              type: 'insufficient_funds_error',
              required: paymentCheck.requiredBalance,
              current: paymentCheck.currentBalance,
              estimated_cost: paymentCheck.estimatedCost
            }
          }, 402);
        }
        
        // Mettre à jour la balance dans authData
        authData.user.balance = paymentCheck.currentBalance;
      }
      
      // Ajouter les données d'auth au contexte
      c.set('auth', authData);
      c.set('balance', authData.user.balance);
      
      await next();
    } catch (error) {
      console.error('Authentication error:', error);
      
      let message = 'Authentication failed';
      let status = 401;
      let hint: string | undefined;
      
      if (error instanceof Error) {
        message = error.message;
        
        // Mapper certaines erreurs spécifiques avec des conseils
        if (message.includes('Insufficient funds')) {
          status = 402;
        } else if (message.includes('Invalid JWT structure')) {
          status = 401;
          hint = 'The token appears to be an API key instead of a JWT. Use X-API-Key header or ensure you\'re sending a valid Supabase JWT token.';
        } else if (message.includes('Invalid API key')) {
          status = 401;
          hint = 'Verify your API key is correct and active. API keys should be sent via X-API-Key header.';
        } else if (message.includes('Invalid') || message.includes('not found')) {
          status = 401;
        } else if (message.includes('Database') || message.includes('fetch')) {
          status = 503;
        }
      }
      
      const errorResponse: any = {
        error: {
          message,
          type: status === 402 ? 'insufficient_funds_error' : 'authentication_error',
          timestamp: new Date().toISOString()
        }
      };
      
      if (hint) {
        errorResponse.error.hint = hint;
      }
      
      return c.json(errorResponse, status as any);
    }
  };
}

/**
 * Middleware d'authentification par défaut
 */
export const authMiddleware = createAuthMiddleware();

/**
 * Middleware d'authentification sans vérification de balance
 */
export const authOnlyMiddleware = createAuthMiddleware({ checkBalance: false });

/**
 * Met à jour le timestamp last_used_at d'une clé API (asynchrone)
 * @param userId - ID de l'utilisateur
 * @param apiKeyName - Nom de la clé API
 */
export async function updateApiKeyUsage(userId: string, apiKeyName?: string): Promise<void> {
  if (!apiKeyName || !userId) return;
  
  // Exécution asynchrone sans attendre
  setImmediate(async () => {
    try {
      const { error } = await supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('api_key_name', apiKeyName);
        
      if (error) {
        console.error('Failed to update API key usage:', error);
      }
    } catch (error) {
      console.error('Failed to update API key usage:', error);
    }
  });
}

/**
 * Invalide le cache d'authentification pour un utilisateur
 * @param userId - ID de l'utilisateur
 */
export function invalidateUserAuth(userId: string): void {
  cacheUtils.invalidateBalance(userId);
  
  // Invalider toutes les clés API de cet utilisateur
  // (nécessiterait une structure de cache plus complexe pour être optimal)
  if (process.env.NODE_ENV === 'development') {
    console.log(`Auth cache invalidated for user: ${userId}`);
  }
}

/**
 * Invalide le cache d'une clé API spécifique
 * @param apiKey - Clé API
 */
export function invalidateApiKeyAuth(apiKey: string): void {
  cacheUtils.invalidateApiKey(apiKey);
  
  if (process.env.NODE_ENV === 'development') {
    console.log(`API key cache invalidated: ${apiKey.substring(0, 8)}...`);
  }
}

/**
 * Récupère les informations d'authentification depuis le cache
 * @param apiKey - Clé API
 * @returns Données d'auth ou undefined si pas en cache
 */
export function getCachedAuthData(apiKey: string): AuthData | undefined {
  return cacheUtils.getAuthData(apiKey);
}

/**
 * Vérifie si une clé API est valide (format)
 * @param apiKey - Clé API à valider
 * @returns true si le format est valide
 */
export function isValidApiKeyFormat(apiKey: string): boolean {
  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }
  
  // Vérifications de base du format
  if (apiKey.length < 10) {
    return false;
  }
  
  // Pas de caractères dangereux
  if (apiKey.includes(' ') || apiKey.includes('\n') || apiKey.includes('\t')) {
    return false;
  }
  
  return true;
}

/**
 * Vérifie si un token ressemble à une clé API plutôt qu'à un JWT
 * @param token - Token à analyser
 * @returns true si c'est probablement une clé API
 */
function looksLikeApiKey(token: string): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }
  
  // Les clés API commencent généralement par des préfixes spécifiques
  const apiKeyPrefixes = ['sk_', 'ak_', 'api_', 'key_'];
  const hasApiKeyPrefix = apiKeyPrefixes.some(prefix => token.startsWith(prefix));
  
  // Un JWT a toujours 3 segments séparés par des points
  const segments = token.split('.');
  const hasJwtStructure = segments.length === 3;
  
  // Si ça a un préfixe de clé API ou pas la structure JWT, c'est probablement une clé API
  return hasApiKeyPrefix || !hasJwtStructure;
}

/**
 * Génère des statistiques d'authentification
 * @returns Statistiques des caches d'auth
 */
export function getAuthStats(): {
  apiKeysCache: { keys: number; hits: number; misses: number };
  balanceCache: { keys: number; hits: number; misses: number };
} {
  const apiKeyStats = apiKeysCache.getStats();
  const balanceStats = balanceCache.getStats();
  
  return {
    apiKeysCache: {
      keys: apiKeyStats.keys,
      hits: apiKeyStats.hits,
      misses: apiKeyStats.misses
    },
    balanceCache: {
      keys: balanceStats.keys,
      hits: balanceStats.hits,
      misses: balanceStats.misses
    }
  };
}
