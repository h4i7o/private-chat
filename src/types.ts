export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  CAP_USD: string;
  ANTHROPIC_ADMIN_KEY?: string;      // 任意。Console の実額を取りに行くときだけ使う(読み取り専用の集計)
  ANTHROPIC_WORKSPACE_ID?: string;   // 任意。集計をこのアプリのワークスペースだけに絞る
}

export interface User {
  id: string;
  name: string;
  role: 'owner' | 'user';
}

export type AppEnv = { Bindings: Env; Variables: { user: User } };
