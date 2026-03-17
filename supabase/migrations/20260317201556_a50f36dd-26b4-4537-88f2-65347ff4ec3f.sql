
DELETE FROM contest_pool_crews WHERE contest_pool_id IN (
  SELECT id FROM contest_pools WHERE contest_template_id = '3138d6b2-a88c-4178-a567-1995f9b8de67'
);
DELETE FROM contest_entries WHERE pool_id IN (
  SELECT id FROM contest_pools WHERE contest_template_id = '3138d6b2-a88c-4178-a567-1995f9b8de67'
);
DELETE FROM contest_pools WHERE contest_template_id = '3138d6b2-a88c-4178-a567-1995f9b8de67';
DELETE FROM contest_templates WHERE id = '3138d6b2-a88c-4178-a567-1995f9b8de67';
