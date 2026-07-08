
-- OTP codes issued to users for sensitive-action step-up
CREATE TABLE public.auth_otp_codes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('withdraw','responsible_limits','password_change')),
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_otp_codes_user_purpose ON public.auth_otp_codes(user_id, purpose, created_at DESC);
CREATE INDEX idx_auth_otp_codes_expires ON public.auth_otp_codes(expires_at);

GRANT ALL ON public.auth_otp_codes TO service_role;
ALTER TABLE public.auth_otp_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all client access to otp codes" ON public.auth_otp_codes FOR ALL USING (false) WITH CHECK (false);

-- Step-up tokens minted after successful OTP verification
CREATE TABLE public.step_up_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('withdraw','responsible_limits','password_change')),
  token_hash TEXT NOT NULL UNIQUE,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_step_up_tokens_hash ON public.step_up_tokens(token_hash);
CREATE INDEX idx_step_up_tokens_expires ON public.step_up_tokens(expires_at);

GRANT ALL ON public.step_up_tokens TO service_role;
ALTER TABLE public.step_up_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all client access to step up tokens" ON public.step_up_tokens FOR ALL USING (false) WITH CHECK (false);

-- Consume a step-up token atomically. Returns TRUE if a matching unused, unexpired token was found and marked consumed.
CREATE OR REPLACE FUNCTION public.consume_step_up_token(_user_id UUID, _token_hash TEXT, _purpose TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  UPDATE public.step_up_tokens
     SET consumed_at = now()
   WHERE token_hash = _token_hash
     AND user_id = _user_id
     AND purpose = _purpose
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_step_up_token(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_step_up_token(UUID, TEXT, TEXT) TO service_role;
