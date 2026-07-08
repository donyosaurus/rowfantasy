// Request an email-OTP for a sensitive action (withdraw / responsible-limits / password change).
// The 6-digit code is hashed with SHA-256 before storage; the raw code is only ever in the email body.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser, checkRateLimit } from '../shared/auth-helpers.ts';
import { sha256Hex } from '../shared/step-up.ts';

const bodySchema = z.object({
  purpose: z.enum(['withdraw', 'responsible_limits', 'password_change']),
});

const PURPOSE_LABEL: Record<string, string> = {
  withdraw: 'confirm your withdrawal',
  responsible_limits: 'update your responsible-gaming settings',
  password_change: 'change your password',
};

const SITE_NAME = 'RowFantasy';
const SENDER_DOMAIN = 'notify.rowfantasy.com';
const FROM_DOMAIN = 'notify.rowfantasy.com';

function renderOtpEmail(code: string, purposeText: string): { html: string; text: string } {
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="border-bottom:2px solid hsl(168,76%,50%);padding-bottom:12px;">
<div style="font-size:18px;font-weight:bold;color:hsl(217,91%,12%);letter-spacing:0.5px;">RowFantasy</div>
</td></tr>
<tr><td style="padding-top:28px;">
<h1 style="font-size:24px;font-weight:bold;color:hsl(222,47%,11%);margin:0 0 20px;line-height:1.3;">Your verification code</h1>
<p style="font-size:15px;color:hsl(215,16%,35%);line-height:1.6;margin:0 0 20px;">Use the code below to ${purposeText}. It expires in 10 minutes.</p>
<div style="font-family:Courier,monospace;font-size:32px;font-weight:bold;color:hsl(217,91%,12%);letter-spacing:6px;background:hsl(210,20%,96%);border-radius:12px;padding:20px;text-align:center;margin:0 0 30px;">${code}</div>
<p style="font-size:12px;color:hsl(215,16%,55%);margin:32px 0 0;line-height:1.5;">If you didn't request this, you can safely ignore this email. For help, reply or email support@rowfantasy.com.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `RowFantasy\n\nYour verification code: ${code}\n\nUse this code to ${purposeText}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email. Support: support@rowfantasy.com`;
  return { html, text };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const auth = await authenticateUser(req, SUPABASE_URL, ANON_KEY);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userId = auth.user.id;

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid input' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { purpose } = parsed.data;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Rate limit: max 5 code requests per 30 min per user (across purposes)
    const rateOk = await checkRateLimit(admin, userId, 'otp-request', 5, 30);
    if (!rateOk) {
      return new Response(JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve user email (auth-scoped .getUser() already returned it)
    const email: string | undefined = auth.user.email;
    if (!email) {
      return new Response(JSON.stringify({ error: 'No email on account' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generate 6-digit numeric code
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    const code = String(rand[0] % 1_000_000).padStart(6, '0');
    const codeHash = await sha256Hex(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Invalidate any prior unconsumed codes for this purpose
    await admin.from('auth_otp_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('user_id', userId).eq('purpose', purpose).is('consumed_at', null);

    const { error: insertError } = await admin.from('auth_otp_codes').insert({
      user_id: userId,
      purpose,
      code_hash: codeHash,
      expires_at: expiresAt,
    });
    if (insertError) {
      console.error('[otp-request] insert error', insertError);
      return new Response(JSON.stringify({ error: 'Failed to create code' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Enqueue email
    const { html, text } = renderOtpEmail(code, PURPOSE_LABEL[purpose]);
    const messageId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    await admin.from('email_send_log').insert({
      message_id: messageId, template_name: `otp_${purpose}`, recipient_email: email, status: 'pending',
    });

    const { error: enqueueError } = await admin.rpc('enqueue_email', {
      queue_name: 'auth_emails',
      payload: {
        run_id: runId,
        message_id: messageId,
        to: email,
        from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
        sender_domain: SENDER_DOMAIN,
        subject: 'Your RowFantasy verification code',
        html, text,
        purpose: 'transactional',
        label: `otp_${purpose}`,
        queued_at: new Date().toISOString(),
      },
    });

    if (enqueueError) {
      console.error('[otp-request] enqueue error', enqueueError);
      await admin.from('email_send_log').insert({
        message_id: messageId, template_name: `otp_${purpose}`, recipient_email: email,
        status: 'failed', error_message: 'Failed to enqueue',
      });
      return new Response(JSON.stringify({ error: 'Failed to send code' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, message: 'Verification code sent to your email' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[otp-request] error', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
