// Post a reply on a support ticket (user or admin) and email the other party.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getCorsHeaders } from '../shared/cors.ts';
import { authenticateUser, verifyAdmin, checkRateLimit } from '../shared/auth-helpers.ts';

const bodySchema = z.object({
  ticket_id: z.string().uuid(),
  body: z.string().trim().min(1).max(5000),
});

const SITE_NAME = 'RowFantasy';
const SENDER_DOMAIN = 'notify.rowfantasy.com';
const FROM_DOMAIN = 'notify.rowfantasy.com';
const SUPPORT_INBOX = 'rowfantasy@gmail.com';
const APP_ORIGIN = 'https://www.rowfantasy.com';

function renderUserEmail(ticketId: string, subject: string, snippet: string): { html: string; text: string } {
  const url = `${APP_ORIGIN}/my-tickets/${ticketId}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="border-bottom:2px solid hsl(168,76%,50%);padding-bottom:12px;">
<div style="font-size:18px;font-weight:bold;color:hsl(217,91%,12%);letter-spacing:0.5px;">RowFantasy</div>
</td></tr>
<tr><td style="padding-top:28px;">
<h1 style="font-size:22px;font-weight:bold;color:hsl(222,47%,11%);margin:0 0 16px;line-height:1.3;">New reply on your support ticket</h1>
<p style="font-size:14px;color:hsl(215,16%,35%);margin:0 0 8px;"><strong>Subject:</strong> ${escapeHtml(subject)}</p>
<div style="background:hsl(210,20%,96%);border-radius:10px;padding:16px;font-size:14px;color:hsl(217,91%,12%);line-height:1.55;margin:16px 0 24px;white-space:pre-wrap;">${escapeHtml(snippet)}</div>
<div style="text-align:center;margin:0 0 28px;">
<a href="${url}" style="display:inline-block;background:hsl(168,76%,42%);color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;font-size:15px;">View & Reply</a>
</div>
<p style="font-size:12px;color:hsl(215,16%,55%);margin:0;line-height:1.5;">Need help? Email <a href="mailto:rowfantasy@gmail.com" style="color:hsl(168,76%,32%);">rowfantasy@gmail.com</a>.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `RowFantasy\n\nNew reply on your support ticket.\nSubject: ${subject}\n\n${snippet}\n\nView and reply: ${url}`;
  return { html, text };
}

function renderAdminEmail(ticketId: string, subject: string, userEmail: string, snippet: string): { html: string; text: string } {
  const url = `${APP_ORIGIN}/admin?tab=support&ticket=${ticketId}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:24px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 0 12px;font-size:12px;color:hsl(215,16%,45%);text-transform:uppercase;letter-spacing:1px;">Support inbox</td></tr>
<tr><td>
<h1 style="font-size:20px;font-weight:bold;color:hsl(222,47%,11%);margin:0 0 12px;">New user reply — ticket #${ticketId.slice(0,8)}</h1>
<p style="font-size:14px;color:hsl(215,16%,35%);margin:0 0 6px;"><strong>From:</strong> ${escapeHtml(userEmail)}</p>
<p style="font-size:14px;color:hsl(215,16%,35%);margin:0 0 14px;"><strong>Subject:</strong> ${escapeHtml(subject)}</p>
<div style="background:hsl(210,20%,96%);border-radius:8px;padding:14px;font-size:14px;color:hsl(217,91%,12%);line-height:1.55;white-space:pre-wrap;margin:0 0 20px;">${escapeHtml(snippet)}</div>
<a href="${url}" style="display:inline-block;background:hsl(217,91%,12%);color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;font-size:14px;">Open in admin</a>
</td></tr></table></td></tr></table></body></html>`;
  const text = `Support inbox — new user reply\nTicket: ${ticketId}\nFrom: ${userEmail}\nSubject: ${subject}\n\n${snippet}\n\nOpen: ${url}`;
  return { html, text };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
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
    const { ticket_id, body } = parsed.data;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Rate limit: 30 replies / 10 min per user
    const rateOk = await checkRateLimit(admin, userId, 'support-ticket-reply', 30, 10);
    if (!rateOk) {
      return new Response(JSON.stringify({ error: 'Too many replies. Please wait.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Load ticket
    const { data: ticket, error: tErr } = await admin
      .from('support_tickets')
      .select('id, user_id, email, subject, status')
      .eq('id', ticket_id)
      .maybeSingle();
    if (tErr || !ticket) {
      return new Response(JSON.stringify({ error: 'Ticket not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const isAdmin = await verifyAdmin(auth.supabase, userId);
    const isOwner = ticket.user_id === userId;
    if (!isAdmin && !isOwner) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!isAdmin && ticket.status === 'closed') {
      return new Response(JSON.stringify({ error: 'Ticket is closed' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authorRole = isAdmin && !isOwner ? 'admin' : (isAdmin ? 'admin' : 'user');
    // If admin also owns the ticket (rare) treat as user reply so notifications don't loop.
    const finalRole = isAdmin && !isOwner ? 'admin' : 'user';

    const { data: reply, error: rErr } = await admin
      .from('support_ticket_replies')
      .insert({
        ticket_id,
        author_user_id: userId,
        author_role: finalRole,
        body,
      })
      .select('id, created_at')
      .single();

    if (rErr) {
      console.error('[support-ticket-reply] insert error', rErr);
      return new Response(JSON.stringify({ error: 'Failed to post reply' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Enqueue notification email to the counterpart
    const snippet = body.length > 600 ? body.slice(0, 600) + '…' : body;
    const messageId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    let to: string;
    let subject: string;
    let html: string;
    let text: string;
    let label: string;

    if (finalRole === 'admin') {
      // Notify user
      to = ticket.email;
      subject = `Re: ${ticket.subject}`;
      label = 'support_reply_to_user';
      const rendered = renderUserEmail(ticket_id, ticket.subject, snippet);
      html = rendered.html; text = rendered.text;
    } else {
      // Notify support inbox
      to = SUPPORT_INBOX;
      subject = `[Ticket ${ticket_id.slice(0, 8)}] New user reply: ${ticket.subject}`;
      label = 'support_reply_to_admin';
      const rendered = renderAdminEmail(ticket_id, ticket.subject, ticket.email, snippet);
      html = rendered.html; text = rendered.text;
    }

    await admin.from('email_send_log').insert({
      message_id: messageId, template_name: label, recipient_email: to, status: 'pending',
    });

    const { error: enqErr } = await admin.rpc('enqueue_email', {
      queue_name: 'transactional_emails',
      payload: {
        run_id: runId,
        message_id: messageId,
        idempotency_key: `reply-${reply.id}`,
        to,
        from: `${SITE_NAME} Support <noreply@${FROM_DOMAIN}>`,
        sender_domain: SENDER_DOMAIN,
        subject,
        html, text,
        purpose: 'transactional',
        label,
        queued_at: new Date().toISOString(),
      },
    });

    if (enqErr) {
      console.error('[support-ticket-reply] enqueue error', enqErr);
      // Reply is already saved; don't fail the whole request.
    }

    return new Response(JSON.stringify({ success: true, reply }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[support-ticket-reply] error', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
