-- メモリ: ユーザーごとに覚えておくメモ(送信のたびに使うかどうかは画面のスイッチで切り替える)
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_user ON memories (user_id, created_at);
