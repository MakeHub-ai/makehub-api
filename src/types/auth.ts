/**
 * Types pour l'authentification et les utilisateurs
 */

export interface User {
  id: string;
  email?: string;
  balance: number;
}

export interface ApiKey {
  id: string;
  name: string;
  key: string;
}

export interface AuthData {
  user: User;
  apiKey?: ApiKey;
  authMethod: 'api_key' | 'supabase_token';
  userPreferences?: UserPreferences;
}

export interface UserPreferences {
  preferredProviders?: string[];
  maxCostPerRequest?: number;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}

/**
 * Types pour les variables Hono Context
 * Ajout de la signature d'index pour la compatibilité avec Hono
 */
export interface HonoVariables {
  auth: AuthData;
  balance: number;
  [key: string]: any; // Signature d'index requise par Hono
}

/**
 * Configuration de base de données
 */
export interface DatabaseConfig {
  minimalFund: number;
  cacheTtl: number;
  balanceCacheTtl: number;
}

/**
 * Types pour les clés de cache
 */
export type CacheKey = 
  | `balance:${string}`
  | `apikey:${string}`
  | 'models:all'
  | `models:${string}`;

/**
 * Types pour les réponses d'authentification
 */
export interface AuthResponse {
  success: boolean;
  user?: User;
  error?: string;
}

export interface BalanceCheck {
  sufficient: boolean;
  current: number;
  required: number;
}