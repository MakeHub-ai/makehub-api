// src/services/family-routing.ts

import { supabase } from '../config/database.js';
import { createAdapter } from '../adapters/index.js';
import type { StandardRequest, FamilyConfig, RoutingResult, ComplexityEvaluation } from '../types/index.js';
import { ta } from 'zod/v4/locales';

export class FamilyRoutingService {
  private readonly memoryCache = new Map<string, { result: RoutingResult; expiresAt: number }>();
  private readonly modelConfigCache = new Map<string, any>();

  /**
   * Vérifie si un model_id correspond à une famille
   */
  async isFamilyModel(modelId: string): Promise<boolean> {
    if (!modelId || typeof modelId !== 'string') {
      return false;
    }

    const { data } = await supabase
      .from('family')
      .select('family_id')
      .eq('family_id', modelId)
      .eq('is_active', true)
      .maybeSingle();
    
    const found = !!data;
    return found;
  }

  /**
   * Récupère la configuration d'une famille
   */
  async getFamilyConfig(familyId: string): Promise<FamilyConfig | null> {
    const { data, error } = await supabase
      .from('family')
      .select('*')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      console.error(`[FamilyRoutingService] getFamilyConfig: not found or error`, error);
      return null;
    }
    return data as FamilyConfig;
  }

  /**
   * Évalue et route une requête famille
   */
  async evaluateAndRoute(
    familyId: string, 
    request: StandardRequest
  ): Promise<RoutingResult> {

    // Compression conditionnelle si champ présent
    if (request.compression === true) {
      if (Array.isArray(request.messages)) {
        request.messages = await this.compressMessages(request.messages);
      }
    }

    // 1. Récupérer la config de la famille
    const config = await this.getFamilyConfig(familyId);
    if (!config) {
      console.error(`[FamilyRoutingService] evaluateAndRoute: Family ${familyId} not found`);
      throw new Error(`Family ${familyId} not found`);
    }


    // 2. Évaluer la complexité
    const evaluation = await this.evaluateComplexity(request, config);

    // 3. Choisir le modèle basé sur le score
    const selectedRange = config.routing_config.score_ranges.find(
      range => evaluation.score >= range.min_score && evaluation.score <= range.max_score
    );

    if (!selectedRange) {
      console.warn(`[FamilyRoutingService] No matching score range for score ${evaluation.score}, using fallback`);
      // Fallback
      const fallbackResult = {
        selectedModel: config.routing_config.fallback_model,
        selectedProvider: config.routing_config.fallback_provider,
        complexityScore: evaluation.score,
        reasoning: 'Fallback - no matching score range',
        evaluationCost: evaluation.cost,
        evaluationTokens: evaluation.tokens.total,
        fromCache: false
      };
      return fallbackResult;
    }

    const result: RoutingResult = {
      selectedModel: selectedRange.target_model,
      selectedProvider: config.routing_config.fallback_provider,
      complexityScore: evaluation.score,
      reasoning: selectedRange.reason,
      evaluationCost: evaluation.cost,
      evaluationTokens: evaluation.tokens.total,
      fromCache: false
    };

    // 4. Mettre en cache (en mémoire seulement)
    const cacheKey = this.hashRequest(request);
    const expiresAt = Date.now() + (config.routing_config.cache_duration_minutes * 60 * 1000);
    this.memoryCache.set(cacheKey, { result, expiresAt });

    console.log(`[FamilyRoutingService] rerouting result for family ${familyId}:`, result.complexityScore, result.selectedModel);
    return result;
  }

  /**
   * Compresse les messages en identifiant ceux qui peuvent être supprimés
   */
  private async compressMessages(messages: any[]): Promise<any[]> {
    if (!messages || messages.length <= 3) {
      return messages; // Ne pas compresser si trop peu de messages
    }

    try {
      // Configuration du modèle de compression (hardcodé)
      const compressionModelId = "mistral/devstral-small-fp8";
      const compressionProvider = "deepinfra";

      // 1. Récupérer la config du modèle de compression avec cache
      const cacheKey = `${compressionModelId}:${compressionProvider}`;
      let model = this.modelConfigCache.get(cacheKey);

      if (!model) {
        const { data, error } = await supabase
          .from('models')
          .select('*')
          .eq('model_id', compressionModelId)
          .eq('provider', compressionProvider)
          .maybeSingle();

        if (error || !data) {
          console.warn(`[FamilyRoutingService] compressMessages: Model not found, skipping compression`);
          return messages;
        }
        model = data;
        this.modelConfigCache.set(cacheKey, model);
      }

      // 2. Construire la config de l'adapter
      let apiKey: string | undefined;
      if (model.api_key_name) {
        apiKey = process.env[model.api_key_name];
      }

      const adapterConfig = {
        apiKey,
        baseURL: model.base_url,
        ...model.extra_param
      };

      // Tronquer les messages si nécessaire
      messages = this.truncateMessages(messages, 10000); // Limite arbitraire

      // 3. Instancier l'adapter
      const adapter = createAdapter(model.adapter, adapterConfig);

      // 4. Numéroter les messages et créer le prompt
      const numberedMessages = messages.map((msg, index) => ({
        number: index + 1,
        role: msg.role,
        content: msg.content
      }));

      const compressionPrompt = `Analyze this conversation and identify which messages can be safely removed without losing important context or breaking the conversation flow.

      **Guidelines:**
      - Keep the first message (usually system prompt)
      - Keep the last 2-3 messages (current context)
      - Remove redundant messages, acknowledgments, or messages that don't add value
      - Keep messages that introduce new topics or contain important information
      - Preserve the logical flow of the conversation

      **Messages:**
      ${numberedMessages.map(msg => `${msg.number}. [${msg.role}]: ${msg.content}`).join('\n')}

      Respond with ONLY the numbers of messages to REMOVE, separated by commas. Examples:
      - "2,4,7" (remove messages 2, 4, and 7)
      - "3-6,9" (remove messages 3 through 6, and message 9)
      - "none" (if no messages should be removed)

      Response:`;

      const compressionRequest: StandardRequest = {
        model: model.provider_model_id,
        messages: [
          {
            role: 'user',
            content: compressionPrompt
          }
        ],
        max_tokens: 50,
        temperature: 0
      };

      // 5. Faire la requête de compression
      const response = await adapter.makeRequest(
        compressionRequest,
        model.provider_model_id,
        false
      );

      if ('data' in response) {
        throw new Error('Unexpected streaming response for compression');
      }

      // 6. Parser la réponse pour identifier les messages à supprimer
      const content = response.choices[0]?.message?.content?.trim().toLowerCase() || 'none';
      
      if (content === 'none' || content === '') {
        return messages;
      }

      const toRemove = new Set<number>();
      
      // Parser les numéros (ex: "1,2,3" ou "1-5,8")
      const parts = content.split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.includes('-')) {
          // Range (ex: "3-6")
          const [start, end] = trimmed.split('-').map(n => parseInt(n));
          if (!isNaN(start) && !isNaN(end)) {
            for (let i = start; i <= end; i++) {
              toRemove.add(i);
            }
          }
        } else {
          // Single number
          const num = parseInt(trimmed);
          if (!isNaN(num)) {
            toRemove.add(num);
          }
        }
      }

      // 7. Filtrer les messages (en gardant les index 0-based)
      const compressedMessages = messages.filter((_, index) => !toRemove.has(index + 1));
      
      console.log(`[FamilyRoutingService] compressMessages: Removed ${messages.length - compressedMessages.length} messages (${Array.from(toRemove).join(',')})`);
      
      return compressedMessages;

    } catch (error) {
      console.error('[FamilyRoutingService] Message compression failed:', error);
      return messages; // Retourner les messages originaux en cas d'erreur
    }
  }

  /**
   * Tronque les messages trop longs pour respecter la limite de tokens
   */
  private truncateMessages(messages: any[], maxTotalTokens: number = 128000): any[] {
    if (!messages || messages.length === 0) return messages;

    // Calculer la limite par message en fonction du nombre de messages
    const maxTokensPerMessage = Math.min(5000, Math.floor(maxTotalTokens / messages.length));
    
    return messages.map(message => {
      if (!message.content || typeof message.content !== 'string') {
        return message;
      }

      const estimatedTokens = this.estimateTokens(message.content);
      
      if (estimatedTokens <= maxTokensPerMessage) {
        return message;
      }

      // Calculer la taille à garder (début + fin)
      const targetLength = Math.floor(maxTokensPerMessage * 4); // Approximation inverse des tokens
      const keepStart = Math.floor(targetLength * 0.6); // 60% du début
      const keepEnd = Math.floor(targetLength * 0.4); // 40% de la fin
      
      const content = message.content;
      const truncatedContent = 
        content.substring(0, keepStart) + 
        '\n\n[... contenu tronqué ...]\n\n' + 
        content.substring(content.length - keepEnd);

      return {
        ...message,
        content: truncatedContent
      };
    });
  }

  /**
   * Évalue la complexité d'une requête (SANS LOGGING EN DB)
   */
  private async evaluateComplexity(
    request: StandardRequest, 
    config: FamilyConfig,
    compress: boolean = true
  ): Promise<ComplexityEvaluation> {
    try {

      // 1. Récupérer la config du modèle d'évaluation depuis la table models avec model_id ET provider, avec cache mémoire
      const cacheKey = `${config.evaluation_model_id}:${config.evaluation_provider}`;
      let model = this.modelConfigCache.get(cacheKey);

      if (!model) {
        const { supabase } = await import('../config/database.js');
        const { data, error } = await supabase
          .from('models')
          .select('*')
          .eq('model_id', config.evaluation_model_id)
          .eq('provider', config.evaluation_provider)
          .maybeSingle();

        if (error || !data) {
          throw new Error(
            `[FamilyRoutingService] evaluateComplexity: Model not found for model_id=${config.evaluation_model_id} and provider=${config.evaluation_provider}`
          );
        }
        model = data;
        this.modelConfigCache.set(cacheKey, model);
      }

      // 2. Construire dynamiquement la config de l'adapter
      let apiKey: string | undefined;
      if (model.api_key_name) {
        apiKey = process.env[model.api_key_name];
      }

      const adapterConfig = {
        apiKey,
        baseURL: model.base_url,
        ...model.extra_param
      };

      // 3. Instancier dynamiquement l'adapter
      const adapter = createAdapter(model.adapter, adapterConfig);

      const evaluationPrompt = `Rate the complexity (1-100) of what the AI assistant is about to do in its response.

      **Analyze the assistant's intended action:**
      - Is it about to analyze/discover/investigate something complex?
      - Is it planning or architecting a solution?
      - Is it implementing something with a clear path forward?
      - Is it applying a fix that was already identified?

      **Context clues from the conversation:**
      - What groundwork exists from previous exchanges?
      - How much cognitive load is needed for the assistant's next step?
      - Is this continuing established analysis or starting fresh investigation?

      **Think like this:** If you were the AI assistant about to respond, how much mental effort would your specific next action require?

      Respond with only a single integer between 1 and 100.`

      // Appliquer la compression puis la troncature des messages
      let processedMessages = request.messages || [];
      
      if (compress) {
        processedMessages = await this.compressMessages(processedMessages);
      }
      
      const truncatedMessages = this.truncateMessages(processedMessages);

      const evaluationRequest: StandardRequest = {
        model: model.provider_model_id,
        messages: [
          {
            role: 'system',
            content: evaluationPrompt
          },
          {
            role: 'user', 
            content: JSON.stringify({
              messages: truncatedMessages,
              tools: request.tools,
              task_indicators: {
                message_count: truncatedMessages.length,
                has_tools: !!(request.tools && request.tools.length > 0),
                total_characters: JSON.stringify(truncatedMessages).length,
                has_system_message: truncatedMessages.some(m => m.role === 'system')
              }
            })
          }
        ],
        max_tokens: 10,
        temperature: 0
      };

      // 5. Faire la requête d'évaluation DIRECTEMENT (sans logging)
      const response = await adapter.makeRequest(
        evaluationRequest, 
        model.provider_model_id,
        false
      );

      if ('data' in response) {
        throw new Error('Unexpected streaming response for evaluation');
      }

      // 6. Extraire le score
      const content = response.choices[0]?.message?.content || '50';
      const score = parseInt(content.trim());
      const finalScore = isNaN(score) ? 50 : Math.max(1, Math.min(100, score));

      // 7. Récupérer le coût réel depuis usage si disponible, sinon fallback sur l'ancien calcul
      let evaluationCost: number;
      let inputTokens: number;
      let outputTokens: number;
      if (response.usage && typeof response.usage.cost === 'number') {
        evaluationCost = response.usage.cost;
        inputTokens = response.usage.prompt_tokens ?? this.estimateTokens(JSON.stringify(evaluationRequest.messages));
        outputTokens = response.usage.completion_tokens ?? 5;
      } else {
        inputTokens = this.estimateTokens(JSON.stringify(evaluationRequest.messages));
        outputTokens = 5;
        evaluationCost = await this.calculateEvaluationCost(
          inputTokens,
          outputTokens,
          config.evaluation_model_id,
          model.provider
        );
      }

      const evalResult = {
        score: finalScore,
        cost: evaluationCost,
        tokens: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens
        }
      };
      return evalResult;

    } catch (error) {
      console.error('[FamilyRoutingService] Evaluation failed:', error);
      // Fallback en cas d'erreur
      return {
        score: 50,
        cost: 0.0001, // Coût minimal par défaut
        tokens: {
          input: 10,
          output: 5,
          total: 15
        }
      };
    }
  }

  /**
   * Calcule le coût d'une évaluation à la volée
   */
  private async calculateEvaluationCost(
    inputTokens: number,
    outputTokens: number,
    modelId: string,
    provider: string
  ): Promise<number> {
    try {
      const { data, error } = await supabase
        .from('models')
        .select('price_per_input_token, price_per_output_token')
        .eq('model_id', modelId)
        .eq('provider', provider)
        .single();

      if (error || !data) {
        console.warn(`[FamilyRoutingService] calculateEvaluationCost: model pricing not found, using default`);
        return 0.0001; // Coût par défaut très faible
      }

      const inputCost = (inputTokens * data.price_per_input_token) / 1000;
      const outputCost = (outputTokens * data.price_per_output_token) / 1000;
      const totalCost = parseFloat((inputCost + outputCost).toFixed(6));
      return totalCost;
    } catch (error) {
      console.error('[FamilyRoutingService] Failed to calculate evaluation cost:', error);
      return 0.0001;
    }
  }

  /**
   * Estime le nombre de tokens d'un texte (approximatif)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4); // Approximation simple
  }

  /**
   * Crée un hash simple du contenu de la requête pour le cache
   */
  private hashRequest(request: StandardRequest): string {
    const content = JSON.stringify({
      messages: request.messages,
      tools: request.tools,
      temperature: request.temperature,
      max_tokens: request.max_tokens
    });
    
    // Hash simple (en production, utiliser crypto)
    return btoa(content).slice(0, 32);
  }

  /**
   * Retourne l'URL de base d'un provider
   */
  private getProviderBaseUrl(provider: string): string {
    const urls: Record<string, string> = {
      'deepinfra': 'https://api.deepinfra.com/v1',
      'openai': 'https://api.openai.com/v1',
      'anthropic': 'https://api.anthropic.com/v1'
    };
    return urls[provider] || 'https://api.deepinfra.com/v1';
  }

  /**
   * Nettoie le cache en mémoire (expire les entrées anciennes)
   */
  public cleanCache(): void {
    const now = Date.now();
    let deleted = 0;
    for (const [key, value] of this.memoryCache.entries()) {
      if (value.expiresAt <= now) {
        this.memoryCache.delete(key);
        deleted++;
      }
    }
  }
}

export const familyRoutingService = new FamilyRoutingService();
