import express from 'express';
import Stripe  from 'stripe';
import axios   from 'axios';
import dotenv  from 'dotenv';
import cors    from 'cors';
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const APP_BASE      = process.env.APP_BASE || 'http://localhost:4242';
const PRODUCT_IDS   = { solo: 'snap_solo_ltd', plus: 'snap_plus_ltd', pro: 'snap_pro_ltd', agency: 'snap_agency_ltd' };
const BASE_PRICES   = { solo: 49, plus: 149, pro: 299, agency: 499 };
const BASE_CREDITS  = { solo: 250, plus: 1000, pro: 5000, agency: 10000 };
const START_BONUS   = { solo: 200, plus: 200,  pro: 1000,  agency: 2000 };
const PRELAUNCH     = new Date('2025-07-27T00:00:00-06:00');

function calcDiscount(now = new Date()) {
  const d = Math.floor((now - PRELAUNCH) / 86_400_000);
  return Math.max(0, 50 - d);
}
function calcBonus(tier, now = new Date()) {
  const d     = Math.floor((now - PRELAUNCH) / 86_400_000);
  const drop  = Math.round(START_BONUS[tier] * 0.02 * d);
  return Math.max(0, START_BONUS[tier] - drop);
}

const T = {
    purchasers  : process.env.NOCO_TABLE_PURCHASERS   || 'ltd_purchasers',
    owners      : process.env.NOCO_TABLE_OWNERS       || 'ltd_referral_owners',
    codes       : process.env.NOCO_TABLE_CODES        || 'ltd_referral_codes',
    redemptions : process.env.NOCO_TABLE_REDEMPTIONS  || 'ltd_referral_redemptions',
    licenses    : process.env.NOCO_TABLE_LICENSES     || 'ltd_licenses'
  };
  
  const app = express();
  app.use(cors());
  

/* Webhook must read the raw body BEFORE any JSON parser */
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_ENDPOINT_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    console.log('💡 Webhook received: checkout.session.completed', event.data.object.id);
    (async () => {
      const s = event.data.object;

      /* 1) Record the purchase */
      await axios.post(`${process.env.NOCO_API_URL}/${T.purchasers}`, {
        checkout_session_id : s.id,
        payment_intent_id   : s.payment_intent || '',
        stripe_customer_id  : s.customer || '',
        email               : s.customer_details?.email || '',
        customer_name       : s.customer_details?.name || '',
        phone               : s.customer_details?.phone || '',
        tier                : s.metadata.tier,
        currency            : s.currency || 'usd',
        price_paid          : (s.amount_total || 0) / 100,
        discount_percent    : 100 - ((s.amount_total || 0) / 100) / BASE_PRICES[s.metadata.tier] * 100,
        discount_source     : s.metadata.referralCodeUsed ? 'referral' : 'daily',
        base_credits        : Number(s.metadata.baseCredits || 0),
        bonus_credits       : Number(s.metadata.bonusCredits || 0),
        referral_extra      : Number(s.metadata.referralExtra || 0),
        referral_code_used  : s.metadata.referralCodeUsed || '',
        referral_owner_email: s.metadata.refOwnerEmail || '',
        purchased_at        : new Date().toISOString(),
        raw_session         : s
      }, { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } })
      
      .catch(e => console.error('NocoDB purchase error', e.response?.data || e.message));

      /* 2) If referral code used, log redemption + bump owner totals */
      if (s.metadata.referralCodeUsed) {
        const code = s.metadata.referralCodeUsed;

        // mark code as used
        try {
            const { data } = await axios.get(
                `${process.env.NOCO_API_URL}/${T.codes}?where=(code,eq,${code})`,
                { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } }
              );
              
          const row = data.list?.[0];
          if (row) {
            await axios.patch(
                `${process.env.NOCO_API_URL}/${T.codes}/${row.Id || row.id}`,
                { status:'used', used_by_email:s.customer_details?.email || '', used_at:new Date().toISOString() },
                { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } }
              );
              
          }
        } catch(e) {
          console.error('NocoDB mark-used error', e.response?.data || e.message);
        }

        // redemption record
        await axios.post(`${process.env.NOCO_API_URL}/${T.redemptions}`, {
            code,
            purchaser_email           : s.customer_details?.email || '',
            tier_purchased            : s.metadata.tier,
            discount_percent_applied  : 50,
            credit_value              : Number(s.metadata.referralExtra || 0),
            redeemed_ts               : new Date().toISOString(),
            checkout_session_id       : s.id,
            amount_total_usd          : (s.amount_total || 0) / 100,
            agency_stacked            : Number(s.metadata.agency_stacked || 1)
          }, { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } })
        .catch(e => console.error('NocoDB redemption error', e.response?.data || e.message));

        // bump owner totals (upsert-ish)
        try {
          const ownerEmail = s.metadata.refOwnerEmail || '';
          if (ownerEmail) {
            const { data } = await axios.get(
                `${process.env.NOCO_API_URL}/${T.owners}?where=(owner_email,eq,${ownerEmail})`,
                { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } }
              );
              
            const owner = data.list?.[0];
            if (owner) {
                await axios.patch(
                    `${process.env.NOCO_API_URL}/${T.owners}/${owner.Id || owner.id}`,
                    {
                      total_redemptions: (owner.total_redemptions || 0) + 1,
                      credits_earned   : (owner.credits_earned   || 0) + Number(s.metadata.referralExtra || 0),
                      updated_ts       : new Date().toISOString()
                    },
                    { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } }
                  );
                  
            } else {
                await axios.post(
                    `${process.env.NOCO_API_URL}/${T.owners}`,
                    {
                      owner_email        : ownerEmail,
                      total_codes_issued : 0,
                      total_redemptions  : 1,
                      credits_earned     : Number(s.metadata.referralExtra || 0),
                      created_ts         : new Date().toISOString(),
                      updated_ts         : new Date().toISOString()
                    },
                    { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } }
                  );
                  
            }
          }
        } catch(e) {
          console.error('NocoDB owner-update error', e.response?.data || e.message);
        }
      }
    })();
  }

  res.json({ received: true });
});

/* JSON parser AFTER webhook */
app.use(express.json());
app.get('/health', (req, res) => res.send('ok'));

app.get('/checkout-success', async (req, res) => {
  const sessionId = req.query.session_id || '';
  let email = '';
  let amount = '';
  let currency = '';
  try {
    if (sessionId) {
      const s = await stripe.checkout.sessions.retrieve(sessionId);
      email = s.customer_details?.email || '';
      amount = ((s.amount_total || 0) / 100).toFixed(2);
      currency = (s.currency || 'usd').toUpperCase();
    }
  } catch (e) {
    console.error('retrieve session error', e.message);
  }
  res.set('Content-Type', 'text/html');
  res.send(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Thank you</title><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b1b39;color:#fff;padding:2rem}' +
    '.card{max-width:680px;margin:0 auto;background:#0f2a5a;border:1px solid #1f3b7b;border-radius:12px;padding:24px}' +
    '.btn{display:inline-block;margin-top:12px;padding:10px 16px;background:#ec4899;color:#fff;border-radius:8px;text-decoration:none}</style>' +
    '</head><body><div class="card"><h1>Thanks for your purchase!</h1>' +
    (email ? '<p>Receipt email: <strong>' + email + '</strong></p>' : '') +
    (amount ? '<p>Amount: <strong>' + amount + ' ' + currency + '</strong></p>' : '') +
    '<p>We’re finalizing your license. You can close this tab.</p>' +
    '<a class="btn" href="/">Back to site</a></div></body></html>'
  );
});


const stripeClient = stripe;

/* Generate a one-per-day, one-time code for an owner */
app.post('/api/referrals/generate', async (req, res) => {
  const { ownerEmail } = req.body;
  if (!ownerEmail) return res.status(400).json({ error: 'ownerEmail required' });
  const today = new Date().toISOString().slice(0,10); // YYYY-MM-DD

  try {
    // return existing today’s code if present
    const q = `${process.env.NOCO_API_URL}/${T.codes}?where=(owner_email,eq,${ownerEmail})~and(issued_date,eq,${today})`;
    const { data } = await axios.get(q, { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } });
    
    if (Array.isArray(data.list) && data.list.length) return res.json({ code: data.list[0].code });

    // create a new code
    const token = Math.random().toString(36).slice(2,10).toUpperCase();
    const code  = `${ownerEmail.split('@')[0].slice(0,6).toUpperCase()}-${token}`;
    await axios.post(`${process.env.NOCO_API_URL}/${T.codes}`, {
        code, owner_email: ownerEmail, issued_date: today, status: 'issued'
      }, { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } });

    // bump owner totals
    const q2 = `${process.env.NOCO_API_URL}/${T.owners}?where=(owner_email,eq,${ownerEmail})`;
    const { data: odata } = await axios.get(q2, { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } }); 
    const owner = odata.list?.[0];
    if (owner) {
        await axios.patch(`${process.env.NOCO_API_URL}/${T.owners}/${owner.Id || owner.id}`, {
            total_codes_issued: (owner.total_codes_issued || 0) + 1,
            updated_ts: new Date().toISOString()
          }, { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } });
          
    } else {
        await axios.post(`${process.env.NOCO_API_URL}/${T.owners}`, {
            owner_email: ownerEmail,
            total_codes_issued: 1,
            total_redemptions : 0,
            credits_earned    : 0,
            created_ts        : new Date().toISOString(),
            updated_ts        : new Date().toISOString()
          }, { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } });
          
    }

    res.json({ code });
  } catch (e) {
    console.error('generate error', e.response?.data || e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* Validate a referral code is unused & return owner email */
app.post('/api/check-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ valid:false });

  try {
    const q = `${process.env.NOCO_API_URL}/${T.codes}?where=(code,eq,${code})~and(status,eq,issued)`;
    const { data } = await axios.get(q, { headers:{ 'xc-token': process.env.NOCO_API_TOKEN } });
    
    const row = data.list?.[0];
    return res.json({ valid: !!row, ownerEmail: row?.owner_email || '' });
  } catch {
    return res.json({ valid:false });
  }
});

/* Create Checkout Session (dynamic price; optional referral coupon; optional agency stack) */
app.post('/api/create-checkout-session', async (req, res) => {
    const { tier, referralCode, agencyStack = 1, promoCode } = req.body;
    if (!PRODUCT_IDS[tier]) return res.status(400).json({ error: 'Unknown tier' });

  const now         = new Date();
  let discountPct   = calcDiscount(now);
  let referralValid = false;
  let refOwnerEmail = '';

  // Temporary: allow SNAP10 during test
  if (referralCode && referralCode.toUpperCase() === 'SNAP10') {
    referralValid = true;
  } else if (referralCode) {
    try {
      const r = await axios.post('/api/check-code', { code: referralCode }, { baseURL: 'http://localhost:4242' });
      referralValid = !!r.data.valid;
      refOwnerEmail = r.data.ownerEmail || '';
    } catch {}
  }

  if (referralValid) discountPct = 50;

  const unitAmount = Math.round(BASE_PRICES[tier] * 100 * (1 - discountPct / 100));
  const bonus      = calcBonus(tier, now);
  const refExtra   = referralValid ? Math.floor((BASE_CREDITS[tier] + bonus) * 0.10) : 0;
  const qty        = tier === 'agency' ? Math.max(1, parseInt(agencyStack || 1, 10)) : 1;

  try {
    const discounts = [];
if (promoCode) {
  discounts.push({ promotion_code: promoCode });
}

const session = await stripeClient.checkout.sessions.create({
  mode: 'payment',
  phone_number_collection: { enabled: true },
  line_items: [{
    quantity: qty,
    price_data: {
      currency   : 'usd',
      product    : PRODUCT_IDS[tier],
      unit_amount: unitAmount
    }
  }],
  discounts,
  allow_promotion_codes: true,
  metadata: {
    tier,
    baseCredits      : BASE_CREDITS[tier],
    bonusCredits     : bonus,
    referralExtra    : refExtra,
    referralCodeUsed : referralValid ? referralCode : '',
    refOwnerEmail    : referralValid ? refOwnerEmail : '',
    agency_stacked   : qty
  },
  success_url: `${process.env.APP_BASE || 'http://localhost:4242'}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url : `${process.env.APP_BASE || 'http://localhost:4242'}/#plans`
});

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'stripe_error' });
  }
});

app.listen(4242, () => console.log('✅ Server listening on :4242'));
