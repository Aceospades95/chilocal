/* share.js — "share our plan": renders a 1080×1350 card on canvas (no
 * external assets) and hands it to the Web Share API, falling back to a
 * download. The card is the app's word-of-mouth loop. */

function star6(ctx, cx, cy, R, r) {
  ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const rad = (i % 2 === 0 ? R : r);
    const a = (Math.PI / 6) * i - Math.PI / 2;
    const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}

function wrap(ctx, text, x, y, maxW, lh) {
  const words = text.split(" ");
  let line = "", yy = y;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      ctx.fillText(line, x, yy); line = w; yy += lh;
    } else line = t;
  }
  if (line) ctx.fillText(line, x, yy);
  return yy;
}

export function renderShareCard(plan, ctxNight, dateN) {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");

  // night sky
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0a1020"); bg.addColorStop(0.55, "#070d1a"); bg.addColorStop(1, "#04070e");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // scattered stars
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * W, y = Math.random() * H * 0.5;
    g.globalAlpha = 0.12 + Math.random() * 0.5;
    g.fillStyle = "#cfe4ff";
    g.fillRect(x, y, 2, 2);
  }
  g.globalAlpha = 1;
  // big chicago star watermark
  g.save();
  g.globalAlpha = 0.07; g.fillStyle = "#ff4b5c";
  star6(g, W - 150, 240, 260, 104); g.fill();
  g.restore();

  const L = 92;
  g.fillStyle = "#ffb45c";
  g.font = "600 34px -apple-system, 'Segoe UI', sans-serif";
  g.fillText("C H I L O C A L  ·  T O N I G H T", L, 150);

  g.fillStyle = "#8a93a8";
  g.font = "400 40px Georgia, serif";
  const when = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  g.fillText(`${when}${dateN ? `  ·  Date #${dateN}` : ""}`, L, 226);

  g.fillStyle = "#f4eede";
  g.font = "italic 700 96px Georgia, serif";
  let y = wrap(g, plan.hero.v.name, L, 400, W - 2 * L, 108);

  g.fillStyle = "#64d8ff";
  g.font = "400 44px -apple-system, 'Segoe UI', sans-serif";
  g.fillText(`${plan.hero.v.cat}  ·  ${plan.hero.v.hood}`, L, y + 86);
  y += 86;

  if (plan.second) {
    g.fillStyle = "#ffb45c";
    g.font = "400 46px Georgia, serif";
    g.fillText("then →", L, y + 110);
    g.fillStyle = "#f4eede";
    g.font = "italic 600 62px Georgia, serif";
    y = wrap(g, plan.second.venue.name, L + 190, y + 112, W - 2 * L - 190, 70) + 20;
  }

  // the why, quoted
  g.fillStyle = "#aab4c8";
  g.font = "italic 42px Georgia, serif";
  y = wrap(g, `“${plan.why}”`, L, y + 150, W - 2 * L, 58);

  // footer
  g.strokeStyle = "rgba(255,180,92,.4)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(L, H - 170); g.lineTo(W - L, H - 170); g.stroke();
  g.fillStyle = "#ff4b5c"; star6(g, L + 22, H - 96, 24, 10); g.fill();
  g.fillStyle = "#f4eede";
  g.font = "700 44px Georgia, serif";
  g.fillText("Chi·Local", L + 66, H - 80);
  g.fillStyle = "#8a93a8";
  g.font = "400 34px -apple-system, 'Segoe UI', sans-serif";
  g.fillText("the night decides itself", W - L - 440, H - 80);

  return c;
}

export async function sharePlan(plan, ctxNight, dateN) {
  const canvas = renderShareCard(plan, ctxNight, dateN);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const file = new File([blob], "tonight.png", { type: "image/png" });
  const text = `Tonight: ${plan.hero.v.name}${plan.second ? " → " + plan.second.venue.name : ""} (${plan.hero.v.hood}). Decided by ChiLocal.`;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "aborted"; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "chilocal-tonight.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return "downloaded";
}
