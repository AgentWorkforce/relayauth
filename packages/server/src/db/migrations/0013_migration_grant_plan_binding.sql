-- Stack-safe amendment to 0012: #110 may land before this follow-up, so do
-- not rewrite its checksum. Existing grants have NULL here and therefore fail
-- closed at hydration/mint; newly created grants always persist both values.

ALTER TABLE migration_grants ADD COLUMN allowed_pairs_json TEXT CHECK (
  allowed_pairs_json IS NULL OR (
    json_valid(allowed_pairs_json)
    AND json_type(allowed_pairs_json) = 'array'
    AND json_array_length(allowed_pairs_json) BETWEEN 1 AND 1000
  )
);

ALTER TABLE migration_grants ADD COLUMN plan_json TEXT CHECK (
  plan_json IS NULL OR (
    json_valid(plan_json)
    AND json_type(plan_json) = 'object'
  )
);
