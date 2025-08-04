import express from 'express';
import Stripe from 'stripe';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import { randomUUID } from 'crypto';
dotenv.config();

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);

async function awardReferralCreditsForInvoice(invoice) {
    try {
        const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };
        const subscriptionId = invoice.subscription || '';
        if (!subscriptionId) return;

        const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
        const md  = sub.metadata || {};

        const installments   = Math.max(1, parseInt(md.installments || '1', 10));
        const stackCount     = Math.max(1, parseInt(md.stack_count  || '1', 10));
        const perUnitExtra   = Math.max(0, parseInt(md.referralExtra || '0', 10));
        const refOwnerEmail  = md.refOwnerEmail || '';
        const referralUsed   = !!(md.referralCodeUsed || '');
        const purchaserEmail = invoice.customer_email || '';

        // Only applicable to installment plans that actually used a referral
        if (!referralUsed || !refOwnerEmail || perUnitExtra <= 0 || installments <= 1) return;

        const totalExtra = perUnitExtra * stackCount;

        // Determine which installment index we are on by counting prior "referrer" rows
        const qCount = `${process.env.NOCO_API_URL}/${T.creditsLedger}?limit=9999&where=(subscription_id,eq,${subscriptionId})~and(type,eq,installment_referral)~and(role,eq,referrer)`;
        const { data: led } = await axios.get(qCount, headers).catch(() => ({ data: { list: [] } }));
        const priorReferrerRows = Array.isArray(led.list) ? led.list.length : 0;
        const thisIndex = priorReferrerRows + 1;
        if (thisIndex > installments) return;

        // Pro-rata per installment; last payment gets remainder
        const basePer   = Math.floor(totalExtra / installments);
        const remainder = totalExtra - basePer * (installments - 1);
        const awardNow  = (thisIndex === installments) ? remainder : basePer;
        if (awardNow <= 0) return;

        // Idempotency by invoice_id + role; if either row exists, skip that row
        const qReferee  = `${process.env.NOCO_API_URL}/${T.creditsLedger}?limit=1&where=(invoice_id,eq,${invoice.id})~and(role,eq,referee)`;
        const qReferrer = `${process.env.NOCO_API_URL}/${T.creditsLedger}?limit=1&where=(invoice_id,eq,${invoice.id})~and(role,eq,referrer)`;
        const [r1, r2] = await Promise.all([
            axios.get(qReferee, headers).catch(() => ({ data: { list: [] } })),
            axios.get(qReferrer, headers).catch(() => ({ data: { list: [] } }))
        ]);
        const hasReferee  = (r1.data?.list || []).length > 0;
        const hasReferrer = (r2.data?.list || []).length > 0;

        const rows = [];
        if (!hasReferee) {
            rows.push({
                type            : 'installment_referral',
                subscription_id : subscriptionId,
                invoice_id      : invoice.id,
                installment_idx : thisIndex,
                recipient_email : purchaserEmail,
                amount          : awardNow,
                direction       : 'credit',
                role            : 'referee'
            });
        }
        if (!hasReferrer) {
            rows.push({
                type            : 'installment_referral',
                subscription_id : subscriptionId,
                invoice_id      : invoice.id,
                installment_idx : thisIndex,
                recipient_email : refOwnerEmail,
                amount          : awardNow,
                direction       : 'credit',
                role            : 'referrer'
            });
        }

        for (const row of rows) {
            await axios.post(`${process.env.NOCO_API_URL}/${T.creditsLedger}`, row, headers);
        }
    } catch (e) {
        console.error('awardReferralCreditsForInvoice error', e.response?.data || e.message);
    }
}

const APP_BASE = process.env.APP_BASE || 'http://localhost:4242';
const PRODUCT_IDS = { solo: 'snap_solo_ltd', plus: 'snap_plus_ltd', pro: 'snap_pro_ltd', agency: 'snap_agency_ltd' };
const BASE_PRICES = { solo: 49, plus: 149, pro: 299, agency: 499 };
const BASE_CREDITS = { solo: 250, plus: 1000, pro: 5000, agency: 10000 };
const START_BONUS = { solo: 200, plus: 200, pro: 1000, agency: 2000 };
const PRELAUNCH = new Date('2025-07-27T00:00:00-06:00');

function calcDiscount(now = new Date()) {
    const d = Math.floor((now - PRELAUNCH) / 86_400_000);
    return Math.max(0, 50 - d);
}
function calcBonus(tier, now = new Date()) {
    const d = Math.floor((now - PRELAUNCH) / 86_400_000);
    const drop = Math.round(START_BONUS[tier] * 0.02 * d);
    return Math.max(0, START_BONUS[tier] - drop);
}

const T = {
    purchasers   : process.env.NOCO_TABLE_PURCHASERS    || 'ltd_purchasers',
    owners       : process.env.NOCO_TABLE_OWNERS        || 'ltd_referral_owners',
    codes        : process.env.NOCO_TABLE_CODES         || 'ltd_referral_codes',
    redemptions  : process.env.NOCO_TABLE_REDEMPTIONS   || 'ltd_referral_redemptions',
    licenses     : process.env.NOCO_TABLE_LICENSES      || 'ltd_licenses',
    altpay       : process.env.NOCO_TABLE_ALTPAY        || 'alt_pay_requests',
    creditsLedger: process.env.NOCO_TABLE_CREDITS_LEDGER|| 'ltd_credits_ledger'
};

const app = express();
app.use(cors());

const inflightSessions = new Map();
const processedSessions = new Set();

async function handleCheckoutCompleted(s) {
    const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };

    // 1) Purchaser (idempotent by checkout_session_id)
    try {
        const purchaserCheckUrl = `${process.env.NOCO_API_URL}/${T.purchasers}?limit=1&where=(checkout_session_id,eq,${s.id})`;
        const { data: purchaserExisting } = await axios.get(purchaserCheckUrl, headers).catch(() => ({ data: { list: [] } }));
        const purchaserAlready = Array.isArray(purchaserExisting.list) && purchaserExisting.list.length > 0;

        if (!purchaserAlready) {
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
            }, headers).catch(e => console.error('NocoDB purchase error', e.response?.data || e.message));
        }
    } catch (e) {
        console.error('purchaser block error', e.response?.data || e.message);
    }

    // 2) Referral (idempotent by checkout_session_id)
    try {
        if (s.metadata?.referralCodeUsed) {
            const code = s.metadata.referralCodeUsed;

            // Is redemption already written for this session?
            const redemptionCheckUrl = `${process.env.NOCO_API_URL}/${T.redemptions}?limit=1&where=(checkout_session_id,eq,${s.id})`;
            const { data: redExisting } = await axios.get(redemptionCheckUrl, headers).catch(() => ({ data: { list: [] } }));
            const redemptionAlready = Array.isArray(redExisting.list) && redExisting.list.length > 0;

            if (!redemptionAlready) {
                // Mark code as used only if still 'issued'
                try {
                    const { data: codeData } = await axios.get(
                        `${process.env.NOCO_API_URL}/${T.codes}?limit=1&where=(code,eq,${code})`,
                        headers
                    );
                    const codeRow = codeData.list?.[0];
                    if (codeRow && String(codeRow.status || '').toLowerCase() === 'issued') {
                        await axios.patch(
                            `${process.env.NOCO_API_URL}/${T.codes}/${codeRow.Id || codeRow.id}`,
                            { status: 'used', used_by_email: s.customer_details?.email || '', used_at: new Date().toISOString() },
                            headers
                        );
                    }
                } catch (e) {
                    console.error('NocoDB mark-used error', e.response?.data || e.message);
                }

                // Redemption insert
                await axios.post(`${process.env.NOCO_API_URL}/${T.redemptions}`, {
                    code,
                    purchaser_email         : s.customer_details?.email || '',
                    tier_purchased          : s.metadata.tier,
                    discount_percent_applied: 50,
                    credit_value            : Number(s.metadata.referralExtra || 0),
                    redeemed_ts             : new Date().toISOString(),
                    checkout_session_id     : s.id,
                    amount_total_usd        : (s.amount_total || 0) / 100,
                    agency_stacked          : Number(s.metadata?.stack_count || s.metadata?.agency_stacked || 1)
                }, headers).catch(e => console.error('NocoDB redemption error', e.response?.data || e.message));

                // Owner bump (upsert-ish)
                try {
                    const ownerEmail = s.metadata.refOwnerEmail || '';
                    if (ownerEmail) {
                        const { data: odata } = await axios.get(
                            `${process.env.NOCO_API_URL}/${T.owners}?where=(owner_email,eq,${ownerEmail})`,
                            headers
                        );
                        const owner = odata.list?.[0];
                        if (owner) {
                            await axios.patch(
                                `${process.env.NOCO_API_URL}/${T.owners}/${owner.Id || owner.id}`,
                                {
                                    total_redemptions: (owner.total_redemptions || 0) + 1,
                                    credits_earned   : (owner.credits_earned   || 0) + Number(s.metadata.referralExtra || 0),
                                    updated_ts       : new Date().toISOString()
                                },
                                headers
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
                                headers
                            );
                        }
                    }
                } catch (e) {
                    console.error('NocoDB owner-update error', e.response?.data || e.message);
                }
            }
        }
    } catch (e) {
        console.error('referral block error', e.response?.data || e.message);
    }

    // 3) Licenses (idempotent by notes === "session:<id>")
    try {
        const qty = Number(s.metadata?.stack_count || s.metadata?.agency_stacked || 1);
        const purchaserEmail = s.customer_details?.email || '';
        const tier = s.metadata?.tier || '';
        const stackGroupId = s.id; // deterministic per session

        const licCheckUrl = `${process.env.NOCO_API_URL}/${T.licenses}?limit=9999&where=(notes,eq,session:${s.id})`;
        const { data: licExisting } = await axios.get(licCheckUrl, headers).catch(() => ({ data: { list: [] } }));
        const existingCount = Array.isArray(licExisting.list) ? licExisting.list.length : 0;
        const missing = Math.max(0, qty - existingCount);

        for (let i = 0; i < missing; i++) {
            await axios.post(`${process.env.NOCO_API_URL}/${T.licenses}`, {
                license_id            : randomUUID(),
                purchaser_email       : purchaserEmail,
                tier                  : tier,
                status                : 'active',
                stack_group_id        : stackGroupId,
                claimed_by_email      : purchaserEmail,
                notes                 : `session:${s.id}`,
                email_transfer_history: [
                    {
                        type      : 'created',
                        ts        : new Date().toISOString(),
                        by        : purchaserEmail,
                        origin    : 'stripe_webhook',
                        session_id: s.id
                    }
                ]
            }, headers);
        }
    } catch (e) {
        console.error('NocoDB license-create error', e.response?.data || e.message);
    }
}


/* Webhook must read the raw body BEFORE any JSON parser */
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_ENDPOINT_SECRET);
    } catch (err) {
        console.error('Webhook signature error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        console.log('💡 Webhook received: checkout.session.completed', s.id, 'evt:', event.id);
      
        const key = s.id;
        if (processedSessions.has(key)) {
          console.log('↪️ already processed session', key);
          return res.json({ received: true });
        }
        if (inflightSessions.has(key)) {
          console.log('↪️ processing in flight for session', key);
          return res.json({ received: true });
        }
      
        const task = (async () => {
          try {
            // If this is an installment subscription, create a schedule to auto-cancel after N cycles
            const installments = parseInt(s.metadata?.installments || '1', 10);
            if (s.mode === 'subscription' && s.subscription && installments > 1) {
              try {
                await stripeClient.subscriptionSchedules.create({
                    from_subscription: s.subscription,
                    end_behavior: 'cancel',
                    phases: [{
                      items: [{ price: event.data.object.display_items?.[0]?.price?.id || undefined, quantity: 1 }],
                      iterations: installments
                    }]
                  });
              } catch (e) {
                console.error('schedule create error', e.message);
              }
            }
      
            await handleCheckoutCompleted(s);
            processedSessions.add(key);
          } catch (e) {
            console.error('processing error', e.response?.data || e.message);
          } finally {
            inflightSessions.delete(key);
          }
        })();
      
        inflightSessions.set(key, task);
    } else if (event.type === 'invoice.paid') {
        const inv = event.data.object;
        console.log('💡 Webhook received: invoice.paid', inv.id, 'sub:', inv.subscription || '');
        try {
          await awardReferralCreditsForInvoice(inv);
        } catch (e) {
          console.error('invoice.paid handler error', e.response?.data || e.message);
        }
    }

    // Always respond 2xx quickly so Stripe does not retry
    return res.json({ received: true });
});


/* JSON parser AFTER webhook */
app.use(express.json());
app.get('/health', (req, res) => res.send('ok'));

app.post('/api/alt-pay-request', async (req, res) => {
  try {
    const { tier, referralCode = '', stackCount = 1, installments = 1, email = '', phone = '' } = req.body || {};
    if (!PRODUCT_IDS[tier]) return res.status(400).json({ error: 'Unknown tier' });
    if (!email) return res.status(400).json({ error: 'email_required' });

    const ref = 'ALT-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };
    await axios.post(`${process.env.NOCO_API_URL}/${T.altpay}`, {
      reference: ref,
      email,
      phone,
      tier,
      stack_count: Math.max(1, parseInt(stackCount || 1, 10)),
      installments: Math.max(1, parseInt(installments || 1, 10)),
      referral_code_entered: referralCode || '',
      created_ts: new Date().toISOString(),
      status: 'open'
    }, headers);

    res.json({ ok: true, reference: ref });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: e.response?.data || e.message });
  }
});

app.get('/checkout-success', async (req, res) => {
    const sessionId = req.query.session_id || '';
    let email = '';
    let amount = '';
    let currency = '';

    try {
        if (sessionId) {
            const s = await stripeClient.checkout.sessions.retrieve(sessionId);
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

/* Validate a referral code is unused & return owner email */
app.post('/api/check-code', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.json({ valid: false });

    try {
        const q = `${process.env.NOCO_API_URL}/${T.codes}?where=(code,eq,${code})~and(status,eq,issued)`;
        const { data } = await axios.get(q, { headers: { 'xc-token': process.env.NOCO_API_TOKEN } });
        const row = data.list?.[0];
        return res.json({ valid: !!row, ownerEmail: row?.owner_email || '' });
    } catch {
        return res.json({ valid: false });
    }
});

/* Redeem a referral code AFTER purchase */
app.post('/api/referrals/redeem-after', async (req, res) => {
    const { code, purchaserEmail } = req.body || {};
    if (!code || !purchaserEmail) return res.status(400).json({ error: 'code_and_email_required' });

    const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };

    try {
        // 1) Code must be issued and unused
        const { data: codeData } = await axios.get(
            `${process.env.NOCO_API_URL}/${T.codes}?limit=1&where=(code,eq,${code})~and(status,eq,issued)`,
            headers
        );
        const codeRow = codeData.list?.[0];
        if (!codeRow) return res.status(400).json({ error: 'invalid_or_used_code' });

        // 2) Purchaser must exist
        const { data: purData } = await axios.get(
            `${process.env.NOCO_API_URL}/${T.purchasers}?limit=1&where=(email,eq,${purchaserEmail})`,
            headers
        );
        const p = purData.list?.[0];
        if (!p) return res.status(400).json({ error: 'purchaser_not_found' });

        // 3) Compute bonus credits and any discount refund to match 50%
        const base = Number(p.base_credits || 0);
        const bonus = Number(p.bonus_credits || 0);
        const credit_value = Math.floor((base + bonus) * 0.10);

        const alreadyDiscount = Number(p.discount_percent || 0);
        const discount_refund_due = Math.max(0, 50 - alreadyDiscount);

        // 4) Insert redemption record
        await axios.post(`${process.env.NOCO_API_URL}/${T.redemptions}`, {
            code,
            purchaser_email: purchaserEmail,
            tier_purchased: p.tier || '',
            discount_percent_applied: 50,
            credit_value,
            redeemed_ts: new Date().toISOString(),
            checkout_session_id: p.checkout_session_id || '',
            amount_total_usd: Number(p.price_paid || 0),
            agency_stacked: Number(p.stack_count || p.agency_stacked || 1) || 1
        }, headers);

        // 5) Mark code as used
        await axios.patch(`${process.env.NOCO_API_URL}/${T.codes}/${codeRow.Id || codeRow.id}`, {
            status: 'used',
            used_by_email: purchaserEmail,
            used_at: new Date().toISOString()
        }, headers);

        // 6) Update owner rollup (upsert-ish)
        const ownerEmail = codeRow.owner_email || '';
        if (ownerEmail) {
            const { data: odata } = await axios.get(
                `${process.env.NOCO_API_URL}/${T.owners}?limit=1&where=(owner_email,eq,${ownerEmail})`,
                headers
            );
            const owner = odata.list?.[0];
            if (owner) {
                await axios.patch(`${process.env.NOCO_API_URL}/${T.owners}/${owner.Id || owner.id}`, {
                    total_redemptions: (owner.total_redemptions || 0) + 1,
                    credits_earned: (owner.credits_earned || 0) + credit_value,
                    updated_ts: new Date().toISOString()
                }, headers);
            } else {
                await axios.post(`${process.env.NOCO_API_URL}/${T.owners}`, {
                    owner_email: ownerEmail,
                    total_codes_issued: 0,
                    total_redemptions: 1,
                    credits_earned: credit_value,
                    created_ts: new Date().toISOString(),
                    updated_ts: new Date().toISOString()
                }, headers);
            }
        }

        res.json({ ok: true, credit_value, discount_refund_due });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: e.response?.data || e.message });
    }
});

/* Referral history for an owner */
app.get('/api/referrals/history', async (req, res) => {
    const email = String(req.query.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email_required' });

    const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };

    try {
        // 1) All codes by owner
        const { data: codesData } = await axios.get(
            `${process.env.NOCO_API_URL}/${T.codes}?limit=9999&where=(owner_email,eq,${email})`,
            headers
        );
        const codes = (codesData.list || []).map(r => r.code).filter(Boolean);
        if (!codes.length) return res.json({ total_redemptions: 0, credits_earned: 0, redemptions: [] });

        // 2) Redemptions for those codes
        const inList = codes.map(c => encodeURIComponent(c)).join(',');
        const { data: redData } = await axios.get(
            `${process.env.NOCO_API_URL}/${T.redemptions}?limit=9999&where=(code,in,${inList})`,
            headers
        );
        const list = redData.list || [];
        const total = list.length;
        const credits = list.reduce((s, r) => s + Number(r.credit_value || 0), 0);

        res.json({
            total_redemptions: total,
            credits_earned: credits,
            redemptions: list.sort((a, b) => String(b.redeemed_ts || '').localeCompare(String(a.redeemed_ts || '')))
        });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: e.response?.data || e.message });
    }
});


/* Price options (one-time + payment plans) */
app.post('/api/pricing-options', async (req, res) => {
    try {
      const { tier, referralCode, stackCount = 1, promoCode } = req.body || {};
      if (!PRODUCT_IDS[tier]) return res.status(400).json({ error: 'Unknown tier' });
  
      const now = new Date();
      let discountPct   = calcDiscount(now);
      let referralValid = false;
      let refOwnerEmail = '';
  
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
  
      const qty   = Math.max(1, parseInt(stackCount || 1, 10));
      const base  = BASE_PRICES[tier] * qty;
      const total = +(base * (1 - discountPct / 100)).toFixed(2);
  
      const bonus = calcBonus(tier, now);
      const referralExtraPerUnit = referralValid ? Math.floor((BASE_CREDITS[tier] + bonus) * 0.10) : 0;
      const referralExtraTotal   = referralExtraPerUnit * qty;
  
      const oneTime = {
        total,
        totalFormatted: `$${total.toFixed(2)}`,
        note: 'Pay once, own for life',
        feePercent: 0,
        feeDollars: 0
      };
  
      const installmentsList = [];
      for (let n = 2; n <= 12; n++) {
        const percentFeeDollars = +(total * (n / 100)).toFixed(2);
        const minDollarFee      = 5 * (n - 1);
        const feeDollars        = Math.max(percentFeeDollars, minDollarFee);
        const gross             = +(total + feeDollars).toFixed(2);
        const per               = +(gross / n).toFixed(2);
  
        const allowSpecial2 = (total > 50 && total <= 100 && n === 2);
        if (per >= 40 || allowSpecial2) {
          const perInstallmentCredits = referralValid ? Math.floor(referralExtraTotal / n) : 0;
          const feePercentEffective   = +(feeDollars / total).toFixed(4); // 0.1234 = 12.34%
          installmentsList.push({
            installments: n,
            feeDollars,
            feePercentEffective,
            perPayment: per,
            totalWithFee: gross,
            perPaymentFormatted: `$${per.toFixed(2)}`,
            totalWithFeeFormatted: `$${gross.toFixed(2)}`,
            approxCreditsPerPayment: perInstallmentCredits
          });
        }
      }
  
      res.json({
        tier,
        tierLabel: tier.charAt(0).toUpperCase() + tier.slice(1),
        stackCount: qty,
        discountPct,
        referralValid,
        referralCode: referralValid ? referralCode : '',
        bonus,
        referralExtraPerUnit,
        referralExtraTotal,
        oneTime,
        installments: installmentsList
      });
    } catch (e) {
      res.status(500).json({ error: 'server_error', detail: e.message });
    }
  });


  
  /* Create Checkout Session (dynamic price; optional referral coupon; optional agency stack) */
  app.post('/api/create-checkout-session', async (req, res) => {
    // kept for backward compatibility (one-time path). Prefer /api/create-plan-checkout.
    const { tier, referralCode, stackCount = 1, promoCode } = req.body;
    if (!PRODUCT_IDS[tier]) return res.status(400).json({ error: 'Unknown tier' });
  
    const now = new Date();
    let discountPct   = calcDiscount(now);
    let referralValid = false;
    let refOwnerEmail = '';
  
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
    const qty        = Math.max(1, parseInt(stackCount || 1, 10));
  
    try {
      const discounts = [];
      if (promoCode) discounts.push({ promotion_code: promoCode });
  
      const session = await stripeClient.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: qty,
          price_data: { currency: 'usd', product: PRODUCT_IDS[tier], unit_amount: unitAmount }
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
          stack_count      : qty,
          agency_stacked   : qty,
          installments     : 1
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
  
  /* Create either one-time or installment checkout (preferred) */
  app.post('/api/create-plan-checkout', async (req, res) => {
    try {
      const { tier, referralCode, stackCount = 1, installments = 1, promoCode } = req.body || {};
      if (!PRODUCT_IDS[tier]) return res.status(400).json({ error: 'Unknown tier' });
  
      const now = new Date();
      let discountPct   = calcDiscount(now);
      let referralValid = false;
      let refOwnerEmail = '';
  
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
  
      const qty      = Math.max(1, parseInt(stackCount || 1, 10));
      const base     = BASE_PRICES[tier] * qty;
      const total    = +(base * (1 - discountPct / 100)).toFixed(2);
      const bonus    = calcBonus(tier, now);
      const refExtra = referralValid ? Math.floor((BASE_CREDITS[tier] + bonus) * 0.10) : 0;
  
      if (installments <= 1) {
        const unitAmount = Math.round(BASE_PRICES[tier] * 100 * (1 - discountPct / 100));
        const discounts  = [];
        if (promoCode) discounts.push({ promotion_code: promoCode });
        const session = await stripeClient.checkout.sessions.create({
          mode: 'payment',
          line_items: [{ quantity: qty, price_data: { currency: 'usd', product: PRODUCT_IDS[tier], unit_amount: unitAmount } }],
          discounts,
          allow_promotion_codes: true,
          metadata: {
            tier,
            baseCredits: BASE_CREDITS[tier],
            bonusCredits: bonus,
            referralExtra: refExtra,
            referralCodeUsed: referralValid ? referralCode : '',
            refOwnerEmail: referralValid ? refOwnerEmail : '',
            stack_count: qty,
            agency_stacked: qty,
            installments: 1,
            plan_total_cents: Math.round(total * 100),
            per_payment_cents: Math.round(total * 100)
          },
          success_url: `${process.env.APP_BASE || 'http://localhost:4242'}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url : `${process.env.APP_BASE || 'http://localhost:4242'}/#plans`
        });
        return res.json({ url: session.url });
      }
  
      const percentFeeDollars = +(total * (installments / 100)).toFixed(2);
      const minDollarFee      = 5 * (installments - 1);
      const feeDollars        = Math.max(percentFeeDollars, minDollarFee);
      const gross             = +(total + feeDollars).toFixed(2);
      const per               = +(gross / installments).toFixed(2);

  
      const price = await stripeClient.prices.create({
        currency: 'usd',
        unit_amount: Math.round(per * 100),
        recurring: { interval: 'month' },
        product_data: { name: `SnapLayer LTD – ${tier} – ${installments} payments` }
      });
  
      const session = await stripeClient.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: price.id, quantity: 1 }],
        allow_promotion_codes: false,
        subscription_data: {
          metadata: {
            tier,
            stack_count: qty,
            installments,
            plan_total_cents: Math.round(gross * 100),
            per_payment_cents: Math.round(per * 100),
            baseCredits: BASE_CREDITS[tier],
            bonusCredits: bonus,
            referralExtra: refExtra,
            referralCodeUsed: referralValid ? referralCode : '',
            refOwnerEmail: referralValid ? refOwnerEmail : ''
          }
        },

        success_url: `${process.env.APP_BASE || 'http://localhost:4242'}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url : `${process.env.APP_BASE || 'http://localhost:4242'}/#plans`
      });
  
      res.json({ url: session.url });
    } catch (err) {
      console.error('Stripe plan error:', err);
      res.status(500).json({ error: 'stripe_error' });
    }
  });

  

app.listen(4242, () => console.log('✅ Server listening on :4242'));
