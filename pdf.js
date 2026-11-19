/* A small PDF writer for the photo sheet: a title, then JPEG photos with a heading, a few to a page.
   No library and nothing loaded at run time: the photos are already JPEGs (the marked-up photos), so each goes
   into the PDF as it is (DCTDecode) and only the page layout, the text (Helvetica, WinAnsi) and the file
   structure are written here.

     TribarPdf.build({title, subtitle, notes, items: [{jpeg: Uint8Array, heading: "text"}], perPage: 2, footer: "text"})
       -> {pdf: Uint8Array (the file), pages, photos, skipped: [headings of photos that weren't JPEGs]}

   Letter size, half-inch margins. A photo is scaled to fit its slot, never stretched. */
(function (root) {
"use strict";

const PAGE_W = 612, PAGE_H = 792, MARGIN = 36;

// ---- text: the PDF standard fonts take WinAnsi bytes; anything it hasn't got becomes "?"
const WIN = {"’": 0x92, "‘": 0x91, "“": 0x93, "”": 0x94, "–": 0x96, "—": 0x97, "•": 0x95, "…": 0x85, "€": 0x80};
function winBytes(s) {
  const out = [];
  for (const ch of String(s == null ? "" : s)) {
    const c = ch.codePointAt(0);
    out.push(c < 0x80 ? c : WIN[ch] || (c >= 0xa0 && c <= 0xff ? c : 0x3f));
  }
  return out;
}
// a PDF literal string: ( ) and \ escaped, anything outside printable ASCII as an octal escape
function literal(s) {
  let t = "(";
  for (const b of winBytes(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) t += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) t += "\\" + b.toString(8).padStart(3, "0");
    else t += String.fromCharCode(b);
  }
  return t + ")";
}
// Helvetica's widths for the characters a heading uses, close enough to cut a long line (average 0.52 em)
const textWidth = (s, size) => winBytes(s).length * size * 0.56;
function clip(s, size, maxW) {
  s = String(s == null ? "" : s);
  if (textWidth(s, size) <= maxW) return s;
  const n = Math.max(1, Math.floor(maxW / (size * 0.56)) - 1);
  return s.slice(0, n) + "…";
}

// A line broken into lines no wider than maxW (a word wider than that gets its own)
function wrap(s, size, maxW) {
  const out = []; let line = "";
  for (const word of String(s == null ? "" : s).split(" ")) {
    const next = line ? line + " " + word : word;
    if (line && textWidth(next, size) > maxW) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

// ---- JPEG: the size and the colour space from the start-of-frame marker
function jpegInfo(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return {h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9]};
    i += 2 + len;
  }
  return null;
}

function build(opt) {
  const items = [], skipped = [];
  for (const it of opt.items || []) {
    const info = jpegInfo(it.jpeg);
    if (info && info.w > 0 && info.h > 0) items.push({jpeg: it.jpeg, heading: it.heading || "", info});
    else skipped.push(it.heading || "");
  }
  const perPage = Math.max(1, opt.perPage || 2);

  // ---- layout: page 1 has the title above its photos
  const pages = [];                       // [{slots: [{item, x, y, w, h, headY}], title: bool}]
  const textW = PAGE_W - 2 * MARGIN;
  const subLines = opt.subtitle ? wrap(opt.subtitle, 12, textW) : [], noteLines = (opt.notes || []).flatMap(n => wrap(n, 10, textW));
  const titleH = 92 + 16 * Math.max(0, subLines.length - 1) + 14 * noteLines.length;
  for (let i = 0; i < items.length; i += perPage) pages.push({items: items.slice(i, i + perPage), first: i === 0});
  if (!pages.length) pages.push({items: [], first: true});

  const objs = [];                        // each: array of Uint8Array / string chunks
  const enc = new TextEncoder();
  const bytes = x => typeof x === "string" ? enc.encode(x) : x;
  const add = (...chunks) => { objs.push(chunks.map(bytes)); return objs.length; };    // returns the object number
  const reserve = () => { objs.push(null); return objs.length; };
  const set = (n, ...chunks) => { objs[n - 1] = chunks.map(bytes); };

  const catalog = reserve(), pagesObj = reserve(), fontR = reserve(), fontB = reserve();
  const pageNums = [];
  const total = pages.length, footer = opt.footer || "";

  pages.forEach((pg, pi) => {
    let y = PAGE_H - MARGIN;              // the top of what's left
    const ops = [];
    const text = (s, x, yy, size, bold, gray) => ops.push("BT /" + (bold ? "F2" : "F1") + " " + size + " Tf " + (gray == null ? "0" : gray) + " g " + x + " " + yy.toFixed(1) + " Td " + literal(s) + " Tj ET");
    if (pg.first) {
      text(clip(opt.title || "", 20, PAGE_W - 2 * MARGIN), MARGIN, y - 20, 20, true);
      let ny = y - 40;
      for (const l of subLines) { text(l, MARGIN, ny, 12, false, 0.3); ny -= 16; }
      ny -= 2;
      for (const l of noteLines) { text(l, MARGIN, ny, 10, false, 0.3); ny -= 14; }
      ops.push("0.75 G 0.5 w " + MARGIN + " " + (y - titleH + 24) + " m " + (PAGE_W - MARGIN) + " " + (y - titleH + 24) + " l S");
      y -= titleH;
    }
    const bottom = MARGIN + 14;           // room for the footer
    const slotH = (y - bottom) / perPage;
    const imgRefs = [];
    pg.items.forEach((it, si) => {
      const top = y - si * slotH, headH = 16, boxW = PAGE_W - 2 * MARGIN, boxH = slotH - headH - 8;
      text(clip(it.heading, 10, boxW), MARGIN, top - 11, 10, true);
      const k = Math.min(boxW / it.info.w, boxH / it.info.h), w = it.info.w * k, h = it.info.h * k;
      const x = MARGIN + (boxW - w) / 2, yy = top - headH - h;
      const cs = it.info.comps === 1 ? "/DeviceGray" : it.info.comps === 4 ? "/DeviceCMYK" : "/DeviceRGB";
      const num = add("<< /Type /XObject /Subtype /Image /Width " + it.info.w + " /Height " + it.info.h + " /ColorSpace " + cs +
                      " /BitsPerComponent 8 /Filter /DCTDecode /Length " + it.jpeg.length + " >>\nstream\n", it.jpeg, "\nendstream");
      imgRefs.push(num);
      ops.push("q " + w.toFixed(2) + " 0 0 " + h.toFixed(2) + " " + x.toFixed(2) + " " + yy.toFixed(2) + " cm /Im" + (si + 1) + " Do Q");
      ops.push("0.8 G 0.5 w " + x.toFixed(2) + " " + yy.toFixed(2) + " " + w.toFixed(2) + " " + h.toFixed(2) + " re S");
    });
    text(clip(footer, 8, PAGE_W - 2 * MARGIN - 70), MARGIN, MARGIN - 6, 8, false, 0.45);
    text("Page " + (pi + 1) + " of " + total, PAGE_W - MARGIN - 50, MARGIN - 6, 8, false, 0.45);
    const content = ops.join("\n");
    const cnum = add("<< /Length " + enc.encode(content).length + " >>\nstream\n", content, "\nendstream");
    const xo = imgRefs.map((n, i) => "/Im" + (i + 1) + " " + n + " 0 R").join(" ");
    const pnum = add("<< /Type /Page /Parent " + pagesObj + " 0 R /MediaBox [0 0 " + PAGE_W + " " + PAGE_H + "] /Contents " + cnum + " 0 R /Resources << /Font << /F1 " + fontR + " 0 R /F2 " + fontB +
                     " 0 R >>" + (xo ? " /XObject << " + xo + " >>" : "") + " >> >>");
    pageNums.push(pnum);
  });
  const info = add("<< /Title " + literal(opt.title || "") + " /Producer (Tribar Calculator) >>");
  set(catalog, "<< /Type /Catalog /Pages " + pagesObj + " 0 R >>");
  set(pagesObj, "<< /Type /Pages /Count " + pageNums.length + " /Kids [" + pageNums.map(n => n + " 0 R").join(" ") + "] >>");
  set(fontR, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  set(fontB, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  // ---- the file: header, numbered objects, cross-reference table, trailer
  const parts = [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  let off = parts[0].length;
  const offsets = [];
  objs.forEach((chunks, i) => {
    offsets.push(off);
    const head = enc.encode((i + 1) + " 0 obj\n"), tail = enc.encode("\nendobj\n");
    parts.push(head); off += head.length;
    for (const c of chunks) { parts.push(c); off += c.length; }
    parts.push(tail); off += tail.length;
  });
  let xref = "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
  for (const o of offsets) xref += String(o).padStart(10, "0") + " 00000 n \n";
  xref += "trailer\n<< /Size " + (objs.length + 1) + " /Root " + catalog + " 0 R /Info " + info + " 0 R >>\nstartxref\n" + off + "\n%%EOF\n";
  parts.push(enc.encode(xref));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return {pdf: out, pages: pages.length, photos: items.length, skipped};
}

root.TribarPdf = {build, jpegInfo};
if (typeof module !== "undefined" && module.exports) module.exports = root.TribarPdf;
})(typeof self !== "undefined" ? self : globalThis);
