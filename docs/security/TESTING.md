# RowFantasy Security Testing Checklist

> **Status header (added 2026-07-12):** Useful pre-launch test procedures, but written 2025-11-01 —
> some endpoint names/paths may have drifted (verify against `supabase/functions/`). Current
> verified state lives in `audits/fixes-verified.md`.

## Pre-Launch Security Validation

This checklist must be completed and all tests must pass before enabling `real_money_enabled` flag.

---

## 🔐 Authentication & Authorization Tests

### Test 1: Unauthenticated Contest Matchmaking
**Expected:** 401 Unauthorized

```bash
curl -X POST https://your-project.supabase.co/functions/v1/contest-matchmaking \
  -H "Content-Type: application/json" \
  -d '{"userId":"test-user-id","contestTemplateId":"test-id","tierId":"standard","picks":[],"entryFeeCents":1000}'
```

**Pass Criteria:** Returns `{"error":"Authentication required"}` with status 401

---

### Test 2: Mismatched User ID
**Expected:** 403 Forbidden

```bash
# First get valid JWT for user A
# Then try to enter user B
curl -X POST https://your-project.supabase.co/functions/v1/contest-matchmaking \
  -H "Authorization: Bearer <USER_A_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<USER_B_ID>","contestTemplateId":"test-id","tierId":"standard","picks":[],"entryFeeCents":1000}'
```

**Pass Criteria:** Returns `{"error":"Access denied"}` with status 403

---

### Test 3: Non-Admin Scoring Attempt
**Expected:** 403 Forbidden

```bash
curl -X POST https://your-project.supabase.co/functions/v1/contest-scoring \
  -H "Authorization: Bearer <NON_ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"test-instance","results":[]}'
```

**Pass Criteria:** Returns `{"error":"Admin access required"}` with status 403

---

### Test 4: Non-Admin Settlement Attempt
**Expected:** 403 Forbidden

```bash
curl -X POST https://your-project.supabase.co/functions/v1/contest-settlement \
  -H "Authorization: Bearer <NON_ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"test-instance","forceResettle":false}'
```

**Pass Criteria:** Returns `{"error":"Admin access required"}` with status 403

---

### Test 5: Admin Status Check
**Expected:** Returns correct admin status

```bash
# Test with admin user
curl https://your-project.supabase.co/functions/v1/user-admin-check \
  -H "Authorization: Bearer <ADMIN_JWT>"

# Test with regular user
curl https://your-project.supabase.co/functions/v1/user-admin-check \
  -H "Authorization: Bearer <USER_JWT>"

# Test without auth
curl https://your-project.supabase.co/functions/v1/user-admin-check
```

**Pass Criteria:** 
- Admin user: `{"isAdmin":true,"authenticated":true}`
- Regular user: `{"isAdmin":false,"authenticated":true}`
- No auth: `{"isAdmin":false,"authenticated":false}`

---

## 💸 Financial Controls Tests

### Test 6: Duplicate Settlement Prevention
**Expected:** Second settlement ignored

```bash
# Settle contest first time
curl -X POST https://your-project.supabase.co/functions/v1/contest-settlement \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"completed-instance","forceResettle":false}'

# Try to settle again immediately
curl -X POST https://your-project.supabase.co/functions/v1/contest-settlement \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"completed-instance","forceResettle":false}'
```

**Pass Criteria:** Second call returns success but doesn't modify balances. Check `compliance_audit_logs` for duplicate prevention log.

---

### Test 7: Parallel Withdrawal Race Condition
**Expected:** Only one $500 withdrawal succeeds

```javascript
// Run in browser console or Node script
const token = 'USER_JWT_HERE';

Promise.all([
  fetch('https://your-project.supabase.co/functions/v1/wallet-withdraw', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ amountCents: 50000 }) // $500
  }),
  fetch('https://your-project.supabase.co/functions/v1/wallet-withdraw', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ amountCents: 50000 }) // $500
  })
]).then(responses => Promise.all(responses.map(r => r.json())))
  .then(results => console.log('Results:', results));
```

**Pass Criteria:** One succeeds, one fails with "Daily withdrawal limit exceeded" or similar

---

### Test 8: Pending Withdrawals Counted in Daily Limit
**Expected:** Pending withdrawal blocks new withdrawal

```bash
# Create pending withdrawal
curl -X POST https://your-project.supabase.co/functions/v1/wallet-withdraw \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"amountCents":50000}'

# Try another withdrawal while first is pending
curl -X POST https://your-project.supabase.co/functions/v1/wallet-withdraw \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"amountCents":50000}'
```

**Pass Criteria:** Second call fails with daily limit error

---

## 🪝 Webhook Security Tests

### Test 9: Replay Protection
**Expected:** Duplicate webhook rejected

```bash
# Send webhook with specific ID
curl -X POST https://your-project.supabase.co/functions/v1/payments-webhook?provider=mock \
  -H "Content-Type: application/json" \
  -H "webhook-signature: test-signature" \
  -H "webhook-timestamp: $(date -u +%s)" \
  -H "webhook-id: test-unique-id-123" \
  -d '{"event":"payment.succeeded","sessionId":"test-session"}'

# Send exact same webhook again
curl -X POST https://your-project.supabase.co/functions/v1/payments-webhook?provider=mock \
  -H "Content-Type: application/json" \
  -H "webhook-signature: test-signature" \
  -H "webhook-timestamp: $(date -u +%s)" \
  -H "webhook-id: test-unique-id-123" \
  -d '{"event":"payment.succeeded","sessionId":"test-session"}'
```

**Pass Criteria:** Second call returns 409 or 401 with `{"error":"invalid"}`

---

### Test 10: Timestamp Validation
**Expected:** Old webhook rejected

```bash
# Send webhook with timestamp from 10 minutes ago
OLD_TIMESTAMP=$(($(date -u +%s) - 600))

curl -X POST https://your-project.supabase.co/functions/v1/payments-webhook?provider=mock \
  -H "Content-Type: application/json" \
  -H "webhook-signature: test-signature" \
  -H "webhook-timestamp: $OLD_TIMESTAMP" \
  -H "webhook-id: test-old-webhook" \
  -d '{"event":"payment.succeeded","sessionId":"test-session"}'
```

**Pass Criteria:** Returns 401 with `{"error":"invalid"}`

---

## 🔒 Error Message Sanitization Tests

### Test 11: Database Constraint Violation
**Expected:** Generic error message (no table names)

```bash
# Try to create duplicate entry (trigger unique constraint)
curl -X POST https://your-project.supabase.co/functions/v1/contest-enter \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"contestId":"same-contest","picks":[]}'

# Call twice to trigger duplicate
```

**Pass Criteria:** Error message is "You have already entered this contest" NOT "duplicate key value violates unique constraint 'contest_entries_pkey'"

---

### Test 12: Insufficient Funds
**Expected:** Generic message

```bash
# Try to enter contest with insufficient balance
curl -X POST https://your-project.supabase.co/functions/v1/contest-enter \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"contestId":"expensive-contest","entryFeeCents":1000000,"picks":[]}'
```

**Pass Criteria:** Returns "Insufficient balance" NOT SQL error details

---

## 🛡️ Rate Limiting Tests

### Test 13: Rate Limit Enforcement
**Expected:** Excessive requests blocked

```javascript
// Rapid-fire 200 requests
const token = 'USER_JWT_HERE';
const promises = [];

for (let i = 0; i < 200; i++) {
  promises.push(
    fetch('https://your-project.supabase.co/functions/v1/contest-matchmaking', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ /* valid payload */ })
    })
  );
}

Promise.all(promises).then(responses => {
  const codes = responses.map(r => r.status);
  console.log('Status codes:', codes);
  console.log('429s (rate limited):', codes.filter(c => c === 429).length);
});
```

**Pass Criteria:** After ~100 requests, subsequent calls return 429 Too Many Requests

---

## 🚦 Feature Flag Tests

### Test 14: Real Money Flag Enforcement
**Expected:** Deposits/withdrawals blocked when flag is false

```sql
-- In database, ensure feature flag is off
UPDATE feature_flags SET enabled = false WHERE flag_name = 'real_money_enabled';
```

```bash
# Try to deposit
curl -X POST https://your-project.supabase.co/functions/v1/wallet-deposit \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"amountCents":10000}'

# Try to withdraw
curl -X POST https://your-project.supabase.co/functions/v1/wallet-withdraw \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"amountCents":5000}'
```

**Pass Criteria:** Both return error indicating real money operations are disabled

---

## 🔍 Admin UI Tests

### Test 15: Non-Admin Access to Admin Routes
**Expected:** UI hidden, server rejects

1. Log in as regular user
2. Navigate to `/admin` route
3. Open browser DevTools console
4. Try to call admin endpoints

**Pass Criteria:** 
- Admin page shows "Access Denied" or redirects
- Admin endpoint calls return 403
- No admin data visible in network responses

---

## 📋 Pre-Launch Checklist

Before setting `real_money_enabled = true`, verify:

- [ ] All 15 tests above pass
- [ ] `SECURITY.md` reviewed and approved
- [ ] All edge functions deployed successfully
- [ ] Database migration applied (webhook_dedup, feature_flags, rate_limits tables exist)
- [ ] Admin accounts created and verified
- [ ] Monitoring/alerting configured
- [ ] Incident response plan documented
- [ ] Legal/compliance review completed
- [ ] Insurance coverage confirmed
- [ ] Backup/recovery procedures tested

---

## 🚨 Automated Test Script (Optional)

```bash
#!/bin/bash
# security-test-suite.sh

echo "🔐 RowFantasy Security Test Suite"
echo "=================================="

PASSED=0
FAILED=0

run_test() {
  local test_name="$1"
  local test_command="$2"
  local expected_pattern="$3"
  
  echo -n "Testing: $test_name... "
  
  result=$(eval "$test_command" 2>&1)
  
  if echo "$result" | grep -q "$expected_pattern"; then
    echo "✅ PASS"
    ((PASSED++))
  else
    echo "❌ FAIL"
    echo "  Expected: $expected_pattern"
    echo "  Got: $result"
    ((FAILED++))
  fi
}

# Add test cases here
run_test "Unauthenticated matchmaking" \
  "curl -s -X POST $BASE_URL/contest-matchmaking -d '{}'" \
  "Authentication required"

# ... more tests ...

echo ""
echo "=================================="
echo "Results: $PASSED passed, $FAILED failed"

if [ $FAILED -gt 0 ]; then
  echo "❌ Security validation FAILED. Do not enable real money operations."
  exit 1
else
  echo "✅ All security tests passed!"
  exit 0
fi
```

---

## 📞 Support

If any test fails:
1. Review error logs in Supabase dashboard
2. Check `compliance_audit_logs` table
3. Verify edge function deployment
4. Consult `SECURITY.md` documentation
5. Do NOT enable real money until all issues resolved
