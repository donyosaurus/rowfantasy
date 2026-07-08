# Support Inbox

Two-sided ticket threading built on the existing `support_tickets` table.

## 1. Database

New table `support_ticket_replies`:
- `ticket_id` → `support_tickets.id` (cascade)
- `author_user_id` → `auth.users` (nullable for system entries)
- `author_role` — `user` | `admin` | `system`
- `body` text (1–5000 chars)
- `created_at`

Also add to `support_tickets`:
- `last_reply_at timestamptz`
- `last_reply_by text` (`user` | `admin`) — drives "unread" badge

RLS:
- User can `SELECT` replies on their own tickets, `INSERT` replies as `author_user_id = auth.uid()` where they own the ticket and it's not `closed`.
- Admin (`has_role`) can `SELECT`/`INSERT` on all.
- GRANTs to `authenticated` and `service_role`.

Trigger on reply insert → updates `support_tickets.status`, `last_reply_at`, `last_reply_by`, `updated_at`.

## 2. Edge functions

- `support-ticket-reply` (POST) — user or admin posts a reply. Validates ticket access, inserts reply, enqueues notification email (via existing `enqueue_email` → `transactional_emails`) to the *other* party:
  - Admin reply → email the user "You have a new reply on ticket #…"
  - User reply → email `rowfantasy@gmail.com` (support inbox) with subject `[Ticket ####] New user reply`
- `support-ticket-thread` (GET) — returns ticket + ordered replies. User sees own, admin sees any.
- `admin-support-tickets` (GET) — admin list with filters (status, topic, search email/subject), unread flag, counts.
- Extend existing `support-tickets` GET to include `last_reply_at`, `last_reply_by`, unread flag.

## 3. Frontend

- **New page `/my-tickets`** (`src/pages/MyTickets.tsx`):
  - List of user's tickets (subject, topic, status, last activity, unread dot when `last_reply_by = 'admin'` and user hasn't viewed since).
  - Click → thread drawer/page with message bubbles (user right, admin left) + reply composer (disabled if `closed`).
  - Link added in Profile menu + Header user dropdown.
- **Admin inbox** (`src/pages/Admin.tsx` new tab "Support"):
  - Left column: filterable ticket list (status tabs: Open / In progress / Waiting / Resolved / Closed).
  - Right pane: full thread, status selector, reply composer, quick actions (assign to me, mark resolved, close).
- **Contact page** already creates tickets — after submit, redirect authed users to `/my-tickets/:id`.

## 4. Emails

Reuse existing branded HTML style from `otp-request`. Two templates inlined in the edge function (no new registry work needed):
- User notification: "New reply on your support ticket" + subject + preview + CTA to `/my-tickets/:id`.
- Admin notification: plain internal email to `rowfantasy@gmail.com` with ticket link to `/admin?tab=support&ticket=:id`.

## Out of scope (explicit)
- File attachments.
- Inbound email → ticket (users still reply inside the app).
- Canned responses / macros.
- SLA timers.

## Technical notes
- No new secrets required.
- Reply notifications go through the existing pgmq `transactional_emails` queue with idempotency key `reply-<reply_id>`.
- Admin notification recipient is the constant `rowfantasy@gmail.com` per project memory.
- Unread state is derived: `last_reply_by = 'admin' AND user_last_viewed_at < last_reply_at` — track `user_last_viewed_at` on `support_tickets` (updated when user opens the thread).
