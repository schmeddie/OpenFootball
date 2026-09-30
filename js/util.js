// Shared helpers. Every script attaches to the global OF namespace so the app
// runs without a build step and the engine can also be loaded from Node.
(function (root) {
  const OF = (root.OF = root.OF || {});

  // Small, fast, seedable PRNG (mulberry32).
  function makeRng(seed) {
    let a = seed >>> 0;
    const rng = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
    rng.chance = (p) => rng() < p;
    rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
    // Pick an item with probability proportional to weightFn(item).
    rng.weighted = (arr, weightFn) => {
      let total = 0;
      const ws = arr.map((x) => {
        const w = Math.max(0, weightFn(x));
        total += w;
        return w;
      });
      if (total <= 0) return arr.length ? rng.pick(arr) : undefined;
      let r = rng() * total;
      for (let i = 0; i < arr.length; i++) {
        r -= ws[i];
        if (r <= 0) return arr[i];
      }
      return arr[arr.length - 1];
    };
    return rng;
  }

  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const logistic = (x) => 1 / (1 + Math.exp(-x));
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

  // Weighted blend of attributes: weights is { attrKey: weight }.
  function blend(attrs, weights) {
    let s = 0;
    let w = 0;
    for (const k in weights) {
      s += (attrs[k] || 0) * weights[k];
      w += weights[k];
    }
    return w ? s / w : 0;
  }

  OF.util = { makeRng, hashSeed, clamp, logistic, avg, blend };
})(typeof globalThis !== 'undefined' ? globalThis : this);
