import { supabase } from '../config/database.js';
import { modelsCache, cacheUtils } from '../config/cache.js';

/**
 * Récupère tous les modèles disponibles
 * @returns {Promise<Array>} Liste des modèles
 */
export async function getAllModels() {
  const cacheKey = cacheUtils.modelsKey();
  let models = modelsCache.get(cacheKey);
  
  if (models) {
    return models;
  }
  
  const { data, error } = await supabase
    .from('models')
    .select('*')
    .order('provider', { ascending: true });
  
  if (error) {
    throw new Error(`Failed to fetch models: ${error.message}`);
  }
  
  modelsCache.set(cacheKey, data);
  return data;
}

/**
 * Récupère les modèles d'un provider spécifique
 * @param {string} provider 
 * @returns {Promise<Array>} Liste des modèles du provider
 */
export async function getModelsByProvider(provider) {
  const cacheKey = cacheUtils.providerModelsKey(provider);
  let models = modelsCache.get(cacheKey);
  
  if (models) {
    return models;
  }
  
  const { data, error } = await supabase
    .from('models')
    .select('*')
    .eq('provider', provider)
    .order('model_id', { ascending: true });
  
  if (error) {
    throw new Error(`Failed to fetch models for provider ${provider}: ${error.message}`);
  }
  
  modelsCache.set(cacheKey, data);
  return data;
}

/**
 * Récupère un modèle spécifique par son ID
 * @param {string} modelId 
 * @returns {Promise<Object>} Modèle
 */
export async function getModelById(modelId) {
  const allModels = await getAllModels();
  const model = allModels.find(m => m.model_id === modelId);
  
  if (!model) {
    throw new Error(`Model ${modelId} not found`);
  }
  
  return model;
}

/**
 * Filtre les providers/modèles selon la requête
 * Cette fonction implémente la logique de sélection des combinaisons model/provider
 * @param {Object} request - Requête standardisée
 * @param {Object} userPreferences - Préférences utilisateur (optionnel)
 * @returns {Promise<Array>} Liste des combinaisons {model, provider} triées par priorité
 */
export async function filterProviders(request, userPreferences = {}) {
  const { model: requestedModel, stream = false, tools = null } = request;
  
  // Récupérer tous les modèles
  const allModels = await getAllModels();
  
  // Filtrer selon les critères
  let availableModels = allModels.filter(model => {
    // Si un modèle spécifique est demandé, il doit correspondre soit à model_id soit à provider_model_id
    if (requestedModel) {
      if (model.model_id !== requestedModel && model.provider_model_id !== requestedModel) {
        return false;
      }
    }
    
    // Check tool calling support
    if (tools && tools.length > 0 && !model.support_tool_calling) {
      return false;
    }

    // Check vision support if image content exists
    const hasImages = request.messages?.some(m => 
      Array.isArray(m.content) && m.content.some(({ type }) => type === 'image_url')
    );

    if (hasImages && !modelSupportsFeature(model, 'vision')) {
      return false;
    }
    
    return true;
  });
  
  // If after filtering, no models are available
  if (availableModels.length === 0) {
    // If a specific model was requested, it means it didn't match or wasn't found
    if (requestedModel) {
      throw new Error(`No compatible (or available) model found for: ${requestedModel}`);
    } else {
      // If no specific model was requested (e.g. fallback scenario), try to find *any* model marked as fallback
      const fallbackModels = allModels.filter(m => m.is_fallback);
      if (fallbackModels.length > 0) {
        availableModels = fallbackModels; // Use these fallback models
      } else {
        // If still no models, then truly no compatible models are available
        throw new Error('No compatible models found for this request, and no fallback models are configured.');
      }
    }
  }
  
  // Trier par priorité (peut être personnalisé selon les préférences utilisateur)
  availableModels.sort((a, b) => {
    // Priorité 1: Préférences utilisateur
    if (userPreferences.preferredProviders) {
      const aProviderPriority = userPreferences.preferredProviders.indexOf(a.provider);
      const bProviderPriority = userPreferences.preferredProviders.indexOf(b.provider);
      
      if (aProviderPriority !== -1 && bProviderPriority !== -1) {
        return aProviderPriority - bProviderPriority;
      }
      if (aProviderPriority !== -1) return -1;
      if (bProviderPriority !== -1) return 1;
    }
    
    // Priorité 2: Coût (moins cher en premier)
    const aCost = a.price_per_input_token + a.price_per_output_token;
    const bCost = b.price_per_input_token + b.price_per_output_token;
    
    if (aCost !== bCost) {
      return aCost - bCost;
    }
    
    // Priorité 3: Taille de contexte (plus grand en premier)
    return (b.context_window || 0) - (a.context_window || 0);
  });
  
  // Retourner les combinaisons model/provider
  return availableModels.map(model => ({
    model: model,
    provider: model.provider,
    modelId: model.model_id, // This is the gateway's internal ID for the model
    providerModelId: model.provider_model_id, // This is the ID the provider API expects
    baseUrl: model.base_url,
    supportsToolCalling: model.support_tool_calling,
    supportsVision: modelSupportsFeature(model, 'vision'), // Explicitly add this
    contextWindow: model.context_window,
    pricing: {
      inputToken: model.price_per_input_token,
      outputToken: model.price_per_output_token
    },
    extraParams: model.extra_param || {}
  }));
}

/**
 * Estime le coût d'une requête
 * @param {Object} request - Requête standardisée
 * @param {Object} model - Modèle sélectionné
 * @returns {number} Coût estimé en USD
 */
export function estimateRequestCost(request, model) {
  // Estimation basique basée sur la longueur du texte
  // Dans un vrai système, on utiliserait un tokenizer approprié
  
  const messages = request.messages || [];
  let estimatedInputTokens = 0;
  
  // Estimer les tokens d'entrée
  messages.forEach(message => {
    if (typeof message.content === 'string') {
      // Estimation approximative: 1 token ≈ 4 caractères
      estimatedInputTokens += Math.ceil(message.content.length / 4);
    } else if (Array.isArray(message.content)) {
      // Contenu multimodal (texte + images)
      message.content.forEach(item => {
        if (item.type === 'text') {
          estimatedInputTokens += Math.ceil(item.text.length / 4);
        } else if (item.type === 'image_url') {
          // Coût fixe pour les images (à ajuster selon le provider)
          estimatedInputTokens += 1000;
        }
      });
    }
  });
  
  // Estimer les tokens de sortie (basé sur max_tokens ou valeur par défaut)
  const estimatedOutputTokens = request.max_tokens || 1000;
  
  // Calculer le coût
  const inputCost = estimatedInputTokens * model.pricing.inputToken;
  const outputCost = estimatedOutputTokens * model.pricing.outputToken;
  
  return inputCost + outputCost;
}

/**
 * Vérifie si un modèle supporte une fonctionnalité
 * @param {Object} model 
 * @param {string} feature 
 * @returns {boolean}
 */
export function modelSupportsFeature(model, feature) {
  switch (feature) {
    case 'tool_calling':
      return model.support_tool_calling;
    case 'streaming':
      return true; // Tous les modèles supportent le streaming
    case 'vision':
      // À implémenter selon les capacités des modèles
      return model.model_id.includes('vision') || 
             ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'gemini-1.5-pro'].includes(model.model_id);
    default:
      return false;
  }
}
