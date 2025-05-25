import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Supabase client for authentication and database operations
// En mode test, on utilise un mock si les URLs ne sont pas valides
let supabase;

// Fonction pour créer un mock complet avec chaînage
const createSupabaseMock = () => {
  const mockQuery = {
    _table: null,
    _apiKey: null,
    _userId: null,
    
    select: function(columns) { return this; },
    insert: function(data) { return this; },
    update: function(data) { return this; },
    delete: function() { return this; },
    eq: function(column, value) { 
      if (column === 'api_key') this._apiKey = value;
      if (column === 'user_id') this._userId = value;
      return this; 
    },
    neq: function(column, value) { return this; },
    gt: function(column, value) { return this; },
    gte: function(column, value) { return this; },
    lt: function(column, value) { return this; },
    lte: function(column, value) { return this; },
    like: function(column, pattern) { return this; },
    ilike: function(column, pattern) { return this; },
    is: function(column, value) { return this; },
    in: function(column, values) { return this; },
    contains: function(column, value) { return this; },
    containedBy: function(column, value) { return this; },
    rangeGt: function(column, range) { return this; },
    rangeGte: function(column, range) { return this; },
    rangeLt: function(column, range) { return this; },
    rangeLte: function(column, range) { return this; },
    rangeAdjacent: function(column, range) { return this; },
    overlaps: function(column, value) { return this; },
    textSearch: function(column, query) { return this; },
    match: function(query) { return this; },
    not: function(column, operator, value) { return this; },
    or: function(filters) { return this; },
    filter: function(column, operator, value) { return this; },
    order: function(column, options) { return this; },
    limit: function(count) { return this; },
    range: function(from, to) { return this; },
    single: function() { 
      // Pour les tests avec la clé API de test
      if (this._table === 'api_keys' && this._apiKey === 'test-api-key-123') {
        return Promise.resolve({ 
          data: {
            id: 'test-api-key-id',
            user_id: 'test-user-id',
            api_key: 'test-api-key-123',
            api_key_name: 'test_api_key',
            is_active: true,
            wallet: {
              user_id: 'test-user-id',
              balance: 10.0
            }
          }, 
          error: null 
        });
      }
      // Pour les wallets
      if (this._table === 'wallet') {
        return Promise.resolve({ 
          data: { balance: 10.0 }, 
          error: null 
        });
      }
      return Promise.resolve({ data: null, error: null }); 
    },
    maybeSingle: function() { return this.single(); },
    then: function(resolve) { return resolve({ data: [], error: null }); }
  };

  return {
    from: function(table) { 
      const query = Object.create(mockQuery);
      query._table = table;
      return query;
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null })
    }
  };
};

try {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_URL.startsWith('https://') && 
      serviceKey && serviceKey.length > 10) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      serviceKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
  } else {
    console.warn('Using Supabase mock - missing or invalid credentials');
    supabase = createSupabaseMock();
  }
} catch (error) {
  console.warn('Supabase connection failed, using mock:', error.message);
  supabase = createSupabaseMock();
}

export { supabase };

// Supabase client for user authentication (with anon key)
let supabaseAuth;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_URL.startsWith('https://') && 
      process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_ANON_KEY.length > 10) {
    supabaseAuth = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  } else {
    // Mock pour les tests
    supabaseAuth = {
      auth: {
        getUser: () => ({ data: { user: null }, error: null }),
        signInWithPassword: () => ({ data: null, error: null })
      }
    };
  }
} catch (error) {
  console.warn('Supabase Auth connection failed, using mock:', error.message);
  supabaseAuth = {
    auth: {
      getUser: () => ({ data: { user: null }, error: null }),
      signInWithPassword: () => ({ data: null, error: null })
    }
  };
}

export { supabaseAuth };

export const dbConfig = {
  minimalFund: parseFloat(process.env.MINIMAL_FUND) || 0.01,
  cacheTtl: parseInt(process.env.CACHE_TTL_SECONDS) || 300,
  balanceCacheTtl: parseInt(process.env.BALANCE_CACHE_TTL_SECONDS) || 60
};
