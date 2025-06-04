import NodeCache from 'node-cache';
import { dbConfig } from './database.js';
import type { AuthData, CacheKey } from '../types/index.js';

// Cache principal pour les données générales
export const cache = new NodeCache({
  stdTTL: dbConfig.cacheTtl,
  checkperiod: 60,
  useClones: false
});

// Cache spécialisé pour les balances avec TTL plus court
export const balanceCache = new NodeCache({
  stdTTL: dbConfig.balanceCacheTtl,
  checkperiod: 30,
  useClones: false
});

// Cache pour les modèles (TTL plus long car ils changent rarement)
export const modelsCache = new NodeCache({
  stdTTL: 3600, // 1 heure
  checkperiod: 300,
  useClones: false
});

// Cache pour les clés API (TTL moyen)
export const apiKeysCache = new NodeCache({
  stdTTL: 600, // 10 minutes
  checkperiod: 60,
  useClones: false
});

// Utilitaires de cache
export const cacheUtils = {
  // Génère une clé de cache pour la balance d'un utilisateur
  balanceKey: (userId: string): CacheKey => `balance:${userId}`,
  
  // Génère une clé de cache pour une clé API
  apiKeyKey: (apiKey: string): CacheKey => `apikey:${apiKey}`,
  
  // Génère une clé de cache pour les modèles
  modelsKey: (): CacheKey => 'models:all',
  
  // Génère une clé de cache pour les modèles d'un provider
  providerModelsKey: (provider: string): CacheKey => `models:${provider}`,
  
  // Invalide le cache de balance d'un utilisateur
  invalidateBalance: (userId: string): void => {
    balanceCache.del(cacheUtils.balanceKey(userId));
  },
  
  // Invalide le cache d'une clé API
  invalidateApiKey: (apiKey: string): void => {
    apiKeysCache.del(cacheUtils.apiKeyKey(apiKey));
  },
  
  // Invalide tous les caches de modèles
  invalidateModels: (): void => {
    modelsCache.flushAll();
  },

  // Récupère la balance depuis le cache
  getBalance: (userId: string): number | undefined => {
    return balanceCache.get<number>(cacheUtils.balanceKey(userId));
  },

  // Met en cache la balance d'un utilisateur
  setBalance: (userId: string, balance: number): void => {
    balanceCache.set(cacheUtils.balanceKey(userId), balance);
  },

  // Récupère les données d'auth depuis le cache
  getAuthData: (apiKey: string): AuthData | undefined => {
    return apiKeysCache.get<AuthData>(cacheUtils.apiKeyKey(apiKey));
  },

  // Met en cache les données d'auth
  setAuthData: (apiKey: string, authData: AuthData): void => {
    apiKeysCache.set(cacheUtils.apiKeyKey(apiKey), authData);
  },

  // Récupère tous les modèles depuis le cache
  getAllModels: (): any[] | undefined => {
    return modelsCache.get<any[]>(cacheUtils.modelsKey());
  },

  // Met en cache tous les modèles
  setAllModels: (models: any[]): void => {
    modelsCache.set(cacheUtils.modelsKey(), models);
  },

  // Récupère les modèles d'un provider depuis le cache
  getProviderModels: (provider: string): any[] | undefined => {
    return modelsCache.get<any[]>(cacheUtils.providerModelsKey(provider));
  },

  // Met en cache les modèles d'un provider
  setProviderModels: (provider: string, models: any[]): void => {
    modelsCache.set(cacheUtils.providerModelsKey(provider), models);
  }
};

// Interface pour les statistiques de cache
export interface CacheStats {
  keys: number;
  hits: number;
  misses: number;
  hitRate: number;
}

// Fonction pour obtenir les statistiques de tous les caches
export const getCacheStats = (): Record<string, CacheStats> => {
  const getStats = (cache: NodeCache, name: string): CacheStats => {
    const stats = cache.getStats();
    return {
      keys: stats.keys,
      hits: stats.hits,
      misses: stats.misses,
      hitRate: stats.hits / (stats.hits + stats.misses) || 0
    };
  };

  return {
    main: getStats(cache, 'main'),
    balance: getStats(balanceCache, 'balance'),
    models: getStats(modelsCache, 'models'),
    apiKeys: getStats(apiKeysCache, 'apiKeys')
  };
};

// Fonction pour vider tous les caches
export const flushAllCaches = (): void => {
  cache.flushAll();
  balanceCache.flushAll();
  modelsCache.flushAll();
  apiKeysCache.flushAll();
};

// Événements de cache pour le debugging
if (process.env.NODE_ENV === 'development') {
  const logCacheEvent = (cacheName: string, event: string, key: string) => {
  };

  cache.on('set', (key: string, value: any) => {
    logCacheEvent('MAIN', 'SET', key);
  });
  
  cache.on('del', (key: string, value: any) => {
    logCacheEvent('MAIN', 'DEL', key);
  });
  
  cache.on('expired', (key: string, value: any) => {
    logCacheEvent('MAIN', 'EXPIRED', key);
  });

  balanceCache.on('set', (key: string, value: any) => {
    logCacheEvent('BALANCE', 'SET', key);
  });

  modelsCache.on('set', (key: string, value: any) => {
    logCacheEvent('MODELS', 'SET', key);
  });

  apiKeysCache.on('set', (key: string, value: any) => {
    logCacheEvent('APIKEYS', 'SET', key);
  });
}