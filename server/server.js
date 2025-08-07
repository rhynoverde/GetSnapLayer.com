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
        const md = sub.metadata || {};

        const installments = Math.max(1, parseInt(md.installments || '1', 10));
        const stackCount = Math.max(1, parseInt(md.stack_count || '1', 10));
        const perUnitExtra = Math.max(0, parseInt(md.referralExtra || '0', 10));
        const refOwnerEmail = md.refOwnerEmail || '';
        const referralUsed = !!(md.referralCodeUsed || '');
        const purchaserEmail = invoice.customer_email || '';

        if (!referralUsed || !refOwnerEmail || perUnitExtra <= 0 || installments <= 1) return;

        const totalExtra = perUnitExtra * stackCount;

        const qCount = `${process.env.NOCO_API_URL}/${T.creditsLedger}?limit=9999&where=(subscription_id,eq,${subscriptionId})~and(type,eq,installment_referral)~and(role,eq,referrer)`;
        const { data: led } = await axios.get(qCount, headers).catch(() => ({ data: { list: [] } }));
        const priorReferrerRows = Array.isArray(led.list) ? led.list.length : 0;
        const thisIndex = priorReferrerRows + 1;
        if (thisIndex > installments) return;

        const basePer = Math.floor(totalExtra / installments);
        const remainder = totalExtra - basePer * (installments - 1);
        const awardNow = (thisIndex === installments) ? remainder : basePer;
        if (awardNow <= 0) return;

        const qReferee = `${process.env.NOCO_API_URL}/${T.creditsLedger}?limit=1&where=(invoice_id,eq,${invoice.id})~and(role,eq,referee)`;
        const qReferrer = `${process.env.NOCO_API_URL}/${T.creditsLedger}?limit=1&where=(invoice_id,eq,${invoice.id})~and(role,eq,referrer)`;
        const [r1, r2] = await Promise.all([
            axios.get(qReferee, headers).catch(() => ({ data: { list: [] } })),
            axios.get(qReferrer, headers).catch(() => ({ data: { list: [] } }))
        ]);
        const hasReferee = (r1.data?.list || []).length > 0;
        const hasReferrer = (r2.data?.list || []).length > 0;

        const rows = [];
        if (!hasReferee) {
            rows.push({
                type: 'installment_referral',
                subscription_id: subscriptionId,
                invoice_id: invoice.id,
                installment_idx: thisIndex,
                recipient_email: purchaserEmail,
                amount: awardNow,
                direction: 'credit',
                role: 'referee'
            });
        }
        if (!hasReferrer) {
            rows.push({
                type: 'installment_referral',
                subscription_id: subscriptionId,
                invoice_id: invoice.id,
                installment_idx: thisIndex,
                recipient_email: refOwnerEmail,
                amount: awardNow,
                direction: 'credit',
                role: 'referrer'
            });
        }

        for (const row of rows) {
            await axios.post(`${process.env.NOCO_API_URL}/${T.creditsLedger}`, row, headers);
        }
    } catch (e) {
        console.error('awardReferralCreditsForInvoice error', e.response?.data || e.message);
    }
}

async function recordInstallmentForInvoice(invoice) {
    try {
        const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };
        const subscriptionId = invoice.subscription || '';
        if (!subscriptionId) return;

        // idempotency: if we already recorded this invoice, bail
        const qExist = `${process.env.NOCO_API_URL}/${T.installments}?limit=1&where=(invoice_id,eq,${invoice.id})`;
        const { data: ex } = await axios.get(qExist, headers).catch(() => ({ data: { list: [] } }));
        if ((ex.list || []).length) return;

        // locate the purchase row by subscription_id
        const qPurchase = `${process.env.NOCO_API_URL}/${T.purchases}?limit=1&where=(subscription_id,eq,${subscriptionId})`;
        const { data: p } = await axios.get(qPurchase, headers).catch(() => ({ data: { list: [] } }));
        const purchase = (p.list || [])[0];
        if (!purchase) return;

        // next installment number for this purchase
        const purchaseId = purchase.Id || purchase.id;
        const qCount = `${process.env.NOCO_API_URL}/${T.installments}?limit=0&where=(purchase_id,eq,${purchaseId})`;
        const { data: c } = await axios.get(qCount, headers).catch(() => ({ data: { count: 0 } }));
        const number = (c.count || 0) + 1;

        const paidAt = (invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : new Date()).toISOString();
        const amount = ((invoice.amount_paid || invoice.amount_due || 0) / 100);

        await axios.post(`${process.env.NOCO_API_URL}/${T.installments}`, {
            purchase_id: purchaseId,
            installment_number: number,
            amount_paid: amount,
            currency: (invoice.currency || 'usd').toUpperCase(),
            invoice_id: invoice.id,
            paid_at: paidAt
        }, headers);
    } catch (e) {
        console.error('recordInstallmentForInvoice error', e.response?.data || e.message);
    }
}


const APP_BASE = process.env.APP_BASE || 'http://localhost:4242';
const PRODUCT_IDS = { solo: 'snap_solo_ltd', plus: 'snap_plus_ltd', pro: 'snap_pro_ltd', agency: 'snap_agency_ltd' };
const BASE_PRICES = { solo: 49, plus: 149, pro: 299, agency: 499 };
const BASE_CREDITS = { solo: 250, plus: 1000, pro: 5000, agency: 10000 };
const START_BONUS = {           // 40 % of BASE_CREDITS
    solo: 100,
    plus: 400,
    pro: 2000,
    agency: 4000
};
const PRELAUNCH = new Date('2025-07-27T00:00:00-06:00');

function calcDiscount(now = new Date()) {
    if (cfg.discount_override != null) return Number(cfg.discount_override);
    const d = Math.floor((now - PRELAUNCH) / 86_400_000);
    const raw = 60 - d;
    const autoVal = Math.max(50, raw);
    if (cfg.hold_drop) {
        if (lastAutoDiscount != null) return lastAutoDiscount;
    }
    lastAutoDiscount = autoVal;
    return autoVal;
}

function calcBonus(tier, now = new Date()) {
    if (cfg.bonus_override != null) {
        const pct = Math.max(0, Number(cfg.bonus_override));
        return Math.round((BASE_CREDITS[tier] || 0) * (pct / 100));
    }

    const d = Math.floor((now - PRELAUNCH) / 86_400_000);
    const drop = Math.round(START_BONUS[tier] * 0.02 * d);
    const autoVal = Math.max(0, START_BONUS[tier] - drop);

    if (cfg.hold_drop) {
        if (lastAutoBonus[tier] != null) return lastAutoBonus[tier];
    }
    lastAutoBonus[tier] = autoVal;
    return autoVal;
}


const T = {
    purchases: process.env.NOCO_TABLE_PURCHASES || 'ltd_purchases',
    users: process.env.NOCO_TABLE_USERS || 'ltd_users',
    owners: process.env.NOCO_TABLE_OWNERS || 'ltd_referral_owners',
    codes: process.env.NOCO_TABLE_CODES || 'ltd_referral_codes',
    redemptions: process.env.NOCO_TABLE_REDEMPTIONS || 'ltd_referral_redemptions',
    licenses: process.env.NOCO_TABLE_LICENSES || 'ltd_licenses',
    altpay: process.env.NOCO_TABLE_ALTPAY || 'alt_pay_requests',
    creditsLedger: process.env.NOCO_TABLE_CREDITS_LEDGER || 'ltd_credits_ledger',
    installments: process.env.NOCO_TABLE_INSTALLMENTS || 'ltd_installments'
};

const app = express();
app.use(cors());

/* ─── runtime-config (shared) ─── */
const cfg = {
    discount_override: null,
    bonus_override: null,
    hold_drop: false,
    rollover_months: 6,
    banner: '',
    banner_style: 'static',     // 'static' | 'scroll'
    banner_theme: 'info',       // 'info' | 'warning' | 'success' | 'danger'
    banner_speed: 18,           // seconds for scroll
    banner_dismissible: true
};


let lastAutoDiscount = null;
let lastAutoBonus = {};
/* ─────────────────────────────── */


// --- Control-room basic auth ---
function adminAuth(req, res, next) {
    // --- DEV ONLY: allow requests from localhost without Basic-Auth ---
    if (req.ip === '::1' || req.ip === '127.0.0.1') return next();
    // ------------------------------------------------------------------

    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Control Room"');
        return res.status(401).end();
    }
    const [user, pass] = Buffer.from(hdr.slice(6), 'base64').toString().split(':');
    if (user === process.env.ADMIN_BASIC_USER && pass === process.env.ADMIN_BASIC_PASS) {
        return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Control Room"');
    return res.status(401).end();
}


// Serve anything inside ./admin when the auth passes
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(
    '/control-room',
    adminAuth,
    express.static(path.join(__dirname, '..', 'admin'))
);

// Fallback for /control-room if no admin/index.html yet
app.get('/control-room', adminAuth, (req, res) => {
    res.send('<h1 style="font-family:system-ui">SnapLayer Control Room</h1><p>Add your dashboard to /admin/index.html</p>');
});


const inflightSessions = new Map();
const processedSessions = new Set();

async function handleCheckoutCompleted(s) {
    const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };

    // 1) Purchaser (idempotent by checkout_session_id)
    try {
        const purchaserCheckUrl = `${process.env.NOCO_API_URL}/${T.purchases}?limit=1&where=(checkout_session_id,eq,${s.id})`;
        const { data: purchaserExisting } = await axios.get(purchaserCheckUrl, headers).catch(() => ({ data: { list: [] } }));
        const purchaserAlready = Array.isArray(purchaserExisting.list) && purchaserExisting.list.length > 0;

        if (!purchaserAlready) {
            const purchaserEmail = s.customer_details?.email || '';
            let userId = null;
            try {
                const { data: u1 } = await axios.get(`${process.env.NOCO_API_URL}/${T.users}?limit=1&where=(email,eq,${purchaserEmail})`, headers);
                if (u1.list?.[0]) {
                    userId = u1.list[0].Id || u1.list[0].id;
                } else {
                    const { data: u2 } = await axios.post(`${process.env.NOCO_API_URL}/${T.users}`, { email: purchaserEmail, username: (purchaserEmail || '').split('@')[0] }, headers);
                    userId = u2.Id || u2.id;
                }
            } catch { }

            const qty = Math.max(1, parseInt(s.metadata.stack_count || s.metadata.agency_stacked || '1', 10));
            const baseTotal = BASE_PRICES[s.metadata.tier] * qty;
            const planTotal = (Number(s.metadata.plan_total_cents || 0) / 100) || baseTotal * (1 - (calcDiscount(new Date()) / 100));
            const discountPct = Math.max(0, Math.round((1 - planTotal / baseTotal) * 100));

            await axios.post(`${process.env.NOCO_API_URL}/${T.purchases}`, {
                user_id: userId,
                checkout_session_id: s.id,
                payment_intent_id: s.payment_intent || '',
                stripe_customer_id: s.customer || '',
                subscription_id: s.subscription || '',
                installments: parseInt(s.metadata?.installments || '1', 10),
                email: purchaserEmail,
                customer_name: s.customer_details?.name || '',
                phone: s.customer_details?.phone || '',
                tier: s.metadata.tier,
                currency: (s.currency || 'usd').toUpperCase(),
                amount_total_usd: (s.amount_total || 0) / 100,
                plan_total: planTotal,
                discount_percent: discountPct,
                discount_source: s.metadata.referralCodeUsed ? 'referral' : 'daily',
                base_credits: Number(s.metadata.baseCredits || 0),
                bonus_credits: Number(s.metadata.bonusCredits || 0),
                referral_extra: Number(s.metadata.referralExtra || 0),
                referral_code_used: s.metadata.referralCodeUsed || '',
                referral_owner_email: s.metadata.refOwnerEmail || '',
                stack_count: qty,
                status: 'paid',
                purchased_at: new Date().toISOString(),
                raw_session: s
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
                    purchaser_email: s.customer_details?.email || '',
                    tier_purchased: s.metadata.tier,
                    discount_percent_applied: 50,
                    credit_value: Number(s.metadata.referralExtra || 0),
                    redeemed_ts: new Date().toISOString(),
                    checkout_session_id: s.id,
                    amount_total_usd: (s.amount_total || 0) / 100,
                    agency_stacked: Number(s.metadata?.stack_count || s.metadata?.agency_stacked || 1)
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
                                    credits_earned: (owner.credits_earned || 0) + Number(s.metadata.referralExtra || 0),
                                    updated_ts: new Date().toISOString()
                                },
                                headers
                            );
                        } else {
                            await axios.post(
                                `${process.env.NOCO_API_URL}/${T.owners}`,
                                {
                                    owner_email: ownerEmail,
                                    total_codes_issued: 0,
                                    total_redemptions: 1,
                                    credits_earned: Number(s.metadata.referralExtra || 0),
                                    created_ts: new Date().toISOString(),
                                    updated_ts: new Date().toISOString()
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
                license_id: randomUUID(),
                purchaser_email: purchaserEmail,
                tier: tier,
                status: 'active',
                stack_group_id: stackGroupId,
                claimed_by_email: purchaserEmail,
                notes: `session:${s.id}`,
                email_transfer_history: [
                    {
                        type: 'created',
                        ts: new Date().toISOString(),
                        by: purchaserEmail,
                        origin: 'stripe_webhook',
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
                        const sched = await stripeClient.subscriptionSchedules.create({
                            from_subscription: s.subscription,
                            end_behavior: 'cancel'
                        });
                        await stripeClient.subscriptionSchedules.update(sched.id, {
                            phases: [{ iterations: installments }]
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
            await recordInstallmentForInvoice(inv);
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


app.get('/api/runtime-config', (req, res) => {
    const start = (typeof PRELAUNCH !== 'undefined' && PRELAUNCH instanceof Date)
        ? PRELAUNCH.toISOString()
        : (process.env.PRELAUNCH_START || '2025-08-04T00:00:00Z');
    res.json({ prelaunchStart: start, cfg });
});

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

/* ────────────────────────────────────────────────────────────────────────────
   Referral + Pricing + Checkout APIs
   These match what your front-end (referral.js, checkout.js) calls.
──────────────────────────────────────────────────────────────────────────── */

function money(n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); }
function titleTier(t) { return ({ solo: 'Solo', plus: 'Plus', pro: 'Pro', agency: 'Agency' }[t] || t); }

async function fetchCodeRow(code) {
    const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };
    const url = `${process.env.NOCO_API_URL}/${T.codes}?limit=1&where=(code,eq,${code})`;
    const { data } = await axios.get(url, headers).catch(() => ({ data: { list: [] } }));
    return (data.list || [])[0] || null;
}

async function hasPurchased(email) {
    const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };
    const url = `${process.env.NOCO_API_URL}/${T.purchases}?limit=1&where=(email,eq,${email})`;
    const { data } = await axios.get(url, headers).catch(() => ({ data: { list: [] } }));
    return ((data.list || []).length > 0);
}

function referralExtraPerUnit(tier, now = new Date()) {
    const base = BASE_CREDITS[tier] || 0;
    const bonus = calcBonus(tier, now) || 0;
    return Math.floor(0.10 * (base + bonus));
}

/* Referral history for an owner */


/* Redeem after purchase (prorate credits on future invoices via webhook) */


/* Pricing options used by the plan modal */


/* Create a Stripe Checkout session for the selected plan */

app.get('/checkout-success', async (req, res) => {
    const sessionId = req.query.session_id || '';
    let email = '';
    let amount = '';
    let currency = 'USD';

    let tier = '';
    let stack = 1;
    let installments = 1;

    let planTotal = 0;     // one-time total before plan fee
    let planFee = 0;       // added fee for payment plans
    let planGross = 0;     // total with plan fee
    let perPayment = 0;    // amount per installment
    let discountPct = 0;

    let baseCredits = 0;
    let bonusCredits = 0;
    let referralCredits = 0;

    let createdAt = new Date();

    try {
        if (sessionId) {
            const s = await stripeClient.checkout.sessions.retrieve(sessionId);
            email = s.customer_details?.email || '';
            amount = ((s.amount_total || 0) / 100).toFixed(2);
            currency = (s.currency || 'usd').toUpperCase();
            createdAt = new Date((s.created || Math.floor(Date.now() / 1000)) * 1000);

            let md = s.metadata || {};
            if (s.subscription) {
                try {
                    const sub = await stripeClient.subscriptions.retrieve(s.subscription);
                    md = sub.metadata || md;
                } catch { }
            }

            tier = String(md.tier || '').toLowerCase();
            stack = Math.max(1, parseInt(md.stack_count || md.agency_stacked || '1', 10));
            installments = Math.max(1, parseInt(md.installments || '1', 10));

            planTotal = Number(md.plan_total_cents || 0) / 100;
            planFee = Number(md.plan_fee_cents || 0) / 100;
            planGross = Number(md.plan_gross_cents || 0) / 100;
            perPayment = Number(md.per_payment_cents || 0) / 100;

            const basePerUnitCredits = Number(md.baseCredits || (BASE_CREDITS[tier] || 0));
            const bonusPerUnit = Number(md.bonusCredits || 0);
            const refExtraPerUnit = Number(md.referralExtra || 0);

            baseCredits = basePerUnitCredits * stack;
            bonusCredits = bonusPerUnit * stack;
            referralCredits = refExtraPerUnit * stack;

            const baseNoDiscTotal = (BASE_PRICES[tier] || 0) * stack;
            discountPct = Number(md.discountPctUsed || 0) || (baseNoDiscTotal ? Math.max(0, Math.round((1 - (planTotal || ((s.amount_total || 0) / 100)) / baseNoDiscTotal) * 100)) : 0);

            if (!planTotal && baseNoDiscTotal) {
                planTotal = +(((s.amount_total || 0) / 100)).toFixed(2);
            }
            if (!planGross) planGross = +(planTotal + planFee).toFixed(2);
            if (!perPayment && installments > 1) perPayment = +(planGross / installments).toFixed(2);
        }
    } catch (e) {
        console.error('retrieve session error', e.message);
    }

    const label = (t => ({ solo: 'SOLO', plus: 'PLUS', pro: 'PRO', agency: 'AGENCY' }[t] || t.toUpperCase()))(tier);
    const payDay = createdAt.getDate();

    const _fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    const _feeDollars = Math.max(0, (planGross || 0) - (planTotal || 0));
    const _feePct = planTotal ? Math.round((_feeDollars / planTotal) * 100) : 0;
    const oneLinePrice = installments > 1
        ? `${_fmt.format(planTotal)} + ${_feePct}% plan fee of ${_fmt.format(_feeDollars)} = ${_fmt.format(planGross)}`
        : `${_fmt.format(planTotal)}`;

    const paymentsLine = installments > 1
        ? `${installments} payments of ${new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(perPayment)} (charged each month around the ${payDay}th)`
        : `Paid in full today`;

    const _nf = new Intl.NumberFormat('en-US');
    const creditsLine = `${_nf.format(baseCredits)} Credits + ${_nf.format(bonusCredits)} PreLaunch Bonus Credits${referralCredits ? ` + ${_nf.format(referralCredits)} Referral Credits` : ''} = ${_nf.format(baseCredits + bonusCredits + referralCredits)} Total Monthly Image Credits`;

    let suggestedUsername = (() => {
        const base = (email || '').split('@')[0];
        return (base || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
    })();
    try {
        const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };

        // 1) Do we already have a user for this email?
        let existingUser = null;
        try {
            const { data: uByEmail } = await axios.get(`${process.env.NOCO_API_URL}/${T.users}?limit=1&where=(email,eq,${email})`, headers);
            existingUser = (uByEmail.list || [])[0] || null;
        } catch { }

        if (existingUser && (existingUser.username || '').trim()) {
            // Use their saved username as-is.
            suggestedUsername = existingUser.username.trim();
        } else {
            // Propose from email local-part; ensure uniqueness.
            let candidate = suggestedUsername;
            let needsSuffix = false;
            try {
                const { data: uByName } = await axios.get(`${process.env.NOCO_API_URL}/${T.users}?limit=1&where=(username,eq,${candidate})`, headers);
                needsSuffix = !!(uByName.list && uByName.list[0] && (uByName.list[0].email || '').toLowerCase() !== (email || '').toLowerCase());
            } catch { }
            if (needsSuffix) {
                const suffix = Math.random().toString(36).slice(2, 6);
                candidate = `${candidate}-${suffix}`;
            }
            suggestedUsername = candidate;

            // Persist now: update existing user (no username) or create new user.
            try {
                if (existingUser) {
                    await axios.patch(`${process.env.NOCO_API_URL}/${T.users}/${existingUser.Id || existingUser.id}`, {
                        username: suggestedUsername, updated_ts: new Date().toISOString()
                    }, headers);
                } else {
                    await axios.post(`${process.env.NOCO_API_URL}/${T.users}`, {
                        email, username: suggestedUsername, created_ts: new Date().toISOString()
                    }, headers);
                }
            } catch { }
        }
    } catch { }


    let shareRocket = '';
    let shareMonster = '';
    let shareImg = '';
    try {
        const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };
        const now  = new Date();
        const ymd  = now.toISOString().slice(0, 10);                               // YYYY-MM-DD

        let code = '';
        const q = `${process.env.NOCO_API_URL}/${T.codes}?limit=1` +
                  `&where=(owner_email,eq,${email})~and(issued_date,eq,${ymd})`;
        console.log('Fetching existing code:', q);
        const { data: existing } = await axios.get(q, headers).catch(() => ({ data: { list: [] } }));
        if (existing.list?.[0]?.code) {
            code = existing.list[0].code;
            console.log('Found existing code:', code);
        } else {
            code = Math.random().toString(36).slice(2, 9).toUpperCase();
            console.log('Generating new code:', code);
            await axios.post(`${process.env.NOCO_API_URL}/${T.codes}`, {
                code,
                owner_email: email,
                issued_date: ymd,
                status: 'issued'
            }, headers);
            console.log('Posted new code');
        }

        shareRocket  = `https://my.reviewshare.pics/i/uvfZfFhwv.png?custom_text_1=${encodeURIComponent(code)}`;
        shareMonster = `https://my.reviewshare.pics/i/YV4pSeYFI.png?custom_text_1=${encodeURIComponent(code)}`;
        shareImg     = shareRocket;

    } catch (e) {
        console.error('Error in share code block:', e);
    }
    if (!shareRocket) shareRocket = 'https://f000.backblazeb2.com/file/GetSnapLayer/images/SnapLayerBlastingOff-003.jpg';
    if (!shareMonster) shareMonster = 'https://f000.backblazeb2.com/file/GetSnapLayer/images/monster-001.jpg';
    if (!shareImg) shareImg = shareRocket;

    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
  <html>
  <head>
  <meta charset="utf-8">
  <title>Thank you</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { --pink:#ec4899; --bg:#0b1b39; --card:#0f2a5a; --border:#1f3b7b; }
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:#fff;padding:24px}
    .card{max-width:840px;margin:0 auto;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px}
    h1{margin:0 0 8px 0}
    .muted{color:#bcd3ff}
    .grid{display:grid;gap:16px}
    .two{grid-template-columns:repeat(2,minmax(0,1fr))}
    .pill{display:inline-block;background:#10306b;border:1px solid #2a4a8e;border-radius:999px;padding:6px 10px;font-size:12px}
    .btn{display:inline-block;margin-top:12px;padding:10px 16px;background:var(--pink);color:#fff;border-radius:8px;text-decoration:none}
    .btn-row{display:flex;gap:8px;flex-wrap:wrap}
    .input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #2a4a8e;background:#091737;color:#fff}
    .label{font-size:12px;margin:8px 0 6px 0;color:#cfe0ff}
    .small{font-size:12px;color:#c7d6ff}
    .box{background:#0c2250;border:1px dashed #335bab;border-radius:12px;padding:14px;text-align:center;color:#c7d6ff}
  </style>
  </head>
  <body>
    <div class="card">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
    <img src="https://f000.backblazeb2.com/file/GetSnapLayer/images/snaplayer-logo-on-blue-1024x1024.jpg" alt="SnapLayer" style="height:56px;width:56px;border-radius:12px">
    <span style="font-weight:800;font-size:18px;color:#dfe9ff">SnapLayer</span>
  </div>
      <h1>Thanks for your purchase!</h1>
      ${email ? `<p>Receipt email: <strong>${email}</strong></p>` : ``}
      ${amount ? `<p>Amount: <strong>${amount} ${currency}</strong></p>` : ``}
  
      <div class="grid two" style="margin-top:16px">
        <div>
          <div class="pill">${label} Plan – ${stack} License Stack</div>
          <p style="margin:12px 0 0 0;font-size:20px"><strong>${oneLinePrice}</strong></p>
          <p class="muted" style="margin:6px 0 0 0">${paymentsLine}${discountPct ? ` • ${discountPct}% discount applied` : ``}</p>
          <p style="margin:12px 0 0 0">${creditsLine}</p>
  
          <div class="box" style="margin-top:14px;text-align:left">
            <strong>Payment plan terms</strong>
            <p class="small" style="margin-top:6px">
              If a payment plan payment fails and isn’t resolved within 30 days, your account will be reduced to the largest tier/stack fully covered by the payments received (minus the plan’s added percentage) until you catch up. By proceeding, you agree to these terms.
            </p>
          </div>
        </div>
  
        <div>
          <div class="label">Your username</div>
          <input id="u-name" class="input" value="${suggestedUsername}">
          <div class="label">Text me important updates (optional)</div>
          <input id="u-phone" class="input" placeholder="Your mobile number">
          <label class="label" style="display:flex;align-items:center;gap:8px;margin-top:10px">
            <input id="u-opt" type="checkbox" checked>
            <span>Yes, email me updates, specials and promotions.</span>
          </label>
          <div class="btn-row">
            <a id="save-profile" class="btn" href="#">Save my preferences</a>
            <a class="btn" href="/">Back to site</a>
          </div>
          <div id="save-msg" class="small" style="margin-top:8px"></div>
        </div>
      </div>
  
      <hr style="border:none;border-top:1px solid #1f3b7b;margin:20px 0">
  
      <h3 style="margin:0 0 8px 0">Share & earn bonus credits</h3>
      <p class="small">We’ve got images you can use to share the SnapLayer PreLaunch and your referral code. Placeholders for now—assets coming soon.</p>
      <div class="grid two" style="margin-top:8px">
  <a class="box" href="${shareRocket}" target="_blank" style="display:block">
    <img src="${shareRocket}" alt="Rocket share image" style="max-width:100%;border-radius:10px">
  </a>
  <a class="box" href="${shareMonster}" target="_blank" style="display:block">
    <img src="${shareMonster}" alt="Monster share image" style="max-width:100%;border-radius:10px">
  </a>
</div>

    </div>
  
  <script>
    (function(){
      const btn = document.getElementById('save-profile');
      const msg = document.getElementById('save-msg');
      btn?.addEventListener('click', async function(e){
        e.preventDefault();
        msg.textContent = 'Saving...';
        try {
          const r = await fetch('/api/finish-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: ${JSON.stringify(email)},
              username: document.getElementById('u-name')?.value || '',
              phone: document.getElementById('u-phone')?.value || '',
              optin: !!document.getElementById('u-opt')?.checked
            })
          });
          const d = await r.json();
          msg.textContent = d && d.ok ? 'Saved. Thank you!' : 'Could not save right now.';
        } catch {
          msg.textContent = 'Could not save right now.';
        }
      });
    })();
  </script>
  </body>
  </html>`);
});

app.post('/api/finish-profile', express.json(), async (req, res) => {
    try {
        const { email = '', username = '', phone = '', optin = false } = req.body || {};
        if (!email) return res.status(400).json({ error: 'email_required' });

        const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };

        let finalUsername = (username || (email.split('@')[0] || 'user'))
            .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
        try {
            const q = `${process.env.NOCO_API_URL}/${T.users}?limit=1&where=(username,eq,${finalUsername})`;
            const { data: chk } = await axios.get(q, headers);
            if (chk.list?.[0] && (chk.list[0].email || '').toLowerCase() !== email.toLowerCase()) {
                finalUsername = `${finalUsername}-${Math.random().toString(36).slice(2, 6)}`;
            }
        } catch { }

        let uid = null;

        try {
            const { data: u1 } = await axios.get(`${process.env.NOCO_API_URL}/${T.users}?limit=1&where=(email,eq,${email})`, headers);
            if (u1.list?.[0]) uid = u1.list[0].Id || u1.list[0].id;
        } catch { }

        if (uid) {
            await axios.patch(`${process.env.NOCO_API_URL}/${T.users}/${uid}`, {
                username: finalUsername, phone, marketing_opt_in: !!optin, updated_ts: new Date().toISOString()
            }, headers).catch(() => { });
        } else {
            await axios.post(`${process.env.NOCO_API_URL}/${T.users}`, {
                email, username: finalUsername, phone, marketing_opt_in: !!optin, created_ts: new Date().toISOString()
            }, headers).catch(() => { });
        }

        res.json({ ok: true, username: finalUsername });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: e.response?.data || e.message });
    }
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

/* Generate (or fetch) today’s referral code */
app.post('/api/referrals/generate', async (req, res) => {
    const { ownerEmail = '' } = req.body || {};
    if (!ownerEmail) return res.status(400).json({ error: 'email_required' });

    const headers = { headers: { 'xc-token': process.env.NOCO_API_TOKEN } };
    const today = new Date().toISOString().slice(0, 10);         // YYYY-MM-DD

    try {
        /* 1) Already issued today? */
        const q = `${process.env.NOCO_API_URL}/${T.codes}?limit=1&where=(owner_email,eq,${ownerEmail})~and(issued_date,eq,${today})`;
        const { data } = await axios.get(q, headers);
        if (data.list?.[0]) return res.json({ code: data.list[0].code });

        /* 2) Make a fresh 7-char code */
        const code = Math.random().toString(36).slice(2, 9).toUpperCase();
        await axios.post(`${process.env.NOCO_API_URL}/${T.codes}`, {
            code,
            owner_email: ownerEmail,
            issued_date: today,
            status: 'issued'
        }, headers);

        /* 3) Roll-up owner table (creates row if missing) */
        await axios.post(`${process.env.NOCO_API_URL}/rpc/upsert_referral_owner`,   // optional stored proc
            { email: ownerEmail }, headers).catch(() => { });

        return res.json({ code });
    } catch (e) {
        console.error('generate-code error', e.response?.data || e.message);
        return res.status(500).json({ error: 'server_error' });
    }
});
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
            `${process.env.NOCO_API_URL}/${T.purchases}?limit=1&where=(email,eq,${purchaserEmail})`,
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

        // 5) Enforce max uses and mark code as used if this is the last allowed use
        const maxUses = codeRow.max_uses ?? 1;
        const { data: countData } = await axios.get(
            `${process.env.NOCO_API_URL}/${T.redemptions}?limit=0&where=(code_id,eq,${codeRow.Id || codeRow.id})`,
            headers
        );
        const uses = countData.count || 0;
        if (maxUses !== null && uses >= maxUses) {
            return res.status(400).json({ error: 'max_uses_exceeded' });
        }
        if (maxUses !== null && uses + 1 >= maxUses) {
            await axios.patch(`${process.env.NOCO_API_URL}/${T.codes}/${codeRow.Id || codeRow.id}`, {
                status: 'used',
                used_by_email: purchaserEmail,
                used_at: new Date().toISOString()
            }, headers);
        }


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

        function toSchemaDate(dt) {
            if (!dt) return '';
            const d = new Date(dt);
            if (isNaN(d.getTime())) return String(dt);
            let yyyy = d.getFullYear();
            let mm = String(d.getMonth() + 1).padStart(2, '0');
            let dd = String(d.getDate()).padStart(2, '0');
            let hr = d.getHours();
            let min = String(d.getMinutes()).padStart(2, '0');
            let ampm = hr >= 12 ? 'PM' : 'AM';
            let hr12 = hr % 12; if (hr12 === 0) hr12 = 12;
            return `${yyyy}-${mm}-${dd} ${String(hr12).padStart(2, '0')}:${min} ${ampm}`;
        }
        res.json({
            total_redemptions: total,
            credits_earned: credits,
            redemptions: list
                .map(r => ({
                    ...r,
                    redeemed_ts: toSchemaDate(r.redeemed_ts)
                }))
                .sort((a, b) => String(b.redeemed_ts || '').localeCompare(String(a.redeemed_ts || '')))
        });

    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: e.response?.data || e.message });
    }
});


/* Price options (one-time + payment plans) */
app.post('/api/pricing-options', async (req, res) => {
    try {
        const { tier, referralCode, stackCount = 1 } = req.body || {};
        if (!PRODUCT_IDS[tier]) return res.status(400).json({ error: 'Unknown tier' });

        const now = new Date();
        let discountPct = calcDiscount(now);
        let referralValid = false;
        let refOwnerEmail = '';

        if (referralCode) {
            try {
                const r = await axios.post('/api/check-code', { code: referralCode }, { baseURL: 'http://localhost:4242' });
                referralValid = !!r.data.valid;
                refOwnerEmail = r.data.ownerEmail || '';
            } catch { }
        }
        if (referralValid) discountPct = 50;

        const qty = Math.max(1, parseInt(stackCount || 1, 10));
        const base = BASE_PRICES[tier] * qty;
        const total = +(base * (1 - discountPct / 100)).toFixed(2);

        const bonus = calcBonus(tier, now);
        const perUnitExtra = referralValid ? Math.floor((BASE_CREDITS[tier] + bonus) * 0.10) : 0;
        const totalExtra = perUnitExtra * qty;

        const oneTime = {
            total,
            totalFormatted: `$${total.toFixed(2)}`,
            note: 'Best value — no plan fee'
        };

        const installments = [];
        for (let n = 2; n <= 12; n++) {
            const feeDollars = +(total * (n / 100)).toFixed(2);           // EXACT N%
            const gross = +(total + feeDollars).toFixed(2);
            const per = +(gross / n).toFixed(2);

            const perOK = per >= 40 || (n === 2 && total >= 50 && total <= 100); // $40 min; 2-pay exception
            if (!perOK) continue;

            installments.push({
                installments: n,
                feeDollars,
                feePercentEffective: +(feeDollars / total).toFixed(4),
                perPayment: per,
                totalWithFee: gross,
                perPaymentFormatted: `$${per.toFixed(2)}`,
                totalWithFeeFormatted: `$${gross.toFixed(2)}`,
                approxCreditsPerPayment: referralValid ? Math.floor(totalExtra / n) : 0
            });
        }

        res.json({
            tier,
            tierLabel: titleTier(tier),
            stackCount: qty,
            discountPct,
            oneTime,
            installments,
            baseCredits: BASE_CREDITS[tier],
            bonusCredits: bonus,
            referralValid,
            referralCode: referralValid ? referralCode : '',
            refOwnerEmail,
            referralExtraPerUnit: perUnitExtra,
            referralExtraTotal: totalExtra
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
    let discountPct = calcDiscount(now);
    let referralValid = false;
    let refOwnerEmail = '';

    if (referralCode && referralCode.toUpperCase() === 'SNAP10') {
        referralValid = true;
    } else if (referralCode) {
        try {
            const r = await axios.post('/api/check-code', { code: referralCode }, { baseURL: 'http://localhost:4242' });
            referralValid = !!r.data.valid;
            refOwnerEmail = r.data.ownerEmail || '';
        } catch { }
    }
    if (referralValid) discountPct = 50;

    const unitAmount = Math.round(BASE_PRICES[tier] * 100 * (1 - discountPct / 100));
    const bonus = calcBonus(tier, now);
    const refExtra = referralValid ? Math.floor((BASE_CREDITS[tier] + bonus) * 0.10) : 0;
    const qty = Math.max(1, parseInt(stackCount || 1, 10));

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
                baseCredits: BASE_CREDITS[tier],
                bonusCredits: bonus,
                referralExtra: refExtra,
                referralCodeUsed: referralValid ? referralCode : '',
                refOwnerEmail: referralValid ? refOwnerEmail : '',
                stack_count: qty,
                agency_stacked: qty,
                installments: 1,
                discountPctUsed: discountPct
            },

            success_url: `${process.env.APP_BASE || 'http://localhost:4242'}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.APP_BASE || 'http://localhost:4242'}/#plans`
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
        let discountPct = calcDiscount(now);
        let referralValid = false;
        let refOwnerEmail = '';

        if (referralCode && referralCode.toUpperCase() === 'SNAP10') {
            referralValid = true;
        } else if (referralCode) {
            try {
                const r = await axios.post('/api/check-code', { code: referralCode }, { baseURL: 'http://localhost:4242' });
                referralValid = !!r.data.valid;
                refOwnerEmail = r.data.ownerEmail || '';
            } catch { }
        }
        if (referralValid) discountPct = 50;

        const qty = Math.max(1, parseInt(stackCount || 1, 10));
        const base = BASE_PRICES[tier] * qty;
        const total = +(base * (1 - discountPct / 100)).toFixed(2);
        const bonus = calcBonus(tier, now);
        const refExtra = referralValid ? Math.floor((BASE_CREDITS[tier] + bonus) * 0.10) : 0;

        if (installments <= 1) {
            const unitAmount = Math.round(BASE_PRICES[tier] * 100 * (1 - discountPct / 100));
            const discounts = [];
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
                    discountPctUsed: discountPct,
                    plan_total_cents: Math.round(total * 100),
                    per_payment_cents: Math.round(total * 100)
                },

                success_url: `${process.env.APP_BASE || 'http://localhost:4242'}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.APP_BASE || 'http://localhost:4242'}/#plans`
            });
            return res.json({ url: session.url });
        }

        const feePercent = 4 + 2 * (installments - 1);
        const percentFeeDollars = +(total * (installments / 100)).toFixed(2);
        const minDollarFee = 5 * (installments - 1);
        const feeDollars = Math.max(percentFeeDollars, minDollarFee);
        const gross = +(total + feeDollars).toFixed(2);
        const per = +(gross / installments).toFixed(2);

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
                    plan_total_cents: Math.round(total * 100),
                    plan_fee_cents: Math.round((gross - total) * 100),
                    plan_gross_cents: Math.round(gross * 100),
                    per_payment_cents: Math.round(per * 100),
                    baseCredits: BASE_CREDITS[tier],
                    bonusCredits: bonus,
                    referralExtra: refExtra,
                    referralCodeUsed: referralValid ? referralCode : '',
                    refOwnerEmail: referralValid ? refOwnerEmail : '',
                    discountPctUsed: discountPct
                }
            },


            success_url: `${process.env.APP_BASE || 'http://localhost:4242'}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.APP_BASE || 'http://localhost:4242'}/#plans`
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe plan error:', err);
        res.status(500).json({ error: 'stripe_error' });
    }
});

let discountHold = false;
let bonusHold = false;
let bannerMsg = '';

app.post('/control-room/toggles', adminAuth, express.json(), (req, res) => {
    const {
        discount_override = null,
        bonus_override = null,
        hold_drop = null,
        rollover_months = null,
        banner = null,
        banner_style = null,
        banner_theme = null,
        banner_speed = null,
        banner_dismissible = null
    } = req.body || {};

    if (discount_override !== null) cfg.discount_override = (discount_override === '' ? null : Number(discount_override));
    if (bonus_override !== null) cfg.bonus_override = (bonus_override === '' ? null : Number(bonus_override));
    if (hold_drop !== null) cfg.hold_drop = !!hold_drop;
    if (rollover_months !== null) cfg.rollover_months = Math.max(1, Math.min(24, Number(rollover_months) || 6));
    if (banner !== null) cfg.banner = String(banner);

    if (banner_style !== null) cfg.banner_style = String(banner_style || 'static');
    if (banner_theme !== null) cfg.banner_theme = String(banner_theme || 'info');
    if (banner_speed !== null) cfg.banner_speed = Math.max(6, Math.min(60, Number(banner_speed) || 18));
    if (banner_dismissible !== null) cfg.banner_dismissible = !!banner_dismissible;

    res.json(cfg);
});



app.get('/control-room/toggles', adminAuth, (req, res) => {
    res.json(cfg);
});




app.listen(4242, () => console.log('✅ Server listening on :4242'));
