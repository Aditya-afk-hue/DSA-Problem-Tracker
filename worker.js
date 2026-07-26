// DSA Tracker — Pro license backend
// Runs on Cloudflare Workers. Talks to Razorpay for payment, stores issued
// license keys in a Cloudflare KV namespace, and answers status checks from
// the front-end app. Also stores generated certificates so they can be
// looked up by Verification ID alone, instead of requiring every field to
// be retyped and re-hashed client-side.
//
// Endpoints:
//   POST /api/order                -> creates a Razorpay order, returns order_id + key_id
//   POST /api/verify-payment       -> verifies a completed payment's signature, issues a license key
//   POST /api/license/status       -> { license_key } -> { active: true|false }
//   POST /api/certificate/register -> { license_key, id, ...fields } -> stores a certificate record
//   POST /api/certificate/lookup   -> { id } -> the stored record, if any

const PRICE_PAISE = 49900; // ₹499.00 — change this to whatever you want to charge, in paise
const CURRENCY = 'INR';

// Lock this down to your actual site once it's live, e.g. 'https://aditya-afk-hue.github.io'
const ALLOWED_ORIGIN = '*';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      if (url.pathname === '/api/order' && request.method === 'POST') {
        return await createOrder(env, cors);
      }
      if (url.pathname === '/api/verify-payment' && request.method === 'POST') {
        return await verifyPayment(request, env, cors);
      }
      if (url.pathname === '/api/license/status' && request.method === 'POST') {
        return await licenseStatus(request, env, cors);
      }
      if (url.pathname === '/api/certificate/register' && request.method === 'POST') {
        return await registerCertificate(request, env, cors);
      }
      if (url.pathname === '/api/certificate/lookup' && request.method === 'POST') {
        return await lookupCertificate(request, env, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: err.message || 'Server error' }, 500, cors);
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function createOrder(env, cors) {
  const auth = 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const receipt = 'dsa_pro_' + crypto.randomUUID().slice(0, 12);

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ amount: PRICE_PAISE, currency: CURRENCY, receipt }),
  });
  const order = await res.json();
  if (!res.ok) {
    return json({ error: order?.error?.description || 'Could not create order' }, 400, cors);
  }

  return json(
    { order_id: order.id, amount: order.amount, currency: order.currency, key_id: env.RAZORPAY_KEY_ID },
    200,
    cors
  );
}

async function verifyPayment(request, env, cors) {
  const body = await request.json();
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return json({ error: 'Missing payment fields' }, 400, cors);
  }

  // Idempotency: if this order already produced a key (e.g. the client retried
  // after a dropped connection), just hand back the same key instead of
  // minting a second one.
  const existingKey = await env.LICENSES.get('order:' + razorpay_order_id);
  if (existingKey) {
    return json({ license_key: existingKey }, 200, cors);
  }

  const expectedSig = await hmacSHA256Hex(
    env.RAZORPAY_KEY_SECRET,
    `${razorpay_order_id}|${razorpay_payment_id}`
  );
  if (expectedSig !== razorpay_signature) {
    return json({ error: "Signature mismatch — payment couldn't be verified" }, 400, cors);
  }

  const licenseKey = crypto.randomUUID().toUpperCase();
  const record = JSON.stringify({
    active: true,
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    createdAt: Date.now(),
  });

  await env.LICENSES.put('key:' + licenseKey, record);
  await env.LICENSES.put('order:' + razorpay_order_id, licenseKey);

  return json({ license_key: licenseKey }, 200, cors);
}

async function licenseStatus(request, env, cors) {
  const body = await request.json();
  const key = (body?.license_key || '').trim();
  if (!key) return json({ active: false, error: 'No key provided' }, 400, cors);

  const raw = await env.LICENSES.get('key:' + key);
  if (!raw) return json({ active: false }, 200, cors);

  const data = JSON.parse(raw);
  return json({ active: !!data.active }, 200, cors);
}

// Registering a certificate requires a currently-active license key — this
// isn't a perfect anti-forgery guarantee (the license holder could still
// submit inflated stats for themselves), but it does two real things: (1) it
// costs money and ties every write to a specific paid license, so it's not
// an open, free-for-anyone write endpoint anyone can spam; (2) the server
// independently recomputes the same SHA-256 verification ID from the
// submitted fields and rejects the write if it doesn't match what the
// client claims — so a stored record can never be internally inconsistent
// with its own ID, same guarantee the offline hash-check already gave you.
async function registerCertificate(request, env, cors) {
  const body = await request.json();
  const { license_key, id, trackLabel, name, profileUrl, company, stats } = body || {};
  if (!license_key || !id || !trackLabel || !name || !profileUrl || !stats) {
    return json({ error: 'Missing required fields' }, 400, cors);
  }

  const licenseRaw = await env.LICENSES.get('key:' + license_key.trim());
  if (!licenseRaw) return json({ error: 'Invalid or inactive license key' }, 401, cors);
  const licenseData = JSON.parse(licenseRaw);
  if (!licenseData.active) return json({ error: 'Invalid or inactive license key' }, 401, cors);

  const expectedId = await certVerificationId(trackLabel, name, profileUrl, stats);
  if (expectedId !== id) {
    return json({ error: 'Submitted ID does not match the recomputed hash of the submitted fields' }, 400, cors);
  }

  const record = { id, trackLabel, name, profileUrl, company: company || null, stats, registeredAt: Date.now() };
  await env.LICENSES.put('cert:' + id, JSON.stringify(record));
  return json({ ok: true }, 200, cors);
}

async function lookupCertificate(request, env, cors) {
  const body = await request.json();
  const id = (body?.id || '').trim().toUpperCase();
  if (!id) return json({ found: false, error: 'No id provided' }, 400, cors);

  const raw = await env.LICENSES.get('cert:' + id);
  if (!raw) return json({ found: false }, 200, cors);

  return json({ found: true, record: JSON.parse(raw) }, 200, cors);
}

// Mirrors the client-side certVerificationSeed()/certVerificationId() in
// index.html exactly — same seed string, same SHA-256-derived short ID
// format. Keep these in sync if you ever change one side.
function certVerificationSeed(trackLabel, name, profileUrl, stats) {
  const { totalSolved, total, bydiff } = stats;
  return [
    'DSA-CERT-V1',
    trackLabel,
    (name || '').trim().toLowerCase(),
    (profileUrl || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''),
    `${totalSolved}/${total}`,
    `E${bydiff.E.s}/${bydiff.E.t}`,
    `M${bydiff.M.s}/${bydiff.M.t}`,
    `H${bydiff.H.s}/${bydiff.H.t}`,
  ].join('|');
}
async function certVerificationId(trackLabel, name, profileUrl, stats) {
  const seed = certVerificationSeed(trackLabel, name, profileUrl, stats);
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(seed));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const short = hex.slice(0, 12).toUpperCase();
  return `DSA-${short.slice(0, 4)}-${short.slice(4, 8)}-${short.slice(8, 12)}`;
}

async function hmacSHA256Hex(secret, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
