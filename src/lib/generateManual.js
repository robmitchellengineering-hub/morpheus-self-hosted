import { jsPDF } from 'jspdf';
import caps from '@/lib/morpheusCapabilities.json';

// Professional layout, auto-generated from src/lib/morpheusCapabilities.json.
// Add a capability (or a `workflow` field) there and this manual picks it up automatically.

const ACCENT = [0, 230, 120];       // neon green
const ACCENT_DIM = [0, 150, 80];
const BODY = [205, 220, 210];        // soft off-white for readability
const MUTED = [130, 160, 140];
const BG = [8, 12, 9];               // near-black, green-tinted
const PANEL = [14, 22, 16];
const INK = [10, 14, 11];

const COMPILE_TARGETS = [
  ['source', 'Raw project files, no compilation.'],
  ['web-app', 'A static website you can host anywhere.'],
  ['windows-exe', 'A standalone program for Windows.'],
  ['mac-app', 'A native application for macOS.'],
  ['linux-binary', 'A runnable program for Linux.'],
  ['android-apk', 'An installable Android app.'],
  ['ios-app', 'An Xcode project for iOS.'],
  ['python-package', 'A pip-installable Python package.'],
  ['arduino-firmware', 'Firmware for a microcontroller.'],
  ['rpi-distro', 'A bootable Raspberry Pi OS image (pi-gen).'],
  ['linux-distro', 'A bootable PC/server image (mkosi): Debian, Ubuntu, Fedora.']
];

const REFERENCES = [
  ['Morpheus Market', 'https://morpheus.nz/market'],
  ['mkosi — OS image builder', 'https://github.com/systemd/mkosi'],
  ['pi-gen — Raspberry Pi OS', 'https://github.com/RPi-Distro/pi-gen'],
  ['GitHub Actions', 'https://docs.github.com/actions'],
  ['Stripe API', 'https://docs.stripe.com/api'],
  ['Rufus (Windows flasher)', 'https://rufus.ie/'],
  ['balenaEtcher', 'https://etcher.balena.io/']
];

export function generateManual() {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const PAGE_W = 595, PAGE_H = 842;
  const ML = 54, MR = 54, MT = 64, MB = 56;
  const CW = PAGE_W - ML - MR;
  let y = 0;

  const bg = (c = BG) => { doc.setFillColor(...c); doc.rect(0, 0, PAGE_W, PAGE_H, 'F'); };
  const pages = () => doc.internal.getNumberOfPages();
  const ensure = (s) => { if (y + s > PAGE_H - MB) { doc.addPage(); bg(); y = MT; } };
  const gap = (g) => { y += g; };

  const para = (txt, size = 10, color = BODY, lead = 14.5) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(size); doc.setTextColor(...color);
    const lines = doc.splitTextToSize(txt, CW);
    for (const ln of lines) { ensure(lead); doc.text(ln, ML, y + size); y += lead; }
    y += 4;
  };

  const h2 = (txt) => {
    ensure(22);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...ACCENT);
    doc.text(txt.toUpperCase(), ML, y + 9);
    y += 16;
  };

  const bullet = (txt) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...BODY);
    const lines = doc.splitTextToSize(txt, CW - 18);
    for (let i = 0; i < lines.length; i++) {
      ensure(15);
      if (i === 0) { doc.setFillColor(...ACCENT); doc.circle(ML + 3, y + 7, 1.8, 'F'); }
      doc.text(lines[i], ML + 14, y + 9.5);
      y += 15;
    }
    y += 3;
  };

  const callout = (label, text) => {
    const lines = doc.splitTextToSize(text, CW - 30);
    const h = lines.length * 13 + 24;
    ensure(h + 8);
    doc.setFillColor(...PANEL); doc.roundedRect(ML, y, CW, h, 5, 5, 'F');
    doc.setFillColor(...ACCENT); doc.roundedRect(ML, y, 4, h, 2, 2, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...ACCENT);
    doc.text(label.toUpperCase(), ML + 16, y + 15);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...BODY);
    let ty = y + 28;
    for (const ln of lines) { doc.text(ln, ML + 16, ty); ty += 13; }
    y += h + 10;
  };

  const steps = (text) => {
    const parts = text.split(/[→]/).map(s => s.trim()).filter(Boolean);
    parts.forEach((s, i) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...BODY);
      const lines = doc.splitTextToSize(s, CW - 34);
      const rowH = Math.max(22, lines.length * 12 + 6);
      ensure(rowH + 4);
      const cx = ML + 10, cy = y + 9;
      doc.setFillColor(...ACCENT); doc.circle(cx, cy, 10, 'F');
      doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text(String(i + 1), cx, cy + 3.5, { align: 'center' });
      doc.setTextColor(...BODY); doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
      doc.text(lines, ML + 30, y + 8);
      y += rowH + 4;
    });
    y += 4;
  };

  // Simulated terminal mockup: renders "what you see" at each step of a worked example.
  const terminal = (title, lines) => {
    doc.setFont('courier', 'normal'); doc.setFontSize(8);
    const wrapped = [];
    lines.forEach((l) => { doc.splitTextToSize(l, CW - 28).forEach((w) => wrapped.push(w)); });
    const lineH = 12, padY = 10, barH = 20;
    const h = padY * 2 + barH + wrapped.length * lineH;
    ensure(h + 10);
    const x0 = ML, y0 = y;
    doc.setFillColor(...INK); doc.rect(x0, y0, CW, h, 'F');
    doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(0.6); doc.rect(x0, y0, CW, h);
    doc.setFillColor(...PANEL); doc.rect(x0, y0, CW, barH, 'F');
    doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(0.4); doc.line(x0, y0 + barH, x0 + CW, y0 + barH);
    doc.setFont('courier', 'bold'); doc.setFontSize(8); doc.setTextColor(...ACCENT);
    doc.text(title, x0 + 12, y0 + 13);
    doc.setFillColor(...ACCENT_DIM);
    doc.circle(x0 + CW - 30, y0 + 10, 2, 'F');
    doc.circle(x0 + CW - 22, y0 + 10, 2, 'F');
    doc.circle(x0 + CW - 14, y0 + 10, 2, 'F');
    let ly = y0 + barH + padY + 8;
    wrapped.forEach((l) => {
      let color = BODY, font = 'normal';
      if (l.startsWith('> ')) { color = ACCENT; font = 'bold'; }
      else if (l.startsWith('M:')) { color = [130, 205, 150]; }
      else if (/^[├└│]/.test(l)) { color = MUTED; }
      else if (l.startsWith('[OK]')) { color = ACCENT; font = 'bold'; }
      else if (l.startsWith('[..]')) { color = MUTED; }
      else if (l.startsWith('ERR') || l.startsWith('[ERR]')) { color = [255, 120, 120]; font = 'bold'; }
      else if (l.startsWith('#')) { color = ACCENT_DIM; }
      doc.setFont('courier', font); doc.setFontSize(8); doc.setTextColor(...color);
      doc.text(l, x0 + 12, ly);
      ly += lineH;
    });
    y += h + 12;
  };

  const exampleBlock = (num, ex) => {
    chStart(num, 'Example — ' + ex.title);
    para(ex.scenario);
    ex.steps.forEach((st, si) => {
      h2('Step ' + (si + 1) + ': ' + st.action);
      if (st.note) para(st.note, 9.5, MUTED, 13);
      terminal(st.screen || 'morpheus', st.lines);
    });
  };

  const chapters = [];
  const chStart = (num, title) => {
    doc.addPage(); bg(); y = MT;
    const p = pages();
    chapters.push({ num, title, page: p });
    try { doc.outline.add(null, (num != null ? num + '. ' : '') + title, { pageNumber: p }); } catch (e) {}
    // number badge
    if (num != null) {
      doc.setFillColor(...ACCENT); doc.circle(ML + 11, y + 9, 11, 'F');
      doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
      doc.text(String(num), ML + 11, y + 13, { align: 'center' });
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...ACCENT);
    doc.text(title, ML + (num != null ? 32 : 0), y + 14);
    y += 26;
    doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(1.2); doc.line(ML, y, ML + CW, y);
    y += 16;
    return p;
  };

  // =================== COVER ===================
  bg();
  // decorative double frame
  doc.setDrawColor(...ACCENT); doc.setLineWidth(1.5); doc.rect(24, 24, PAGE_W - 48, PAGE_H - 48);
  doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(0.5); doc.rect(30, 30, PAGE_W - 60, PAGE_H - 60);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(40); doc.setTextColor(...ACCENT);
  doc.text('MORPHEUS', PAGE_W / 2, 170, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(...MUTED);
  doc.text('F E A T U R E D   U S E R   M A N U A L', PAGE_W / 2, 198, { align: 'center' });
  doc.setDrawColor(...ACCENT); doc.setLineWidth(1); doc.line(PAGE_W / 2 - 90, 214, PAGE_W / 2 + 90, 214);

  // intro paragraph
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...BODY);
  const introLines = doc.splitTextToSize(caps.intro || '', CW - 60);
  let cy = 246;
  for (const ln of introLines) { doc.text(ln, PAGE_W / 2, cy, { align: 'center' }); cy += 16; }

  // feature pills
  const pills = ['CHAT → CODE', 'ANY TARGET', 'OWN YOUR CODE'];
  const pw = 150, ph = 34, pgap = 18;
  const totalW = pills.length * pw + (pills.length - 1) * pgap;
  let px = (PAGE_W - totalW) / 2;
  const py = 372;
  pills.forEach((label) => {
    doc.setFillColor(...PANEL); doc.roundedRect(px, py, pw, ph, 6, 6, 'F');
    doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(0.8); doc.roundedRect(px, py, pw, ph, 6, 6);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...ACCENT);
    doc.text(label, px + pw / 2, py + 21, { align: 'center' });
    px += pw + pgap;
  });

  // principle quote box
  const qy = 440;
  doc.setFillColor(...PANEL); doc.roundedRect(ML + 30, qy, CW - 60, 86, 6, 6, 'F');
  doc.setFillColor(...ACCENT); doc.roundedRect(ML + 30, qy, 4, 86, 2, 2, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...ACCENT);
  doc.text('THE CORE PRINCIPLE', ML + 50, qy + 26);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(...BODY);
  const qLines = doc.splitTextToSize('"' + caps.principle + '"', CW - 100);
  let qy2 = qy + 46;
  for (const ln of qLines) { doc.text(ln, ML + 50, qy2); qy2 += 17; }

  // closing line
  doc.setFont('helvetica', 'italic'); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
  const closeLines = doc.splitTextToSize(caps.closing || '', CW - 80);
  let clY = 560;
  for (const ln of closeLines) { doc.text(ln, PAGE_W / 2, clY, { align: 'center' }); clY += 14; }

  // version footer
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text('Version ' + new Date().toISOString().slice(0, 10) + '  ·  Auto-generated from the live capability manifest', PAGE_W / 2, PAGE_H - 48, { align: 'center' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...ACCENT_DIM);
  doc.text('MORPHEUS · BASE44', PAGE_W / 2, PAGE_H - 62, { align: 'center' });

  // =================== TOC (reserved) ===================
  doc.addPage(); bg();
  const tocPage = pages();
  y = MT;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(...ACCENT);
  doc.text('Contents', ML, y + 18); y += 30;
  doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(1); doc.line(ML, y, ML + CW, y); y += 14;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
  doc.text('Tap any entry to jump to that section. The full text is searchable — press Ctrl+F (or Cmd+F).', ML, y + 8); y += 22;
  const tocStartY = y;
  y = PAGE_H - MB;

  // =================== WELCOME ===================
  chStart(null, 'Welcome');
  para('Morpheus is a software studio that lives on your phone. You describe what you want in plain language, and Morpheus writes the real code, builds the backend, compiles a native binary, and deploys it — no laptop required, no lock-in, no illusions. You own every file it produces.');
  para('This manual explains every feature in clear English, with a simple step-by-step workflow for each. It is generated automatically from Morpheus\'s live capability list, so it always matches the version you are using.');
  h2('How to use this manual');
  bullet('Read "Getting Started" first to sign in and create your first project.');
  bullet('Jump to any capability chapter for a plain-English explanation and a numbered workflow.');
  bullet('For full walkthroughs, see the "Example —" chapters near the end: each shows a real workload step by step, with simulated screens of exactly what you will see.');
  bullet('Use the Index at the back to find any topic quickly.');
  callout('Tip', 'Prefer to learn by doing? Open the Construct, tap HELP in the toolbar, then tap any button for an inline explanation.');

  // =================== GETTING STARTED ===================
  chStart(1, 'Getting Started');
  para('Morpheus uses a standard, secure sign-in. You can use an email and password, or sign in with Google.');
  h2('Sign in');
  bullet('Enter your email and password on the Login screen, or tap "Continue with Google".');
  bullet('Forgot your password? Tap "Forgot password?" to receive a reset email.');
  h2('Register');
  bullet('Create an account with email and password, or Google.');
  bullet('After registering, a one-time passcode is sent to your email. Enter it to verify your account and finish.');
  h2('Navigation');
  para('The bottom tab bar (mobile) follows the order: Construct, Architect, Market, Settings. On desktop, navigation runs along the side. The browser back button closes any open panel before it navigates away.');

  // =================== CAPABILITY CHAPTERS ===================
  caps.capabilities.forEach((cap, i) => {
    chStart(i + 2, cap.title);
    para(cap.body);
    if (cap.workflow) {
      h2('How to use it');
      steps(cap.workflow);
    }
  });

  // =================== WORKED EXAMPLES ===================
  const exStart = caps.capabilities.length + 2;
  (caps.examples || []).forEach((ex, i) => exampleBlock(exStart + i, ex));

  // =================== COMPILE TARGETS ===================
  const ctNum = exStart + (caps.examples ? caps.examples.length : 0);
  chStart(ctNum, 'Compile Targets');
  para('The same project can be compiled to many targets. Choose one when you create a project, or change it later from the toolbar.');
  h2('Available targets');
  COMPILE_TARGETS.forEach(([t, d]) => {
    ensure(18);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...ACCENT);
    doc.text(t, ML, y + 9);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...BODY);
    const dLines = doc.splitTextToSize(d, CW - 150);
    doc.text(dLines, ML + 150, y + 9);
    y += Math.max(15, dLines.length * 12) + 4;
  });
  gap(4);
  callout('Good to know', 'Compilation runs on GitHub-hosted runners through a generated Actions workflow. When the build finishes, the artifact is saved inside your project under _compiled/, where you can download it directly.');

  // =================== REFERENCES ===================
  chStart(ctNum + 1, 'References & Resources');
  para('External links open in a new tab. Tap any URL to open the resource.');
  gap(4);
  REFERENCES.forEach(([label, url]) => {
    ensure(30);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...ACCENT);
    doc.text(label, ML, y + 9);
    doc.setFont('courier', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text(url, ML, y + 22);
    doc.link(ML, y + 2, CW, 24, { url });
    y += 30;
  });

  // =================== INDEX ===================
  doc.addPage(); bg(); y = MT;
  const indexPage = pages();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(...ACCENT);
  doc.text('Index', ML, y + 18); y += 30;
  doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(1); doc.line(ML, y, ML + CW, y); y += 14;
  para('A hyperlinked index of key terms. Each entry jumps to its section. Use Ctrl+F (or Cmd+F) to search.', 9.5, MUTED, 13);
  gap(4);
  const indexTerms = [];
  caps.capabilities.forEach((cap, i) => indexTerms.push([cap.title, i + 2]));
  indexTerms.push(['Getting Started', 1]);
  indexTerms.push(['Welcome', chapters.find(c => c.title === 'Welcome')?.page || 2]);
  (caps.examples || []).forEach((ex, i) => indexTerms.push(['Example: ' + ex.title, exStart + i]));
  indexTerms.push(['Compile Targets', ctNum]);
  indexTerms.push(['References', ctNum + 1]);
  indexTerms.sort((a, b) => a[0].localeCompare(b[0]));
  const colW = CW / 2;
  let col = 0, colY = y;
  for (let i = 0; i < indexTerms.length; i++) {
    const [term, page] = indexTerms[i];
    if (colY > PAGE_H - MB - 16) { col = 1; colY = y; }
    const x = ML + col * colW;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...BODY);
    doc.text(term, x, colY + 9);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...ACCENT);
    doc.text(String(page), x + colW - 20, colY + 9, { align: 'right' });
    doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(0.3); doc.line(x, colY + 13, x + colW - 30, colY + 13);
    doc.link(x, colY, colW - 20, 14, { pageNumber: page });
    colY += 16;
  }

  // =================== FILL TOC ===================
  doc.setPage(tocPage);
  y = tocStartY;
  const welcomeCh = chapters.find(c => c.title === 'Welcome');
  const tocEntries = [
    { label: 'Welcome', page: welcomeCh?.page },
    { label: '1. Getting Started', page: chapters.find(c => c.title === 'Getting Started')?.page }
  ];
  caps.capabilities.forEach((cap, i) => tocEntries.push({ label: (i + 2) + '. ' + cap.title, page: chapters.find(c => c.num === i + 2)?.page }));
  (caps.examples || []).forEach((ex, i) => tocEntries.push({ label: (exStart + i) + '. Example — ' + ex.title, page: chapters.find(c => c.num === exStart + i)?.page }));
  tocEntries.push({ label: ctNum + '. Compile Targets', page: chapters.find(c => c.num === ctNum)?.page });
  tocEntries.push({ label: (ctNum + 1) + '. References & Resources', page: chapters.find(c => c.num === ctNum + 1)?.page });
  tocEntries.push({ label: 'Index', page: indexPage });

  for (const e of tocEntries) {
    if (e.page == null) continue;
    ensure(22);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...BODY);
    doc.text(e.label, ML, y + 9);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...ACCENT);
    doc.text(String(e.page), ML + CW, y + 9, { align: 'right' });
    doc.setDrawColor(...ACCENT_DIM); doc.setLineWidth(0.3); doc.line(ML, y + 14, ML + CW, y + 14);
    doc.link(ML, y, CW, 18, { pageNumber: e.page });
    y += 22;
  }

  // =================== FOOTERS ===================
  const total = pages();
  for (let i = 2; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text('Morpheus User Manual', ML, PAGE_H - 26);
    doc.text(String(i - 1), ML + CW, PAGE_H - 26, { align: 'right' });
  }

  doc.save('Morpheus-User-Manual.pdf');
}