/**
 * Types pour les entités de base de données
 */

export interface Model {
  model_id: string;
  provider: string;
  provider_model_id: string;
  support_tool_calling: boolean;
  support_vision: boolean;
  price_per_input_token: number;
  price_per_output_token: number;
  context_window: number | null;
  base_url: string;
  api_key_name: string;
  adapter: string;
  extra_param: Record<string, any> | null;
  tokenizer_name: string;
  pricing_method: string;
  created_at: string;
  is_fallback?: boolean;
}


export interface RequestRow {
  request_id: string;
  user_id: string;
  api_key_name: string | null;
  provider: string;
  model: string;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  status: RequestStatus;
  streaming: boolean;
  error_message: string | null;
}

export interface RequestContentRow {
  request_id: string;
  request_json: Record<string, any>;
  response_json: Record<string, any> | null;
  created_at: string;
}

export interface MetricsRow {
  request_id: string;
  created_at: string;
  total_duration_ms: number | null;
  time_to_first_chunk: number | null;
  dt_first_last_chunk: number | null;
  is_metrics_calculated: boolean;
  throughput_tokens_s: number | null;
}

export interface TransactionRow {
  id: string;
  user_id: string;
  amount: number;
  type: TransactionType;
  request_id: string | null;
  created_at: string;
  description: string | null;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  api_key: string;
  api_key_name: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface WalletRow {
  user_id: string;
  balance: number;
  created_at: string;
  updated_at: string;
}

export type RequestStatus = 'ready_to_compute' | 'completed' | 'error';
export type TransactionType = 'credit' | 'debit';

/**
 * Types pour Supabase client
 */
export interface Database {
  public: {
    Tables: {
      models: {
        Row: Model;
        Insert: Partial<Model>;
        Update: Partial<Model>;
      };
      requests: {
        Row: RequestRow;
        Insert: Partial<RequestRow>;
        Update: Partial<RequestRow>;
      };
      requests_content: {
        Row: RequestContentRow;
        Insert: Partial<RequestContentRow>;
        Update: Partial<RequestContentRow>;
      };
      metrics: {
        Row: MetricsRow;
        Insert: Partial<MetricsRow>;
        Update: Partial<MetricsRow>;
      };
      transactions: {
        Row: TransactionRow;
        Insert: Partial<TransactionRow>;
        Update: Partial<TransactionRow>;
      };
      api_keys: {
        Row: ApiKeyRow;
        Insert: Partial<ApiKeyRow>;
        Update: Partial<ApiKeyRow>;
      };
      wallet: {
        Row: WalletRow;
        Insert: Partial<WalletRow>;
        Update: Partial<WalletRow>;
      };
    };
  };
}

/**
 * Types pour les jointures courantes
 */
export interface RequestWithContent extends RequestRow {
  requests_content: RequestContentRow;
}

export interface RequestWithContentAndModel extends RequestWithContent {
  models: Model;
}

export interface ApiKeyWithWallet extends ApiKeyRow {
  wallet: WalletRow;
}
