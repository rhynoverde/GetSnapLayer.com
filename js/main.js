// main.js: Handles dynamic pricing, countdown, and banner

const API_BASE = window.SNAP_API_BASE || '';

let prelaunchStart = new Date('2025-08-04T00:00:00Z');

// Base prices for each tier
const basePrices = {
  solo: 49,
  plus: 149,
  pro: 299,
  agency: 499,
};

// Dev simulation state
const dev = {
  forceRemainingSec: null // null = live; number = pretend seconds remaining
};

let explodedToday = false;
let lastAutoDiscount = null;

// --- Pricing / Discount ---
function calcDiscount(now = new Date()) {
  const cfg = window.__RUNTIME_CFG__ || {};
  if (cfg.discount_override != null) return cfg.discount_override;

  const d = Math.floor((now - prelaunchStart) / 86_400_000);
  const raw = 60 - d;                  // starts at 60, drops daily
  const autoVal = Math.max(50, raw);   // never below 50%

  if (cfg.hold_drop) {
    if (lastAutoDiscount != null) return lastAutoDiscount;
  }
  lastAutoDiscount = autoVal;
  return autoVal;
}

function updatePricing() {
  const now = new Date();
  const discount = calcDiscount(now);

  for (const tier in basePrices) {
    const priceEl = document.querySelector(`.price-${tier}`);
    const discEl = document.querySelector(`.discount-${tier}`);
    if (!priceEl || !discEl) continue;
    const base = basePrices[tier];
    const finalPrice = (base * (1 - discount / 100)).toFixed(2);
    priceEl.textContent = `$${finalPrice}`;
    discEl.textContent = `${discount}% off`;
  }

  const discountLabel = document.getElementById('todays-discount');
  if (discountLabel) discountLabel.textContent = `Today’s Discount: ${discount}% Off`;

  const headerDiscountText = document.getElementById('header-discount-text');
  if (headerDiscountText) headerDiscountText.textContent = `${discount}% discount expires in`;

  const tomorrowLine = document.getElementById('tomorrow-line');
  if (tomorrowLine) {
    const tomorrowDiscount = Math.max(0, discount - 1);
    tomorrowLine.textContent = `Tomorrow's discount will be ${tomorrowDiscount}% and limits will decrease.`;
  }

  updatePlanBonuses();
}

function updatePlanBonuses() {
  const cfg = window.__RUNTIME_CFG__ || {};
  const base = { solo: 250, plus: 1000, pro: 5000, agency: 10000 };
  const startBonus = { solo: 100, plus: 400, pro: 2000, agency: 4000 }; // 40% of base

  const now = new Date();
  const daysElapsed = Math.max(0, Math.floor((now - prelaunchStart) / 86400000));
  const currentBonus = {};

  if (cfg.bonus_override != null) {
    Object.keys(startBonus).forEach(tier => { currentBonus[tier] = Number(cfg.bonus_override); });
  } else {
    Object.keys(startBonus).forEach(tier => {
      const start = startBonus[tier];
      const drop = Math.round(start * 0.02 * daysElapsed);
      currentBonus[tier] = Math.max(0, start - drop);
    });
  }

  document.querySelectorAll('.plan-base').forEach(el => {
    const tier = el.getAttribute('data-tier');
    if (tier && base[tier] != null) el.textContent = base[tier];
  });
  document.querySelectorAll('.plan-bonus').forEach(el => {
    const tier = el.getAttribute('data-tier');
    if (tier && currentBonus[tier] != null) el.textContent = currentBonus[tier];
  });

  const rollover = Math.max(1, Number(cfg.rollover_months || 6));
  document.querySelectorAll('.rollover-months').forEach(el => { el.textContent = rollover; });
}


// --- Banner ---
function renderBanner() {
  const cfg = window.__RUNTIME_CFG__ || {};
  const host = document.getElementById('site-banner');
  if (!host) return;

  const text = (cfg.banner || '').trim();
  if (!text) { host.classList.add('hidden'); host.innerHTML=''; return; }

  const theme        = (cfg.banner_theme || 'info').toLowerCase();
  const mode         = (cfg.banner_style || 'static').toLowerCase();
  const durationSec  = Math.max(6, Math.min(60, Number(cfg.banner_speed || 18)));
  const dismissible  = (cfg.banner_dismissible !== false);

  const closeBtn = dismissible ? '<button id="banner-close" class="banner-close">×</button>' : '';

  if (mode === 'scroll') {
    const repeated = Array(8).fill(text).join(' • ');
    host.innerHTML =
      '<div class="banner-strip banner-' + theme + ' banner-marquee" style="--duration:' + durationSec + 's">' +
        '<div class="banner-inner"><span class="track">' + repeated + '</span></div>' +
        closeBtn +
      '</div>';
  } else {
    const lines = (text || '').split('\n').slice(0,5).map(s => '<div>'+s+'</div>').join('');
host.innerHTML =
  '<div class="banner-strip banner-' + theme + ' banner-static">' +
    '<div class="banner-inner" style="display:flex;flex-direction:column;gap:2px">' + lines + '</div>' +
    closeBtn +
  '</div>';

  }

  host.classList.remove('hidden');
  const headerEl = document.querySelector('header');
  const applyOffset = () => { if (headerEl) headerEl.style.top = host.offsetHeight + 'px'; };
  applyOffset();
  window.addEventListener('resize', applyOffset);
  const btn = document.getElementById('banner-close');
  if (btn) btn.addEventListener('click', () => {
    host.classList.add('hidden');
    if (headerEl) headerEl.style.top = '0px';
  });
  
}

// --- Time helpers / formatting ---
function msUntilMidnight(now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  let diff = midnight - now;
  if (dev.forceRemainingSec != null) diff = dev.forceRemainingSec * 1000;
  return diff;
}

function formatHHMMSS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function applyTimerEffects(remainingMs) {
  const main = document.getElementById('timer');
  const mini = document.getElementById('mini-timer-display');
  const head = document.getElementById('header-timer');
  const headMobile = document.getElementById('header-timer-mobile');

  const inLastHour = remainingMs <= 3600000 && remainingMs > 0;
  const inLastTenMin = remainingMs <= 600000 && remainingMs > 0;
  const inLastTenSec = remainingMs <= 60000 && remainingMs > 0;

  const apply = (el) => {
    if (!el) return;
    el.classList.toggle('pulse-hour', inLastHour && !inLastTenMin && !inLastTenSec);
    el.classList.toggle('shake-ten', inLastTenMin && !inLastTenSec);
    el.classList.toggle('shake-final', inLastTenSec);
  };

  apply(main);
  apply(mini);
  apply(head);
  apply(headMobile);
}

function explodeAndReset() {
  if (explodedToday) return;
  explodedToday = true;

  const overlay = document.getElementById('explosion-overlay');
  if (overlay) {
    overlay.classList.add('explode');
    overlay.addEventListener('animationend', () => {
      overlay.classList.remove('explode');
      explodedToday = false;
      dev.forceRemainingSec = null; // return to live
      updatePricing();
      updateTimer(); // refresh to new day
    }, { once: true });
  } else {
    updatePricing();
    updateTimer();
    explodedToday = false;
  }
}

// --- Timer updates (main and mini) ---
function updateTimer() {
  const remaining = msUntilMidnight();
  const text = formatHHMMSS(remaining);

  const timerEl = document.getElementById('timer');
  if (timerEl) timerEl.textContent = text;

  const miniEl = document.getElementById('mini-timer-display');
  if (miniEl) miniEl.textContent = text;

  const headEl = document.getElementById('header-timer');
  if (headEl) headEl.textContent = text;

  const headMobileEl = document.getElementById('header-timer-mobile');
  if (headMobileEl) headMobileEl.textContent = text;

  applyTimerEffects(remaining);

  if (remaining <= 0) explodeAndReset();

  if (dev.forceRemainingSec != null && dev.forceRemainingSec > 0) {
    dev.forceRemainingSec -= 1;
  }
}

function showMiniTimerIfNeeded() {
  const mini = document.getElementById('mini-timer');
  const hero = document.getElementById('hero');
  if (!mini || !hero) return;
  const threshold = hero.offsetTop + hero.offsetHeight - 120;
  if (window.scrollY > threshold) mini.classList.remove('hidden');
  else mini.classList.add('hidden');
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const r = await fetch(`${API_BASE}/api/runtime-config`);
    const s = await r.json().catch(() => ({}));
    if (s.prelaunchStart) prelaunchStart = new Date(s.prelaunchStart);
    if (s.cfg) window.__RUNTIME_CFG__ = s.cfg;
  } catch {}

  renderBanner();
  updatePricing();
  updateTimer();
  setInterval(updateTimer, 1000);

  // Logo shrink on scroll + show mini timer
  const logo = document.getElementById('snaplayer-logo');
  const onScroll = () => {
    if (logo) {
      if (window.scrollY > 20) logo.classList.add('logo-small');
      else logo.classList.remove('logo-small');
    }
    showMiniTimerIfNeeded();
  };
  window.addEventListener('scroll', onScroll);
  onScroll();

  // Mobile hamburger
  const menuToggle = document.getElementById('menu-toggle');
  const mobileNav  = document.getElementById('mobile-nav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => mobileNav.classList.toggle('hidden'));
  }

  // Dev panel buttons
  const btnHour   = document.getElementById('dev-hour');
  const btnTen    = document.getElementById('dev-ten');
  const btnTenSec = document.getElementById('dev-tensec');
  const btnReset  = document.getElementById('dev-reset');
  const btnExplode= document.getElementById('dev-explode');
  const btnHide   = document.getElementById('dev-hide');
  const btnShow   = document.getElementById('dev-show');
  const devPanel  = document.getElementById('dev-panel');

  if (btnHour)   btnHour.addEventListener('click', () => { dev.forceRemainingSec = 3600; updateTimer(); });
  if (btnTen)    btnTen.addEventListener('click',  () => { dev.forceRemainingSec = 600;  updateTimer(); });
  if (btnTenSec) btnTenSec.addEventListener('click', () => { dev.forceRemainingSec = 10;  updateTimer(); });
  if (btnReset)  btnReset.addEventListener('click', () => { dev.forceRemainingSec = null; updateTimer(); });
  if (btnExplode)btnExplode.addEventListener('click',() => { dev.forceRemainingSec = 0;   updateTimer(); });
  if (btnHide && btnShow && devPanel) {
    btnHide.addEventListener('click', () => { devPanel.classList.add('hidden'); btnShow.classList.remove('hidden'); });
    btnShow.addEventListener('click', () => { devPanel.classList.remove('hidden'); btnShow.classList.add('hidden'); });
  }

  // Image style toggle for "Why Buy Now?"
  const toggle = document.getElementById('style-toggle');
  const imageMap = {
    'built-for-speed'  : { uniform: 'images/built-for-speed-uniform-style.jpg',  alt: 'images/built-for-speed-style-002.jpg' },
    'reuse-or-resell'  : { uniform: 'images/resell-or-reuse-uniform-style.jpg',  alt: 'images/reuse-or-resell-style-002.jpg' },
    'stack-accounts'   : { uniform: 'images/stack-accounts-uniform-style.jpg',   alt: 'images/stack-accounts-style-002.jpg' },
    'shape-the-product': { uniform: 'images/shape-the-product-uniform-style.jpg',alt: 'images/shape-the-project-style-002.jpg' }
  };
  let useAlt = false;
  const applyStyle = () => {
    Object.entries(imageMap).forEach(([key, paths]) => {
      const img = document.querySelector(`img[data-key="${key}"]`);
      if (img) img.src = useAlt ? paths.alt : paths.uniform;
    });
  };
  if (toggle) {
    toggle.addEventListener('click', () => {
      useAlt = !useAlt;
      applyStyle();
      toggle.textContent = useAlt ? 'Show Uniform Style' : 'Show Style 002';
    });
    applyStyle();
  }

  // Reveal-on-scroll for features
  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('opacity-100','translate-y-0'); });
  }, { threshold: 0.15 });
  document.querySelectorAll('[data-reveal]').forEach(el => observer.observe(el));
});
