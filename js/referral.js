(function () {
    const API = (window.SNAP_API_BASE || '') + '';
    const $ = (id) => document.getElementById(id);

    function setMsg(el, html, good) {
        if (!el) return;
        el.innerHTML = html;
        el.className = 'mt-3 text-sm ' + (good ? 'text-green-300' : 'text-red-300');
    }

    async function postJSON(url, body) {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { ok: r.ok, data: await r.json().catch(() => ({})) };
    }

    async function getJSON(url) {
        const r = await fetch(url);
        return { ok: r.ok, data: await r.json().catch(() => ({})) };
    }

    document.addEventListener('DOMContentLoaded', () => {
        // Get today's referral code
        const formGet = $('form-get-code');
        formGet && formGet.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = $('get-email').value.trim();
            const resEl = $('get-code-result');
            setMsg(resEl, 'Working...', true);
            const { ok, data } = await postJSON(API + '/api/referrals/generate', { ownerEmail: email });
            if (ok && data && data.code) {
                try { await navigator.clipboard.writeText(data.code); } catch { }
                setMsg(
                    resEl,
                    `Your code for today: <span class="font-mono font-semibold">${data.code}</span><br>
             Share this anywhere. When someone buys with it, you get +10% of their plan’s monthly credits.`,
                    true
                );
            } else {
                setMsg(resEl, 'Could not generate a code. Double-check your email and try again.', false);
            }
        });

        // Redeem a friend's code after purchase
        const formRedeem = $('form-redeem');
        formRedeem && formRedeem.addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = $('redeem-code').value.trim().toUpperCase();
            const email = $('redeem-email').value.trim();
            const resEl = $('redeem-result');
            setMsg(resEl, 'Validating & redeeming...', true);
            const { ok, data } = await postJSON(API + '/api/referrals/redeem-after', { code, purchaserEmail: email });
            if (ok && data && data.ok) {
                const refundMsg = (data.discount_refund_due && data.discount_refund_due > 0)
                    ? ` We will refund ${data.discount_refund_due}% to match the 50% max discount.`
                    : '';
                setMsg(resEl, `Success! You earned +${data.credit_value} credits.${refundMsg}`, true);
            } else {
                const msg = (data && (data.error || data.message)) || 'Redemption failed.';
                setMsg(resEl, 'That code is invalid or fully used up.', false);
                try {
                    const fb = 'https://www.facebook.com/search/top/?q=' + encodeURIComponent('SnapLayer referral code');
                    const html = '<div class="mt-2"><a href="' + fb + '" target="_blank" class="inline-block px-3 py-2 rounded bg-blue-700 text-white">Search for a Valid Referral Code</a></div>' +
                        '<div class="mt-2 flex gap-2 flex-wrap">' +
                        '<a href="#" target="_blank" class="px-3 py-2 rounded bg-blue-800 text-white">SnapLayer Facebook Group (must join first)</a>' +
                        '<a href="#" target="_blank" class="px-3 py-2 rounded bg-indigo-800 text-white">SnapLayer Discord Server (must join first)</a>' +
                        '</div>';
                    resEl.insertAdjacentHTML('beforeend', html);
                } catch { }
            }
        });

        // View referral history
        const formHist = $('form-history');
        formHist && formHist.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = $('history-email').value.trim();
            const resEl = $('history-result');
            setMsg(resEl, 'Loading...', true);
            const { ok, data } = await getJSON(API + '/api/referrals/history?email=' + encodeURIComponent(email));
            if (ok && data) {
                const items = Array.isArray(data.redemptions) ? data.redemptions : [];
                const list = items.slice(0, 10).map(r =>
                    `<li class="mb-1"><span class="font-mono">${r.code}</span> · ${r.tier_purchased} · ${r.credit_value} credits · ${new Date(r.redeemed_ts).toLocaleString()}</li>`
                ).join('');
                setMsg(
                    resEl,
                    `Total redemptions: <b>${data.total_redemptions || 0}</b> · Credits earned: <b>${data.credits_earned || 0}</b>` +
                    (list ? `<ul class="mt-2">${list}</ul>` : ''),
                    true
                );
            } else {
                setMsg(resEl, 'No history yet for this email.', false);
            }
        });
    });
})();
