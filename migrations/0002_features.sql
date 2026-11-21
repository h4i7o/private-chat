-- ピン留め、会話の圧縮(/compact)、再生成の版管理、パスキー

ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

-- 圧縮された発言は画面には残るが、APIには送らない
ALTER TABLE messages ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0;

-- 再生成した応答の版。messages には「いま表示している版」が入る。
CREATE TABLE ai_versions (
  id      TEXT PRIMARY KEY,
  msg_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  n       INTEGER NOT NULL,
  text    TEXT NOT NULL,
  model   TEXT,
  meta    TEXT,
  ts      INTEGER NOT NULL,
  UNIQUE (msg_id, n)
);

CREATE TABLE passkeys (
  id          TEXT PRIMARY KEY,           -- credential id (base64url)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,              -- SPKI (base64url)
  alg         INTEGER NOT NULL,           -- -7 (ES256) / -257 (RS256)
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- 使い捨てのチャレンジ(5分で失効)
CREATE TABLE webauthn_challenges (
  challenge   TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL,              -- 'login' | 'register'
  user_id     TEXT,
  created_at  INTEGER NOT NULL
);
