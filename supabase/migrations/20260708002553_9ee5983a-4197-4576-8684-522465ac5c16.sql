UPDATE public.state_regulation_rules
   SET status = 'restricted'
 WHERE state_code IN ('NY','NH','MD') AND status = 'regulated';

UPDATE public.state_regulation_rules
   SET notes = NULL
 WHERE notes ILIKE '%licens%';

NOTIFY pgrst, 'reload schema';