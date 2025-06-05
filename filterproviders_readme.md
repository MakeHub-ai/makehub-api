# 🎯 FilterProviders - Système de Sélection Intelligente des Providers

## 📖 Vue d'ensemble

Le système `filterProviders` est un algorithme sophistiqué de sélection automatique des providers LLM basé sur un **scoring vectoriel 3D** combinant prix, performance et historique utilisateur. Il optimise automatiquement le choix entre plusieurs providers offrant le même modèle.

### 🎪 Principe de base

```
Requête utilisateur: "Je veux gpt-4o avec un ratio speed/price de 80%"
                     ↓
┌─────────────────────────────────────────────────────────────────┐
│  🔍 Filtrage des providers offrant "gpt-4o"                    │
│  • Provider A: OpenAI direct                                   │
│  • Provider B: Azure OpenAI                                    │
│  • Provider C: Together AI                                     │
└─────────────────────────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────────┐
│  📊 Analyse vectorielle 3D pour chaque provider               │
│  • Dimension 1: Prix ($/1k tokens)                            │
│  • Dimension 2: Throughput (tokens/seconde)                   │
│  • Dimension 3: Latence (millisecondes)                       │
└─────────────────────────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────────┐
│  🎯 Calcul du score optimal selon ratio_sp=80%                │
│  • Point optimal: Prix=20%, Performance=80%                   │
│  • Distance euclidienne de chaque provider au point optimal   │
└─────────────────────────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────────┐
│  🚀 Boost caching + Tri final                                 │
│  • Providers avec historique caching: score × 0.5            │
│  • Tri par score croissant (meilleur score = plus proche)     │
└─────────────────────────────────────────────────────────────────┘
                     ↓
        Provider sélectionné avec justification
```

---

## 🧮 Algorithme de Scoring Vectoriel 3D

### 📐 Les 3 Dimensions

1. **💰 Prix** (Dimension économique)
   - Somme `price_per_input_token + price_per_output_token`
   - Normalisé 0-1 (0 = moins cher, 1 = plus cher)

2. **⚡ Throughput** (Dimension performance)
   - Médiane des `throughput_tokens_s` des N dernières requêtes
   - Normalisé 0-1 (0 = plus lent, 1 = plus rapide)

3. **🕐 Latence** (Dimension réactivité)  
   - Médiane des `time_to_first_chunk` des N dernières requêtes
   - Normalisé 0-1 inversé (0 = plus lent, 1 = plus rapide)

### 🎯 Point Optimal selon ratio_sp

Le paramètre `ratio_sp` (0-100) définit l'équilibre souhaité :

```typescript
const ratioNormalized = ratio_sp / 100;  // 0.0 à 1.0

// Points optimaux dans l'espace 3D
const optimalPrice = 1 - ratioNormalized;      // Plus ratio_sp ↑, moins le prix compte
const optimalThroughput = ratioNormalized;     // Plus ratio_sp ↑, plus le throughput compte  
const optimalLatency = ratioNormalized;        // Plus ratio_sp ↑, plus la latence compte
```

**Exemples de points optimaux :**

| ratio_sp | Priorité | Point Optimal | Description |
|----------|----------|---------------|-------------|
| 0 | 💰 Prix | (1.0, 0.0, 0.0) | Prix minimal, performance secondaire |
| 50 | ⚖️ Équilibré | (0.5, 0.5, 0.5) | Compromis équilibré |
| 100 | ⚡ Performance | (0.0, 1.0, 1.0) | Performance maximale, prix secondaire |

### 📏 Calcul de la Distance

```typescript
// Distance euclidienne 3D de chaque provider au point optimal
const distance = Math.sqrt(
  Math.pow(normalizedPrice - optimalPrice, 2) +
  Math.pow(normalizedThroughput - optimalThroughput, 2) +
  Math.pow(normalizedLatency - optimalLatency, 2)
);

// Score final (plus bas = meilleur)
const finalScore = hasCaching ? distance * 0.5 : distance;
```

---

## 🚀 Logique de Caching Priority

### 🔍 Détection du Caching

Le système analyse les **5 dernières requêtes** de l'utilisateur pour chaque couple `(model_id, provider)` :

```sql
SELECT cached_tokens FROM requests 
WHERE user_id = ? AND model = ? AND provider = ?
  AND cached_tokens > 0
ORDER BY created_at DESC 
LIMIT 5
```

**Si des `cached_tokens > 0` sont trouvés** → `cachingBoost = true`

### 🎁 Boost du Score

Les providers avec historique de caching reçoivent un **boost de 50%** :

```typescript
// Provider avec caching détecté
finalScore = distance * 0.5  // Score divisé par 2 = meilleur classement

// Provider sans caching
finalScore = distance  // Score normal
```

**Exemple concret :**

```
Provider A (Azure): distance=0.4, pas de caching → score=0.4
Provider B (OpenAI): distance=0.6, avec caching → score=0.3
→ Provider B sélectionné grâce au caching bonus !
```

---

## ⚡ Optimisations SQL

### 🔄 Requêtes Batch

Au lieu de N requêtes séparées, le système utilise **2 requêtes optimisées** :

#### 1. Métriques de Performance (Batch)

```sql
-- Récupère toutes les métriques en une fois
SELECT provider,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY throughput_tokens_s) as throughput_median,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_to_first_chunk) as latency_median,
       COUNT(*) as sample_count
FROM metrics m
JOIN requests r ON m.request_id = r.request_id  
WHERE r.model = 'gpt-4o' 
  AND r.provider IN ('openai', 'azure', 'together')
  AND m.throughput_tokens_s IS NOT NULL
GROUP BY provider
```

#### 2. Historique de Caching (Batch)

```sql
-- Récupère l'historique de caching pour tous les providers
SELECT provider, cached_tokens
FROM requests 
WHERE user_id = ? AND model = 'gpt-4o'
  AND provider IN ('openai', 'azure', 'together')
  AND cached_tokens > 0
ORDER BY created_at DESC
LIMIT 15  -- 5 par provider max
```

### 📈 Gains de Performance

| Méthode | Nombre de requêtes | Temps estimé |
|---------|-------------------|--------------|
| **Avant** (séquentiel) | 2N (N providers) | ~200ms pour 3 providers |
| **Après** (batch) | 2 requêtes fixes | ~50ms constant |
| **Avec fonction SQL** | 1 requête | ~20ms optimal |

---

## 🛠️ Guide d'Utilisation

### 📝 Signature de la Fonction

```typescript
async function filterProviders(
  request: StandardRequest,      // DOIT contenir un model_id
  userId: string,               // Pour l'historique de caching
  userPreferences?: UserPreferences,
  filterOptions?: FilterOptions
): Promise<ProviderCombination[]>
```

### 🎛️ Paramètres de Configuration

```typescript
interface FilterOptions {
  ratio_sp?: number;           // 0-100, défaut: 50
  metricsWindowSize?: number;  // Défaut: 10 dernières métriques
  requireToolCalling?: boolean;
  requireVision?: boolean;
  maxCostPerToken?: number;
}
```

### 💡 Exemples d'Usage

#### Exemple 1: Optimisation Prix
```typescript
const combinations = await filterProviders(
  {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }]
  },
  "user-123",
  {},
  { ratio_sp: 10 }  // 90% prix, 10% performance
);
// → Sélectionne le provider le moins cher
```

#### Exemple 2: Optimisation Performance
```typescript
const combinations = await filterProviders(
  {
    model: "claude-3-sonnet",
    messages: [{ role: "user", content: "Urgent task" }]
  },
  "user-456", 
  {},
  { ratio_sp: 90 }  // 10% prix, 90% performance
);
// → Sélectionne le provider le plus rapide
```

#### Exemple 3: Équilibré avec Tools
```typescript
const combinations = await filterProviders(
  {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Calculate 2+2" }],
    tools: [{ type: "function", function: { name: "calculator" } }]
  },
  "user-789",
  {},
  { 
    ratio_sp: 50,  // Équilibré
    requireToolCalling: true 
  }
);
// → Filtre d'abord par support tools, puis optimise
```

---

## 🔧 Filtres de Compatibilité

### ✅ Filtres Stricts (Exclusion complète)

1. **Model ID Match**
   ```typescript
   model.model_id === requestedModel || model.provider_model_id === requestedModel
   ```

2. **Tool Calling Support**
   ```typescript
   if (hasTools && !model.support_tool_calling) return false;
   ```

3. **Vision Support** (depuis la DB uniquement)
   ```typescript
   if (hasImages && !model.support_vision) return false;
   ```

4. **Context Window** (strict)
   ```typescript
   const totalTokens = estimateTokensFromRequest(request);
   if (model.context_window && totalTokens > model.context_window) return false;
   ```

### ⚠️ Comportement en cas d'aucun provider compatible

```typescript
if (availableModels.length === 0) {
  throw new Error(`No providers found for model_id: ${requestedModel}, or model incompatible with request requirements`);
}
```

---

## 📊 Métriques et Monitoring

### 🔍 Logs de Debug

La fonction produit des logs détaillés :

```
🎯 Filtering providers for model_id: gpt-4o
📊 Found 3 providers for model_id: gpt-4o
   - openai (https://api.openai.com/v1)
   - azure-openai (https://xxx.openai.azure.com)
   - together (https://api.together.xyz/v1)

🏆 Provider ranking for gpt-4o:
   1. azure-openai (score: 0.234 + CACHE) - T:45.2 L:180ms
   2. openai (score: 0.456) - T:38.1 L:220ms  
   3. together (score: 0.678) - T:52.3 L:350ms
```

### 📈 Données de Performance Collectées

```typescript
interface ModelPerformanceMetrics {
  throughput_median: number | null;  // tokens/seconde
  latency_median: number | null;     // millisecondes
  sample_count: number;              // nombre de mesures
}
```

---

## ⚙️ Configuration Avancée

### 🎯 Tuning du ratio_sp selon les Use Cases

| Use Case | ratio_sp recommandé | Justification |
|----------|-------------------|---------------|
| **Chatbot production** | 20-30 | Coût maîtrisé, performance suffisante |
| **Aide en temps réel** | 70-80 | Réactivité primordiale |
| **Analyse batch** | 10 | Volume élevé, coût critique |
| **Démo/prototype** | 50 | Équilibre pour tests |
| **Gaming/interactif** | 90 | Latence ultra-faible |

### 🔧 Personnalisation par Utilisateur

```typescript
interface UserPreferences {
  preferredProviders?: string[];    // Providers favoris
  maxCostPerRequest?: number;       // Budget max
  defaultRatioSp?: number;         // ratio_sp par défaut
}
```

### 🚨 Gestion d'Erreurs

```typescript
try {
  const providers = await filterProviders(request, userId, prefs, options);
} catch (error) {
  if (error.message.includes('No providers found')) {
    // Aucun provider compatible
    // → Fallback ou erreur user-friendly
  }
  if (error.message.includes('model_id is required')) {
    // model_id manquant dans la requête
    // → Erreur de validation
  }
}
```

---

## 🎨 Diagramme d'Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    filterProviders()                           │
└─────────────────────────┬───────────────────────────────────────┘
                         │
         ┌───────────────┴───────────────┐
         │                               │
         ▼                               ▼
┌─────────────────┐              ┌─────────────────┐
│   📊 Metrics    │              │   🚀 Caching    │
│   Analysis      │              │   Detection     │
├─────────────────┤              ├─────────────────┤
│• Throughput     │              │• User History   │
│• Latency        │              │• 5 Last Reqs    │
│• Sample Count   │              │• cached_tokens  │
└─────────────────┘              └─────────────────┘
         │                               │
         └───────────────┬───────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                 🎯 Vector Scoring 3D                           │
├─────────────────────────────────────────────────────────────────┤
│  Price(0-1) ◄────┐     ┌────► Throughput(0-1)                 │
│                   │     │                                      │
│                   │     │                                      │
│              ┌────┴─────┴────┐                                 │
│              │  ratio_sp     │                                 │
│              │  Optimal Point│                                 │
│              └────┬─────┬────┘                                 │
│                   │     │                                      │
│                   │     │                                      │
│  Latency(0-1) ◄───┘     └────► Euclidean Distance              │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│               🏆 Final Ranking                                 │
├─────────────────────────────────────────────────────────────────┤
│  1. Sort by caching boost (priority)                          │
│  2. Sort by vector score (ascending)                          │
│  3. Return ProviderCombination[]                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Roadmap & Améliorations

### 🔮 Fonctionnalités Futures

1. **Machine Learning** : Prédiction des performances basée sur l'historique
2. **Géolocalisation** : Optimisation selon la région utilisateur  
3. **Load Balancing** : Distribution intelligente de la charge
4. **A/B Testing** : Comparaison automatique des providers
5. **Real-time Metrics** : Métriques temps réel via WebSocket

### 🎯 Optimisations Techniques

1. **Cache Redis** : Mise en cache des scores calculés
2. **Fonction SQL native** : Calcul vectoriel en base
3. **Streaming metrics** : Collecte de métriques en temps réel
4. **Parallel scoring** : Calcul parallèle des scores

---

## 📚 Références

- [Types TypeScript](../types/requests.ts) - Interfaces et types utilisés
- [Base adapter](../adapters/base.ts) - Logique des adapters
- [Request handler](../services/request-handler.ts) - Gestion des requêtes
- [Cache system](../config/cache.ts) - Système de cache

---

**🏆 Le système `filterProviders` représente l'état de l'art en matière de sélection intelligente de providers LLM, combinant performance, coût et expérience utilisateur dans un algorithme de scoring vectoriel sophistiqué.**