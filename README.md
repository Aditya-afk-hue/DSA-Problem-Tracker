# DSA Tracker — Pro license backend

A tiny Cloudflare Worker that replaces Gumroad: it creates Razorpay orders,
verifies completed payments, mints a license key per successful payment, and
answers "is this key active?" checks from the app. Runs entirely on
Cloudflare's free tier.

## 1. Razorpay setup

1. Sign up at https://razorpay.com and complete individual KYC (PAN + bank
   account). This can take a day or two to get approved for live payments —
   you can build and test everything below in **Test Mode** while you wait.
2. In the Razorpay Dashboard, go to **Settings → API Keys** and generate a
   key pair. You'll get a `Key Id` and a `Key Secret`. Keep the secret
   private — never put it in front-end code.
3. Note the price you want to charge — edit `PRICE_PAISE` at the top of
   `worker.js` (amount is in paise, so ₹499 = `49900`).

## 2. Cloudflare Worker setup

You'll need Node.js installed locally to run these commands.

```bash
npm install -g wrangler
wrangler login                     # opens a browser to authenticate

cd license-backend
wrangler kv namespace create LICENSES
# copy the returned "id" into wrangler.toml, replacing REPLACE_WITH_YOUR_KV_NAMESPACE_ID

wrangler secret put RAZORPAY_KEY_ID
# paste your Razorpay Key Id when prompted

wrangler secret put RAZORPAY_KEY_SECRET
# paste your Razorpay Key Secret when prompted

wrangler deploy
```

Wrangler will print a URL when it's done, something like:
`https://dsa-tracker-license-backend.<your-subdomain>.workers.dev`

That's your `BACKEND_URL` — you'll paste it into the app's `index.html`.

## 3. Lock down CORS (recommended before going live)

In `worker.js`, change:

```js
const ALLOWED_ORIGIN = '*';
```

to your actual site, e.g.:

```js
const ALLOWED_ORIGIN = 'https://aditya-afk-hue.github.io';
```

Then `wrangler deploy` again. This stops other sites from calling your
backend directly.

## 4. Switching from Test Mode to Live Mode

While Razorpay reviews your account, use your **Test** API keys (Test Mode
toggle in the dashboard) — test payments use dummy card numbers, no real
money moves. Once Razorpay approves your account for live payments, generate
**Live** API keys and re-run the two `wrangler secret put` commands with the
live values, then `wrangler deploy` again.

## How it works, end to end

1. User clicks "Buy Pro" in the app → app calls `POST /api/order`.
2. Worker asks Razorpay to create an order, returns `order_id` + a public
   `key_id` to the app.
3. App opens Razorpay's checkout popup with that order. User pays.
4. On success, Razorpay hands the app a `payment_id`, `order_id`, and a
   `signature`. The app sends all three to `POST /api/verify-payment`.
5. Worker recomputes the expected signature using the secret key (which
   only the Worker has) and compares it. If it matches, the payment is
   genuine — the Worker mints a license key, stores it in KV, and returns it.
6. The app stores that key locally and shows it to the user (they should
   save it — it's how they'd re-activate Pro on another device).
7. On every load, the app calls `POST /api/license/status` with the stored
   key to make sure it's still valid.

## Notes / limitations

- KV storage here is simple key→JSON. It's enough for tracking "is this key
  active," but if you want a real admin view of sales, refunds, etc., you'd
  eventually want a proper database (e.g. Cloudflare D1, or Supabase) instead
  of KV.
- This doesn't currently handle refunds automatically — if you refund someone
  in the Razorpay dashboard, you'd need to manually mark their key inactive
  (e.g. `wrangler kv key put --binding=LICENSES "key:THEKEY" '{"active":false}'`).
  A webhook-based refund handler is a reasonable next step if this matters to you.
