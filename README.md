# FEMADEXDRIVE v2.1 — frontend + backend

This is the upgraded version of the supplied FemmaDexDrive project. It is split into:

- `frontend/` — React/Vite responsive customer, rider, tracking and operations UI.
- `backend/` — Render Node API for secure routing, order creation, Paystack checkout/webhooks, public tracking and admin email notifications.
- `backend/supabase/migrations/001_femmadexdrive_v2.sql` — database schema, RLS, delivery state machine, rider approval, storage bucket and realtime setup.
- `netlify.toml` — builds and deploys the Netlify frontend.

## What was upgraded

### Customer

- Signup/login through Supabase Auth.
- OpenStreetMap address search and reverse geocoding through Nominatim, with MapLibre GL JS interactive maps.
- Server-side OpenRouteService driving distance and ETA from the selected coordinates.

- Weight entry for large and very large parcels, plus package dimensions.
- Motorcycle/car/van/lorry recommendation.
- Suggested delivery quotes are stored without exposing the suggested amount to customers.
- Admin/supervisor price approval or adjustment is audited before payment is enabled.
- Paystack checkout uses the approved amount read from Supabase on the server.
- Real Paystack checkout redirect.
- Payment is only considered paid after Paystack verification/webhook.
- Permanent tracking number.
- Public tracking without login, with limited information.
- Customer delivery dashboard.
- Customer/rider realtime chat.

### Rider

- Rider signup/application with vehicle and plate details.
- Bike/vehicle and identity-document upload area after account creation.
- Pending-review state and admin approval.
- Online/offline presence and compatible paid delivery requests.
- Atomic delivery acceptance and status changes.
- Rider sees recipient details and the admin-approved delivery price.
- Riders can accept or decline jobs; decisions are recorded in Supabase and declined jobs are hidden from that rider.
- Delivery stages: accepted → picked up → on the way → at destination → delivered.

### Admin

- Admin/supervisor role controlled in Supabase.
- Production admin host restriction using `VITE_ADMIN_HOST`.
- Delivery activity feed, full delivery details, price adjustment and payment status.
- Rider application approval, approval email, and availability.
- Realtime order updates.

### Email

Important delivery/payment events can be emailed to `femmadexmanagement@gmail.com` using Resend.
Supabase remains the searchable source of truth; email is an additional operational record/notification.

## Paystack

The backend uses Paystack's server-side Checkout Redirect flow. The secret key is never sent to the browser.

Required Render server variables:

- `PAYSTACK_SECRET_KEY`

For live payments, use your Paystack live secret key. During development, use the appropriate Paystack test credentials.

Paystack's webhook endpoint must be publicly reachable. Configure the Paystack webhook URL as:

`https://femmadexdrive.onrender.com/api/paystack-webhook`

The redirect URL is:

Paystack returns to the Render API callback, which verifies the transaction and redirects the customer to `https://femmadexdrive.netlify.app/payment-result`. The callback URL is derived from Render's `RENDER_EXTERNAL_URL`; it must not point to a Netlify Functions URL.

The webhook verifies `x-paystack-signature` with HMAC SHA-512 before changing an order to paid.

## Routing / distance

Set:

`ORS_API_KEY=...`

The backend geocodes the two addresses and sends their coordinates to OpenRouteService driving directions. It stores the resulting Precise Distance & ETA and estimated driving time.

Do not replace this with a browser-provided distance. The backend recalculates it.

## Admin account and password

No admin password is stored in this project. Create the operations account in Supabase Auth, then run `backend/supabase/ADMIN_SETUP.sql` to create or repair its profile and promote the configured UID/email to the `admin` role. The script verifies that the Auth user exists and that its email matches. The frontend does not expose a password or admin secret.

## Security

See `SECURITY.md`. The application uses server-side secrets, Supabase RLS, private rider-document storage, Paystack webhook verification, atomic rider acceptance, vehicle eligibility checks, security headers and participant-only chat. No web application can honestly guarantee that it is impossible to hack.

## Supabase setup

1. Create a Supabase project.
2. Open SQL Editor and run migrations `001_femmadexdrive_v2.sql` through `015_package_categories_without_measurements.sql` in order. Migration 006 is safe to apply when chat/call tables already exist. Apply migrations 014 and 015 before deploying the matching frontend.

3. Create/confirm your Auth settings.
4. Create your first admin account through Supabase Auth.
5. Run `backend/supabase/VERIFY_SCHEMA.sql`. Confirm every row reports `installed = true` before proceeding.
6. Run `backend/supabase/ADMIN_SETUP.sql` to create or repair the intended operations account's profile and promote it by its configured Auth UUID.

Do not put the admin password in source code.

The migration creates a private `rider-documents` storage bucket.

## Rider matching, offers, and operations

Migration 014 adds per-rider delivery offers, explicit eligibility checks, audited assignment history, operations alerts, and atomic assignment/reassignment RPCs. It preserves Paystack's `payment_status` and changes neither payment verification nor payment state during dispatch.

The compatibility matrix is intentionally exact rather than rank-based:

| Delivery requirement | Eligible rider vehicle |
| --- | --- |
| Motorcycle / bike | Motorcycle / bike |
| Car | Car |
| Van (legacy category) | Van |
| Truck / lorry | Truck / lorry |

In particular, a truck does not automatically receive motorcycle or car deliveries. Extend this matrix only after operations has approved the corresponding business rule.

Offers expire after 90 seconds by default. Pending paid orders remain in `paid` (or the existing `searching` status) with `rider_id IS NULL`; declined and timed-out offers are stored per rider, while other eligible riders continue to receive offers. An online rider's dashboard refreshes every 15 seconds and also listens for Supabase Realtime changes. Going online and the operations dashboard refresh the queue immediately. No extra environment variables are required.

The offer and unassigned-alert periods are configurable in Supabase SQL Editor by an operations DBA, for example:

```sql
update public.dispatch_settings
set offer_timeout_seconds = 90,
    unassigned_alert_minutes = 15,
    updated_at = now()
where id = true;
```

Migration 015 adds a nullable `orders.package_category` column; it does not overwrite old package or measurement data. New bookings store `small`, `medium`, or `bulky`; old rows without this value display a category inferred from the existing `package_size`. The four measurement columns remain in place and new bookings store `NULL` rather than fabricated values. Every new quote remains unpaid and awaits operations price approval. Operations must record the safe vehicle decision and reason before approving the customer-facing price. The customer then sees the approved vehicle and price and must initiate the existing Paystack checkout.

Run `backend/supabase/VERIFY_SCHEMA.sql` after migration 015, then run `backend/supabase/tests/014_dispatch_contract.sql` and `backend/supabase/tests/015_package_category_contract.sql` in the Supabase SQL Editor. These checks create no users, orders, or payments. Resolve duplicate active rider assignments before migration 014 if it reports that the one-active-delivery unique index cannot be installed; do not delete delivery history to make the migration pass. Run the backend package-rule tests with `node --test tests/package-selection.test.mjs` from `backend/`.

Do not apply migrations or deploy automatically as part of this code change. For a rollout after approval, first apply migration 015 after existing migrations through 014, run the schema/SQL checks above, then deploy the updated Render API and Vite frontend. The API change reuses existing environment settings; no new secrets or variables are required. Preserve the existing Paystack, routing and auto-completion configuration. Use the existing Netlify base directory `frontend`, build command `npm install --no-audit --no-fund && npm run build`, and publish directory `dist`. Do not add a Supabase service-role key to Netlify or any `VITE_*` setting.

The operations dashboard's live alerts are backed by `dispatch_alerts`, `order_events`, and `rider_offers` and refresh through Supabase Realtime plus a 15-second fallback. It includes no-compatible-rider, exhausted/expired offer, overdue unassigned delivery, rider problem, and reassignment alerts. Delivery phone details are returned only through the authorised contact RPC. Reassignment after pickup requires operations to confirm custody and enter recovery/handover arrangements; the prior assignment remains in `order_assignment_history`.

### Manual dispatch verification checklist

- Verify the matrix for motorcycle, car, truck, and the explicitly retained legacy van/lorry aliases. Confirm truck offers do not appear for car or motorcycle orders.
- Submit each package category without weight or dimension values. Confirm the selected category is stored and displayed in the customer order, rider offer, and admin order details; confirm the legacy measurement columns remain unchanged on existing orders.
- Verify that new unmeasured quotes carry `requires_manual_review`, are not paid, and cannot be approved until operations records a verified vehicle. Change the vehicle and price in operations, confirm the customer sees the revised quote, and verify Paystack cannot be initialized before the customer initiates payment.
- With no compatible approved rider online, verify the paid order remains unassigned and the operations dashboard shows the pending/no-compatible-rider state.
- Bring a compatible approved rider online and verify the offer appears without changing payment status.
- Decline with and without a reason; verify this rider no longer sees the offer, another compatible rider can, and the order remains pending.
- Let an offer expire; verify timeout history, retry to another eligible rider, and the all-offers-exhausted alert when applicable.
- Go offline or suspend a rider after an offer; verify acceptance fails and no new offer is returned. Verify suspending an assigned rider is blocked until the active delivery is resolved.
- Have two authorised rider sessions attempt the same offer concurrently; verify exactly one assignment and one active order per rider.
- Report problems both before and after pickup. Verify admin alerts; after pickup, verify reassignment cannot proceed without explicit custody confirmation and a recorded handover/recovery note.
- Manually assign a different eligible rider and verify the assignment history records both riders and the operations reason.
- Verify customer Realtime status and customer-visible activity after assignment, return-to-pool, and reassignment. Customer contact actions must expose the assigned rider's contact only after assignment; recipient details in an offer must be available only to that offer's approved, online, compatible rider.
- Confirm unpaid orders never appear in rider offers, and no dispatch RPC changes Paystack payment records or payment status.
- Attempt customer role escalation, rider self-approval/vehicle changes, unauthorised admin reassignment, and anonymous RPC execution; verify each is denied.
- Recheck the existing chat, calls, maps, public tracking, customer confirmation, and Paystack callback/webhook workflows.

### Existing test accounts

Create and confirm each customer, rider, and admin account in Supabase Authentication first. Then run `backend/supabase/TEST_ACCOUNTS_SETUP.sql` to safely sync `profiles.role` by Auth email. It is safe to rerun, does not create users or change passwords, and does not depend on hard-coded UUIDs. It creates a missing rider profile as pending; approve the rider before dispatch testing. Login reads `profiles.role` after password verification and routes to the matching dashboard.

## Environment files and Netlify variables

Local development is split by trust boundary:

- `frontend/.env` contains only browser-public `VITE_*` settings. The matching template is `frontend/.env.example`.
- `backend/.env` contains server-only settings. The matching template is `backend/.env.example`.
- Do not create a root `.env`, commit either local file, or put a server secret in a `VITE_*` variable.

The backend reads `SUPABASE_SECRET_KEY` (a Supabase server secret key) or, for older projects, `SUPABASE_SERVICE_ROLE_KEY`. Never use the anon/publishable key for server-side database work. The local server secret and Paystack key should be newly rotated values; the existing exposed values must not be reused.

Browser variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_BASE_URL`
- `VITE_ADMIN_HOST`
- `VITE_SUPPORT_PHONE`

Server-only variables:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`)
- `APP_ORIGIN`
- `PAYSTACK_SECRET_KEY`
- `ORS_API_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `ADMIN_EMAIL`
- pricing variables

Never prefix a secret with `VITE_`.

## Pricing

The quote engine uses the routing provider's verified road distance, a ₦1,500 base, the first 5 km included, ₦150 per additional kilometre, a ₦2,000 minimum, and a package-category estimate adjustment (₦0 small, ₦500 medium, ₦1,000 bulky). This is a suggested quote, not a confirmed charge: operations must verify the vehicle and may set a revised price, which is shown to the customer before checkout. No weight or dimensions are inferred from a selected category.

## Deployment

The root `netlify.toml` builds and serves the frontend only. The API runs separately on Render from `backend/server.mjs`.

### Netlify frontend

Use `femmadexdrive.netlify.app`. Set base directory `frontend`, build command `npm install --no-audit --no-fund && npm run build`, and publish directory `dist`. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL=https://femmadexdrive.onrender.com/api`, and `VITE_ADMIN_HOST=femmadexdrive.netlify.app` in Netlify's build environment. MapLibre loads OpenStreetMap tiles directly over HTTPS; address search and Nominatim reverse-geocoding use the configured backend API rather than browser-to-Nominatim requests. No Mapbox token is required.

### Render API

Create a Render Web Service from this repository with root directory `backend`, build command `npm install`, start command `npm start`, and Node 20 or newer. Set server variables in Render, including `ORS_API_KEY` for OpenRouteService road routing. Set `APP_ORIGIN=https://femmadexdrive.netlify.app`. The Paystack return callback is generated using Render's `RENDER_EXTERNAL_URL`; do not configure a Netlify callback URL. Configure the Paystack webhook URL as `https://femmadexdrive.onrender.com/api/paystack-webhook`. After approval, apply Supabase migrations 001–015 in order before deploying the updated quote API and customer UI; run both dispatch and package-category SQL contract tests before rollout.


The API exposes `/health` and endpoints under `/api/`. Automatic delivery completion runs at startup and once per minute in the Render process. Locally, run `npm run dev` from `frontend/` and `npm start` from `backend/`; without `VITE_API_BASE_URL`, Vite proxies `/api` to the local backend at `127.0.0.1:10000` (override with `API_PROXY_TARGET` if needed). Frontend-only browser variables belong in `frontend/.env`, while server-only variables belong in `backend/.env`.

For voice calls, set `LIVEKIT_URL=wss://femmadexdrive-8px9a45n.livekit.cloud`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in Render only. The authenticated API checks delivery participation and issues short-lived, microphone-only room tokens. Never put the API secret in a `VITE_*` variable or source control. Browsers must grant microphone access.

Netlify production builds do not read local `.env` files. Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`, and `VITE_ADMIN_HOST` in Netlify; configure `APP_ORIGIN=https://femmadexdrive.netlify.app`, `ORS_API_KEY`, and the required Supabase server credentials in Render. The browser sends authenticated quotes to `/api/quote`; the backend validates the Supabase session and customer role, verifies pickup/dropoff addresses, and calls OpenRouteService using its server-only `ORS_API_KEY`. Never place Supabase server secrets, Paystack keys, or the ORS key in a `VITE_*` variable. Redeploy both services after changing their environment variables.

New delivery requests are calculated through the authenticated `/api/quote` endpoint using the OpenRouteService `driving-car/geojson` route. The backend prices the route at ₦1,500 base fare, first 5 km included, ₦150/km after that, and a ₦2,000 minimum, plus ₦500 for medium and ₦1,000 for large/very-large packages. Quotes await admin/supervisor review; only the approved amount is available to customer checkout. Apply migration 011 before using the updated quote flow.

Run `npm run check:live` from `frontend/` before deployment. It checks Supabase Auth, database tables, Paystack key acceptance, routing/email credentials, Netlify and Render reachability, CORS, and that the callback route is registered on the Render API. These read-only probes do not initialize a payment or send email.

Build:

```bash
cd frontend
npm install
npm run build
```

The required environment variables must be configured before real Supabase/Paystack/routing/email flows can operate. A successful frontend build proves compilation only; it is not a substitute for `npm run check:live` and the production checklist below.

## Customer and rider test accounts

Accounts are real Supabase Auth users. Create/confirm the customer, rider, and permanent admin accounts in Supabase Auth, then run `backend/supabase/TEST_ACCOUNTS_SETUP.sql` to sync `profiles.role` by email. It never creates Auth accounts or changes passwords, and preserves existing profile names and rider application details. Login routes each account by its database role. The setup leaves the test rider pending; approve the rider from the admin dashboard before testing dispatch. Set/change passwords in Supabase Auth only, never in SQL or source.

## Important production checks before accepting real customers

The Render API process runs automatic completion every minute using migration 002. Confirm the scheduler logs after deployment. Migration 007 stores the selected pickup/dropoff coordinates and adds them to the rider's available-deliveries feed; apply it before deploying the coordinate-dependent order API.

- Verify your Paystack business account and live credentials.
- Configure and test the Paystack webhook.
- Verify your Paystack redirect URL.
- Verify the ORS routing key and usage limits.
- Configure a verified Resend sender/domain when moving beyond testing.
- Set the real admin hostname.
- Promote exactly the intended operations account to `admin`.
- Test Supabase RLS with customer, rider and admin accounts separately.
- Test failed, pending, duplicated and successful payment webhooks.
- Migration 005 enforces at most one pending checkout per delivery and applies verified payment and order-state changes atomically.
- Test an order that is rejected by rider eligibility.
- Test customer delivery confirmation and the five-minute auto-confirmation job separately.
- Confirm automatic completion is running by checking the Render service logs after deployment.

## Local environment files

The local `frontend/.env` and `backend/.env` contain sensitive configuration and are ignored by `.gitignore`. Treat credentials previously pasted into chat or logs as compromised: rotate Supabase, Paystack, routing, and email keys before live use. Any `VITE_*` value is bundled into the browser, so only the Supabase URL and public anon key belong there; keep server credentials out of frontend settings.

## Delivery charge model

The browser never sets the final charge. The backend geocodes both addresses, calculates route distance and duration, and creates a package-category estimate. The selected category is guidance, not proof of actual capacity: without verified measurements, the vehicle is provisional and the quote is flagged for operations review. The admin/supervisor records a verified vehicle and price before the order becomes payable. The customer can then choose to start Paystack checkout; dispatch logic never changes payment status.

## Customer ↔ rider chat

Each assigned delivery has its own realtime chat room backed by `chat_messages` and Supabase Realtime. RLS allows only the customer and assigned rider to read/write an active delivery chat. Admins can read operational records. Rider/customer contact details are returned through a participant-checked RPC.

## Automatic delivery confirmation

When a rider marks an order `delivered`, the customer has five minutes to confirm. The Render process checks once per minute and server-side marks overdue deliveries `completed`, recording an `auto_completed` event.
