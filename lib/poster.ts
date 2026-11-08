import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, NOT_MENTIONED } from './config.js';
import type { FieldName } from './extract.js';
import { containsLink, stripLinks } from './text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');
const W = 1080;
const H = 1350;

let fontsReady = false;
function loadFonts() {
  if (fontsReady) return;
  const reg = (file: string, name: string) => {
    if (!GlobalFonts.registerFromPath(path.join(FONT_DIR, file), name)) throw new Error('Font could not be loaded: ' + file);
  };
  reg('NotoSans-Regular.ttf', 'PDSSans');
  reg('NotoSans-Bold.ttf', 'PDSSansBold');
  reg('NotoSansTelugu-Regular.ttf', 'PDSTelugu');
  reg('NotoSansTelugu-Bold.ttf', 'PDSTeluguBold');
  fontsReady = true;
}

export interface PosterInput {
  headline_te: string;
  fields: Record<FieldName, string>;
  isUpdate?: boolean;
  changed?: string[];
}

/** Only these fields can ever reach the public poster. Application / notification links are NOT among them. */
const LONG_ROWS: { key: FieldName; en: string; te: string; lines: number }[] = [
  { key: 'qualification', en: 'Qualification', te: 'విద్యార్హత', lines: 2 },
  { key: 'eligibility', en: 'Eligibility', te: 'అర్హత', lines: 2 },
  { key: 'post_names', en: 'Posts', te: 'పోస్టులు', lines: 2 },
  { key: 'selection_process', en: 'Selection', te: 'ఎంపిక విధానం', lines: 2 },
];
const KEY_FACTS: { key: FieldName; en: string; te: string }[] = [
  { key: 'vacancies', en: 'Vacancies', te: 'ఖాళీలు' },
  { key: 'age_limit', en: 'Age Limit', te: 'వయో పరిమితి' },
  { key: 'application_fee', en: 'Fee', te: 'ఫీజు' },
];
const DATES: { key: FieldName; en: string; te: string }[] = [
  { key: 'application_start', en: 'Starts', te: 'ప్రారంభం' },
  { key: 'last_date', en: 'Last Date', te: 'చివరి తేదీ' },
  { key: 'exam_date', en: 'Exam', te: 'పరీక్ష' },
];

const has = (v: string | undefined) => !!v && v !== NOT_MENTIONED;
const clean = (v: string) => stripLinks(v);

function rr(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface TextOpts {
  size: number;
  fill: string;
  bold?: boolean;
  align?: 'left' | 'center';
}

/** Draws the poster. Returns every string drawn so the "no links" rule can be checked. */
function draw(ctx: SKRSContext2D, inp: PosterInput, logo: Image | null): string[] {
  const f = inp.fields;
  const pub: string[] = [];
  const setFont = (o: TextOpts) => {
    // Latin glyphs from Noto Sans, Telugu glyphs from Noto Sans Telugu (HarfBuzz shaping handles conjuncts correctly)
    ctx.font = o.bold ? `${o.size}px PDSSansBold, PDSTeluguBold` : `${o.size}px PDSSans, PDSTelugu`;
  };
  const measure = (s: string, o: TextOpts) => {
    setFont(o);
    return ctx.measureText(s).width;
  };
  const T = (x: number, y: number, text: string, o: TextOpts) => {
    pub.push(text);
    setFont(o);
    ctx.fillStyle = o.fill;
    ctx.textAlign = o.align === 'center' ? 'center' : 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
  };
  const wrap = (text: string, o: TextOpts, maxW: number, maxLines: number): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (measure(next, o) <= maxW || !cur) cur = next;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      let last = kept[maxLines - 1];
      while (last.length > 1 && measure(last + ' …', o) > maxW) last = last.slice(0, -1).trimEnd();
      kept[maxLines - 1] = last + ' …';
      return kept;
    }
    return lines;
  };

  // background
  ctx.fillStyle = '#FFF8EC';
  ctx.fillRect(0, 0, W, H);
  const navy = (x: number, y: number, w: number, h: number) => {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#0B2A5B');
    g.addColorStop(1, '#14439A');
    ctx.fillStyle = g;
  };

  // header: the real PDS logo (assets/logo.png) when present, otherwise a text header
  let hdrH = 176;
  if (logo) {
    hdrH = 190;
    ctx.fillStyle = '#F0F9FE';
    ctx.fillRect(0, 0, W, hdrH);
    const lh = 168;
    const lw = (lh * logo.width) / logo.height;
    ctx.drawImage(logo, (W - lw) / 2, (hdrH - lh) / 2, lw, lh);
    pub.push('PDS PRAVEEN DIGITAL SERVICES');
  } else {
    navy(0, 0, W, 176);
    ctx.fillRect(0, 0, W, 176);
    ctx.fillStyle = '#F28C28';
    ctx.beginPath();
    ctx.arc(106, 88, 62, 0, Math.PI * 2);
    ctx.fill();
    T(106, 106, 'PDS', { size: 46, fill: '#0B2A5B', bold: true, align: 'center' });
    T(190, 82, 'PDS | PRAVEEN DIGITAL SERVICES', { size: 46, fill: '#fff', bold: true });
    T(190, 128, BRAND.tagline, { size: 30, fill: '#FFD9A0' });
  }
  ctx.fillStyle = '#F28C28';
  ctx.fillRect(0, hdrH, W, 8);

  // tag pill
  const tag = inp.isUpdate ? 'UPDATED NOTIFICATION • నవీకరణ' : 'NEW GOVERNMENT UPDATE • కొత్త ప్రకటన';
  const tagO: TextOpts = { size: 28, fill: '#fff', bold: true, align: 'center' };
  const tagW = Math.min(960, measure(tag, tagO) + 70);
  ctx.fillStyle = '#D62839';
  rr(ctx, 60, hdrH + 30, tagW, 52, 26);
  ctx.fill();
  T(60 + tagW / 2, hdrH + 67, tag, tagO);

  // headline
  let y = hdrH + 142;
  const headTe = clean(inp.headline_te || '');
  if (headTe) {
    for (const ln of wrap(headTe, { size: 46, fill: '', bold: true }, 960, 2)) {
      T(60, y, ln, { size: 46, fill: '#0B2A5B', bold: true });
      y += 62;
    }
  }
  for (const ln of wrap(clean(f.title), { size: 32, fill: '', bold: true }, 960, 2)) {
    T(60, y, ln, { size: 32, fill: '#222', bold: true });
    y += 44;
  }
  if (has(f.department)) {
    for (const ln of wrap(clean(f.department), { size: 28, fill: '' }, 960, 2)) {
      T(60, y + 4, ln, { size: 28, fill: '#14439A' });
      y += 38;
    }
  }
  y += 14;

  // strips: important dates (dark) and key facts (light)
  const strip = (items: { key: FieldName; en: string; te: string }[], dark: boolean, h: number) => {
    const shown = items.filter((d) => has(f[d.key]));
    if (!shown.length) return;
    const colW = (960 - (shown.length - 1) * 14) / shown.length;
    shown.forEach((d, i) => {
      const x = 60 + i * (colW + 14);
      if (dark) {
        ctx.fillStyle = '#0B2A5B';
        rr(ctx, x, y, colW, h, 16);
        ctx.fill();
      } else {
        ctx.fillStyle = '#fff';
        rr(ctx, x, y, colW, h, 16);
        ctx.fill();
        ctx.strokeStyle = '#F28C28';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      T(x + colW / 2, y + 34, d.en + ' • ' + d.te, { size: 22, fill: dark ? '#FFD9A0' : '#14439A', bold: !dark, align: 'center' });
      wrap(clean(f[d.key]), { size: 27, fill: '', bold: true }, colW - 22, 2).forEach((ln, li) => {
        T(x + colW / 2, y + 72 + li * 32, ln, { size: 27, fill: dark ? '#fff' : '#222', bold: true, align: 'center' });
      });
    });
    y += h + 14;
  };
  strip(DATES, true, 116);
  strip(KEY_FACTS, false, 116);

  // long rows (skipped when no space is left)
  const bottomLimit = 1150;
  const LABEL_W = 300;
  for (const r of LONG_ROWS) {
    if (!has(f[r.key])) continue;
    const lines = wrap(clean(f[r.key]), { size: 26, fill: '' }, 960 - LABEL_W - 50, r.lines);
    if (!lines.length) continue;
    const hgt = Math.max(60, 22 + lines.length * 34);
    if (y + hgt > bottomLimit) continue;
    ctx.fillStyle = '#fff';
    rr(ctx, 60, y, 960, hgt, 14);
    ctx.fill();
    ctx.strokeStyle = '#EAD9B8';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#F28C28';
    rr(ctx, 60, y, 10, hgt, 5);
    ctx.fill();
    T(88, y + 38, r.en + ' • ' + r.te, { size: 22, fill: '#14439A', bold: true });
    lines.forEach((ln, li) => T(60 + LABEL_W + 40, y + 38 + li * 34, ln, { size: 26, fill: '#222' }));
    y += hgt + 9;
  }

  // important instructions
  if (has(f.important_instructions)) {
    const lines = wrap(clean(f.important_instructions), { size: 25, fill: '' }, 912, 2);
    const hgt = 52 + lines.length * 32;
    if (lines.join('').trim() && y + hgt <= 1186) {
      ctx.fillStyle = '#FFF0D6';
      rr(ctx, 60, y, 960, hgt, 14);
      ctx.fill();
      ctx.strokeStyle = '#F28C28';
      ctx.lineWidth = 2;
      ctx.stroke();
      T(84, y + 36, 'Important • ముఖ్య సూచనలు', { size: 23, fill: '#B25800', bold: true });
      lines.forEach((ln, li) => T(84, y + 72 + li * 32, ln, { size: 25, fill: '#333' }));
    }
  }

  // footer
  navy(0, 1196, W, 154);
  ctx.fillRect(0, 1196, W, 154);
  ctx.fillStyle = '#F28C28';
  ctx.fillRect(0, 1196, W, 6);
  T(W / 2, 1248, 'PDS – PRAVEEN DIGITAL SERVICES', { size: 40, fill: '#fff', bold: true, align: 'center' });
  T(W / 2, 1298, 'Contact: ' + BRAND.phones.join(' | '), { size: 38, fill: '#FFD9A0', bold: true, align: 'center' });
  T(W / 2, 1332, BRAND.tagline, { size: 24, fill: '#cfe0ff', align: 'center' });

  return pub;
}

/** Throws if anything that looks like a web link would appear on the public poster. */
export function assertNoLinks(publicText: string): void {
  if (containsLink(publicText)) {
    throw new Error('Poster safety check failed: a web link was found in the poster text');
  }
}

/** Renders the poster PNG. Every text drawn on it is checked for links first. */
export async function renderPoster(inp: PosterInput): Promise<Buffer> {
  return (await renderPosterWithText(inp)).png;
}

export async function renderPosterWithText(inp: PosterInput): Promise<{ png: Buffer; publicText: string }> {
  loadFonts();
  const logoPath = path.join(ROOT, 'assets', 'logo.png');
  const logo = existsSync(logoPath) ? await loadImage(readFileSync(logoPath)) : null;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const texts = draw(ctx, inp, logo);
  const publicText = texts.join('\n');
  assertNoLinks(publicText);
  return { png: canvas.toBuffer('image/png'), publicText };
}
