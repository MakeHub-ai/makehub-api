#!/bin/bash

# Script pour tester complètement le webhook
# Usage: ./examples/test-webhook-complete.sh

echo "🚀 Test complet du webhook de calcul des tokens"
echo "=============================================="
echo ""

# Vérifier que Node.js est disponible
if ! command -v node &> /dev/null; then
    echo "❌ Node.js n'est pas installé"
    exit 1
fi

# Vérifier que le serveur est démarré
echo "🔍 Vérification que le serveur est démarré..."
if ! curl -s http://localhost:3000/health > /dev/null; then
    echo "❌ Le serveur n'est pas accessible sur http://localhost:3000"
    echo "   Démarrez le serveur avec: npm run dev"
    exit 1
fi
echo "✅ Serveur accessible"
echo ""

# Créer des données de test
echo "📝 Création de données de test..."
node examples/create-test-data.js
if [ $? -ne 0 ]; then
    echo "❌ Erreur lors de la création des données de test"
    exit 1
fi
echo ""

# Tester le webhook
echo "🔧 Test du webhook..."
node examples/test-webhook.js
if [ $? -ne 0 ]; then
    echo "❌ Erreur lors du test du webhook"
    exit 1
fi
echo ""

# Proposer de nettoyer les données
echo "🧹 Voulez-vous nettoyer les données de test ? (y/N)"
read -r response
if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo "Nettoyage des données de test..."
    node examples/create-test-data.js clean
    echo "✅ Données nettoyées"
else
    echo "ℹ️  Données de test conservées. Pour les nettoyer plus tard :"
    echo "   node examples/create-test-data.js clean"
fi

echo ""
echo "🎉 Test complet terminé !"
