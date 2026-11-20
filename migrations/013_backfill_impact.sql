-- Findings created before impact existed kept the column default, so legacy rows
-- need their review depth derived from the same evidence year filters as new ones.
WITH derived AS (
  SELECT f.id,
         COALESCE(r.filters -> 'years', r.filters -> 'compare_years') AS multi_year,
         r.filters -> 'year' AS year_filter
  FROM findings f JOIN analysis_runs r ON r.id = f.analysis_run_id
)
UPDATE findings AS f
SET impact = CASE
  WHEN jsonb_typeof(d.multi_year) = 'array' THEN
    CASE
      WHEN jsonb_array_length(d.multi_year) >= 27 THEN 'high'
      WHEN jsonb_array_length(d.multi_year) > 1 THEN 'standard'
      ELSE 'low'
    END
  WHEN jsonb_typeof(d.year_filter) = 'number' THEN 'low'
  ELSE 'high'
END
FROM derived AS d
WHERE d.id = f.id;
