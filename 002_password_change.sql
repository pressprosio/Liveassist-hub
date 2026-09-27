-- Team members given a generated password must choose their own at first sign-in.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
