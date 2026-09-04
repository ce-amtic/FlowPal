/**
 * FlowPal 存储 schema。
 *
 * 原则：原始碎片不可变、永不删除；条目是派生结果，用户可改、可合并、可丢弃，改动记录保留；
 * 每个结构化字段带引用，指向原文的哪一段。
 *
 * 这里没有 user_id 列——现在只有一个用户，userId 恒为 'local'。SQL 只出现在
 * packages/server/src/store/ 这一个目录，所以将来加多用户是加一列 + 改这个目录。
 *
 * DDL 写成字符串而不是 .sql 文件，是因为 desktop 那侧要把 server 打成一个 bundle，
 * 相对模块路径的文件读取在打包后会指向错的地方，而且不会报错。
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 原始碎片：只增，永不改、永不删。
CREATE TABLE IF NOT EXISTS fragments (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,               -- ISO8601 带 +08:00
  device        TEXT NOT NULL,
  source        TEXT NOT NULL,               -- paste|hotkey|drop|share|screenshot|email|calendar|timetable
  raw_type      TEXT NOT NULL,               -- text|image|audio|file|structured
  raw_text      TEXT,                        -- 原文 / 转写文本 / 结构化来源的原始 JSON
  raw_blob_path TEXT                         -- 图片、文件落盘的相对路径
);

-- 条目：五类共用一张宽表，多余的列留空。字段重合度高，拆表会让每个查询都要 union。
CREATE TABLE IF NOT EXISTS items (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,             -- event|task|thought|progress|state
  title           TEXT NOT NULL,             -- 展示给用户的那一句话
  starts_at       TEXT,                      -- 事件用；同时是 rrule 的 DTSTART
  due_at          TEXT,                      -- 事务用。与 starts_at 分列：「什么时候开始做」
                                             -- 与「什么时候必须交」的差别正是紧迫度的输入
  date_precision  TEXT,                      -- day|minute。没有它，无时刻的日期会被当成午夜
  date_raw        TEXT,                      -- 「第8周周三」
  rrule           TEXT,                      -- RFC 5545 RRULE。缺了它模型面对「每周三的组会」
                                             -- 只能编一个具体的周三
  date_confidence TEXT,                      -- high|medium|low
  confidence      TEXT NOT NULL,
  location        TEXT,
  status          TEXT NOT NULL,             -- active|done|dropped|needs_confirm
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_due    ON items(due_at);

-- 一条条目来自哪些碎片。同一件事从多个来源进来是常态而不是例外，
-- 合并时只往这张表追加一行，items 一个字段都不用动。
CREATE TABLE IF NOT EXISTS item_sources (
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  fragment_id TEXT NOT NULL REFERENCES fragments(id),
  added_at    TEXT NOT NULL,
  PRIMARY KEY (item_id, fragment_id)
);

-- 每个字段指向原文的哪一段。quote 是逐字片段，offset 由我们 indexOf 出来。
CREATE TABLE IF NOT EXISTS item_citations (
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  field        TEXT NOT NULL,
  fragment_id  TEXT NOT NULL REFERENCES fragments(id),
  quote        TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  PRIMARY KEY (item_id, field, fragment_id)
);

-- 事务 → 事件、进度 → 事务
CREATE TABLE IF NOT EXISTS item_links (
  id           TEXT PRIMARY KEY,
  from_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  to_item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                -- task_of_event|progress_of_task
  created_at   TEXT NOT NULL
);

-- 所有改动，含改期。带 fragment_id 是因为改期本身是画像信号，
-- 要知道是哪条通知把日期推走的。
CREATE TABLE IF NOT EXISTS item_history (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  changed_at  TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  actor       TEXT NOT NULL,                 -- user|llm|merge
  fragment_id TEXT REFERENCES fragments(id)
);

CREATE INDEX IF NOT EXISTS idx_history_item ON item_history(item_id);
`
