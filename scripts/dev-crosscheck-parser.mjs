// DEV-ONLY cross-check: does the dependency-free scanner agree with @babel/parser?
//
// scripts/lib/prose-ink.mjs hand-rolls a JSX scanner because the CI guards job
// runs without `npm install` (see verify-guards-no-install.mjs). Hand-rolled
// scanners are exactly the kind of thing that is quietly wrong, so this checks
// the thing that matters — which TAG owns each occurrence — against a real
// parser. It is NOT registered in CI, because CI cannot install @babel/parser;
// run it by hand whenever the scanner changes.
//
//   node scripts/dev-crosscheck-parser.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scanSource } from './lib/prose-ink.mjs';

let parse;
try { ({ parse } = await import('@babel/parser')); }
catch { console.error('\n@babel/parser is not installed — run npm install, or skip: this check is dev-only.\n'); process.exit(2); }

const files = execFileSync('grep', ['-rlE', 'text-primary/[0-9]+', 'src', '--include=*.jsx', '--include=*.js'],
  { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn));
  if (typeof node.type === 'string') fn(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue;
    walk(node[k], fn);
  }
}

let agree = 0; const disagree = []; let babelTotal = 0; const babelNoTag = [];
const tiny = (n) => n.type === 'JSXIdentifier' ? n.name : n.type;

for (const rel of files) {
  const src = readFileSync(rel, 'utf8');
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  // offset -> tag, from the real parser
  const truth = new Map();
  walk(ast, (node) => {
    if (node.type !== 'JSXElement') return;
    const op = node.openingElement;
    const attr = op.attributes.find((a) => a.type === 'JSXAttribute' && a.name?.name === 'className');
    if (!attr) return;
    const strings = [];
    if (attr.value?.type === 'StringLiteral') strings.push(attr.value);
    else if (attr.value?.type === 'JSXExpressionContainer') {
      walk(attr.value.expression, (n) => { if (n.type === 'StringLiteral' || n.type === 'TemplateElement') strings.push(n); });
    }
    for (const nd of strings) {
      const text = nd.type === 'TemplateElement' ? nd.value.raw : nd.value;
      // Babel's TemplateElement range already starts at the quasi's content.
      const base = nd.start + (nd.type === 'StringLiteral' ? 1 : 0);
      const re = /(^|[\s'"`])((?:\[[^\]]*\]:|[a-z-]+:)*)(text-primary(?![\w-])(?:\/\d+)?)/g;
      let m;
      while ((m = re.exec(text))) {
        const off = base + m.index + m[1].length + m[2].length;
        truth.set(off, tiny(op.name));
      }
    }
  });
  for (const o of scanSource(src)) {
    if (!o.tag || o.tag === '?') continue;
    babelTotal++;
    const t = truth.get(o.offset);
    if (t === undefined) { babelNoTag.push(`${rel}  offset ${o.offset}  ours=${o.tag}  ${JSON.stringify(o.token)}`); continue; }
    if (t === o.tag) agree++;
    else disagree.push(`${rel}:${o.offset} babel=${t} ours=${o.tag}`);
  }
}
console.log(`attributed occurrences compared : ${babelTotal}`);
console.log(`tag agreed                      : ${agree}`);
console.log(`not in babel's offset set       : ${babelNoTag.length}`);
for (const x of babelNoTag) console.log('    ', x);
console.log(`DISAGREED ON TAG                : ${disagree.length}`);
for (const d of disagree.slice(0, 20)) console.log('   ', d);
