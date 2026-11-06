/* ameter.js - analogt viserinstrument (SVG), gjenbrukbart.
 *
 * Hentet fra hanseinar/webrig-vhf (static/ameter.js), samme opphav.
 * Tillegg her: upper.zoneColor (farge på sonen fra redFrom, standard rød),
 * slik at sonen kan vise «mål nådd» i grønt i stedet for fare.
 *
 *   const m = new AnalogMeter(element, {
 *     upper: {label: "SIGNAL", ticks: [["1", .04], ["3", .155], ...], redFrom: .5, minor: 20},
 *     lower: {label: "POWER W", ticks: [["0", 0], ["10", .2], ...]},   // valgfri
 *     riseS: 0.3, fallS: 0.8,      // tid til ca. 95 % av utslaget opp / ned
 *   });
 *   m.set(0.62);                   // mål for viseren, 0..1 av skalaen
 *   m.value                        // der viseren står nå (0..1)
 *
 * Utseende: innfelt instrument med mørk ramme, opplyst gul skive, glass med
 * refleks, viser med skygge og navkappe. Viseren har treghet (eksponentiell,
 * ulik tid opp og ned, ingen oversving). Animasjonen går bare mens viseren
 * beveger seg. Respekterer prefers-reduced-motion (hopper rett til verdien).
 * Ingen avhengigheter. Skalerer med bredden på elementet.
 */
(function (root) {
  "use strict";
  let uid = 0;
  const NS = "http://www.w3.org/2000/svg";

  class AnalogMeter {
    constructor(el, opts) {
      this.el = el;
      this.o = Object.assign({riseS: 0.3, fallS: 0.8, a0: -48, a1: 48}, opts || {});
      this.value = 0;
      this.target = 0;
      this._raf = 0;
      this._last = 0;
      this.id = "am" + (++uid);
      this._build();
      this._draw(0);
    }

    set(f) {
      f = Math.max(0, Math.min(1, Number(f) || 0));
      this.target = f;
      if (root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        this.value = f; this._draw(f); return;
      }
      if (!this._raf) { this._last = performance.now(); this._raf = requestAnimationFrame(t => this._tick(t)); }
    }

    _tick(t) {
      const dt = Math.min(0.1, (t - this._last) / 1000);
      this._last = t;
      const up = this.target > this.value;
      const tau = (up ? this.o.riseS : this.o.fallS) / 3;      // 3 tidskonstanter = 95 %
      this.value += (this.target - this.value) * (1 - Math.exp(-dt / tau));
      if (Math.abs(this.target - this.value) < 0.0015) this.value = this.target;
      this._draw(this.value);
      this._raf = this.value === this.target ? 0 : requestAnimationFrame(tt => this._tick(tt));
    }

    _angle(f) { return this.o.a0 + (this.o.a1 - this.o.a0) * f; }

    _draw(f) {
      const a = this._angle(f);
      this.needle.setAttribute("transform", `rotate(${a.toFixed(2)} ${this.cx} ${this.cy})`);
      this.shadow.setAttribute("transform", `translate(2.2 3) rotate(${a.toFixed(2)} ${this.cx} ${this.cy})`);
    }

    _build() {
      const W = 300, H = 136, cx = 150, cy = 200, id = this.id, o = this.o;
      this.cx = cx; this.cy = cy;
      const pt = (r, f) => { const a = this._angle(f) * Math.PI / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
      const arc = (r, f0, f1) => {
        const [x0, y0] = pt(r, f0), [x1, y1] = pt(r, f1);
        return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
      };
      const ink = "#2a1d08", needleColor = "#b8261b";
      const red = (o.upper && o.upper.zoneColor) || "#b8261b";
      let g = "";
      const up = o.upper || {ticks: []}, redFrom = up.redFrom ?? 2;
      g += `<path d="${arc(148, 0, Math.min(1, redFrom))}" stroke="${ink}" stroke-width="2" fill="none"/>`;
      if (redFrom < 1) g += `<path d="${arc(148, redFrom, 1)}" stroke="${red}" stroke-width="4.5" fill="none"/>`;
      const minor = up.minor || 0;
      for (let i = 0; i <= minor; i++) {
        const f = i / minor, [x0, y0] = pt(148, f), [x1, y1] = pt(153, f);
        g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${f > redFrom ? red : ink}" stroke-width="1"/>`;
      }
      for (const [t, f] of up.ticks) {
        const [x0, y0] = pt(148, f), [x1, y1] = pt(159, f), [tx, ty] = pt(170, f), r = f > redFrom;
        g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${r ? red : ink}" stroke-width="2"/>`;
        g += `<text x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="${r ? red : ink}">${t}</text>`;
      }
      if (up.label) g += `<text x="${cx}" y="16" text-anchor="middle" font-size="11" font-weight="700" letter-spacing="2.5" fill="${ink}">${up.label}</text>`;
      if (up.unit) g += `<text x="14" y="${H - 8}" font-size="11" font-weight="700" fill="#6b4d12">${up.unit}</text>`;
      const lo = o.lower;
      if (lo) {
        g += `<path d="${arc(122, 0, 1)}" stroke="${ink}" stroke-width="1.2" fill="none"/>`;
        for (const [t, f] of lo.ticks) {
          const [x0, y0] = pt(122, f), [x1, y1] = pt(116, f), [tx, ty] = pt(106, f);
          g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${ink}" stroke-width="1.5"/>`;
          g += `<text x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="${ink}">${t}</text>`;
        }
        if (lo.label) g += `<text x="${cx}" y="${H - 22}" text-anchor="middle" font-size="9.5" font-weight="700" letter-spacing="2.5" fill="${ink}">${lo.label}</text>`;
      }
      const needle = `M${cx - 1.6},${cy} L${cx - 0.6},${cy - 158} L${cx + 0.6},${cy - 158} L${cx + 1.6},${cy} Z`;
      this.el.innerHTML = `
<div class="am-bezel" style="position:relative;border-radius:12px;padding:7px;
  background:linear-gradient(180deg,#0e1012 0%,#2b2f34 55%,#3a3f45 100%);
  box-shadow:inset 0 2px 3px rgba(0,0,0,.65), inset 0 -1px 0 rgba(255,255,255,.12), 0 1px 0 rgba(255,255,255,.35)">
 <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true"
      style="display:block;width:100%;border-radius:6px">
  <defs>
   <radialGradient id="${id}-face" cx="50%" cy="105%" r="115%">
    <stop offset="0" stop-color="#ffe3a0"/><stop offset=".55" stop-color="#f6b84a"/><stop offset="1" stop-color="#cf8419"/>
   </radialGradient>
   <linearGradient id="${id}-recess" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".16" stop-color="#000" stop-opacity=".12"/>
    <stop offset=".3" stop-color="#000" stop-opacity="0"/><stop offset=".92" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity=".22"/>
   </linearGradient>
   <linearGradient id="${id}-side" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#000" stop-opacity=".35"/><stop offset=".07" stop-color="#000" stop-opacity="0"/>
    <stop offset=".93" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/>
   </linearGradient>
   <linearGradient id="${id}-glass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset=".38" stop-color="#fff" stop-opacity=".07"/>
    <stop offset=".39" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
   </linearGradient>
   <radialGradient id="${id}-cap" cx="40%" cy="35%" r="70%">
    <stop offset="0" stop-color="#5a5f66"/><stop offset=".6" stop-color="#1b1d20"/><stop offset="1" stop-color="#000"/>
   </radialGradient>
   <filter id="${id}-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.6"/></filter>
   <clipPath id="${id}-clip"><rect x="0" y="0" width="${W}" height="${H}" rx="6"/></clipPath>
  </defs>
  <g clip-path="url(#${id}-clip)">
   <rect x="0" y="0" width="${W}" height="${H}" fill="url(#${id}-face)"/>
   ${g}
   <path class="am-shadow" d="${needle}" fill="#000" opacity=".32" filter="url(#${id}-blur)"/>
   <path class="am-needle" d="${needle}" fill="${needleColor}"/>
   <ellipse cx="${cx}" cy="${H + 14}" rx="34" ry="24" fill="url(#${id}-cap)"/>
   <rect x="0" y="0" width="${W}" height="${H}" fill="url(#${id}-recess)"/>
   <rect x="0" y="0" width="${W}" height="${H}" fill="url(#${id}-side)"/>
   <rect x="0" y="0" width="${W}" height="${H}" fill="url(#${id}-glass)"/>
  </g>
 </svg>
</div>`;
      this.needle = this.el.querySelector(".am-needle");
      this.shadow = this.el.querySelector(".am-shadow");
    }
  }

  root.AnalogMeter = AnalogMeter;
})(typeof window !== "undefined" ? window : this);
