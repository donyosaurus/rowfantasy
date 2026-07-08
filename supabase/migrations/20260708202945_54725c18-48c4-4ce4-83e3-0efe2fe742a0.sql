
-- Support ticket replies (threading)
CREATE TABLE public.support_ticket_replies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('user','admin','system')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.support_ticket_replies TO authenticated;
GRANT ALL ON public.support_ticket_replies TO service_role;

ALTER TABLE public.support_ticket_replies ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_support_ticket_replies_ticket_id ON public.support_ticket_replies(ticket_id, created_at);

-- Users can read replies on their own tickets
CREATE POLICY "Users read own ticket replies"
ON public.support_ticket_replies FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.support_tickets t
    WHERE t.id = ticket_id AND t.user_id = auth.uid()
  )
);

-- Users can insert their own replies on their own, non-closed tickets
CREATE POLICY "Users insert own ticket replies"
ON public.support_ticket_replies FOR INSERT
TO authenticated
WITH CHECK (
  author_role = 'user'
  AND author_user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.support_tickets t
    WHERE t.id = ticket_id
      AND t.user_id = auth.uid()
      AND t.status <> 'closed'
  )
);

-- Admins full access
CREATE POLICY "Admins manage all ticket replies"
ON public.support_ticket_replies FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Extend support_tickets with thread metadata
ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reply_by TEXT CHECK (last_reply_by IN ('user','admin','system')),
  ADD COLUMN IF NOT EXISTS user_last_viewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_last_viewed_at TIMESTAMPTZ;

-- Allow users to update user_last_viewed_at on their own tickets (RLS only lets them touch that field via a scoped policy).
-- Simpler: give a policy for UPDATE where the row is theirs; we control writable columns via GRANTS (column-level).
GRANT UPDATE (user_last_viewed_at) ON public.support_tickets TO authenticated;

CREATE POLICY "Users mark own ticket viewed"
ON public.support_tickets FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Trigger: after reply insert, bump ticket metadata + status
CREATE OR REPLACE FUNCTION public.support_ticket_after_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.support_tickets
  SET last_reply_at = NEW.created_at,
      last_reply_by = NEW.author_role,
      updated_at = now(),
      status = CASE
        WHEN NEW.author_role = 'user' AND status IN ('resolved','closed') THEN 'open'
        WHEN NEW.author_role = 'user' THEN 'open'
        WHEN NEW.author_role = 'admin' THEN 'waiting'
        ELSE status
      END,
      admin_last_viewed_at = CASE WHEN NEW.author_role = 'admin' THEN now() ELSE admin_last_viewed_at END,
      user_last_viewed_at = CASE WHEN NEW.author_role = 'user' THEN now() ELSE user_last_viewed_at END
  WHERE id = NEW.ticket_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_ticket_after_reply ON public.support_ticket_replies;
CREATE TRIGGER trg_support_ticket_after_reply
AFTER INSERT ON public.support_ticket_replies
FOR EACH ROW EXECUTE FUNCTION public.support_ticket_after_reply();
