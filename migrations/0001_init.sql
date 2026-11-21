-- 金額は全て nano-USD(1e-9 ドル)の整数で持ちます。浮動小数の誤差を出さないためです。

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('owner','user')),
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  iterations  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- 台帳は常に1行。
CREATE TABLE ledger (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  spent     INTEGER NOT NULL DEFAULT 0,
  override  INTEGER NOT NULL DEFAULT 0,
  resets    INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ledger (id) VALUES (1);

CREATE TABLE ledger_models (
  model  TEXT PRIMARY KEY,
  spent  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ledger_models (model) VALUES ('sonnet'), ('opus'), ('fable');

-- 送信前に確保する「最悪ケース」の予約。15分で自動失効するので、Workerが落ちても残額が固まりません。
CREATE TABLE reservations (
  id          TEXT PRIMARY KEY,
  amount      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE chats (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  hist_tokens  INTEGER NOT NULL DEFAULT 0,
  last_model   TEXT,
  last_ts      INTEGER
);
CREATE INDEX chats_user ON chats(user_id, updated_at DESC);

CREATE TABLE messages (
  id        TEXT PRIMARY KEY,
  chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('user','ai')),
  text      TEXT NOT NULL,
  model     TEXT,
  meta      TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX messages_chat ON messages(chat_id, seq);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     TEXT,
  message_id  TEXT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('image','pdf','text')),
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  tokens      INTEGER NOT NULL DEFAULT 0,
  r2_key      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX attachments_msg ON attachments(message_id);
