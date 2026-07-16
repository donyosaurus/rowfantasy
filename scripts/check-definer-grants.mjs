#!/usr/bin/env node
// CI guard: money/admin SECURITY DEFINER functions must stay service-role-only.
//
// Why this exists: the EXECUTE grant on enter_contest_pool_atomic regressed to
// `authenticated` THREE times via auto-generated migrations (most recently
// 20260701033634), silently re-opening a compliance-bypass hole (audit finding
// C1, 2026-07-03). This script replays every migration in order and fails CI if
// any guarded function ends up with an outstanding EXECUTE grant to
// authenticated / anon / PUBLIC.
//
// Limitations (by design, kept simple):
// - Parses explicit GRANT/REVOKE statements only. It does not model Postgres
//   default privileges; the guarded functions all have explicit REVOKE+GRANT
//   pairs in their lockdown migrations, so drift shows up as an un-revoked
//   explicit GRANT — exactly the C1 pattern.
// - Keyed by function NAME (not signature). All guarded names have a single
//   live signature; a same-name overload granted to authenticated should fail
//   the build anyway.
//
// To intentionally open a guarded function to end users: remove it from
// GUARDED_FUNCTIONS in the same PR and say why in the commit message.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

// Money-moving / admin / compliance DEFINER RPCs. Service-role-only, always.
const GUARDED_FUNCTIONS = [
  'enter_contest_pool_atomic',
  'settle_contest_pool_atomic',
  'void_contest_pool_atomic',
  'settle_pool_payouts',
  'admin_resize_contest_pool_atomic',
  'admin_create_contest',
  'admin_void_contest',
  'admin_update_race_results',
  'admin_override_responsible_gaming',
  'admin_list_wallet_balances',
  'apply_pending_responsible_gaming_limit',
  'cancel_pending_withdrawal_atomic',
  'check_deposit_eligibility',
  'check_deposit_limit',
  'check_rate_limit_atomic',
  'initiate_withdrawal_atomic',
  'process_deposit_atomic',
  'process_webhook_deposit_atomic',
  'update_wallet_balance',
  'soft_delete_user_account',
  'increment_pool_entries',
  'clone_contest_pool',
  'calculate_pool_scores',
  'enqueue_email',
  'read_email_batch',
  'delete_email',
  'move_to_dlq',
  'auto_lock_expired_contests',
];

const FORBIDDEN_ROLES = ['public', 'anon', 'authenticated'];

// Strip SQL comments so commented-out statements don't count.
const stripComments = (sql) =>
  sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const parseRoles = (roleList) =>
  roleList
    .split(',')
    .map((r) => r.trim().toLowerCase().replace(/^role\s+/, ''))
    .filter(Boolean);

const buildGrantState = (files) => {
  // fn name -> Set of roles with an outstanding explicit EXECUTE grant
  const state = new Map(GUARDED_FUNCTIONS.map((fn) => [fn, new Set()]));
  // fn name -> whether the function currently exists (per migration replay)
  const exists = new Map(GUARDED_FUNCTIONS.map((fn) => [fn, false]));
  const history = [];

  // Statement-level regexes; all matched against the same source and sorted by
  // offset so CREATE/DROP/GRANT/REVOKE replay in true file order. A migration
  // that does DROP + CREATE (without a following REVOKE FROM PUBLIC) leaves
  // the function with the Postgres-default EXECUTE grant to PUBLIC — modeled
  // here by adding 'public' to the role set on fresh CREATE.
  const grantRe =
    /\bGRANT\s+(?:EXECUTE|ALL)(?:\s+PRIVILEGES)?\s+ON\s+FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+TO\s+([^;]+);/gi;
  const revokeRe =
    /\bREVOKE\s+(?:EXECUTE|ALL)(?:\s+PRIVILEGES)?\s+ON\s+FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+FROM\s+([^;]+);/gi;
  const dropRe =
    /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?/gi;
  const createRe =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;

  const collect = (sql, re, kind) => {
    const out = [];
    for (const m of sql.matchAll(re)) {
      out.push({ index: m.index, kind, match: m });
    }
    return out;
  };

  for (const file of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    const events = [
      ...collect(sql, grantRe, 'GRANT'),
      ...collect(sql, revokeRe, 'REVOKE'),
      ...collect(sql, dropRe, 'DROP'),
      ...collect(sql, createRe, 'CREATE'),
    ].sort((a, b) => a.index - b.index);

    for (const ev of events) {
      const fn = ev.match[1];
      if (!state.has(fn)) continue;
      if (ev.kind === 'DROP') {
        exists.set(fn, false);
        state.get(fn).clear();
        history.push({ file, fn, action: 'DROP' });
      } else if (ev.kind === 'CREATE') {
        // Fresh CREATE (or CREATE-after-DROP) resets ACL to default: EXECUTE
        // to PUBLIC. CREATE OR REPLACE of an existing fn preserves the ACL.
        if (!exists.get(fn)) {
          exists.set(fn, true);
          state.get(fn).add('public');
          history.push({ file, fn, action: 'GRANT', role: 'public' });
        }
      } else if (ev.kind === 'GRANT') {
        const roleList = ev.match[2];
        for (const role of parseRoles(roleList)) {
          state.get(fn).add(role);
          history.push({ file, fn, action: 'GRANT', role });
        }
      } else if (ev.kind === 'REVOKE') {
        const roleList = ev.match[2];
        for (const role of parseRoles(roleList)) {
          state.get(fn).delete(role);
          history.push({ file, fn, action: 'REVOKE', role });
        }
      }
    }
  }

  return { state, history };
};

const main = () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.error('check-definer-grants: no migrations found — refusing to pass vacuously');
    process.exit(2);
  }

  const { state, history } = buildGrantState(files);
  const violations = [];

  for (const [fn, roles] of state) {
    for (const role of roles) {
      if (FORBIDDEN_ROLES.includes(role)) {
        const lastGrant = [...history]
          .reverse()
          .find((h) => h.fn === fn && h.role === role && h.action === 'GRANT');
        violations.push({ fn, role, file: lastGrant?.file ?? 'unknown' });
      }
    }
  }

  if (violations.length > 0) {
    console.error('❌ DEFINER grant guard FAILED — guarded functions must be service-role-only:\n');
    for (const v of violations) {
      console.error(`   ${v.fn}: outstanding EXECUTE grant to "${v.role}" (last granted in ${v.file})`);
    }
    console.error(
      '\nIf intentional, remove the function from GUARDED_FUNCTIONS in scripts/check-definer-grants.mjs'
    );
    console.error('and justify it in the commit message. Otherwise add a REVOKE migration.');
    process.exit(1);
  }

  console.log(`✅ DEFINER grant guard passed: ${GUARDED_FUNCTIONS.length} guarded functions, ${files.length} migrations replayed.`);
};

main();
