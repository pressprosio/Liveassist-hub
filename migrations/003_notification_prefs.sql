-- Each team member chooses what makes their phone or console alert them.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS notify jsonb NOT NULL
  DEFAULT '{"handoffs": true, "new_chats": true, "messages": "mine"}'::jsonb;
