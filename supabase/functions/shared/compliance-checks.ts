// Compliance Gating Functions

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';
import { checkGeoEligibility } from './geo-eligibility.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export interface ComplianceCheckResult {
  allowed: boolean;
  reason?: string;
  metadata?: Record<string, any>;
}

export interface ComplianceContext {
  userId: string;
  stateCode: string;
  amountCents: number;
  actionType: 'deposit' | 'withdrawal' | 'entry';
  ipAddress?: string;
}

export async function performComplianceChecks(
  context: ComplianceContext
): Promise<ComplianceCheckResult> {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

  // 1. Check geo eligibility first (only if enabled and not admin)
  if (geoEnabled && !isAdmin && context.ipAddress && context.ipAddress !== 'unknown') {
    const geoResult = await checkGeoEligibility(context.ipAddress, context.userId);
    
    if (!geoResult.allowed) {
      await logComplianceEvent(supabase, {
        userId: context.userId,
        eventType: 'geo_blocked',
        severity: 'warn',
        description: geoResult.reason || 'Geolocation check failed',
        stateCode: geoResult.stateCode,
        ipAddress: context.ipAddress,
      });
      
      return {
        allowed: false,
        reason: geoResult.reason,
      };
    }
    
    // Update context with detected state if available
    if (geoResult.stateCode) {
      context.stateCode = geoResult.stateCode;
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
        severity: 'error',
        description: `State regulation check failed for ${context.stateCode}`,
        stateCode: context.stateCode,
        ipAddress: context.ipAddress,
      });
      
      return {
        allowed: false,
        reason: 'State not supported or regulations unavailable',
      };
    }

    if (stateRule.status === 'prohibited' || stateRule.status === 'restricted') {
      await logComplianceEvent(supabase, {
        userId: context.userId,
        eventType: 'state_prohibited',
        severity: 'warn',
        description: `Attempted ${context.actionType} from ${stateRule.status} state ${context.stateCode}`,
        stateCode: context.stateCode,
        ipAddress: context.ipAddress,
      });
      
      return {
        allowed: false,
        reason: `Service not available in ${stateRule.state_name}`,
      };
    }
  }

  // 3. Check user profile and age verification
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', context.userId)
    .single();

  if (profileError || !profile) {
    return {
      allowed: false,
      reason: 'User profile not found',
    };
  }

  // Check age verification (Phase 4 requirement)
  if (!profile.date_of_birth || !profile.age_confirmed_at) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'age_verification_missing',
      severity: 'warn',
      description: 'User has not completed age verification',
      stateCode: context.stateCode,
    });
    
    return {
      allowed: false,
      reason: 'Age verification required',
    };
  }

  // Verify minimum age based on state rules
  const birthDate = new Date(profile.date_of_birth);
  const age = Math.floor((Date.now() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  
  // For admins, use default min age of 18 since we skip state rule check
  const minAge = 18;
  if (age < minAge) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'underage_blocked',
      severity: 'error',
      description: `User age ${age} is below minimum ${minAge}`,
      stateCode: context.stateCode,
    });
    
    return {
      allowed: false,
      reason: `You must be at least ${minAge} years old to use this service`,
    };
  }

  if (!profile.is_active) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'inactive_account',
      severity: 'warn',
      description: 'Inactive account attempted transaction',
      stateCode: context.stateCode,
    });
    
    return {
      allowed: false,
      reason: 'Account is inactive',
    };
  }

  // Check self-exclusion
  if (profile.self_exclusion_until) {
    const exclusionDate = new Date(profile.self_exclusion_until);
    if (exclusionDate > new Date()) {
      await logComplianceEvent(supabase, {
        userId: context.userId,
        eventType: 'self_exclusion_block',
        severity: 'info',
        description: 'Self-excluded user attempted transaction',
        stateCode: context.stateCode,
        metadata: { exclusion_until: profile.self_exclusion_until },
      });
      
      return {
        allowed: false,
        reason: `Account self-excluded until ${exclusionDate.toLocaleDateString()}`,
      };
    }
  }

  // Check employee restriction
  if (profile.is_employee) {
    await logComplianceEvent(supabase, {
      userId: context.userId,
      eventType: 'employee_block',
      severity: 'warn',
      description: 'Employee attempted transaction',
      stateCode: context.stateCode,
    });
    
    return {
      allowed: false,
      reason: 'Employees are not permitted to participate',
    };
  }

  // 4. Check deposit limits for deposits
  if (context.actionType === 'deposit') {
    const depositLimit = profile.deposit_limit_monthly || 250000; // Default $2,500
    
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: monthlyDeposits, error: depositError } = await supabase
      .from('transactions')
      .select('amount')
      .eq('user_id', context.userId)
      .eq('type', 'deposit')
      .eq('status', 'completed')
      .gte('created_at', startOfMonth.toISOString());

    if (!depositError && monthlyDeposits) {
      const totalDeposited = monthlyDeposits.reduce(
        (sum, txn) => sum + Number(txn.amount),
        0
      );
      
      if (totalDeposited + context.amountCents / 100 > depositLimit / 100) {
        await logComplianceEvent(supabase, {
          userId: context.userId,
          eventType: 'deposit_limit_exceeded',
          severity: 'warn',
          description: 'Monthly deposit limit exceeded',
          stateCode: context.stateCode,
          metadata: {
            current_total: totalDeposited,
            limit: depositLimit / 100,
            attempted_amount: context.amountCents / 100,
          },
        });
        
        return {
          allowed: false,
          reason: 'Monthly deposit limit exceeded',
          metadata: {
            limit: depositLimit / 100,
            remaining: Math.max(0, depositLimit / 100 - totalDeposited),
          },
        };
      }
    }
  }

  // 5. Check withdrawal limits and restrictions
  if (context.actionType === 'withdrawal') {
    if (context.amountCents > 20000) {
      return {
        allowed: false,
        reason: 'Per-transaction withdrawal limit is $200',
      };
    }

    const { data: pendingWithdrawals } = await supabase
      .from('transactions')
      .select('id')
      .eq('user_id', context.userId)
      .eq('type', 'withdrawal')
      .eq('status', 'pending');

    if (pendingWithdrawals && pendingWithdrawals.length > 0) {
      return {
        allowed: false,
        reason: 'You already have a pending withdrawal. Please wait for it to complete.',
      };
    }

    if (profile.withdrawal_last_requested_at) {
      const lastWithdrawal = new Date(profile.withdrawal_last_requested_at);
      const cooldownMs = 10 * 60 * 1000;
      const timeSinceLastWithdrawal = Date.now() - lastWithdrawal.getTime();
      
      if (timeSinceLastWithdrawal < cooldownMs) {
        const minutesRemaining = Math.ceil((cooldownMs - timeSinceLastWithdrawal) / 60000);
        return {
          allowed: false,
          reason: `Please wait ${minutesRemaining} minute(s) before requesting another withdrawal`,
        };
      }
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data: dailyWithdrawals } = await supabase
      .from('transactions')
      .select('amount')
      .eq('user_id', context.userId)
      .eq('type', 'withdrawal')
      .in('status', ['completed', 'pending'])
      .gte('created_at', startOfDay.toISOString());

    if (dailyWithdrawals) {
      const dailyTotal = dailyWithdrawals.reduce(
        (sum, txn) => sum + Math.abs(Number(txn.amount)),
        0
      );
      
      if ((dailyTotal * 100) + context.amountCents > 50000) {
        return {
          allowed: false,
          reason: 'Daily withdrawal limit of $500 reached',
          metadata: {
            dailyTotal,
            limit: 500,
            remaining: Math.max(0, 500 - dailyTotal),
          },
        };
      }
    }

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const { data: recentDeposits } = await supabase
      .from('transactions')
      .select('amount, deposit_timestamp')
      .eq('user_id', context.userId)
      .eq('type', 'deposit')
      .eq('status', 'completed')
      .gte('deposit_timestamp', twentyFourHoursAgo.toISOString());

    if (recentDeposits && recentDeposits.length > 0) {
      const holdAmount = recentDeposits.reduce(
        (sum, txn) => sum + Number(txn.amount),
        0
      );
      
      if (holdAmount * 100 >= context.amountCents) {
        return {
          allowed: false,
          reason: 'Newly deposited funds must be held for 24 hours before withdrawal',
        };
      }
    }

    await supabase
      .from('profiles')
      .update({ withdrawal_last_requested_at: new Date().toISOString() })
      .eq('id', context.userId);
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
    },
  });

  return {
    allowed: true,
  };
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
