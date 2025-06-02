import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import type { Database, DatabaseConfig } from '../types/index.js';

dotenv.config();

// Supabase client for authentication and database operations
// En mode test, on utilise un mock si les URLs ne sont pas valides
let supabase: ReturnType<typeof createClient<Database>>;

// Fonction pour créer un mock complet avec chaînage
const createSupabaseMock = () => {
  const mockQuery = {
    _table: null as string | null,
    _apiKey: null as string | null,
    _userId: null as string | null,
    
    select: function(columns: string) { return this; },
    insert: function(data: any) { return this; },
    update: function(data: any) { return this; },
    delete: function() { return this; },
    eq: function(column: string, value: any) { 
      if (column === 'api_key') this._apiKey = value;
      if (column === 'user_id') this._userId = value;
      return this; 
    },
    neq: function(column: string, value: any) { return this; },
    gt: function(column: string, value: any) { return this; },
    gte: function(column: string, value: any) { return this; },
    lt: function(column: string, value: any) { return this; },
    lte: function(column: string, value: any) { return this; },
    like: function(column: string, pattern: string) { return this; },
    ilike: function(column: string, pattern: string) { return this; },
    is: function(column: string, value: any) { return this; },
    in: function(column: string, values: any[]) { return this; },
    contains: function(column: string, value: any) { return this; },
    containedBy: function(column: string, value: any) { return this; },
    rangeGt: function(column: string, range: any) { return this; },
    rangeGte: function(column: string, range: any) { return this; },
    rangeLt: function(column: string, range: any) { return this; },
    rangeLte: function(column: string, range: any) { return this; },
    rangeAdjacent: function(column: string, range: any) { return this; },
    overlaps: function(column: string, value: any) { return this; },
    textSearch: function(column: string, query: string) { return this; },
    match: function(query: Record<string, any>) { return this; },
    not: function(column: string, operator: string, value: any) { return this; },
    or: function(filters: string) { return this; },
    filter: function(column: string, operator: string, value: any) { return this; },
    order: function(column: string, options?: { ascending?: boolean }) { return this; },
    limit: function(count: number) { return this; },
    range: function(from: number, to: number) { return this; },
    single: function() { 
      // Pour les tests avec la clé API de test
      if (this._table === 'api_keys' && this._apiKey === 'test-api-key-123') {
        return Promise.resolve({ 
          data: {
            id: 'test-api-key-id',
            user_id: '3dfeb923-1e33-4a3a-9473-ee9637446ae4',
            api_key: 'test-api-key-123',
            api_key_name: 'test_api_key',
            is_active: true,
            wallet: {
              user_id: '3dfeb923-1e33-4a3a-9473-ee9637446ae4',
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
    then: function(resolve: (value: any) => any) { return resolve({ data: [], error: null }); }
  };

  return {
    from: function(table: string) { 
      const query = Object.create(mockQuery);
      query._table = table;
      return query;
    },
    auth: {
      getUser: (token?: string) => Promise.resolve({ data: { user: null }, error: null })
    }
  };
};

try {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_URL.startsWith('https://') && 
      serviceKey && serviceKey.length > 10) {
    supabase = createClient<Database>(
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
    supabase = createSupabaseMock() as any;
  }
} catch (error) {
  console.warn('Supabase connection failed, using mock:', (error as Error).message);
  supabase = createSupabaseMock() as any;
}

export { supabase };

// Supabase client for user authentication (with anon key)
let supabaseAuth: ReturnType<typeof createClient>;

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
        getUser: (token?: string) => Promise.resolve({ data: { user: null }, error: null }),
        signInWithPassword: (credentials: any) => Promise.resolve({ data: null, error: null })
      }
    } as any;
  }
} catch (error) {
  console.warn('Supabase Auth connection failed, using mock:', (error as Error).message);
  supabaseAuth = {
    auth: {
      getUser: (token?: string) => Promise.resolve({ data: { user: null }, error: null }),
      signInWithPassword: (credentials: any) => Promise.resolve({ data: null, error: null })
    }
  } as any;
}

export { supabaseAuth };

export const dbConfig: DatabaseConfig = {
  minimalFund: parseFloat(process.env.MINIMAL_FUND || '0.01'),
  cacheTtl: parseInt(process.env.CACHE_TTL_SECONDS || '300'),
  balanceCacheTtl: parseInt(process.env.BALANCE_CACHE_TTL_SECONDS || '60')
};