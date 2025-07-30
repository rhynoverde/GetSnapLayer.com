// main.js: Handles dynamic pricing and countdown for SnapLayer prelaunch site

const prelaunchStart = new Date('2025-07-27T00:00:00-06:00');

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

// --- Pricing / Discount ---
function calcDiscount(now = new Date()) {
  const daysElapsed = Math.floor((now - prelaunchStart) / 86400000);
  return Math.max(0, 50 - daysElapsed);
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
  if (discountLabel) {
    discountLabel.textContent = `Today’s Discount: ${discount}% Off`;
  }

  const headerDiscountText = document.getElementById('header-discount-text');
  if (headerDiscountText) {
    headerDiscountText.textContent = `${discount}% discount expires in`;
  }

  const tomorrowLine = document.getElementById('tomorrow-line');
  if (tomorrowLine) {
    const tomorrowDiscount = Math.max(0, discount - 1);
    tomorrowLine.textContent = `Tomorrow's discount will be ${tomorrowDiscount}% and limits will decrease.`;
  }

  updatePlanBonuses();
}

function updatePlanBonuses() {
  const base = { solo: 250, plus: 1000, pro: 5000, agency: 10000 };
  const startBonus = { solo: 200, plus: 200, pro: 1000, agency: 2000 }; // Day 1
  const now = new Date();
  const daysElapsed = Math.max(0, Math.floor((now - prelaunchStart) / 86400000)); // Day 0-based
  const currentBonus = {};
  Object.keys(startBonus).forEach(tier => {
    const start = startBonus[tier];
    const drop = Math.round(start * 0.02 * daysElapsed); // 2% of starting bonus per day
    currentBonus[tier] = Math.max(0, start - drop);
  });

  document.querySelectorAll('.plan-base').forEach(el => {
    const tier = el.getAttribute('data-tier');
    if (tier && base[tier] != null) el.textContent = base[tier];
  });
  document.querySelectorAll('.plan-bonus').forEach(el => {
    const tier = el.getAttribute('data-tier');
    if (tier && currentBonus[tier] != null) el.textContent = currentBonus[tier];
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
    // Safety fallback
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

  if (remaining <= 0) {
    explodeAndReset();
  }

  if (dev.forceRemainingSec != null && dev.forceRemainingSec > 0) {
    dev.forceRemainingSec -= 1;
  }
}


function showMiniTimerIfNeeded() {
  const mini = document.getElementById('mini-timer');
  const hero = document.getElementById('hero');
  if (!mini || !hero) return;
  const threshold = hero.offsetTop + hero.offsetHeight - 120;
  if (window.scrollY > threshold) {
    mini.classList.remove('hidden');
  } else {
    mini.classList.add('hidden');
  }
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  updatePricing();
  updateTimer();
  setInterval(updateTimer, 1000);

  // Logo shrink on scroll + show mini timer
  const logo = document.getElementById('snaplayer-logo');
  const onScroll = () => {
    if (logo) {
      if (window.scrollY > 20) {
        logo.classList.add('logo-small');
      } else {
        logo.classList.remove('logo-small');
      }
    }
    showMiniTimerIfNeeded();
  };
  window.addEventListener('scroll', onScroll);
  onScroll();

  // Mobile hamburger
  const menuToggle = document.getElementById('menu-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => {
      mobileNav.classList.toggle('hidden');
    });
  }

  // Dev panel buttons (simulate last hour / last 10 min / last 10 sec / explode / reset)
  const btnHour = document.getElementById('dev-hour');
  const btnTen = document.getElementById('dev-ten');
  const btnTenSec = document.getElementById('dev-tensec');
  const btnReset = document.getElementById('dev-reset');
  const btnExplode = document.getElementById('dev-explode');
  const btnHide = document.getElementById('dev-hide');
  const btnShow = document.getElementById('dev-show');
  const devPanel = document.getElementById('dev-panel');

  if (btnHour) btnHour.addEventListener('click', () => { dev.forceRemainingSec = 3600; updateTimer(); });
  if (btnTen) btnTen.addEventListener('click', () => { dev.forceRemainingSec = 600; updateTimer(); });
  if (btnTenSec) btnTenSec.addEventListener('click', () => { dev.forceRemainingSec = 10; updateTimer(); });
  if (btnReset) btnReset.addEventListener('click', () => { dev.forceRemainingSec = null; updateTimer(); });
  if (btnExplode) btnExplode.addEventListener('click', () => { dev.forceRemainingSec = 0; updateTimer(); });
  if (btnHide && btnShow && devPanel) {
    btnHide.addEventListener('click', () => { devPanel.classList.add('hidden'); btnShow.classList.remove('hidden'); });
    btnShow.addEventListener('click', () => { devPanel.classList.remove('hidden'); btnShow.classList.add('hidden'); });
  }

  // Image style toggle for "Why Buy Now?" artwork
  const toggle = document.getElementById('style-toggle');
  const imageMap = {
    'built-for-speed': { uniform: 'images/built-for-speed-uniform-style.jpg', alt: 'images/built-for-speed-style-002.jpg' },
    'reuse-or-resell': { uniform: 'images/resell-or-reuse-uniform-style.jpg', alt: 'images/reuse-or-resell-style-002.jpg' },
    'stack-accounts': { uniform: 'images/stack-accounts-uniform-style.jpg', alt: 'images/stack-accounts-style-002.jpg' },
    'shape-the-product': { uniform: 'images/shape-the-product-uniform-style.jpg', alt: 'images/shape-the-project-style-002.jpg' }
  };
  let useAlt = false;
  const applyStyle = () => {
    Object.entries(imageMap).forEach(([key, paths]) => {
      const img = document.querySelector(`img[data-key="${key}"]`);
      if (img) img.src = useAlt ? paths.alt : paths.uniform;
    });
  };
  if (toggle) {
    toggle.addEventListener('click', () => { useAlt = !useAlt; applyStyle(); toggle.textContent = useAlt ? 'Show Uniform Style' : 'Show Style 002'; });
    applyStyle();
  }

  // Reveal-on-scroll for features
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) e.target.classList.add('opacity-100', 'translate-y-0');
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('[data-reveal]').forEach(el => observer.observe(el));
});

