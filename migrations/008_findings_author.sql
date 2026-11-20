-- Findings belong to the account that submitted them, so review has an author to
-- attribute and a reviewer can never be asked to review their own submission.
ALTER TABLE findings ADD COLUMN submitted_by UUID REFERENCES users(id);
CREATE INDEX findings_submitted_by_idx ON findings (submitted_by);
