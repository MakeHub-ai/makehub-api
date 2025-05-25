# LLM API Gateway

Une API Gateway robuste pour les modèles de langage (LLM) avec authentification, facturation, fallback automatique et support multi-providers.

## 🚀 Fonctionnalités

- **Multi-providers** : Support d'OpenAI, Anthropic, Google, Meta et plus
- **Authentification flexible** : Clés API personnalisées ou tokens Supabase
- **Fallback automatique** : Basculement transparent entre providers en cas d'erreur
- **Streaming** : Support complet du streaming SSE
- **Tool calling** : Support des appels de fonctions
- **Vision** : Support des images dans les requêtes
- **Cache intelligent** : Mise en cache des données pour optimiser les performances
- **Facturation** : Système de wallet et tracking des coûts
- **Métriques** : Collecte détaillée des performances
- **Notifications** : Alertes automatiques en cas d'erreur

## 📋 Prérequis

- Node.js 18+
- PostgreSQL (via Supabase)
- Clés API des providers LLM

## 🛠️ Installation

1. **Cloner le projet**
```bash
git clone <repository-url>
cd llm-api-gateway
```

2. **Installer les dépendances**
```bash
npm install
```

3. **Configuration**
```bash
cp .env.example .env
```

Éditer le fichier `.env` avec vos configurations :

```env
# Supabase Configuration
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Provider API Keys
API_KEY_OPENAI=your_API_KEY_OPENAI
API_KEY_ANTHROPIC=your_API_KEY_ANTHROPIC
API_KEY_GOOGLE=your_API_KEY_GOOGLE

# Server Configuration
PORT=3000
MINIMAL_FUND=0.01
NTFY_ERROR_URL=https://ntfy.makehub.ai/errors
```

4. **Configurer la base de données**

Exécuter le schéma SQL fourni dans votre instance Supabase pour créer les tables nécessaires.

5. **Démarrer le serveur**
```bash
# Développement
npm run dev

# Production
npm start
```

## 📡 API Endpoints

### Chat Completions
```http
POST /v1/chat/completions
```

Compatible avec l'API OpenAI. Exemples :

**Requête simple :**
```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "user", "content": "Hello, world!"}
  ]
}
```

**Avec streaming :**
```json
{
  "model": "claude-3-5-sonnet",
  "messages": [
    {"role": "user", "content": "Explain quantum computing"}
  ],
  "stream": true
}
```

**Avec tools :**
```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "user", "content": "What's the weather in Paris?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather information",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          }
        }
      }
    }
  ]
}
```

**Avec images :**
```json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "What's in this image?"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
      ]
    }
  ]
}
```

### Autres endpoints

```http
GET /v1/chat/models          # Liste des modèles disponibles
GET /v1/chat/health          # Santé des providers
POST /v1/chat/estimate       # Estimation de coût
GET /health                  # Santé générale du service
```

## 🔐 Authentification

### Méthode 1 : Clé API personnalisée
```http
X-API-Key: your-custom-api-key
```

### Méthode 2 : Token Supabase
```http
Authorization: Bearer your-supabase-jwt-token
```

## 🏗️ Architecture

```
src/
├── config/          # Configuration (DB, cache)
├── middleware/      # Authentification, validation
├── providers/       # Implémentations des providers LLM
├── services/        # Logique métier
├── routes/          # Endpoints API
└── index.js         # Point d'entrée
```

### Providers supportés

- **OpenAI** : GPT-4o, GPT-4o-mini
- **Anthropic** : Claude 3.5 Sonnet, Claude 3.5 Haiku
- **Google** : Gemini 1.5 Pro, Gemini 1.5 Flash
- **Meta** : Llama 3.1 (via Together AI)

### Logique de fallback

1. Sélection des providers compatibles selon le modèle demandé
2. Tri par priorité (préférences utilisateur, coût, performance)
3. Tentative sur chaque provider jusqu'au succès
4. Notification des erreurs techniques
5. Retour des erreurs métier directement

## 💰 Système de facturation

- **Wallet** : Solde par utilisateur
- **Transactions** : Historique des débits/crédits
- **Estimation** : Calcul du coût avant exécution
- **Tracking** : Mesure précise des tokens utilisés

## 📊 Métriques collectées

- **Performance** : Latence, throughput, temps de réponse
- **Usage** : Tokens d'entrée/sortie, coûts
- **Fiabilité** : Taux de succès par provider
- **Streaming** : Time to first chunk, durée totale

## 🔧 Configuration avancée

### Cache
```env
CACHE_TTL_SECONDS=300
BALANCE_CACHE_TTL_SECONDS=60
```

### Rate limiting
```env
RATE_LIMIT_REQUESTS_PER_MINUTE=60
```

### Providers personnalisés

Ajouter un nouveau provider :

```javascript
import { BaseProvider } from './providers/base.js';

class CustomProvider extends BaseProvider {
  transformRequest(request) { /* ... */ }
  transformResponse(response) { /* ... */ }
  // ... autres méthodes
}
```

## 🚀 Déploiement

### Avec Holo (recommandé)
```bash
# Configuration pour Holo
npm run build
holo deploy
```

### Avec Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src ./src
EXPOSE 3000
CMD ["npm", "start"]
```

### Variables d'environnement de production

```env
NODE_ENV=production
PORT=3000
# ... autres variables
```

## 🔍 Monitoring

### Health checks
```bash
curl http://localhost:3000/health
```

### Logs
Les logs incluent :
- Requêtes et réponses
- Erreurs par provider
- Métriques de performance
- Événements de cache

### Notifications d'erreur
Configuration ntfy pour les alertes :
```env
NTFY_ERROR_URL=https://ntfy.makehub.ai/errors
```

## 🧪 Tests

```bash
# Tests unitaires
npm test

# Test de l'API
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

## 🤝 Contribution

1. Fork le projet
2. Créer une branche feature
3. Commit les changements
4. Push vers la branche
5. Ouvrir une Pull Request

## 📄 Licence

MIT License - voir le fichier LICENSE pour plus de détails.

## 🆘 Support

- **Issues** : Utiliser GitHub Issues
- **Documentation** : Voir le wiki du projet
- **Contact** : [votre-email]

---

**Note** : Ce projet est conçu pour être déployé avec Holo mais peut fonctionner sur n'importe quelle plateforme Node.js.
