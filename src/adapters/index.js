import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';

/**
 * Registry des adapters disponibles
 * Chaque adapter peut être utilisé par plusieurs providers
 */
export const adapters = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter
};

/**
 * Crée une instance d'adapter basée sur le type
 * @param {string} adapterType - Type d'adapter (openai, anthropic, etc.)
 * @param {Object} config - Configuration de l'adapter
 * @returns {BaseAdapter} Instance de l'adapter
 */
export function createAdapter(adapterType, config = {}) {
  const AdapterClass = adapters[adapterType];
  
  if (!AdapterClass) {
    throw new Error(`Unknown adapter type: ${adapterType}`);
  }
  
  return new AdapterClass(config);
}

/**
 * Retourne la liste des adapters disponibles
 * @returns {string[]} Liste des types d'adapters
 */
export function getAvailableAdapters() {
  return Object.keys(adapters);
}

/**
 * Vérifie si un adapter est disponible
 * @param {string} adapterType - Type d'adapter
 * @returns {boolean}
 */
export function isAdapterAvailable(adapterType) {
  return adapterType in adapters;
}

// Exports individuels pour faciliter l'import
export { OpenAIAdapter, AnthropicAdapter };
export { BaseAdapter, AdapterError } from './base.js';
