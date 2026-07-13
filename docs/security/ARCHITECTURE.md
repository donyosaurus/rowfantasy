# RowFantasy Security Documentation

> **Status header (added 2026-07-12):** This describes the security architecture *as designed on
> 2025-11-01*. Some controls may have drifted and some claims are unverified against current code.
> The authoritative, current record of security state is `audits/fixes-verified.md`; consult it
> (and the latest review in `audits/`) before relying on anything here.

## Overview

This document describes the security architecture and controls implemented in the RowFantasy DFS platform. It covers authentication, authorization, data protection, payment security, and operational safeguards.

---

## 🔐 Authentication & Authorization

### User Authentication
- **Method**: Supabase Auth with JWT tokens
- **Session Management**: Persistent sessions with automatic token refresh
- **Password Requirements**: Minimum 8 characters (enforced client-side)
- **Leaked Password Protection**: Enabled in Supabase Auth settings

### Role-Based Access Control (RBAC)
- **Roles**: `user` (default), `moderator`, `admin`
- **Storage**: Separate `user_roles` table (never stored on profiles)
- **Verification**: Server-side via `has_role()` security definer function
- **Admin Routes**: All admin functions require authentication + role verification BEFORE any privileged operations

### Row-Level Security (RLS)
All database tables have RLS policies enforcing:
- Users can only view/modify their own data
- Admins can view all data via `has_role(auth.uid(), 'admin')`
- System operations use service role only after authentication

---

## 🛡️ Edge Function Security

### Authentication Pattern
**CRITICAL**: All edge functions follow this pattern:

```typescript
// 1. Authenticate with anon key FIRST
const supabase = createClient(url, ANON_KEY, {
  global: { headers: { Authorization: authHeader } }
});

const { data: { user }, error } = await supabase.auth.getUser();
if (error || !user) {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
}

// 2. For admin functions, verify role
const { data: roles } = await supabase
  .from('user_roles')
  .select('role')
  .eq('user_id', user.id)
  .eq('role', 'admin');

if (!roles || roles.length === 0) {
  return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403 });
}

// 3. ONLY NOW create service client if needed
const supabaseAdmin = createClient(url, SERVICE_KEY);
```

### Function Access Matrix

| Function | Access Level | Service Role? | Notes |
|----------|-------------|---------------|-------|
| `contest-matchmaking` | Authenticated users | Yes (after auth) | Users can only enter themselves |
| `contest-enter` | Authenticated users | No | Uses anon key only |
| `contest-scoring` | Admin only | Yes (after auth) | Results input |
| `contest-settlement` | Admin only | Yes (after auth) | Payout distribution |
| `contest-withdraw` | Authenticated users | No | Entry cancellation |
| `admin-contest-void` | Admin only | Yes (after auth) | Pool cancellation |
| `admin-contest-results` | Admin only | Yes (after auth) | Results management |
| `wallet-deposit` | Authenticated users | No | Payment initiation |
| `wallet-withdraw` | Authenticated users | Yes (for checks) | Withdrawal initiation |
| `payments-webhook` | Public (signature verified) | Yes | Provider callbacks |

### Service Role Usage
- **Never** created before authentication check
- Used only for:
  - Cross-user queries (finding available pools)
  - Admin operations after role verification
  - System operations (webhooks, settlements)
  - Atomic transactions requiring elevated access

---

## 💳 Payment Security

### Webhook Verification
**Three-layer protection**:

1. **Signature Verification**: Constant-time comparison prevents timing attacks
```typescript
await timingSafeEqual(receivedSignature, computedSignature);
```

2. **Timestamp Validation**: Reject webhooks older than 5 minutes
```typescript
isTimestampValid(timestamp, 300); // 300 seconds max age
```

3. **Replay Protection**: Deduplicate via `webhook_dedup` table
```typescript
const existing = await supabase
  .from('webhook_dedup')
  .select('id')
  .eq('id', webhookId)
  .single();

if (existing) {
  return 409; // Duplicate detected
}
```

### Withdrawal Limits & Race Condition Prevention

**Atomic withdrawal checks** via `initiate_withdrawal_atomic()` function:

```sql
-- Advisory lock prevents concurrent withdrawals
PERFORM pg_advisory_xact_lock(hashtext(user_id::text));

-- Check daily limit (including pending)
SELECT COALESCE(SUM(ABS(amount)), 0)
INTO today_total
FROM transactions
WHERE user_id = _user_id
  AND type = 'withdrawal'
  AND status IN ('completed', 'pending')
  AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC');

-- Enforce $500 daily limit
IF (today_total + new_amount) > 500 THEN
  RETURN false, 'Daily withdrawal limit exceeded';
END IF;

-- Enforce 10-minute cooldown
-- Check per-transaction limit
-- Verify available balance with FOR UPDATE lock
```

**Limits**:
- Per-transaction: $5 - $500
- Daily total: $500 (including pending)
- Cooldown: 10 minutes between withdrawals
- UTC timezone for consistency

---

## 🔒 Data Protection

### Error Message Handling
**All errors sanitized** to prevent information disclosure:

```typescript
const ERROR_MESSAGES = {
  'DUPLICATE_ENTRY': 'You have already entered this contest',
  'INSUFFICIENT_FUNDS': 'Insufficient balance',
  'UNAUTHORIZED': 'Authentication required',
  'FORBIDDEN': 'Access denied',
  'NOT_FOUND': 'Resource not found',
  'INTERNAL_ERROR': 'An error occurred. Please try again',
};
```

**Never expose**:
- SQL constraint names
- Table/column names
- Stack traces
- Database error codes
- Internal IDs in production

### Idempotency
**Financial operations protected**:
- Payment sessions: `idempotency_key` on transactions
- Withdrawals: `idempotency_key` + atomic checks
- Settlements: Check `settled_at` before processing
- Webhooks: `webhook_dedup` table

### Rate Limiting
**Tracked in `rate_limits` table**:
- Per-IP and per-user tracking
- Sliding window (default: 100 requests/minute)
- Automatic cleanup of old records
- Configurable per endpoint

---

## 🎯 Contest Security

### Matchmaking Authorization
- User ID derived from authenticated JWT (never from request body)
- Service role used only for pool queries after user auth
- Entry count validation prevents over-subscription
- State code verification for geo-compliance

### Scoring & Settlement
**Admin-only operations**:
- Require authentication + admin role verification
- Idempotent: Prevent duplicate settlements
- Logged to `compliance_audit_logs`
- Use service role ONLY after authorization

### Entry Withdrawal
- Users can only withdraw own entries
- Only before contest locks
- Refunds processed atomically
- Entry fee released from pending balance

---

## 🚦 Launch Safeguards

### Feature Flags
**Master kill switch** in `feature_flags` table:

```sql
SELECT enabled FROM feature_flags WHERE flag_name = 'real_money_enabled';
```

**When `false`**:
- Deposits disabled
- Withdrawals disabled
- Payouts disabled
- Contest entries still allowed (for testing)

**Admin can toggle**:
```sql
UPDATE feature_flags 
SET enabled = true, updated_by = <admin_id>
WHERE flag_name = 'real_money_enabled';
```

### Compliance Logging
**All critical events logged** to `compliance_audit_logs`:
- User authentication failures
- Contest entries/withdrawals
- Deposits/withdrawals/payouts
- Admin actions (scoring, settlement, void)
- Webhook events (valid and invalid)
- Geofencing blocks

**Retention**: Indefinite (regulatory requirement)

---

## 🧪 Testing & Verification

### Security Checklist

- [ ] **Authentication**: Unauthorized calls to protected endpoints return 401
- [ ] **Authorization**: Non-admin calls to admin endpoints return 403
- [ ] **User Isolation**: Users cannot access other users' data
- [ ] **Matchmaking**: Cannot specify userId different from authenticated user
- [ ] **Scoring**: Only admins can score contests
- [ ] **Settlement**: Duplicate settlement ignored (idempotent)
- [ ] **Webhooks**: Old/replayed webhooks rejected
- [ ] **Withdrawals**: Concurrent withdrawals only allow one to succeed
- [ ] **Error Messages**: Constraint violations return generic errors
- [ ] **Rate Limiting**: Excessive requests blocked
- [ ] **Feature Flag**: Real money operations disabled when flag is false

### Testing Methodology

1. **Authentication Tests**:
   ```bash
   # No token
   curl -X POST https://.../functions/v1/contest-matchmaking
   # Expected: 401
   
   # Invalid token
   curl -X POST https://.../functions/v1/contest-matchmaking \
     -H "Authorization: Bearer invalid"
   # Expected: 401
   ```

2. **Authorization Tests**:
   ```bash
   # User token on admin endpoint
   curl -X POST https://.../functions/v1/contest-scoring \
     -H "Authorization: Bearer <user-token>"
   # Expected: 403
   ```

3. **Race Condition Tests**:
   ```bash
   # Send parallel withdrawals
   for i in {1..5}; do
     curl -X POST https://.../functions/v1/wallet-withdraw \
       -H "Authorization: Bearer <token>" \
       -d '{"amountCents": 50000}' &
   done
   # Expected: Only 1 succeeds, others fail with "limit exceeded"
   ```

4. **Webhook Replay Tests**:
   ```bash
   # Send same webhook twice
   curl -X POST https://.../functions/v1/payments-webhook \
     -H "webhook-id: test-123" \
     -H "webhook-signature: <sig>" \
     -d '<payload>'
   # Expected: First succeeds, second returns 409
   ```

---

## 🔧 Configuration

### Environment Variables

```bash
# Authentication
SUPABASE_URL=<project-url>
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-key>

# Payment Providers (if using real providers)
# PAYMENTS_PROVIDER=mock|highrisk|ach
# HIGHRISK_API_KEY=<key>
# HIGHRISK_WEBHOOK_SECRET=<secret>
# ACH_PARTNER_ID=<id>
# ACH_WEBHOOK_SECRET=<secret>

# Geolocation
IPBASE_API_KEY=<key>
```

### Supabase Auth Settings
**Configure in Lovable Cloud → Authentication**:
- ✅ Auto-confirm email (for development)
- ✅ Leaked password protection (for production)
- Site URL: Your deployed app URL
- Redirect URLs: Both preview and production URLs

---

## 📋 Incident Response

### If Security Issue Detected

1. **Immediate Actions**:
   - Disable real money: `UPDATE feature_flags SET enabled = false WHERE flag_name = 'real_money_enabled'`
   - Review `compliance_audit_logs` for scope
   - Notify affected users if data exposed

2. **Investigation**:
   - Check edge function logs
   - Review database audit logs
   - Identify attack vector
   - Assess data exposure

3. **Remediation**:
   - Deploy fix immediately
   - Update security documentation
   - Add test coverage for vulnerability
   - Consider bug bounty disclosure

4. **Post-Incident**:
   - Document timeline and lessons learned
   - Update monitoring/alerting
   - Review similar code patterns
   - Consider penetration testing

---

## 🔍 Monitoring & Alerts

### Recommended Monitoring

- **Authentication failures** > 10/minute from same IP
- **Admin operations** (all should be logged and reviewable)
- **Webhook signature failures** (potential attack)
- **Failed withdrawals** (compliance issue)
- **RLS policy violations** (data access attempt)
- **Feature flag changes** (who enabled real money?)

### Log Queries

```sql
-- Recent auth failures
SELECT * FROM compliance_audit_logs
WHERE event_type = 'authentication_failure'
  AND created_at > now() - interval '1 hour'
ORDER BY created_at DESC;

-- Admin actions today
SELECT * FROM compliance_audit_logs
WHERE admin_id IS NOT NULL
  AND created_at > date_trunc('day', now())
ORDER BY created_at DESC;

-- Failed webhook verifications
SELECT * FROM compliance_audit_logs
WHERE event_type = 'webhook_received'
  AND severity = 'warning'
  AND created_at > now() - interval '1 hour';
```

---

## 📚 References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Supabase Security Best Practices](https://supabase.com/docs/guides/auth/security)
- [PCI DSS Requirements](https://www.pcisecuritystandards.org/)
- [State DFS Regulations](https://docs.lovable.dev/features/security)

---

## ✅ Security Sign-Off

**Before enabling real money (`real_money_enabled = true`)**:

- [ ] All Phase 1 critical fixes implemented and tested
- [ ] Penetration testing completed (recommended)
- [ ] Legal review completed
- [ ] Compliance audit completed
- [ ] Incident response plan documented
- [ ] Monitoring and alerting configured
- [ ] Backup and recovery procedures tested

**Approved by**: `<Admin Name>` on `<Date>`

**Next review date**: `<Date + 90 days>`
