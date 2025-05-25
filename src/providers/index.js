import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

// Registry des providers disponibles
const providers = new Map();

// Initialiser les providers
function initializeProviders() {
  // OpenAI
  providers.set('openai', new OpenAIProvider());
  
  // Anthropic
  providers.set('anthropic', new AnthropicProvider());
  
  // TODO: Ajouter d'autres providers
  // providers.set('google', new GoogleProvider());
  // providers.set('meta', new MetaProvider());
  // providers.set('azure', new AzureProvider());
  // providers.set('aws', new AWSProvider());
}

// Initialiser au démarrage
initializeProviders();

/**
 * Récupère un provider par son nom
 * @param {string} providerName 
 * @returns {BaseProvider}
 */
export function getProvider(providerName) {
  const provider = providers.get(providerName.toLowerCase());
  if (!provider) {
    throw new Error(`Provider ${providerName} not found`);
  }
  return provider;
}

/**
 * Vérifie si un provider existe
 * @param {string} providerName 
 * @returns {boolean}
 */
export function hasProvider(providerName) {
  return providers.has(providerName.toLowerCase());
}

/**
 * Retourne la liste de tous les providers disponibles
 * @returns {Array<string>}
 */
export function getAvailableProviders() {
  return Array.from(providers.keys());
}

/**
 * Retourne les informations de santé de tous les providers
 * @returns {Object}
 */
export function getProvidersHealth() {
  const health = {};
  for (const [name, provider] of providers) {
    health[name] = provider.getHealthInfo();
  }
  return health;
}

/**
 * Ajoute ou met à jour un provider
 * @param {string} name 
 * @param {BaseProvider} provider 
 */
export function registerProvider(name, provider) {
  providers.set(name.toLowerCase(), provider);
}

/**
 * Supprime un provider
 * @param {string} name 
 */
export function unregisterProvider(name) {
  providers.delete(name.toLowerCase());
}

// Exporter les classes de providers pour usage externe
export { OpenAIProvider, AnthropicProvider };
export * from './base.js';
