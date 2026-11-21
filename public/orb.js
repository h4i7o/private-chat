/* 点でできた球。推論中の小球 / 空画面の球 / 残量の球。状態: idle / thinking / speaking / alert */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const DPR = () => Math.min(2, window.devicePixelRatio || 1);
  const TAU = Math.PI * 2;
  const st = { state: 'idle', used: 0 };
  const items = new Set();

  const fib = (n) => { const a = []; const g = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < n; i++) { const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), t = g * i; a.push([Math.cos(t) * r, y, Math.sin(t) * r]); } return a; };
  const rot = (x, y, z, a, tilt) => { const ca = Math.cos(a), sa = Math.sin(a), x1 = x * ca + z * sa, z1 = -x * sa + z * ca, ct = Math.cos(tilt), st2 = Math.sin(tilt); return [x1, y * ct - z1 * st2, y * st2 + z1 * ct]; };
  const pal = () => dark.matches
    ? { cool: [240, 240, 244], warm: [236, 210, 160], lit: (d) => [222 + d * 33, 222 + d * 33, 228 + d * 27], dim: [128, 128, 136], star: '255,255,255', dust: '232,232,238', mini: (d) => [255, 255, 255], bokeh: [215, 215, 226] }
    : { cool: [44, 44, 52], warm: [176, 122, 16], lit: (d) => [34 + (1 - d) * 56, 34 + (1 - d) * 56, 42 + (1 - d) * 56], dim: [140, 140, 150], star: '40,40,50', dust: '80,80,92', mini: (d) => [30, 30, 38], bokeh: [120, 120, 138] };
  const star = (ctx, x, y, L, a, c) => { ctx.strokeStyle = `rgba(${c},${a})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - L, y); ctx.lineTo(x + L, y); ctx.moveTo(x, y - L); ctx.lineTo(x, y + L); ctx.stroke(); };
  const speed = () => ({ idle: 1, thinking: 3.4, speaking: 1.6, alert: 2 }[st.state] || 1);

  function setup(c, size) {
    const d = DPR(); c.width = Math.round(size * d); c.height = Math.round(size * d); c.style.width = size + 'px'; c.style.height = size + 'px';
    const ctx = c.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); return ctx;
  }

  /* 小さな球(推論中・空画面・ログイン) */
  function mkSphere(c) {
    if (c._orb) return; c._orb = 1;
    const k = c.dataset.orb, size = +c.dataset.size || (k === 'hero' ? 132 : 48);
    const ctx = setup(c, size), p = fib(k === 'hero' ? 360 : 150), off = Math.random() * 6, big = k === 'hero';
    items.add({ c, draw(t) {
      const P = pal(), R = size * (big ? .36 : .34), cx = size / 2, cy = size / 2;
      ctx.clearRect(0, 0, size, size);
      const sp = big && st.state !== 'alert' ? Math.min(speed(), 1.6) : speed();
      const pulse = st.state === 'speaking' ? 1 + .06 * Math.sin(t * .008) : 1, jit = st.state === 'alert' ? (Math.random() - .5) * 1.1 : 0;
      const col = st.state === 'alert' ? P.warm : P.cool, ang = t * .00022 * sp + off;
      for (let i = 0; i < p.length; i++) {
        const [x, y, z] = rot(p[i][0], p[i][1], p[i][2], ang, .34), d = (z + 1) / 2, a = .14 + d * .86, s = (big ? .8 : .55) + d * (big ? 1.5 : .95);
        const rgb = big ? [col[0] - 20 + d * 20, col[1] - 10 + d * 10, col[2]] : (st.state === 'alert' ? col : P.mini(d));
        ctx.fillStyle = `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${a})`;
        ctx.beginPath(); ctx.arc(cx + x * R * pulse + jit, cy + y * R * pulse, s, 0, TAU); ctx.fill();
        if (st.state === 'thinking' && d > .72) { const tw = Math.pow(Math.max(0, Math.sin(t * .004 + i * 1.9)), 24); if (tw > .15) star(ctx, cx + x * R, cy + y * R, 2.5 + tw * (big ? 5 : 3.5), tw, P.star); }
      }
    } });
  }

  /* 残量の球: 残りが下から満ち、使った分は上から暗くなる。50% / 80% に点線リング */
  function mkGauge(w) {
    if (w._orb) return; w._orb = 1;
    const size = +w.dataset.size || 220;
    w.style.width = size + 'px'; w.style.height = size + 'px';
    const cb = document.createElement('canvas'), cm = document.createElement('canvas'); cb.className = 'gb'; cm.className = 'gm'; w.append(cb, cm);
    const xb = setup(cb, size), xm = setup(cm, size);
    const GP = fib(640);
    const dust = Array.from({ length: 220 }, () => ({ a: Math.random() * TAU, r: 1.08 + Math.random() * .5, y: Math.random() * 2 - 1, v: (Math.random() - .5) * .0004, s: Math.random() * .9 + .3, ph: Math.random() * 9 }));
    const bokeh = Array.from({ length: 16 }, () => ({ a: Math.random() * TAU, r: .2 + Math.random() * .9, y: Math.random() * 1.6 - .8, v: (Math.random() - .5) * .0003, s: size * .035 + Math.random() * size * .07, ph: Math.random() * 9 }));
    let drag = 0, vel = 0, dragging = false, lx = 0, used = st.used;
    w.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; try { w.setPointerCapture(e.pointerId); } catch { /* */ } });
    w.addEventListener('pointermove', (e) => { if (!dragging) return; const dx = e.clientX - lx; lx = e.clientX; drag += dx * .012; vel = dx * .012; });
    const up = () => { dragging = false; }; w.addEventListener('pointerup', up); w.addEventListener('pointercancel', up);
    items.add({ c: w, draw(t) {
      const P = pal(), W = size, R = W * .37, cx = W / 2, cy = W / 2;
      used += (Math.min(100, st.used) - used) * .1; const f = 1 - used / 100;
      const hot = st.state === 'alert' || used >= 50, tint = hot ? P.warm : P.cool;
      if (!dragging) { vel *= .95; drag += vel; }
      const ang = t * .00016 * (st.state === 'thinking' ? 2.4 : 1) + drag, tilt = .42;
      xm.clearRect(0, 0, W, W); xb.clearRect(0, 0, W, W);
      for (const b of bokeh) { b.a += b.v; const bx = cx + Math.cos(b.a) * b.r * R * 1.1, by = cy + b.y * R, al = .06 + .07 * (1 + Math.sin(t * .0006 + b.ph)) / 2; xb.fillStyle = `rgba(${hot ? 255 : P.bokeh[0]},${hot ? 200 : P.bokeh[1]},${hot ? 120 : P.bokeh[2]},${al})`; xb.beginPath(); xb.arc(bx, by, b.s, 0, TAU); xb.fill(); }
      const gr = xb.createRadialGradient(cx, cy, 0, cx, cy, R * 1.05); gr.addColorStop(0, `rgba(${tint[0]},${tint[1]},${hot ? 140 : tint[2]},${.16 * f + .03})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); xb.fillStyle = gr; xb.fillRect(0, 0, W, W);
      for (const d of dust) { d.a += d.v; const k = Math.sqrt(1 - d.y * d.y * .6), [x, y, z] = rot(Math.cos(d.a) * d.r * k, d.y * d.r * .9, Math.sin(d.a) * d.r * k, ang * .6, tilt); const al = (.08 + .3 * ((z + 1.5) / 3)) * (.6 + .4 * Math.sin(t * .0012 + d.ph)); xm.fillStyle = `rgba(${P.dust},${al})`; xm.fillRect(cx + x * R, cy + y * R, d.s, d.s); }
      const lvl = f * 2 - 1;
      for (let i = 0; i < GP.length; i++) {
        const [x0, y0, z0] = GP[i], [x, y, z] = rot(x0, y0, z0, ang, tilt), d = (z + 1) / 2, lit = y0 <= lvl, near = Math.max(0, 1 - Math.abs(y0 - lvl) * 9);
        let r, g, b, a, s;
        if (lit) { [r, g, b] = P.lit(d); a = .30 + d * .70; s = .85 + d * 1.4; if (near > 0) { r = r * (1 - near) + tint[0] * near; g = g * (1 - near) + tint[1] * near; b = b * (1 - near) + tint[2] * near; a = Math.min(1, a + near * .5); s += near * 1.0; } }
        else { [r, g, b] = P.dim; a = .12 + d * .2; s = .65 + d * .6; }
        xm.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`; xm.beginPath(); xm.arc(cx + x * R, cy + y * R, s, 0, TAU); xm.fill();
        if (lit && near > .55 && d > .35) { const tw = Math.pow(Math.max(0, Math.sin(t * .0035 + i * 2.3)), 20); if (tw > .12) star(xm, cx + x * R, cy + y * R, 3.5 + tw * 6, tw, P.star); }
      }
      for (const [u, hit] of [[50, used >= 50], [80, used >= 80]]) {
        const yy = (1 - u / 100) * 2 - 1, rr = Math.sqrt(1 - yy * yy);
        for (let k = 0; k < 52; k++) { const th = k / 52 * TAU, [x, y, z] = rot(Math.cos(th) * rr, yy, Math.sin(th) * rr, ang, tilt), d = (z + 1) / 2; xm.fillStyle = hit ? `rgba(${P.warm[0]},${P.warm[1]},${P.warm[2]},${.25 + d * .6})` : (dark.matches ? `rgba(255,255,255,${.06 + d * .16})` : `rgba(40,60,100,${.08 + d * .2})`); xm.beginPath(); xm.arc(cx + x * R, cy + y * R, .65 + d * .6, 0, TAU); xm.fill(); }
      }
    } });
  }

  let raf = 0;
  let last = 0;
  function frame(t) {
    raf = 0;
    if (t - last < 28) { if (items.size && !reduce && !document.hidden) raf = requestAnimationFrame(frame); return; }
    last = t;
    for (const it of items) { if (!it.c.isConnected) { items.delete(it); continue; } if (it.c.offsetParent === null && !it.c.closest('.pop')) continue; it.draw(t); }
    if (items.size && !reduce && !document.hidden) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  document.addEventListener('visibilitychange', kick);
  dark.addEventListener?.('change', kick);

  window.Orb = {
    scan(root = document) { root.querySelectorAll('canvas[data-orb]').forEach(mkSphere); root.querySelectorAll('[data-gauge]').forEach(mkGauge); kick(); },
    gauge(el) { mkGauge(el); kick(); },
    set(o) { Object.assign(st, o); kick(); },
    get state() { return st; },
  };
})();
