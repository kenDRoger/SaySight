-- The claim is the submitter's own statement of what a reviewer is verifying.
-- It is required for new findings; existing rows keep NULL.
ALTER TABLE findings ADD COLUMN claim TEXT CHECK (claim IS NULL OR length(btrim(claim)) BETWEEN 20 AND 1000);
