// checkout.js – handles Buy-flow + referral code + call to your back-end
document.addEventListener('DOMContentLoaded', () => {
    const tiers = ['solo', 'plus', 'pro', 'agency'];
    const buttons = Array.from(document.querySelectorAll('#plans a.bg-pink-500'));
  
    buttons.forEach((btn, i) => {
      btn.dataset.tier = tiers[i];
      btn.classList.add('buy-btn');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openModal(btn.dataset.tier);
      });
    });
  
    const modal       = document.getElementById('referral-modal');
    const input       = document.getElementById('referral-code-input');
    const stackWrap   = document.getElementById('stack-count-wrap');
    const stackSelect = document.getElementById('stack-count');
    const btnSkip     = document.getElementById('referral-skip');
    const btnGo       = document.getElementById('referral-continue');
  
    let selectedTier  = null;

const planModal   = document.getElementById('plan-modal');
const planGrid    = document.getElementById('plan-grid');
const planSummary = document.getElementById('plan-summary');
const btnPlanPay  = document.getElementById('plan-pay');
const btnPlanBack = document.getElementById('plan-cancel');
const btnPlanOther= document.getElementById('plan-other');

let selectedInstallments = 1;
let lastOptions = null;
let lastReferral = '';
let lastStack = 1;

function showPlanModal() { planModal && planModal.classList.remove('hidden'); }
function hidePlanModal() { planModal && planModal.classList.add('hidden'); }
function disablePlanButtons(disabled) {
  if (btnPlanPay)   btnPlanPay.disabled   = disabled;
  if (btnPlanBack)  btnPlanBack.disabled  = disabled;
  if (btnPlanOther) btnPlanOther.disabled = disabled;
}

async function openPlanModal(referral) {
  lastReferral = referral || '';
  lastStack    = Math.max(1, parseInt(stackSelect.value || '1', 10));
  disablePlanButtons(true);
  planGrid.innerHTML = '';
  planSummary.textContent = 'Calculating your one-time price and available payment plans...';
  showPlanModal();

  const payload = {
    tier: selectedTier,
    referralCode: lastReferral,
    stackCount: lastStack,
    promoCode: window.SNAP_PROMO_CODE || ''
  };

  try {
    const r = await fetch((window.SNAP_API_BASE || '') + '/api/pricing-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();

    lastOptions = data;
    {
        const base = `Plan: ${data.tierLabel} · Stack: ${data.stackCount} · Today’s discount: ${data.discountPct}%`;
        if (data.referralValid) {
          const credits = data.referralExtraTotal || 0;
          const codeTxt = data.referralCode || '';
          planSummary.innerHTML = `${base}<br><span class="text-green-300">Referral code ${codeTxt} detected. You and the referrer each get ${credits} credits in total. For payment plans, credits are added per successful payment.</span>`;
        } else {
          planSummary.textContent = base;
        }
      }
      
    // Build cards
    const cards = [];
    // One-time
    cards.push({
        label: 'Pay in full',
        sub: data.oneTime.note,
        installments: 1,
        amount: data.oneTime.totalFormatted,
        feeNote: '',
        creditsNote: (data.referralValid && data.referralExtraTotal)
          ? `≈ ${Math.round(data.referralExtraTotal)} credits to you and ${Math.round(data.referralExtraTotal)} to the referrer`
          : ''
      });
    
  // Installments
  data.installments.forEach(opt => {
    const pct = Math.round((opt.feePercentEffective || 0) * 100);
    const feeLine = `Plan fee: +$${(opt.feeDollars || 0).toFixed ? opt.feeDollars.toFixed(2) : (opt.feeDollars || 0)} (≈ ${pct}%)`;
    cards.push({
      label: `${opt.installments} payments`,
      sub: `${opt.perPaymentFormatted} / month`,
      installments: opt.installments,
      amount: opt.totalWithFeeFormatted,
      feeNote: feeLine,
      creditsNote: (data.referralValid && opt.approxCreditsPerPayment)
        ? `≈ ${opt.approxCreditsPerPayment} credits per payment to you and ${opt.approxCreditsPerPayment} to the referrer`
        : ''
    });
  });
  
  planGrid.innerHTML = cards.map(c => `
    <button data-inst="${c.installments}" class="block text-left bg-blue-800/60 hover:bg-blue-700 rounded-lg p-4 border border-blue-700">
      <div class="text-lg font-semibold">${c.label}</div>
      <div class="text-sm text-blue-200">${c.sub}</div>
      <div class="mt-1 text-sm text-blue-300">Total: ${c.amount}</div>
      ${c.feeNote ? `<div class="mt-1 text-xs text-blue-300">${c.feeNote}</div>` : ``}
      ${c.creditsNote ? `<div class="mt-1 text-xs text-green-300">${c.creditsNote}</div>` : ``}
    </button>
  `).join('');


    Array.from(planGrid.querySelectorAll('button[data-inst]')).forEach(btn => {
      btn.addEventListener('click', () => {
        Array.from(planGrid.querySelectorAll('button[data-inst]')).forEach(b => b.classList.remove('ring-2', 'ring-pink-400'));
        btn.classList.add('ring-2', 'ring-pink-400');
        selectedInstallments = parseInt(btn.getAttribute('data-inst') || '1', 10);
      });
    });

    selectedInstallments = 1; // default
    disablePlanButtons(false);
  } catch (e) {
    planSummary.textContent = 'Could not calculate options. Please try again.';
    disablePlanButtons(false);
  }
}

btnPlanBack && btnPlanBack.addEventListener('click', () => {
  hidePlanModal();
});

btnPlanPay && btnPlanPay.addEventListener('click', async () => {
  disablePlanButtons(true);
  try {
    const payload = {
      tier        : selectedTier,
      referralCode: lastReferral,
      stackCount  : lastStack,
      installments: selectedInstallments,
      promoCode   : window.SNAP_PROMO_CODE || ''
    };
    const r  = await fetch((window.SNAP_API_BASE || '') + '/api/create-plan-checkout', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload)
    });
    const data = await r.json();
    if (data?.url) {
      window.location.href = data.url;
    } else {
      alert('Could not start checkout. Please try again.');
      disablePlanButtons(false);
    }
  } catch {
    alert('Something went wrong. Please try again.');
    disablePlanButtons(false);
  }
});

btnPlanOther && btnPlanOther.addEventListener('click', async () => {
  disablePlanButtons(true);
  const email = prompt('Enter your email so we can send your manual invoice / instructions:');
  if (!email) { disablePlanButtons(false); return; }
  const phone = prompt('Phone (optional, for faster coordination):') || '';
  try {
    const payload = {
      tier        : selectedTier,
      referralCode: lastReferral,
      stackCount  : lastStack,
      installments: selectedInstallments,
      email,
      phone
    };
    const r = await fetch((window.SNAP_API_BASE || '') + '/api/alt-pay-request', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload)
    });
    const data = await r.json();
    if (data?.reference) {
      alert('Thanks! Your reference code is ' + data.reference + '. Please post it in the Facebook group so an admin can invoice you, or email sales@snaplayer.com with this reference.');
      hidePlanModal();
    } else {
      alert('Could not record your request. Please try again.');
    }
  } catch {
    alert('Could not record your request. Please try again.');
  } finally {
    disablePlanButtons(false);
  }
});
  
    function openModal(tier) {
        selectedTier = tier;
        input.value  = '';
        stackWrap.classList.remove('hidden');
        modal.classList.remove('hidden');
    }
    function hideModal() { modal.classList.add('hidden'); }
  
    modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });
  
    btnSkip.addEventListener('click', async () => {
        await openPlanModal('');
      });
      
      btnGo.addEventListener('click', async () => {
        await openPlanModal(input.value.trim());
      });
      
  
    async function goToCheckout(referralCode) {
      btnSkip.disabled = true; btnGo.disabled = true;
      try {
        const payload = {
            tier        : selectedTier,
            referralCode: referralCode || '',
            stackCount  : Math.max(1, parseInt(stackSelect.value || '1', 10)),
            promoCode   : window.SNAP_PROMO_CODE || ''
          };
        const r  = await fetch((window.SNAP_API_BASE || '') + '/api/create-checkout-session', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify(payload)
          });
          
        const data = await r.json();
        if (data?.url) {
          window.location.href = data.url;
        } else {
          alert('Could not start checkout. Please try again.');
          btnSkip.disabled = false; btnGo.disabled = false;
        }
      } catch {
        alert('Something went wrong. Please try again.');
        btnSkip.disabled = false; btnGo.disabled = false;
      }
    }
  });
  
  