# FEMADEXDRIVE v2.1 — frontend + backend

This is the upgraded version of the supplied FemmaDexDrive project. It is split into:

- `frontend/` — React/Vite responsive customer, rider, tracking and operations UI.
- `backend/` — Render Node API for secure routing, order creation, Paystack checkout/webhooks, public tracking and admin email notifications.
- `backend/supabase/migrations/001_femmadexdrive_v2.sql` — database schema, RLS, delivery state machine, rider approval, storage bucket and realtime setup.
- `netlify.toml` — builds and deploys the Netlify frontend.

## What was upgraded

### Customer

- Signup/login through Supabase Auth.
- Server-side road-distance calculation.
- Weight entry for large and very large parcels, plus package dimensions.
- Motorcycle/car/van/lorry recommendation.
- Server-side pricing so the browser cannot change the price calculation.
- Recipient name/address capture and admin-adjustable final price before payment.
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
- `PAYSTACK_CALLBACK_URL`

For live payments, use your Paystack live secret key. During development, use the appropriate Paystack test credentials.

Paystack's webhook endpoint must be publicly reachable. Configure the Paystack webhook URL as:

`https://femmadexdrive.onrender.com/api/paystack-webhook`

The redirect URL is:

`https://femmadexdrive.netlify.app/payment-result` (the Render callback redirects here after verification)

The webhook verifies `x-paystack-signature` with HMAC SHA-512 before changing an order to paid.

## Routing / distance

Set:

`ORS_API_KEY=...`

The backend geocodes the two addresses and sends their coordinates to OpenRouteService driving directions. It stores the resulting Precise Distance & ETA and estimated driving time.

Do not replace this with a browser-provided distance. The backend recalculates it.

## Admin account and password

No admin password is stored in this project. Create the one operations account in Supabase Auth with your chosen strong password, then run `backend/supabase/ADMIN_SETUP.sql` to promote `femmadexmanagement@gmail.com` to the `admin` role. The frontend does not expose a password or admin secret.

## Security

See `SECURITY.md`. The application uses server-side secrets, Supabase RLS, private rider-document storage, Paystack webhook verification, atomic rider acceptance, vehicle eligibility checks, security headers and participant-only chat. No web application can honestly guarantee that it is impossible to hack.

## Supabase setup

1. Create a Supabase project.
2. Open SQL Editor and run migrations `001_femmadexdrive_v2.sql` through `008_delivery_recipient_price_and_responses.sql` in order. Migration 006 is safe to apply when chat/call tables already exist.
3. Create/confirm your Auth settings.
4. Create your first admin account through Supabase Auth.
5. Run `backend/supabase/ADMIN_SETUP.sql` to promote the intended operations account, or promote its verified profile by UUID:

`update public.profiles set role='admin' where id='YOUR_AUTH_USER_UUID';`

Do not put the admin password in source code.

The migration creates a private `rider-documents` storage bucket.

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
- `PAYSTACK_CALLBACK_URL`
- `ORS_API_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `ADMIN_EMAIL`
- pricing variables

Never prefix a secret with `VITE_`.

## Pricing

Default pricing values are environment variables so you can change the business rules without rewriting the application.

The initial engine uses:

`base vehicle fee + Precise Distance & ETA × vehicle km rate`

and a simple heavy-weight surcharge.

These are starter values only. Replace them with FEMADEXDRIVE's real pricing policy.

## Deployment

The root `netlify.toml` builds and serves the frontend only. The API runs separately on Render from `backend/server.mjs`.

### Netlify frontend

Use `femmadexdrive.netlify.app`. Set base directory `frontend`, build command `npm install --no-audit --no-fund && npm run build`, and publish directory `dist`. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL=https://femmadexdrive.onrender.com/api`, and `VITE_ADMIN_HOST=femmadexdrive.netlify.app` in Netlify's build environment.

### Render API

Create a Render Web Service from this repository with root directory `backend`, build command `npm install`, start command `npm start`, and Node 20 or newer. Set server variables in Render. Set `APP_ORIGIN=https://femmadexdrive.netlify.app` and `PAYSTACK_CALLBACK_URL=https://femmadexdrive.onrender.com/api/paystack-callback`. Configure the Paystack webhook URL as `https://femmadexdrive.onrender.com/api/paystack-webhook`. Apply Supabase migrations 001–008 before enabling production traffic.

The API exposes `/health` and endpoints under `/api/`. Automatic delivery completion runs at startup and once per minute in the Render process. Locally, run `npm run dev` from `frontend/` and `npm start` from `backend/`; frontend-only browser variables belong in `frontend/.env`, while server-only variables belong in `backend/.env`.

For voice calls, set `LIVEKIT_URL=wss://femmadexdrive-8px9a45n.livekit.cloud`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in Render only. The authenticated API checks delivery participation and issues short-lived, microphone-only room tokens. Never put the API secret in a `VITE_*` variable or source control. Browsers must grant microphone access.

Netlify production builds do not read local `.env` files. Configure browser variables in Netlify and server variables in Render, then redeploy both services. Never place Supabase server secrets or Paystack keys in `VITE_*` variables.

Run `npm run check:live` from `frontend/` before deployment. It checks Supabase Auth, database tables, Paystack key acceptance, routing/email credentials, Netlify and Render reachability, CORS, and callback URL consistency. These read-only probes do not initialize a payment or send email.

Build:

```bash
cd frontend
npm install
npm run build
```

The required environment variables must be configured before real Supabase/Paystack/routing/email flows can operate. A successful frontend build proves compilation only; it is not a substitute for `npm run check:live` and the production checklist below.

## Customer and rider test accounts

Accounts are real Supabase Auth users. Create/confirm the customer, rider, and permanent admin accounts in Supabase Auth, then run `backend/supabase/TEST_ACCOUNTS_SETUP.sql` to sync `profiles.role` by email. It never creates Auth accounts or changes passwords. Login routes each account by its database role. The SQL explicitly auto-approves and sets online only the named test rider so it can accept test deliveries; remove that test-only update before using the setup script for live rider onboarding. Other new riders remain pending until approved. Set/change passwords in Supabase Auth only, never in SQL or source.

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

The browser never sets the final charge. The backend geocodes both addresses, calculates Precise Distance & ETA and driving duration through the routing provider, selects a vehicle from package weight/size rules, and calculates the system estimate. The order begins in `price_review`; only an admin/supervisor can release it to `awaiting_payment` by setting the final price. Paystack checkout can only be initialized for an `awaiting_payment` order.

## Customer ↔ rider chat

Each assigned delivery has its own realtime chat room backed by `chat_messages` and Supabase Realtime. RLS allows only the customer and assigned rider to read/write an active delivery chat. Admins can read operational records. Rider/customer contact details are returned through a participant-checked RPC.

## Automatic delivery confirmation

When a rider marks an order `delivered`, the customer has five minutes to confirm. The Render process checks once per minute and server-side marks overdue deliveries `completed`, recording an `auto_completed` event.
