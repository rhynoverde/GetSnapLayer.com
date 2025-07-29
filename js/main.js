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

  const tomorrowLine = document.getElementById('tomorrow-line');
  if (tomorrowLine) {
    const tomorrowDiscount = Math.max(0, discount - 1);
    tomorrowLine.textContent = `Tomorrow's discount will be ${tomorrowDiscount}% and limits will decrease.`;
  }
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
  const inLastHour = remainingMs <= 3600000 && remainingMs > 0;
  const inLastTen = remainingMs <= 600000 && remainingMs > 0;

  const apply = (el) => {
    if (!el) return;
    el.classList.toggle('pulse-hour', inLastHour);
    el.classList.toggle('shake-ten', inLastTen);
  };
  apply(main);
  apply(mini);
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

  applyTimerEffects(remaining);

  if (remaining <= 0) {
    explodeAndReset();
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

  // Logo shrink on scroll
  const logo = document.getElementById('snaplayer-logo');
  if (logo) {
    const onScroll = () => {
      if (window.scrollY > 20) {
        logo.classList.add('logo-small');
      } else {
        logo.classList.remove('logo-small');
      }
      showMiniTimerIfNeeded();
    };
    window.addEventListener('scroll', onScroll);
    onScroll();
  }

  // Dev panel buttons
  const btnHour = document.getElementById('dev-hour');
  const btnTen = document.getElementById('dev-ten');
  const btnTenSec = document.getElementById('dev-tensec');
  const btnReset = document.getElementById('dev-reset');
  const btnExplode = document.getElementById('dev-explode');

  if (btnHour) btnHour.addEventListener('click', () => { dev.forceRemainingSec = 3600; updateTimer(); });
  if (btnTen) btnTen.addEventListener('click', () => { dev.forceRemainingSec = 600; updateTimer(); });
  if (btnTenSec) btnTenSec.addEventListener('click', () => { dev.forceRemainingSec = 10; updateTimer(); });
  if (btnReset) btnReset.addEventListener('click', () => { dev.forceRemainingSec = null; updateTimer(); });
  if (btnExplode) btnExplode.addEventListener('click', () => { dev.forceRemainingSec = 0; updateTimer(); });
});
