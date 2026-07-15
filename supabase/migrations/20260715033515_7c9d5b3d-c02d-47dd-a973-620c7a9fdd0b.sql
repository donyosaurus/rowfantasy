CREATE OR REPLACE FUNCTION public.guard_support_ticket_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.user_id, NEW.email, NEW.subject, NEW.topic, NEW.message, NEW.status,
      NEW.priority, NEW.assigned_to, NEW.metadata, NEW.created_at, NEW.last_reply_at,
      NEW.last_reply_by, NEW.admin_last_viewed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.email, OLD.subject, OLD.topic, OLD.message, OLD.status,
      OLD.priority, OLD.assigned_to, OLD.metadata, OLD.created_at, OLD.last_reply_at,
      OLD.last_reply_by, OLD.admin_last_viewed_at) THEN
    RAISE EXCEPTION 'only user_last_viewed_at may be updated';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';