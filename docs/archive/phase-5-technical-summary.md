# Phase 5 Technical Summary: Contest Matchmaking, Scoring & Settlement

> **Status header (added 2026-07-12):** Historical design doc (2025-11-01). Table/status names here
> (e.g. `contest_instances`, status `completed`) may NOT match the current schema (see
> `contest_pools` and the real status vocabulary in CLAUDE.md). Kept for design context only —
> verify against current migrations before relying on any schema detail.

## Overview
Phase 5 implements the full contest lifecycle for RowFantasy, including automated matchmaking, multi-pool management, scoring calculations, automated settlement, and real-time leaderboards. All operations comply with skill-based fantasy contest regulations.

---

## Database Schema

### 1. `contest_instances`
Manages individual contest pools for each template.

**Columns:**
- `id` (uuid, PK): Unique instance identifier
- `contest_template_id` (uuid, FK): Links to contest template
- `pool_number` (text): Pool identifier (e.g., "A", "B", "C")
- `tier_id` (text): Entry tier (e.g., "$5", "$10", "$25")
- `entry_fee_cents` (bigint): Entry fee in cents
- `prize_pool_cents` (bigint): Total prize pool
- `max_entries` (integer): Maximum participants (default: 100)
- `min_entries` (integer): Minimum for contest to proceed (default: 2)
- `current_entries` (integer): Current participant count
- `lock_time` (timestamp): Contest lock deadline
- `status` (text): 'open' | 'locked' | 'completed'
- `locked_at` (timestamp): When contest locked
- `completed_at` (timestamp): When results posted
- `settled_at` (timestamp): When payouts processed
- `metadata` (jsonb): Additional data
- `created_at` (timestamp)

**Indexes:**
- `contest_instances_template_status_idx` on (contest_template_id, status)
- `contest_instances_lock_time_idx` on (lock_time)

**RLS Policies:**
- Admins can manage all instances
- Anyone can view open/locked/completed instances

---

### 2. `contest_scores`
Stores calculated scores and rankings for each entry.

**Columns:**
- `id` (uuid, PK): Score record identifier
- `entry_id` (uuid, FK): Links to contest_entries
- `instance_id` (uuid, FK): Links to contest_instances
- `user_id` (uuid, FK): User who submitted entry
- `total_points` (integer): Finish order points (primary)
- `margin_bonus` (numeric): Margin prediction bonus (tie-breaker)
- `rank` (integer): Final ranking
- `payout_cents` (bigint): Prize amount
- `is_winner` (boolean): Won prize money
- `is_tiebreak_resolved` (boolean): Tie broken by margin bonus
- `crew_scores` (jsonb): Individual crew performance breakdown
- `created_at` (timestamp)
- `updated_at` (timestamp)

**Indexes:**
- `contest_scores_entry_idx` (unique) on (entry_id)
- `contest_scores_instance_rank_idx` on (instance_id, rank)

**RLS Policies:**
- Admins can manage all scores
- Users can view their own scores
- Anyone can view scores in completed contests

---

### 3. `race_results_imports`
Audit trail for admin result uploads.

**Columns:**
- `id` (uuid, PK): Import record identifier
- `contest_template_id` (uuid, FK): Contest these results apply to
- `admin_id` (uuid, FK): Admin who uploaded
- `regatta_name` (text): Event name
- `results_data` (jsonb): Full race results array
- `rows_processed` (integer): Number of results
- `status` (text): 'pending' | 'completed' | 'failed'
- `file_hash` (text): SHA-256 hash for deduplication
- `errors` (jsonb): Validation errors if any
- `metadata` (jsonb): Additional import info
- `import_date` (timestamp)
- `created_at` (timestamp)

**Indexes:**
- `race_results_imports_template_idx` on (contest_template_id)
- `race_results_imports_hash_idx` on (file_hash)

**RLS Policies:**
- Admins can create and view imports
- System can update import status

---

## Edge Functions

### 1. `contest-matchmaking`
**Purpose:** Allocate users to contest pools, auto-create new pools when full.

**Endpoint:** `POST /functions/v1/contest-matchmaking`

**Input Schema:**
```typescript
{
  contestTemplateId: string (uuid),
  tierId: string,
  userId: string (uuid),
  picks: DraftPick[],
  entryFeeCents: number,
  stateCode: string
}
```

**Logic Flow:**
1. Validate contest template exists and is open
2. Check user hasn't already entered this tier
3. Find available pool (status='open', current_entries < max_entries)
4. If no pool available, create new pool with incremented pool_number
5. Create entry in `contest_entries` with instance_id
6. Increment instance current_entries
7. Create entry_fee_hold transaction
8. Log to compliance_audit_logs

**Output:**
```typescript
{
  entryId: string,
  instanceId: string,
  poolNumber: string,
  message: string
}
```

**Error Handling:**
- 404: Contest not found or not open
- 400: User already entered this tier
- 500: Database errors

---

### 2. `contest-scoring`
**Purpose:** Calculate points based on finish order + margin prediction.

**Endpoint:** `POST /functions/v1/contest-scoring`

**Input Schema:**
```typescript
{
  instanceId: string (uuid),
  results: Array<{
    crewId: string,
    divisionId: string,
    finishPosition: number,
    finishTime?: number,
    marginSeconds?: number
  }>
}
```

**Scoring Rules:**
- **Finish Points (Primary):**
  - 1st place: 10 points
  - 2nd place: 6 points
  - 3rd place: 3 points
  - 4th+: 0 points

- **Margin Bonus (Tie-breaker):**
  - Bonus = max(0, 10 - |predicted - actual|)
  - Capped at 10 points
  - Only used to break ties in finish points

**Logic Flow:**
1. Fetch all active entries for instance
2. For each entry, calculate:
   - Sum finish points for all picks
   - Calculate margin bonus for each pick
   - Total margin bonus (sum of all bonuses)
3. Sort by total_points DESC, then margin_bonus DESC
4. Assign ranks (handle ties)
5. Upsert to `contest_scores`
6. Update instance status to 'completed'
7. Log to compliance_audit_logs

**Output:**
```typescript
{
  instanceId: string,
  entriesScored: number,
  topScores: Array<{
    userId: string,
    rank: number,
    totalPoints: number,
    marginBonus: number
  }>,
  message: string
}
```

---

### 3. `contest-settlement`
**Purpose:** Distribute payouts and finalize contest.

**Endpoint:** `POST /functions/v1/contest-settlement`

**Input Schema:**
```typescript
{
  instanceId: string (uuid),
  forceResettle?: boolean
}
```

**Prize Distribution:**
- 1st place: 60% of prize pool
- 2nd place: 40% of prize pool (if 2+ entries)

**Logic Flow:**
1. Verify instance exists and has scores
2. Check not already settled (unless forceResettle=true)
3. Calculate prize pool (entry_fee * current_entries)
4. Retrieve ranked scores
5. Assign payouts to top 2
6. For winners:
   - Create contest_winnings transaction
   - Update wallet balance via `update_wallet_balance` RPC
   - Update score with payout_cents and is_winner
7. For non-winners:
   - Create entry_fee_release transaction (accounting only)
8. Update instance settled_at timestamp
9. Log to compliance_audit_logs

**Output:**
```typescript
{
  instanceId: string,
  totalEntries: number,
  prizePool: number,
  winnersCount: number,
  payouts: Array<{
    rank: number,
    payout: number
  }>,
  message: string
}
```

**Error Handling:**
- 404: Instance not found
- 400: No scores found (must run scoring first)
- 400: Already settled (use forceResettle=true to override)

---

### 4. `race-results-import`
**Purpose:** Admin CSV upload of race results with validation and auto-scoring.

**Endpoint:** `POST /functions/v1/race-results-import`

**Authentication:** Admin role required

**Input Schema:**
```typescript
{
  contestTemplateId: string (uuid),
  regattaName: string,
  results: Array<{
    crewId: string,
    crewName: string,
    divisionId: string,
    divisionName: string,
    finishPosition: number,
    finishTime?: string,
    marginSeconds?: number
  }>
}
```

**Validation Checks:**
- Contest template exists
- All crewIds exist in template
- All divisionIds exist in template
- No duplicate imports (SHA-256 hash check)

**Logic Flow:**
1. Authenticate admin user
2. Validate input schema
3. Calculate SHA-256 hash of results
4. Check for duplicate import
5. Validate crew and division IDs
6. Insert to `race_results_imports`
7. Update contest_template with results and lock status
8. Fetch all completed instances for template
9. Trigger scoring for each instance
10. Log to compliance_audit_logs

**Output:**
```typescript
{
  importId: string,
  resultsProcessed: number,
  instancesScored: number,
  scoringResults: Array<{
    instanceId: string,
    status: 'scored' | 'error'
  }>,
  message: string
}
```

---

## Frontend Components

### 1. `ContestLeaderboard.tsx`
**Purpose:** Real-time contest standings display.

**Props:**
- `instanceId` (string): Contest instance to display
- `autoRefresh` (boolean): Enable 30s polling

**Features:**
- Fetches scores ordered by rank
- Displays username, points, margin bonus
- Shows winner badges and payout amounts
- Auto-refreshes every 30s until completed
- Displays rank icons (trophy, medal, award)

**Data Flow:**
```typescript
contest_scores (with profiles join)
  → sort by rank
  → display in card list
  → poll every 30s if autoRefresh && status !== 'completed'
```

---

### 2. `MyEntries.tsx`
**Purpose:** User contest history and statistics.

**Features:**
- Displays all user contest entries
- Shows entry status (pending, active, completed)
- Links to contest detail pages
- Displays performance stats
- Filters by status

**Data Flow:**
```typescript
contest_entries (user_id = current user)
  → join contest_instances
  → join contest_templates
  → join contest_scores
  → display in cards
```

---

## Transaction Reconciliation

### Entry Fee Flow:
1. **Entry:** `entry_fee_hold` transaction created
   - Type: `entry_fee_hold`
   - Amount: entry_fee_cents / 100
   - Status: `completed`
   - Wallet balance: pending_balance increases

2. **Settlement (Winner):**
   - Original entry_fee_hold remains
   - New `contest_winnings` transaction
   - Wallet: pending decreases, available increases by winnings

3. **Settlement (Non-Winner):**
   - Create `entry_fee_release` transaction (amount=0)
   - Accounting record only, no balance change

### Wallet Balance Tracking:
- `available_balance`: Withdrawable funds
- `pending_balance`: Funds in active contests
- `lifetime_deposits`: Total deposits
- `lifetime_withdrawals`: Total withdrawals
- `lifetime_winnings`: Total contest prizes

---

## Compliance Logging

All major events logged to `compliance_audit_logs`:

### Event Types:
- `contest_entry_created`: User joins pool
- `contest_pool_created`: New instance created
- `contest_pool_filled`: Pool reaches max_entries
- `race_results_imported`: Admin uploads results
- `contest_scored`: Scoring engine completes
- `contest_settled`: Payouts distributed

### Log Structure:
```typescript
{
  event_type: string,
  user_id?: string,
  admin_id?: string,
  severity: 'info' | 'warn' | 'error',
  description: string,
  metadata: {
    instance_id?: string,
    pool_number?: string,
    entry_id?: string,
    contest_template_id?: string,
    prize_pool?: number,
    winners?: Array<{...}>
  },
  created_at: timestamp
}
```

---

## API Integration Points (Future)

### Ready for External Integration:
1. **Live Race Data:** Webhook to trigger `contest-scoring` when results available
2. **Payment Processors:** Extend `wallet-deposit`/`wallet-withdraw` with Stripe/ACH
3. **Analytics Dashboard:** Query `contest_scores` and `transactions` for reporting
4. **Fraud Detection:** Monitor `compliance_audit_logs` for suspicious patterns

### Existing Endpoints:
- All edge functions use internal Supabase auth
- No external API dependencies
- Ready for API gateway integration

---

## Testing Checklist

### Full Lifecycle Test:
1. ✅ User enters contest → `contest-matchmaking` creates entry
2. ✅ Pool reaches capacity → new pool auto-created
3. ✅ Admin uploads results → `race-results-import` validates
4. ✅ Scoring runs automatically → `contest-scoring` calculates points
5. ✅ Settlement triggers → `contest-settlement` distributes payouts
6. ✅ Leaderboard updates → displays final standings
7. ✅ Wallet reconciles → entry_fee_hold + payouts = correct balance
8. ✅ Compliance logs → all events recorded

### Transaction Reconciliation:
- Entry fee held in pending_balance
- Winners receive payouts in available_balance
- Non-winners have entry_fee_release record
- All transactions have matching wallet updates

### Security Verification:
- RLS policies enforce proper access control
- Admin functions require role validation
- No client-side privilege escalation possible
- All monetary operations logged

---

## Performance Considerations

### Indexes Created:
- `contest_instances_template_status_idx`: Fast pool lookups
- `contest_instances_lock_time_idx`: Scheduled lock checks
- `contest_scores_entry_idx`: Unique constraint enforcement
- `contest_scores_instance_rank_idx`: Leaderboard queries

### Optimization Opportunities:
- Consider materialized views for high-traffic leaderboards
- Cache contest templates client-side
- Batch scoring for multiple instances
- Async settlement processing for large contests

---

## Phase 5 Summary

**Total New Tables:** 3 (contest_instances, contest_scores, race_results_imports)  
**Total New Functions:** 4 (matchmaking, scoring, settlement, import)  
**Total New Components:** 2 (ContestLeaderboard, MyEntries)  
**Security Model:** RLS + server-side role validation  
**Transaction Safety:** ACID compliance, idempotency keys  
**Compliance:** Full audit trail of all contest operations  

**Status:** ✅ Ready for production deployment and Phase 6 integration.
