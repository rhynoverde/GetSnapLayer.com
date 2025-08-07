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

    const modal = document.getElementById('referral-modal');
    const input = document.getElementById('referral-code-input');
    const stackWrap = document.getElementById('stack-count-wrap');
    const stackSelect = document.getElementById('stack-count');
    const btnRefPay = document.getElementById('ref-pay-card');
    const btnRefPlan = document.getElementById('ref-plan-options');
    const btnRefAlt = document.getElementById('ref-alt-pay');
    const refTierEl = document.getElementById('ref-plan-tier');
    const refPriceEl = document.getElementById('ref-plan-price');
    const refStatus = document.getElementById('referral-status');
    const refCredits = document.getElementById('ref-credits-line');

    let selectedTier = null;

    const planModal = document.getElementById('plan-modal');
    const planGrid = document.getElementById('plan-grid');
    const planSummary = document.getElementById('plan-summary');
    const btnPlanPay = document.getElementById('plan-pay');
    const btnPlanBack = document.getElementById('plan-cancel');
    const btnPlanOther = document.getElementById('plan-other');

    const altModal = document.getElementById('altpay-modal');
    const altMethod       = document.getElementById('alt-method');
    const altOtherMethod  = document.getElementById('alt-other-method');
    const altEmail        = document.getElementById('alt-email');
    const altPhone        = document.getElementById('alt-phone');
    const btnAltSubmit    = document.getElementById('alt-submit');
    const btnAltBack      = document.getElementById('alt-back');
    const altNote         = document.getElementById('alt-note');
    
    altMethod && altMethod.addEventListener('change', () => {
      if (!altOtherMethod) return;
      if ((altMethod.value || '') === 'other') {
        altOtherMethod.classList.remove('hidden');
      } else {
        altOtherMethod.classList.add('hidden');
        altOtherMethod.value = '';
      }
    });
    


    let selectedInstallments = 1;
    let lastOptions = null;
    let lastReferral = '';
    let lastStack = 1;

    function showPlanModal() { planModal && planModal.classList.remove('hidden'); }
    function hidePlanModal() { planModal && planModal.classList.add('hidden'); }
    function showAltModal() { altModal && altModal.classList.remove('hidden'); }
    function hideAltModal() { altModal && altModal.classList.add('hidden'); }
    function disablePlanButtons(disabled) {
        if (btnPlanPay) btnPlanPay.disabled = disabled;
        if (btnPlanBack) btnPlanBack.disabled = disabled;
        if (btnPlanOther) btnPlanOther.disabled = disabled;
    }


    async function openPlanModal(referral) {
        lastReferral = referral || '';
        lastStack = Math.max(1, parseInt(stackSelect.value || '1', 10));
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
                    {
                        const qty = lastStack;
                        const unit = (data.oneTime?.total || 0) / Math.max(1, qty);
                        const unitFmt  = new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(unit);
                        const totalFmt = data.oneTime?.totalFormatted || new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(data.oneTime?.total || 0);
                        const tierName = (selectedTier || '').toUpperCase();
                        const baseCredits  = Number(data.baseCredits || 0) * qty;
                        const bonusCredits = Number(data.bonusCredits || 0) * qty;
                        const refExtra     = Number(data.referralExtraTotal || 0);
                        const discount     = Math.round(Number(data.discountPct || 0));
                      
                        const nf = new Intl.NumberFormat('en-US');
let line = `<div class="text-sm">
                          <div class="font-semibold">${tierName} Plan - ${qty} License Stack</div>
                          <div class="mt-1">${unitFmt} × ${qty} = <span class="font-semibold">${totalFmt}</span> <span class="text-blue-300">(${discount}% off today)</span></div>
                          <div class="mt-1 text-blue-100">${nf.format(baseCredits)} Credits + ${nf.format(bonusCredits)} PreLaunch Bonus Credits${data.referralValid ? ` + ${nf.format(refExtra)} Referral Credits` : ''} = <span class="font-semibold">${nf.format(baseCredits + bonusCredits + (data.referralValid ? refExtra : 0))} Total Credits</span></div>
                        </div>`;
                      
                        if (data.referralValid) {
                          const name = data.referrerUsername ? `, ${data.referrerUsername},` : '';
                          line += `<div class="mt-2 text-green-300 text-xs">Valid code — You and the referrer${name ? name : ''} each get ${refExtra} bonus credits.</div>`;
                        }
                      
                        planSummary.innerHTML = line + `<div class="text-blue-300 text-xs mt-2">If you choose payment plans, credits are added per successful payment.</div>`;
                      }
                      
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
                tier: selectedTier,
                referralCode: lastReferral,
                stackCount: lastStack,
                installments: selectedInstallments,
                promoCode: window.SNAP_PROMO_CODE || ''
            };
            const r = await fetch((window.SNAP_API_BASE || '') + '/api/create-plan-checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
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

    btnPlanOther && btnPlanOther.addEventListener('click', () => {
        hidePlanModal();
        showAltModal();
    });

    btnAltBack && btnAltBack.addEventListener('click', () => {
        hideAltModal();
        showPlanModal();
    });

    btnAltSubmit && btnAltSubmit.addEventListener('click', async () => {
        const payload = {
          tier        : selectedTier,
          referralCode: lastReferral,
          stackCount  : lastStack,
          installments: selectedInstallments,
          email       : (altEmail?.value || '').trim(),
          phone       : (altPhone?.value || '').trim(),
          method      : (altMethod?.value || 'other'),
          other_method: ((altMethod?.value || '') === 'other') ? (altOtherMethod?.value || '').trim() : ''
        };
        altNote.textContent = 'Working...';
        try {
          const r = await fetch((window.SNAP_API_BASE || '') + '/api/alt-pay-request', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify(payload)
          });
          const data = await r.json();
          if (data?.reference) {
            altNote.textContent = 'Request captured. Check your DMs/email shortly. Reference: ' + data.reference;
          } else {
            altNote.textContent = 'Could not record your request. Please try again.';
          }
        } catch {
          altNote.textContent = 'Could not record your request. Please try again.';
        }
      });     


    function openModal(tier) {
        selectedTier = tier;
        input.value = '';
        stackSelect.value = '1';
        if (refStatus) { refStatus.textContent = ''; refStatus.className = ''; }
        stackWrap.classList.remove('hidden');
        modal.classList.remove('hidden');
        refreshReferralPanel();
      }
      
    function hideModal() { modal.classList.add('hidden'); }

    modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });

    modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });

    async function refreshReferralPanel() {
        const code = (input?.value || '').trim();
        const qty  = Math.max(1, parseInt(stackSelect?.value || '1', 10));
        const tier = selectedTier || '';
      
        const fmtMoney = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(+n || 0);
      
        try {
          const r = await fetch((window.SNAP_API_BASE || '') + '/api/pricing-options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tier,
              referralCode: code,
              stackCount: qty,
              promoCode: window.SNAP_PROMO_CODE || ''
            })
          });
          const d = await r.json();
      
          const baseCredits  = Number(d.baseCredits || 0) * qty;
          const bonusCredits = Number(d.bonusCredits || 0) * qty;
          const refExtra     = Number(d.referralExtraTotal || 0);
          const totalNoRef   = baseCredits + bonusCredits;
          const totalWithRef = totalNoRef + refExtra;
      
          const total        = (d.oneTime?.total ?? 0);
          const unit         = qty > 0 ? (total / qty) : 0;
          const unitFmt      = fmtMoney(unit);
          const totalFmt     = d.oneTime?.totalFormatted || fmtMoney(total);
          const tierName     = (tier || '').toUpperCase();
      
          if (refTierEl)  refTierEl.textContent  = `${tierName} Plan - ${qty} License Stack Plan`;
          if (refPriceEl) refPriceEl.textContent = qty === 1 ? `${totalFmt}` : `${unitFmt} × ${qty} = ${totalFmt}`;
      
          if (refCredits) {
            if (d.referralValid) {
              refCredits.textContent = `${baseCredits} Credits + ${bonusCredits} PreLaunch Bonus Credits + ${refExtra} Referral Credits = ${totalWithRef} Total Monthly Credits`;
            } else {
              refCredits.textContent = `${baseCredits} Credits + ${bonusCredits} PreLaunch Bonus Credits = ${totalNoRef} Total Monthly Credits`;
            }
          }
      
          if (refStatus) {
            if (!code) {
              refStatus.textContent = '';
              refStatus.className = '';
            } else if (d.referralValid) {
              const name = d.referrerUsername ? `, ${d.referrerUsername},` : '';
              refStatus.className = 'text-green-300';
              refStatus.textContent = `Valid code — You and the referrer${name ? name : ''} each get ${refExtra} bonus credits`;
            } else {
              const raw = (d.referralInvalidReason || '').toLowerCase();
              const reason = raw.includes('used') ? 'Used' : raw.includes('expir') ? 'Expired' : 'Not In System';
              refStatus.className = 'text-red-300';
              refStatus.textContent = `Code Not Valid — ${reason}`;
            }
          }
        } catch {
          if (refStatus) {
            if (code) {
              refStatus.className = 'text-red-300';
              refStatus.textContent = 'Could not validate code right now';
            } else {
              refStatus.textContent = '';
              refStatus.className = '';
            }
          }
        }
      }

      input.addEventListener('input', refreshReferralPanel);
      stackSelect.addEventListener('change', refreshReferralPanel);
      
    (function setupReferralInfoModal(){
        const openBtn = document.getElementById('referral-info');
        if (!openBtn) return;
      
        let shell = document.getElementById('ref-info-modal');
        if (!shell) {
          shell = document.createElement('div');
          shell.id = 'ref-info-modal';
          shell.className = 'fixed inset-0 z-50 hidden';
          shell.innerHTML = `
            <div class="absolute inset-0 bg-black/60"></div>
            <div class="absolute inset-0 flex items-center justify-center p-4">
              <div class="bg-blue-900 text-white rounded-xl shadow-xl max-w-lg w-full p-6 border border-blue-700">
                <h3 class="text-xl font-bold mb-3">Referral Codes</h3>
                <div class="space-y-3 text-sm text-blue-100">
                  <p>Codes have limited use. Ask the community for another code!</p>
                  <p>Codes can be entered <strong>after purchase</strong> and Referral Bonus Credits are based on your purchase date/window.</p>
                  <p>Feel free to continue with your purchase, then find or trade a limited-use code with a friend or in an LTD community or group (always follow group rules about posts/DMs).</p>
                </div>
                <div class="mt-5 text-right">
                  <button id="ref-info-close" class="bg-pink-500 hover:bg-pink-600 text-white px-4 py-2 rounded-md">Close</button>
                </div>
              </div>
            </div>`;
          document.body.appendChild(shell);
        }
      
        const show = () => { shell.classList.remove('hidden'); };
        const hide = () => { shell.classList.add('hidden'); };
      
        openBtn.addEventListener('click', show);
        shell.addEventListener('click', (e) => { if (e.target === shell || e.target.id === 'ref-info-close') hide(); });
      })();
      

    btnRefPlan?.addEventListener('click', async () => {
        await openPlanModal((input.value || '').trim());
    });

    btnRefPay?.addEventListener('click', async () => {
        await goToCheckout((input.value || '').trim());
    });

    btnRefAlt?.addEventListener('click', () => {
        hideModal();
        showAltModal();
    });



    async function goToCheckout(referralCode) {
        if (btnRefPay) btnRefPay.disabled = true;
        if (btnRefPlan) btnRefPlan.disabled = true;
        if (btnRefAlt) btnRefAlt.disabled = true;
        try {
            const payload = {
                tier: selectedTier,
                referralCode: referralCode || '',
                stackCount: Math.max(1, parseInt(stackSelect.value || '1', 10)),
                promoCode: window.SNAP_PROMO_CODE || ''
            };
            const r = await fetch((window.SNAP_API_BASE || '') + '/api/create-checkout-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await r.json();
            if (data?.url) {
                window.location.href = data.url;
            } else {
                alert('Could not start checkout. Please try again.');
                if (btnRefPay) btnRefPay.disabled = false;
                if (btnRefPlan) btnRefPlan.disabled = false;
                if (btnRefAlt) btnRefAlt.disabled = false;
            }
        } catch {
            alert('Something went wrong. Please try again.');
            if (btnRefPay) btnRefPay.disabled = false;
            if (btnRefPlan) btnRefPlan.disabled = false;
            if (btnRefAlt) btnRefAlt.disabled = false;
        }
    }

});

