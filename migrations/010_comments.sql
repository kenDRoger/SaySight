-- Contextual comments publish immediately (post-moderation); removal is recorded
-- with a reason in an append-only log so a deletion can always be explained.
CREATE TABLE comments (
  id UUID PRIMARY KEY,
  finding_id UUID NOT NULL REFERENCES findings(id),
  author_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX comments_finding_idx ON comments (finding_id, created_at);

CREATE TABLE comment_moderation (
  id UUID PRIMARY KEY,
  comment_id UUID NOT NULL REFERENCES comments(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER comment_moderation_append_only
  BEFORE UPDATE OR DELETE ON comment_moderation
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER comment_moderation_no_truncate
  BEFORE TRUNCATE ON comment_moderation
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_immutable_record_mutation();
