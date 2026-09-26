-- LiveAssist hub schema v1

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sites (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  url          text NOT NULL,
  secret_enc   text NOT NULL,
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_docs (
  site_id    text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  doc_id     text NOT NULL,
  type       text NOT NULL DEFAULT 'page',
  track      text NOT NULL DEFAULT 'general',
  title      text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  excerpt    text NOT NULL DEFAULT '',
  content    text NOT NULL DEFAULT '',
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  hash       text NOT NULL DEFAULT '',
  sync_id    text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) STORED,
  PRIMARY KEY (site_id, doc_id)
);
CREATE INDEX knowledge_docs_tsv ON knowledge_docs USING gin (tsv);

CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  avatar_url    text,
  role          text NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  password_hash text NOT NULL,
  token_version integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  token      text PRIMARY KEY,
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform   text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  visitor_id       text NOT NULL,
  state            text NOT NULL DEFAULT 'ai_active'
                   CHECK (state IN ('ai_active', 'waiting_human', 'human_active', 'closed')),
  topic            text NOT NULL DEFAULT 'auto',
  name             text,
  email            text,
  user_id          bigint,
  page_url         text,
  page_title       text,
  referrer         text,
  ip_hash          text,
  agent_id         uuid REFERENCES agents(id) ON DELETE SET NULL,
  has_lead         boolean NOT NULL DEFAULT false,
  ai_turns         integer NOT NULL DEFAULT 0,
  waiting_since    timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE INDEX conversations_site_state ON conversations (site_id, state);
CREATE INDEX conversations_visitor ON conversations (site_id, visitor_id);
CREATE INDEX conversations_waiting ON conversations (waiting_since) WHERE state = 'waiting_human';
CREATE INDEX conversations_email ON conversations (lower(email));

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('visitor', 'ai', 'agent', 'system')),
  text            text NOT NULL,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  author_name     text,
  author_avatar   text,
  client_id       text,
  rating          text CHECK (rating IN ('up', 'down')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, client_id)
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);

CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'lead' CHECK (kind IN ('lead', 'ticket')),
  name            text,
  email           text,
  phone           text,
  interest        text,
  summary         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_email ON leads (lower(email));

CREATE TABLE webhook_outbox (
  id              bigserial PRIMARY KEY,
  site_id         text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  failed_at       timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_outbox_due ON webhook_outbox (next_attempt_at) WHERE delivered_at IS NULL AND failed_at IS NULL;
