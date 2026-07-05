// Responsible Gaming Limits - Users set deposit limits and self-exclusion.
//
// SECURITY (batch 2): writes to responsible_gaming MUST go through the
// authenticated caller's client so the responsible_gaming_validate_update
// trigger runs. The trigger short-circuits for postgres/service_role, which
// previously silently defeated:
//   - self-exclusion monotonic-extension (couldn't be shortened/cleared)
//   - 24h cooling-off on deposit-limit increases
// Only the compliance_audit_logs insert uses the service-role client.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { getCorsHeaders } from '../shared/cors.ts';

const limitSchema = z.object({
  depositLimit: z.number().int().positive().optional(), // Monthly limit in cents
  exclusionDays: z.number().int().positive().optional(), // Days to self-exclude
});

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Caller-authenticated client: writes go through here so the trigger runs.
    const supabase = createClient(
      supabaseUrl,
      anonKey,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let body;
    try {
      body = limitSchema.parse(await req.json());
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid input' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { depositLimit, exclusionDays } = body;

    if (depositLimit === undefined && exclusionDays === undefined) {
      return new Response(
        JSON.stringify({ error: 'Provide depositLimit or exclusionDays' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Service-role client — ONLY for audit-log inserts (users cannot insert audit rows).
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Read current settings via caller client (RLS: own row).
    const { data: currentRow } = await supabase
      .from('responsible_gaming')
      .select('deposit_limit_monthly_cents, pending_deposit_limit_monthly_cents, pending_limit_effective_at, self_exclusion_until')
      .eq('user_id', user.id)
      .maybeSingle();

    // Helper: idempotent row-ensure. A first-time user sending BOTH
    // depositLimit and exclusionDays would otherwise hit two INSERTs and
    // fail the second with a 23505 unique violation AFTER the deposit-limit
    // write already committed. Track a local flag AND use ignoreDuplicates.
    let rowExists = !!currentRow;
    async function ensureRow() {
      if (rowExists) return;
      const { error } = await supabase
        .from('responsible_gaming')
        .upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true });
      if (error) throw error;
      rowExists = true;
    }

    // Audit-log writer — service-role (users cannot insert audit rows).
    // Called IMMEDIATELY after each successful responsible_gaming write so
    // that a later error (e.g. self-exclusion trigger rejection) cannot
    // silently discard the audit row for a change that already committed.
    async function writeAudit(evt: { eventType: string; description: string; metadata: Record<string, any> }) {
      try {
        await adminClient.from('compliance_audit_logs').insert({
          user_id: user.id,
          event_type: evt.eventType,
          description: evt.description,
          severity: 'info',
          metadata: evt.metadata,
        });
      } catch (logErr) {
        console.error('[responsible-limits] audit log failed:', logErr);
      }
    }

    const responseExtras: Record<string, any> = {};

    // ── Deposit limit ─────────────────────────────────────────────────────
    if (depositLimit !== undefined) {
      const existing = currentRow?.deposit_limit_monthly_cents ?? null;
      const existingPending = currentRow?.pending_deposit_limit_monthly_cents ?? null;
      const isTightening = existing === null || depositLimit < existing;
      const isIncrease = existing !== null && depositLimit > existing;

      await ensureRow();

      if (isTightening) {
        // Tightening (including first-time setting) applies immediately.
        // Also clear any pending increase — responsible-gaming principle:
        // tightening must never be refused, and the DB trigger only permits
        // a decrease-while-pending-active when both pending fields are
        // cleared in the same UPDATE.
        const { error } = await supabase
          .from('responsible_gaming')
          .update({
            deposit_limit_monthly_cents: depositLimit,
            pending_deposit_limit_monthly_cents: null,
            pending_limit_effective_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id);
        if (error) throw error;

        const metadata: Record<string, any> = {
          deposit_limit_cents: depositLimit,
          previous_cents: existing,
        };
        if (existingPending !== null) {
          metadata.pending_cancelled = true;
          metadata.cancelled_pending_cents = existingPending;
        }
        await writeAudit({
          eventType: 'deposit_limit_set',
          description: `Deposit limit set to $${(depositLimit / 100).toFixed(2)}/month`,
          metadata,
        });
        responseExtras.depositLimit = `$${(depositLimit / 100).toFixed(2)}/month`;
        responseExtras.depositLimitEffective = 'immediate';
      } else if (isIncrease) {
        // Increases go through pending + 24h cooling-off (trigger enforces the 24h floor).
        const effectiveAt = new Date(Date.now() + 24 * 60 * 60 * 1000 + 60_000).toISOString(); // +24h+1min buffer
        const { error } = await supabase
          .from('responsible_gaming')
          .update({
            pending_deposit_limit_monthly_cents: depositLimit,
            pending_limit_effective_at: effectiveAt,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id);
        if (error) throw error;

        await writeAudit({
          eventType: 'deposit_limit_increase_pending',
          description: `Deposit limit increase to $${(depositLimit / 100).toFixed(2)}/month pending 24h cooling-off`,
          metadata: {
            pending_deposit_limit_cents: depositLimit,
            current_limit_cents: existing,
            effective_at: effectiveAt,
          },
        });
        responseExtras.pendingDepositLimit = `$${(depositLimit / 100).toFixed(2)}/month`;
        responseExtras.pendingDepositLimitEffectiveAt = effectiveAt;
        responseExtras.depositLimitEffective = 'pending_24h';
      } else {
        // depositLimit === existing → no-op; report state without an audit event.
        responseExtras.depositLimit = `$${(depositLimit / 100).toFixed(2)}/month`;
        responseExtras.depositLimitEffective = 'unchanged';
      }
    }

    // ── Self-exclusion ────────────────────────────────────────────────────
    let selfExclusionUntilOut: string | null = null;
    if (exclusionDays !== undefined) {
      const exclusionUntil = new Date();
      exclusionUntil.setDate(exclusionUntil.getDate() + exclusionDays);
      const exclusionUntilIso = exclusionUntil.toISOString();

      await ensureRow();

      const { error } = await supabase
        .from('responsible_gaming')
        .update({
          self_exclusion_until: exclusionUntilIso,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id);

      if (error) {
        // Trigger rejection → surface as 400 with the DB's message (do not hide as 500).
        const msg = (error.message || '').toLowerCase();
        const code = (error as any).code;
        if (code === '23514' || msg.includes('self-exclusion') || msg.includes('cooling-off') || msg.includes('cannot be cleared')) {
          return new Response(
            JSON.stringify({ error: error.message }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        throw error;
      }

      selfExclusionUntilOut = exclusionUntilIso;
      await writeAudit({
        eventType: 'self_exclusion_enabled',
        description: `Self-exclusion enabled for ${exclusionDays} days until ${exclusionUntil.toLocaleDateString()}`,
        metadata: { exclusion_days: exclusionDays, self_exclusion_until: exclusionUntilIso },
      });
    }

    console.log('[responsible-limits] Updated:', { userId: user.id, depositLimit, exclusionDays });

    return new Response(
      JSON.stringify({
        success: true,
        // Preserve existing response fields
        depositLimit: responseExtras.depositLimit ?? (depositLimit ? `$${(depositLimit / 100).toFixed(2)}/month` : null),
        selfExclusionUntil: selfExclusionUntilOut,
        // New optional fields (do not remove existing ones)
        ...responseExtras,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    // Trigger rejections from the deposit-limit path bubble here too — surface as 400.
    const msg = (error?.message || '').toLowerCase();
    const code = error?.code;
    if (code === '23514' || msg.includes('self-exclusion') || msg.includes('cooling-off') || msg.includes('cannot be cleared') || msg.includes('deposit limit')) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
      );
    }
    console.error('[responsible-limits] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});
