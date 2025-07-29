// main.js: Handles dynamic pricing and countdown for SnapLayer prelaunch site

const prelaunchStart = new Date('2025-07-27T00:00:00-06:00');

// Base prices for each tier
const basePrices = {
  solo: 49,
  plus: 149,
  pro: 299,
  agency: 499,
};

// Update pricing and discount display
function updatePricing() {
  const now = new Date();
  const daysElapsed = Math.floor((now - prelaunchStart) / 86400000);
  const discount = Math.max(0, 50 - daysElapsed);
  for (const tier in basePrices) {
    const priceEl = document.querySelector(`.price-${tier}`);
    const discEl = document.querySelector(`.discount-${tier}`);
    if (!priceEl || !discEl) continue;
    const base = basePrices[tier];
    const finalPrice = (base * (1 - discount / 100)).toFixed(2);
    priceEl.textContent = `$${finalPrice}`;
    discEl.textContent = `${discount}% off`;
  }
  // update hero price (use solo price as default)
  const heroPrice = (basePrices.solo * (1 - discount / 100)).toFixed(2);
  const priceSoloEl = document.getElementById('price-solo');
  const discountSoloEl = document.getElementById('discount-solo');
  if (priceSoloEl && discountSoloEl) {
    priceSoloEl.textContent = `$${heroPrice}`;
    discountSoloEl.textContent = `${discount}% off`;
  }
}

// Update countdown to midnight local time
function updateTimer() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const diff = midnight - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  const timerEl = document.getElementById('timer');
  if (timerEl) {
    timerEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updatePricing();
  updateTimer();
  setInterval(updateTimer, 1000);
});