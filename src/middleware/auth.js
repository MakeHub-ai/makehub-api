import { supabase, supabaseAuth, dbConfig } from '../config/database.js';
import { apiKeysCache, balanceCache, cacheUtils } from '../config/cache.js';

/**
 * Authentifie l'utilisateur via clé API ou token Supabase
 * @param {Object} c - Context Hono
 * @returns {Object} { user, apiKey, authMethod }
 */
export async function authenticateUser(c) {
  const authHeader = c.req.header('Authorization');
  const apiKeyHeader = c.req.header('X-API-Key');
  
  // Méthode 1: Authentification par clé API
  if (apiKeyHeader) {
    return await authenticateWithApiKey(apiKeyHeader);
  }
  
  // Méthode 2: Authentification par token Supabase
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    return await authenticateWithSupabaseToken(token);
  }
  
  throw new Error('No valid authentication method provided');
}

/**
 * Authentification par clé API
 */
async function authenticateWithApiKey(apiKey) {
  console.log('🔑 Authenticating with API key:', apiKey);
  
  // Mode test : accepter la clé de test directement
  if (apiKey === 'test-api-key-123') {
    console.log('✅ Using test API key');
    const testUserData = {
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
    const cacheKey = cacheUtils.apiKeyKey(apiKey);
    apiKeysCache.set(cacheKey, testUserData);
    balanceCache.set(cacheUtils.balanceKey('test-user-id'), 10.0);
    
    return testUserData;
  }
  
  // Vérifier le cache d'abord
  const cacheKey = cacheUtils.apiKeyKey(apiKey);
  let cachedData = apiKeysCache.get(cacheKey);
  
  if (cachedData) {
    console.log('✅ Found cached API key data');
    return {
      user: cachedData.user,
      apiKey: cachedData.apiKey,
      authMethod: 'api_key'
    };
  }
  
  console.log('🔍 Querying database for API key...');
  
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
  
  console.log('📊 Database response:', { data, error });
  
  if (error || !data) {
    console.log('❌ API key not found or invalid');
    throw new Error('Invalid API key');
  }
  
  const userData = {
    user: {
      id: data.user_id,
      balance: data.wallet.balance
    },
    apiKey: {
      id: data.id,
      name: data.api_key_name,
      key: data.api_key
    },
    authMethod: 'api_key'
  };
  
  // Mettre en cache
  apiKeysCache.set(cacheKey, userData);
  
  // Mettre en cache la balance aussi
  balanceCache.set(cacheUtils.balanceKey(data.user_id), data.wallet.balance);
  
  return userData;
}

/**
 * Authentification par token Supabase
 */
async function authenticateWithSupabaseToken(token) {
  // Vérifier le token avec Supabase Auth
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  
  if (error || !user) {
    throw new Error('Invalid Supabase token');
  }
  
  // Récupérer les infos du wallet
  const { data: walletData, error: walletError } = await supabase
    .from('wallet')
    .select('balance')
    .eq('user_id', user.id)
    .single();
  
  if (walletError) {
    throw new Error('User wallet not found');
  }
  
  // Mettre en cache la balance
  balanceCache.set(cacheUtils.balanceKey(user.id), walletData.balance);
  
  return {
    user: {
      id: user.id,
      email: user.email,
      balance: walletData.balance
    },
    apiKey: null,
    authMethod: 'supabase_token'
  };
}

/**
 * Vérifie si l'utilisateur a suffisamment de fonds
 * @param {string} userId 
 * @returns {Promise<number>} balance
 */
export async function checkUserBalance(userId) {
  // Vérifier le cache d'abord
  const cacheKey = cacheUtils.balanceKey(userId);
  let balance = balanceCache.get(cacheKey);
  
  if (balance !== undefined) {
    // Si la balance est >= 1, le cache reste valide
    // Sinon, on re-vérifie pour éviter de donner des crédits inexistants
    if (balance >= 1) {
      return balance;
    }
  }
  
  // Récupérer la balance depuis la DB
  const { data, error } = await supabase
    .from('wallet')
    .select('balance')
    .eq('user_id', userId)
    .single();
  
  if (error) {
    throw new Error('Failed to fetch user balance');
  }
  
  balance = parseFloat(data.balance);
  
  // Mettre en cache
  balanceCache.set(cacheKey, balance);
  
  return balance;
}

/**
 * Middleware d'authentification et vérification des fonds pour Hono
 */
export const authMiddleware = async (c, next) => {
  try {
    // 1. Authentification
    const authData = await authenticateUser(c);
    
    // 2. Vérification des fonds
    const balance = await checkUserBalance(authData.user.id);
    
    if (balance < dbConfig.minimalFund) {
      return c.json({
        error: 'Insufficient funds',
        required: dbConfig.minimalFund,
        current: balance
      }, 402);
    }
    
    // Ajouter les données d'auth au contexte
    c.set('auth', authData);
    c.set('balance', balance);
    
    await next();
  } catch (error) {
    console.error('Authentication error:', error);
    return c.json({
      error: 'Authentication failed',
      message: error.message
    }, 401);
  }
};

/**
 * Met à jour le timestamp last_used_at d'une clé API (asynchrone)
 */
export async function updateApiKeyUsage(userId, apiKeyName) {
  if (!apiKeyName) return;
  
  // Exécution asynchrone sans attendre
  setImmediate(async () => {
    try {
      await supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('api_key_name', apiKeyName);
    } catch (error) {
      console.error('Failed to update API key usage:', error);
    }
  });
}
