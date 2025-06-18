// This test script verifies cache functionality by sending the same message twice.
// It sends identical POST requests to the /v1/chat/completions endpoint.
// Run this script with: node examples/test_cache.js

// Charger les variables d'environnement du fichier .env
import dotenv from 'dotenv';
dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || 'https://api.makehub.ai';
const API_KEY = process.env.API_KEY_MAKEHUB

console.log(`Using API base URL: ${API_BASE_URL}`);;
if (!API_KEY) {
  console.error('🔴 API_KEY_MAKEHUB not found in environment variables')
  console.error('Please set the API_KEY_MAKEHUB environment variable before running this script.');
  process.exit(1);
};


// Prompt long pour atteindre la taille minimale de cache (2048 tokens pour Haiku 3.5)
const longPrompt = `
You are an expert AI researcher and educator tasked with creating a comprehensive explanation of machine learning concepts. Your mission is to provide detailed, accurate, and educational content that covers multiple aspects of machine learning, artificial intelligence, and data science.

Please provide a thorough analysis of the following topics:

1. FUNDAMENTALS OF MACHINE LEARNING:
- Define machine learning and its relationship to artificial intelligence
- Explain the core principles that make machine learning different from traditional programming
- Describe the mathematical foundations including statistics, linear algebra, and calculus
- Discuss the importance of data in machine learning systems
- Explain the concept of algorithms learning patterns from data

2. TYPES OF MACHINE LEARNING:
- Supervised Learning: Explain classification and regression with detailed examples
- Unsupervised Learning: Describe clustering, dimensionality reduction, and association rules
- Reinforcement Learning: Explain agents, environments, rewards, and policy optimization
- Semi-supervised and self-supervised learning approaches
- Transfer learning and few-shot learning methodologies

3. MACHINE LEARNING ALGORITHMS:
- Linear and logistic regression: mathematical formulation and use cases
- Decision trees and ensemble methods (Random Forest, Gradient Boosting)
- Support Vector Machines: kernel trick and optimization
- Neural networks: perceptrons, backpropagation, and deep learning
- K-means clustering and hierarchical clustering
- Principal Component Analysis and t-SNE for dimensionality reduction

4. DATA PREPROCESSING AND FEATURE ENGINEERING:
- Data cleaning techniques and handling missing values
- Feature selection and feature extraction methods
- Normalization and standardization of numerical features
- Encoding categorical variables (one-hot, label, target encoding)
- Handling imbalanced datasets and sampling techniques
- Cross-validation strategies and data splitting best practices

5. MODEL EVALUATION AND VALIDATION:
- Performance metrics for classification (accuracy, precision, recall, F1-score, AUC-ROC)
- Regression metrics (MSE, MAE, R-squared, MAPE)
- Overfitting and underfitting: causes, detection, and prevention
- Bias-variance tradeoff and its implications
- Hyperparameter tuning techniques (grid search, random search, Bayesian optimization)
- Statistical significance testing and confidence intervals

6. DEEP LEARNING AND NEURAL NETWORKS:
- Architecture of artificial neural networks
- Convolutional Neural Networks for computer vision
- Recurrent Neural Networks and LSTMs for sequence data
- Transformer architecture and attention mechanisms
- Generative models: GANs, VAEs, and diffusion models
- Training techniques: optimization algorithms, regularization, dropout

7. PRACTICAL APPLICATIONS AND INDUSTRY USE CASES:
- Computer vision: image classification, object detection, facial recognition
- Natural Language Processing: sentiment analysis, machine translation, chatbots
- Recommendation systems: collaborative filtering and content-based approaches
- Time series forecasting in finance and business
- Autonomous vehicles and robotics applications
- Healthcare applications: medical imaging, drug discovery, personalized medicine

8. ETHICAL CONSIDERATIONS AND CHALLENGES:
- Bias and fairness in machine learning models
- Privacy concerns and data protection regulations
- Explainability and interpretability of AI systems
- Environmental impact of large-scale AI training
- Job displacement and societal implications
- Responsible AI development and deployment practices

9. CURRENT TRENDS AND FUTURE DIRECTIONS:
- Large Language Models and their capabilities
- Multi-modal AI systems combining text, images, and audio
- Edge AI and model compression techniques
- Quantum machine learning possibilities
- AutoML and democratization of machine learning
- Federated learning and privacy-preserving techniques

10. TOOLS AND FRAMEWORKS:
- Programming languages: Python, R, Julia for machine learning
- Libraries and frameworks: scikit-learn, TensorFlow, PyTorch, Keras
- Data manipulation tools: pandas, NumPy, Apache Spark
- Visualization libraries: matplotlib, seaborn, plotly
- Cloud platforms: AWS, Google Cloud, Azure for ML deployment
- MLOps tools for model lifecycle management

Please provide a comprehensive response that demonstrates deep understanding of these machine learning concepts, including specific examples, mathematical intuition where appropriate, and practical insights from real-world applications. Focus on making the content educational and accessible while maintaining technical accuracy.

Now, given this extensive context about machine learning, please explain the concept of machine learning in exactly 3 sentences, but make sure your explanation demonstrates the depth of knowledge covered in the topics above.
Now , please provide a detailed response that adheres to the following guidelines:
- Use clear and concise language
- Include relevant examples to illustrate key points
- Maintain a professional and educational tone
`;

const requestBody = {
  model: "anthropic/claude-4-sonnet",
  messages: [
    { role: "user", content: longPrompt }
  ],
  stream: false, // Disable streaming to get complete response with usage info
  max_tokens: 100,
  temperature: 0.7,
  provider: "bedrock",
};

async function makeRequest(requestNumber) {
  console.log(`\n🔄 Making request ${requestNumber}...`);
  console.log(`Request body:`, JSON.stringify(requestBody, null, 2));
  
  try {
    const response = await fetch(`${API_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': `${API_KEY}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      // Lire le contenu de l'erreur pour avoir les détails
      let errorDetails = '';
      try {
        const errorBody = await response.json();
        errorDetails = JSON.stringify(errorBody, null, 2);
      } catch (e) {
        errorDetails = await response.text();
      }
      console.error(`\n🔴 Erreur HTTP ${response.status} pour la requête ${requestNumber}:`);
      console.error(errorDetails);
      return null;
    }

    const data = await response.json();
    
    console.log(`\n✅ Réponse ${requestNumber} reçue:`);
    console.log(`Content: ${data.choices?.[0]?.message?.content || 'No content'}`);
    
    // Afficher les informations d'usage brutes
    console.log(`\n📊 Usage brut pour la requête ${requestNumber}:`);
    console.log(JSON.stringify(data.usage, null, 2));
    
    // Afficher d'autres informations utiles pour vérifier le cache
    console.log(`\n🔍 Informations supplémentaires pour la requête ${requestNumber}:`);
    console.log(`- Model: ${data.model || 'N/A'}`);
    console.log(`- ID: ${data.id || 'N/A'}`);
    console.log(`- Created: ${data.created || 'N/A'}`);
    
    return data;
    
  } catch (error) {
    console.error(`🔴 Erreur de requête ${requestNumber}:`, error);
    return null;
  }
}

async function testCache() {
  console.log('🧪 Test du cache - Envoi du même message deux fois');
  console.log('Model:', requestBody.model);
  console.log('Message:', requestBody.messages[0].content);
  
  // Première requête
  const response1 = await makeRequest(1);
  
  // Attendre un court moment
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Deuxième requête (identique)
  const response2 = await makeRequest(2);
  
  // Comparer les résultats
  if (response1 && response2) {
    console.log('\n🔄 Comparaison des réponses:');
    
    console.log('\n📊 Comparaison des usage:');
    console.log('Usage 1:', JSON.stringify(response1.usage, null, 2));
    console.log('Usage 2:', JSON.stringify(response2.usage, null, 2));
    
    if (JSON.stringify(response1.usage) === JSON.stringify(response2.usage)) {
      console.log('✅ Les informations d\'usage sont identiques');
    } else {
      console.log('❌ Les informations d\'usage diffèrent');
    }
    
    console.log('\n🆔 Comparaison des IDs:');
    console.log('ID 1:', response1.id);
    console.log('ID 2:', response2.id);
    
    if (response1.id === response2.id) {
      console.log('✅ Les IDs sont identiques (probablement cache hit)');
    } else {
      console.log('❌ Les IDs diffèrent (probablement pas de cache)');
    }
    
    console.log('\n📝 Comparaison du contenu:');
    const content1 = response1.choices?.[0]?.message?.content;
    const content2 = response2.choices?.[0]?.message?.content;
    
    if (content1 === content2) {
      console.log('✅ Le contenu des réponses est identique');
    } else {
      console.log('❌ Le contenu des réponses diffère');
    }
  }
  
  console.log('\n🏁 Test terminé');
}

async function testAnthropicDirectAPI() {
  console.log('\n🔬 Test direct API Anthropic - Prompt Caching');
  
  const API_KEY_ANTHROPIC = process.env.API_KEY_ANTHROPIC || process.env.API_KEY_ANTHROPIC;
  
  if (!API_KEY_ANTHROPIC) {
    console.error('🔴 API_KEY_ANTHROPIC not found in environment variables');
    return;
  }

  const anthropicRequestBody = {
    model: "anthropic/claude-4-sonnet",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: longPrompt, // Utilise le même prompt long pour respecter la taille minimale
            cache_control: { type: "ephemeral" } // Active le prompt caching
          }
        ]
      }
    ],
    max_tokens: 100,
    temperature: 0.7
  };

  async function makeAnthropicRequest(requestNumber) {
    console.log(`\n🔄 Anthropic direct API request ${requestNumber}...`);
    console.log(`Request body:`, JSON.stringify(anthropicRequestBody, null, 2));
    
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY_ANTHROPIC,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify(anthropicRequestBody)
      });

      if (!response.ok) {
        let errorDetails = '';
        try {
          const errorBody = await response.json();
          errorDetails = JSON.stringify(errorBody, null, 2);
        } catch (e) {
          errorDetails = await response.text();
        }
        console.error(`\n🔴 Erreur HTTP ${response.status} pour la requête Anthropic ${requestNumber}:`);
        console.error(errorDetails);
        return null;
      }

      const data = await response.json();
      
      console.log(`\n✅ Réponse Anthropic ${requestNumber} reçue:`);
      console.log(`Content: ${data.content?.[0]?.text || 'No content'}`);
      
      // Afficher les informations d'usage brutes avec focus sur le cache
      console.log(`\n📊 Usage brut Anthropic pour la requête ${requestNumber}:`);
      console.log(JSON.stringify(data.usage, null, 2));
      
      // Mettre en évidence les informations de cache
      if (data.usage) {
        console.log(`\n🎯 Informations de cache pour la requête ${requestNumber}:`);
        console.log(`- Input tokens: ${data.usage.input_tokens || 0}`);
        console.log(`- Output tokens: ${data.usage.output_tokens || 0}`);
        console.log(`- Cache creation tokens: ${data.usage.cache_creation_input_tokens || 0}`);
        console.log(`- Cache read tokens: ${data.usage.cache_read_input_tokens || 0}`);
        
        if (data.usage.cache_creation_input_tokens > 0) {
          console.log(`✨ Cache créé avec ${data.usage.cache_creation_input_tokens} tokens`);
        }
        if (data.usage.cache_read_input_tokens > 0) {
          console.log(`🎉 Cache hit! ${data.usage.cache_read_input_tokens} tokens lus depuis le cache`);
        }
      }
      
      console.log(`\n🔍 Autres informations Anthropic ${requestNumber}:`);
      console.log(`- Model: ${data.model || 'N/A'}`);
      console.log(`- ID: ${data.id || 'N/A'}`);
      console.log(`- Stop reason: ${data.stop_reason || 'N/A'}`);
      
      return data;
      
    } catch (error) {
      console.error(`🔴 Erreur de requête Anthropic ${requestNumber}:`, error);
      return null;
    }
  }

  // Première requête - devrait créer le cache
  const response1 = await makeAnthropicRequest(1);
  
  // Attendre un court moment
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Deuxième requête - devrait utiliser le cache
  const response2 = await makeAnthropicRequest(2);
  
  // Analyser les résultats du cache
  if (response1 && response2) {
    console.log('\n🔄 Analyse du prompt caching Anthropic:');
    
    const usage1 = response1.usage || {};
    const usage2 = response2.usage || {};
    
    console.log('\n📊 Comparaison des usage:');
    console.log('Usage 1:', JSON.stringify(usage1, null, 2));
    console.log('Usage 2:', JSON.stringify(usage2, null, 2));
    
    // Analyser spécifiquement le cache
    if (usage1.cache_creation_input_tokens > 0) {
      console.log(`\n✅ Requête 1: Cache créé (${usage1.cache_creation_input_tokens} tokens)`);
    } else {
      console.log(`\n⚠️ Requête 1: Aucun cache créé`);
    }
    
    if (usage2.cache_read_input_tokens > 0) {
      console.log(`✅ Requête 2: Cache utilisé (${usage2.cache_read_input_tokens} tokens lus)`);
      console.log(`💰 Économie: ${usage2.cache_read_input_tokens} tokens lus au lieu de ${usage1.input_tokens} tokens complets`);
    } else if (usage2.cache_creation_input_tokens > 0) {
      console.log(`⚠️ Requête 2: Cache recréé au lieu d'être utilisé`);
    } else {
      console.log(`❌ Requête 2: Aucun cache utilisé`);
    }
    
    // Comparaison des temps de réponse simulés
    console.log('\n🆔 Comparaison des IDs:');
    console.log('ID 1:', response1.id);
    console.log('ID 2:', response2.id);
    
    console.log('\n📝 Comparaison du contenu:');
    const content1 = response1.content?.[0]?.text;
    const content2 = response2.content?.[0]?.text;
    
    if (content1 === content2) {
      console.log('✅ Le contenu des réponses est identique');
    } else {
      console.log('❌ Le contenu des réponses diffère');
      console.log('Content 1:', content1);
      console.log('Content 2:', content2);
    }
  }
  
  console.log('\n🏁 Test Anthropic direct terminé');
}

async function runAllTests() {
  console.log('🚀 Lancement de tous les tests de cache\n');
  
  // Test via le gateway
  await testCache();
  
  console.log('\n' + '='.repeat(60) + '\n');
  
  // Test direct API Anthropic
  //await testAnthropicDirectAPI();
  
  console.log('\n🎯 Tous les tests terminés');
}

// Exécuter tous les tests
runAllTests();
