# FEMADEXDRIVE security model

No web application can honestly promise to be impossible to hack. This build is hardened so that compromising the frontend alone does not grant administrative or payment authority.

## What is protected

- Paystack secret key is server-only.
- Supabase service-role key is server-only.
- Order creation and pricing are server-side.
- Payment is not considered successful from a browser redirect alone.
- Paystack webhook signatures are checked; the browser callback independently verifies the transaction with Paystack before applying payment state.
- Supabase Row Level Security protects customer, rider, chat and admin data.
- Rider delivery visibility is filtered by approved/online status and compatible vehicle.
- Rider acceptance is atomic, preventing two riders from claiming the same order.
- Rider identity/vehicle files are stored in a private bucket.
- Admin authorization is determined by the database role, not by a hidden frontend URL.
- Migration `004_lockdown_self_updates.sql` restricts authenticated users from editing their own role or rider-approval fields.
- Migration `005_paystack_idempotency.sql` prevents concurrent pending checkouts and applies payment completion atomically.
- The admin hostname is additionally restricted at the UI layer.
- Security headers are configured in Netlify.
- Chat messages are restricted to participants of an active assigned delivery.
- Delivery auto-completion runs server-side rather than relying on a browser timer.

## Admin password

No admin password is embedded in the project. Create the admin user in Supabase Auth and promote the account using `backend/supabase/ADMIN_SETUP.sql`.

## Production checklist

- Use a strong unique admin password and enable MFA in Supabase if available for your plan.
- Never commit `.env` files.
- Use Paystack live credentials only in Render server environment variables.
- Configure `APP_ORIGIN` to the exact production site origin.
- Configure `VITE_ADMIN_HOST` to the actual admin hostname/site.
- Apply Supabase migrations 001–005 in order and verify the role-escalation and payment-idempotency protections.
- Verify Paystack webhook delivery and signature validation before accepting live orders.
- Test customer, rider and admin RLS separately.
- Keep Supabase, Netlify, Render and Paystack accounts protected with MFA.
