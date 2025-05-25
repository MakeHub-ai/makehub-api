import NodeCache from 'node-cache';
import { dbConfig } from './database.js';

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
  balanceKey: (userId) => `balance:${userId}`,
  
  // Génère une clé de cache pour une clé API
  apiKeyKey: (apiKey) => `apikey:${apiKey}`,
  
  // Génère une clé de cache pour les modèles
  modelsKey: () => 'models:all',
  
  // Génère une clé de cache pour les modèles d'un provider
  providerModelsKey: (provider) => `models:${provider}`,
  
  // Invalide le cache de balance d'un utilisateur
  invalidateBalance: (userId) => {
    balanceCache.del(cacheUtils.balanceKey(userId));
  },
  
  // Invalide le cache d'une clé API
  invalidateApiKey: (apiKey) => {
    apiKeysCache.del(cacheUtils.apiKeyKey(apiKey));
  },
  
  // Invalide tous les caches de modèles
  invalidateModels: () => {
    modelsCache.flushAll();
  }
};

// Événements de cache pour le debugging
if (process.env.NODE_ENV === 'development') {
  cache.on('set', (key, value) => {
    console.log(`Cache SET: ${key}`);
  });
  
  cache.on('del', (key, value) => {
    console.log(`Cache DEL: ${key}`);
  });
  
  cache.on('expired', (key, value) => {
    console.log(`Cache EXPIRED: ${key}`);
  });
}
