import { supabase } from '../config/database.js';
import { modelsCache, cacheUtils } from '../config/cache.js';
import type { 
  Model, 
  StandardRequest, 
  ProviderCombination,
  UserPreferences
} from '../types/index.js';

/**
 * Récupère tous les modèles disponibles
 * @returns Liste des modèles
 */
export async function getAllModels(): Promise<Model[]> {
  const cacheKey = cacheUtils.modelsKey();
  let models = cacheUtils.getAllModels();
  
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
  
  if (!data) {
    throw new Error('No models data returned from database');
  }
  
  cacheUtils.setAllModels(data);
  return data;
}

/**
 * Récupère les modèles d'un provider spécifique
 * @param provider - Nom du provider
 * @returns Liste des modèles du provider
 */
export async function getModelsByProvider(provider: string): Promise<Model[]> {
  if (!provider || typeof provider !== 'string') {
    throw new Error('Provider name is required and must be a string');
  }

  const cachedModels = cacheUtils.getProviderModels(provider);
  
  if (cachedModels) {
    return cachedModels;
  }
  
  const { data, error } = await supabase
    .from('models')
    .select('*')
    .eq('provider', provider)
    .order('model_id', { ascending: true });
  
  if (error) {
    throw new Error(`Failed to fetch models for provider ${provider}: ${error.message}`);
  }
  
  const models = data || [];
  cacheUtils.setProviderModels(provider, models);
  return models;
}

/**
 * Récupère un modèle spécifique par son ID
 * @param modelId - ID du modèle
 * @returns Modèle trouvé
 */
export async function getModelById(modelId: string): Promise<Model> {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('Model ID is required and must be a string');
  }

  const allModels = await getAllModels();
  const model = allModels.find(m => m.model_id === modelId);
  
  if (!model) {
    throw new Error(`Model ${modelId} not found`);
  }
  
  return model;
}

/**
 * Récupère un modèle par son ID de provider
 * @param providerModelId - ID du modèle chez le provider
 * @returns Modèle trouvé
 */
export async function getModelByProviderModelId(providerModelId: string): Promise<Model | null> {
  if (!providerModelId || typeof providerModelId !== 'string') {
    return null;
  }

  const allModels = await getAllModels();
  return allModels.find(m => m.provider_model_id === providerModelId) || null;
}

/**
 * Interface pour les options de filtrage
 */
interface FilterOptions {
  requireToolCalling?: boolean;
  requireVision?: boolean;
  maxCostPerToken?: number;
  providers?: string[];
}

/**
 * Filtre les providers/modèles selon la requête
 * Cette fonction implémente la logique de sélection des combinaisons model/provider
 * @param request - Requête standardisée
 * @param userPreferences - Préférences utilisateur (optionnel)
 * @param filterOptions - Options de filtrage supplémentaires
 * @returns Liste des combinaisons {model, provider} triées par priorité
 */
export async function filterProviders(
  request: StandardRequest, 
  userPreferences: UserPreferences = {},
  filterOptions: FilterOptions = {}
): Promise<ProviderCombination[]> {
  const { model: requestedModel, stream = false, tools = null } = request;
  
  // Récupérer tous les modèles
  const allModels = await getAllModels();
  
  // Filtrer selon les critères
  let availableModels = allModels.filter(model => {
    // Si un modèle spécifique est demandé, il doit correspondre soit à model_id soit à provider_model_id
    if (requestedModel && typeof requestedModel === 'string') {
      if (model.model_id !== requestedModel && model.provider_model_id !== requestedModel) {
        return false;
      }
    }
    
    // Check tool calling support
    if ((tools && tools.length > 0) || filterOptions.requireToolCalling) {
      if (!model.support_tool_calling) {
        return false;
      }
    }

    // Check vision support if image content exists
    const hasImages = request.messages?.some(m => 
      Array.isArray(m.content) && m.content.some(item => item.type === 'image_url')
    );

    if (hasImages || filterOptions.requireVision) {
      if (!modelSupportsFeature(model, 'vision')) {
        return false;
      }
    }

    // Filter by cost if specified
    if (filterOptions.maxCostPerToken) {
      const avgCost = (model.price_per_input_token + model.price_per_output_token) / 2;
      if (avgCost > filterOptions.maxCostPerToken) {
        return false;
      }
    }

    // Filter by providers if specified
    if (filterOptions.providers && filterOptions.providers.length > 0) {
      if (!filterOptions.providers.includes(model.provider)) {
        return false;
      }
    }
    
    return true;
  });
  
  // If after filtering, no models are available
  if (availableModels.length === 0) {
    // If a specific model was requested, it means it didn't match or wasn't found
    if (requestedModel && typeof requestedModel === 'string') {
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
    if (userPreferences.preferredProviders && userPreferences.preferredProviders.length > 0) {
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
    ApiKeyName: model.api_key_name, // Ajouter la clé API
    adapter: model.adapter,
    supportsToolCalling: model.support_tool_calling,
    supportsVision: modelSupportsFeature(model, 'vision'), // Explicitly add this
    contextWindow: model.context_window || 0,
    pricing: {
      inputToken: model.price_per_input_token,
      outputToken: model.price_per_output_token
    },
    extraParams: model.extra_param || {}
  }));
}

/**
 * Estime le coût d'une requête
 * @param request - Requête standardisée
 * @param model - Modèle sélectionné ou combination
 * @returns Coût estimé en USD
 */
export function estimateRequestCost(
  request: StandardRequest, 
  model: Model | ProviderCombination
): number {
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
        if (item.type === 'text' && item.text) {
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
  
  // Calculer le coût selon le type de modèle
  let inputPricing: number;
  let outputPricing: number;
  
  if ('pricing' in model) {
    // C'est une ProviderCombination
    inputPricing = model.pricing.inputToken;
    outputPricing = model.pricing.outputToken;
  } else {
    // C'est un Model
    inputPricing = model.price_per_input_token;
    outputPricing = model.price_per_output_token;
  }
  
  const inputCost = (estimatedInputTokens * inputPricing) / 1000; // Prix par 1000 tokens
  const outputCost = (estimatedOutputTokens * outputPricing) / 1000;
  
  return parseFloat((inputCost + outputCost).toFixed(6));
}

/**
 * Types pour les fonctionnalités supportées
 */
type ModelFeature = 'tool_calling' | 'streaming' | 'vision' | 'function_calling';

/**
 * Vérifie si un modèle supporte une fonctionnalité
 * @param model - Modèle à vérifier
 * @param feature - Fonctionnalité à vérifier
 * @returns true si le modèle supporte la fonctionnalité
 */
export function modelSupportsFeature(model: Model, feature: ModelFeature): boolean {
  switch (feature) {
    case 'tool_calling':
    case 'function_calling':
      return model.support_tool_calling;
    case 'streaming':
      return true; // Tous les modèles supportent le streaming via nos adapters
    case 'vision':
      // À implémenter selon les capacités des modèles
      const visionModels = [
        'gpt-4o', 
        'gpt-4o-mini', 
        'gpt-4-vision-preview',
        'claude-3-5-sonnet',
        'claude-3-sonnet', 
        'claude-3-haiku',
        'gemini-1.5-pro',
        'gemini-1.5-flash'
      ];
      return model.model_id.includes('vision') || 
             visionModels.some(vm => model.model_id.includes(vm));
    default:
      return false;
  }
}

/**
 * Récupère les statistiques des modèles
 * @returns Statistiques des modèles
 */
export async function getModelStats(): Promise<{
  totalModels: number;
  providerCounts: Record<string, number>;
  featuresSupport: {
    toolCalling: number;
    vision: number;
    streaming: number;
  };
  avgPricing: {
    inputToken: number;
    outputToken: number;
  };
}> {
  const allModels = await getAllModels();
  
  const providerCounts: Record<string, number> = {};
  let totalToolCalling = 0;
  let totalVision = 0;
  let totalInputPricing = 0;
  let totalOutputPricing = 0;
  
  allModels.forEach(model => {
    // Count by provider
    providerCounts[model.provider] = (providerCounts[model.provider] || 0) + 1;
    
    // Count features
    if (model.support_tool_calling) totalToolCalling++;
    if (modelSupportsFeature(model, 'vision')) totalVision++;
    
    // Sum pricing
    totalInputPricing += model.price_per_input_token;
    totalOutputPricing += model.price_per_output_token;
  });
  
  return {
    totalModels: allModels.length,
    providerCounts,
    featuresSupport: {
      toolCalling: totalToolCalling,
      vision: totalVision,
      streaming: allModels.length // Tous supportent le streaming
    },
    avgPricing: {
      inputToken: allModels.length > 0 ? totalInputPricing / allModels.length : 0,
      outputToken: allModels.length > 0 ? totalOutputPricing / allModels.length : 0
    }
  };
}

/**
 * Invalide le cache des modèles
 */
export function invalidateModelsCache(): void {
  cacheUtils.invalidateModels();
}

/**
 * Recherche des modèles par critères
 * @param query - Critères de recherche
 * @returns Modèles correspondants
 */
export async function searchModels(query: {
  name?: string;
  provider?: string;
  supportsToolCalling?: boolean;
  supportsVision?: boolean;
  maxPricePerInputToken?: number;
  maxPricePerOutputToken?: number;
  minContextWindow?: number;
}): Promise<Model[]> {
  const allModels = await getAllModels();
  
  return allModels.filter(model => {
    if (query.name && !model.model_id.toLowerCase().includes(query.name.toLowerCase())) {
      return false;
    }
    
    if (query.provider && model.provider !== query.provider) {
      return false;
    }
    
    if (query.supportsToolCalling !== undefined && model.support_tool_calling !== query.supportsToolCalling) {
      return false;
    }
    
    if (query.supportsVision !== undefined && modelSupportsFeature(model, 'vision') !== query.supportsVision) {
      return false;
    }
    
    if (query.maxPricePerInputToken !== undefined && model.price_per_input_token > query.maxPricePerInputToken) {
      return false;
    }
    
    if (query.maxPricePerOutputToken !== undefined && model.price_per_output_token > query.maxPricePerOutputToken) {
      return false;
    }
    
    if (query.minContextWindow !== undefined && (model.context_window || 0) < query.minContextWindow) {
      return false;
    }
    
    return true;
  });
}