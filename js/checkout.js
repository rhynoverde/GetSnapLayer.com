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
  
    function openModal(tier) {
        selectedTier = tier;
        input.value  = '';
        stackWrap.classList.remove('hidden');
        modal.classList.remove('hidden');
    }
    function hideModal() { modal.classList.add('hidden'); }
  
    modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });
  
    btnSkip.addEventListener('click', async () => {
      await goToCheckout('');
    });
  
    btnGo.addEventListener('click', async () => {
      await goToCheckout(input.value.trim());
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
  
  