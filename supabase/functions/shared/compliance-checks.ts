// Compliance Gating Functions

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { checkGeoEligibility, getVerifiedWorkerState } from './geo-eligibility.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export interface ComplianceCheckResult {
  allowed: boolean;
  reason?: string;
  metadata?: Record<string, any>;
  // Batch 2 (record-integrity): the state actually used for gating decisions
  // and its provenance. Callers MUST persist `resolvedStateCode` downstream
  // instead of the caller-supplied (spoofable) header/body value.
  resolvedStateCode: string;
  stateCodeSource: 'worker' | 'ipbase' | 'unverified';
}

export interface ComplianceContext {
  userId: string;
  stateCode: string;
  amountCents: number;
  actionType: 'deposit' | 'withdrawal' | 'entry';
  ipAddress?: string;
}

export async function performComplianceChecks(
  context: ComplianceContext,
  req?: Request
): Promise<ComplianceCheckResult> {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Track the provenance of the state code used for gating.
  // 'worker' or 'ipbase' = trusted; 'unverified' = admin bypass or caller-supplied fallback.
  let stateCodeSource: 'worker' | 'ipbase' | 'unverified' = 'unverified';

  // Local helper to build return objects with the resolved state + source.
  const result = (partial: { allowed: boolean; reason?: string; metadata?: Record<string, any> }): ComplianceCheckResult => ({
    ...partial,
    resolvedStateCode: context.stateCode,
    stateCodeSource,
  });

  // P0-W4 Step 1: Try Worker-verified state FIRST. If present and valid, use it
  // directly and skip the IPBase call entirely. Falls through to existing IPBase
  // path if no Worker header is present (direct PostgREST calls, local dev, etc.).
  const workerVerifiedState = req ? await getVerifiedWorkerState(req) : null;
  if (workerVerifiedState) {
    context.stateCode = workerVerifiedState.stateCode;
    stateCodeSource = 'worker';
    // Intentionally no audit-log row: Worker-verified is the expected steady state.
  }

  // 0. Check if geo restrictions are enabled via feature flag
  const { data: flag } = await supabase
    .from('feature_flags')
    .select('value')
    .eq('key', 'ipbase_enabled')
    .single();

  const geoEnabled = (flag?.value as any)?.enabled === true;

  // 0b. Check if user is admin — admins bypass geo and compliance geo checks
  let isAdmin = false;
  if (context.userId) {
    const { data: adminRole } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', context.userId)
      .eq('role', 'admin')
      .maybeSingle();
    isAdmin = !!adminRole;
  }

  // No trusted geo source (no Worker-verified state AND IPBase disabled) → fail-closed.
  // Never trust caller-supplied x-user-state for the geo gate.
  if (!workerVerifiedState && !geoEnabled && !isAdmin) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'geo_no_trusted_source',
      severity: 'warning',
      description: 'No Worker-verified geo state and IPBase disabled — failing closed',
      stateCode: context.stateCode,
      ipAddress: context.ipAddress,
    });
    return result({ allowed: false, reason: 'Geolocation verification required' });
  }

  // 1. Check geo eligibility first (only if enabled, not admin, and not already Worker-verified)
  if (!workerVerifiedState && geoEnabled && !isAdmin && context.ipAddress && context.ipAddress !== 'unknown') {
    const geoResult = await checkGeoEligibility(context.ipAddress, context.userId);

    if (!geoResult.allowed) {
      await logComplianceEvent(supabase, {
        userId: context.userId,
        eventType: 'geo_blocked',
        severity: 'warning',
        description: geoResult.reason || 'Geolocation check failed',
        stateCode: geoResult.stateCode,
        ipAddress: context.ipAddress,
      });

      return result({ allowed: false, reason: geoResult.reason });
    }

    // Update context with detected state if available
    if (geoResult.stateCode) {
      context.stateCode = geoResult.stateCode;
      stateCodeSource = 'ipbase';
    }
  }

  // 2. Check state regulations (skip for admins when geo is the concern)
  if (!isAdmin) {
    const { data: stateRule, error: stateError } = await supabase
      .from('state_regulation_rules')
      .select('*')
      .eq('state_code', context.stateCode)
      .single();

    if (stateError || !stateRule) {
      await logComplianceEvent(supabase, {
        userId: context.userId,
        eventType: 'state_check_failed',
        severity: 'critical',
        description: `State regulation check failed for ${context.stateCode}`,
        stateCode: context.stateCode,
        ipAddress: context.ipAddress,
      });

      return result({ allowed: false, reason: 'State not supported or regulations unavailable' });
    }

    if (stateRule.status === 'prohibited' || stateRule.status === 'restricted') {
      await logComplianceEvent(supabase, {
        userId: context.userId,
        eventType: 'state_prohibited',
        severity: 'warning',
        description: `Attempted ${context.actionType} from ${stateRule.status} state ${context.stateCode}`,
        stateCode: context.stateCode,
        ipAddress: context.ipAddress,
      });

      return result({ allowed: false, reason: `Service not available in ${stateRule.state_name}` });
    }
  }

  // 3. Check user profile and age verification
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', context.userId)
    .single();

  if (profileError || !profile) {
    return result({ allowed: false, reason: 'User profile not found' });
  }

  // P0-C5: SX source-of-truth is responsible_gaming, NOT profiles.
  const { data: rgSettings } = await supabase
    .from('responsible_gaming')
    .select('self_exclusion_until')
    .eq('user_id', context.userId)
    .maybeSingle();

  // Check age verification (Phase 4 requirement)
  if (!profile.date_of_birth || !profile.age_confirmed_at) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'age_verification_missing',
      severity: 'warning',
      description: 'User has not completed age verification',
      stateCode: context.stateCode,
    });

    return result({ allowed: false, reason: 'Age verification required' });
  }

  const birthDate = new Date(profile.date_of_birth);
  const age = Math.floor((Date.now() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));

  const minAge = 18;
  if (age < minAge) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'underage_blocked',
      severity: 'critical',
      description: `User age ${age} is below minimum ${minAge}`,
      stateCode: context.stateCode,
    });

    return result({ allowed: false, reason: `You must be at least ${minAge} years old to use this service` });
  }

  if (!profile.is_active) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'inactive_account',
      severity: 'warning',
      description: 'Inactive account attempted transaction',
      stateCode: context.stateCode,
    });

    return result({ allowed: false, reason: 'Account is inactive' });
  }

  // Check self-exclusion (reads canonical responsible_gaming source per P0-C5).
  if (rgSettings?.self_exclusion_until) {
    const exclusionDate = new Date(rgSettings.self_exclusion_until);
    if (exclusionDate > new Date()) {
      await logComplianceEvent(supabase, {
        userId: context.userId,
        eventType: 'self_exclusion_block',
        severity: 'info',
        description: 'Self-excluded user attempted transaction',
        stateCode: context.stateCode,
        metadata: { exclusion_until: rgSettings.self_exclusion_until },
      });

      return result({ allowed: false, reason: `Account self-excluded until ${exclusionDate.toLocaleDateString()}` });
    }
  }

  // Check employee restriction
  if (profile.is_employee) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'employee_block',
      severity: 'warning',
      description: 'Employee attempted transaction',
      stateCode: context.stateCode,
    });

    return result({ allowed: false, reason: 'Employees are not permitted to participate' });
  }

  // All checks passed
  await logComplianceEvent(supabase, {
    userId: context.userId,
    eventType: 'compliance_passed',
    severity: 'info',
    description: `Compliance checks passed for ${context.actionType}`,
    stateCode: context.stateCode,
    metadata: {
      action: context.actionType,
      amount_cents: context.amountCents,
      state_code_source: stateCodeSource,
    },
  });

  return result({ allowed: true });
}

async function logComplianceEvent(
  supabase: any,
  event: {
    userId: string;
    eventType: string;
    severity: string;
    description: string;
    stateCode?: string;
    ipAddress?: string;
    metadata?: Record<string, any>;
  }
) {
  await supabase.from('compliance_audit_logs').insert({
    user_id: event.userId,
    event_type: event.eventType,
    severity: event.severity,
    description: event.description,
    state_code: event.stateCode,
    ip_address: event.ipAddress,
    metadata: event.metadata,
  });
}
