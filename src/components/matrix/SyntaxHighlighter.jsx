import { useMemo } from 'react';

const COLORS = {
  keyword: '#C586C0',
  string: '#CE9178',
  comment: '#6A9955',
  number: '#B5CEA8',
  function: '#DCDCAA',
  type: '#4EC9B0',
  operator: '#D4D4D4',
  property: '#9CDCFE',
  default: '#D4D4D4',
};

const KEYWORD_SETS = {
  javascript: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|super|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|static|get|set|public|private|protected|readonly|interface|type|enum|namespace|module|declare|abstract|implements|as|satisfies',
  typescript: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|super|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|static|get|set|public|private|protected|readonly|interface|type|enum|namespace|module|declare|abstract|implements|as|satisfies|string|number|boolean|any|unknown|never|void|object|symbol|bigint',
  python: 'def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|pass|del|assert|in|is|not|and|or|None|True|False|self|cls|async|await',
  java: 'public|private|protected|class|interface|extends|implements|return|if|else|for|while|do|switch|case|break|continue|new|this|super|try|catch|finally|throw|throws|import|package|static|final|void|int|long|double|float|boolean|char|byte|short|String|enum|abstract|synchronized|volatile|transient|native|default|instanceof|Override',
  kotlin: 'fun|val|var|class|object|interface|return|if|else|for|while|do|when|break|continue|new|this|super|try|catch|finally|throw|import|package|static|final|void|int|long|double|float|Boolean|Char|Byte|Short|String|enum|abstract|override|private|public|protected|internal|companion|init|data|sealed|suspend|by|as|is|in|null|true|false',
  go: 'package|import|func|var|const|type|struct|interface|return|if|else|for|range|switch|case|default|break|continue|go|defer|chan|select|map|make|new|len|cap|append|copy|delete|nil|true|false|iota',
  rust: 'fn|let|mut|const|static|struct|enum|trait|impl|pub|use|mod|return|if|else|for|while|loop|match|break|continue|as|in|ref|move|self|Self|super|crate|unsafe|async|await|dyn|where|type|union',
  bash: 'if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|local|export|echo|printf|read|set|unset|shift|source|alias|unalias|trap|exit|cd|pwd|ls|cat|grep|sed|awk|curl|wget|chmod|chown|mkdir|rm|cp|mv|ln|tar|zip|unzip',
  groovy: 'def|class|interface|enum|trait|extends|implements|return|if|else|for|while|switch|case|break|continue|new|this|super|try|catch|finally|throw|throws|import|package|static|final|void|var|public|private|protected|abstract|override|it|true|false|null',
};

function getKeywordPattern(lang) {
  const map = {
    javascript: KEYWORD_SETS.javascript,
    typescript: KEYWORD_SETS.typescript,
    jsx: KEYWORD_SETS.javascript,
    tsx: KEYWORD_SETS.typescript,
    python: KEYWORD_SETS.python,
    java: KEYWORD_SETS.java,
    kotlin: KEYWORD_SETS.kotlin,
    go: KEYWORD_SETS.go,
    rust: KEYWORD_SETS.rust,
    bash: KEYWORD_SETS.bash,
    groovy: KEYWORD_SETS.groovy,
    yaml: KEYWORD_SETS.bash,
    markdown: null,
    json: null,
    html: null,
    css: null,
    text: null,
  };
  return map[lang] || null;
}

function buildTokenRegex(lang) {
  const kwPattern = getKeywordPattern(lang);
  const parts = [
    { type: 'comment', re: lang === 'python' ? /#[^\n]*/ : /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/ },
    { type: 'string', re: /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/ },
    { type: 'number', re: /\b0x[0-9a-fA-F]+\b|\b\d+\.?\d*([eE][+-]?\d+)?\b/ },
  ];
  if (kwPattern) {
    parts.push({ type: 'keyword', re: new RegExp(`\\b(?:${kwPattern})\\b`) });
  }
  return parts;
}

function tokenizeLine(line, lang) {
  const patterns = buildTokenRegex(lang);
  const tokens = [];
  let pos = 0;

  while (pos < line.length) {
    const slice = line.slice(pos);
    let best = null;

    for (const { type, re } of patterns) {
      const m = re.exec(slice);
      if (m && (best === null || m.index < best.index)) {
        best = { index: m.index, text: m[0], type };
      }
    }

    if (best === null) {
      tokens.push({ text: slice, type: 'default' });
      break;
    }

    if (best.index > 0) {
      tokens.push({ text: slice.slice(0, best.index), type: 'default' });
    }
    tokens.push({ text: best.text, type: best.type });
    pos += best.index + best.text.length;
  }

  return tokens;
}

function detectLangFromPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', html: 'html', css: 'css', md: 'markdown', py: 'python', sh: 'bash', yml: 'yaml', yaml: 'yaml', txt: 'text', ino: 'cpp', cpp: 'cpp', h: 'cpp', java: 'java', kt: 'kotlin', swift: 'swift', go: 'go', rs: 'rust', gradle: 'groovy', xml: 'xml' };
  return map[ext] || 'text';
}

export default function SyntaxHighlighter({ content, language, filePath }) {
  const effectiveLang = useMemo(() => {
    if (language && language !== 'text') return language;
    if (filePath) return detectLangFromPath(filePath);
    return 'text';
  }, [language, filePath]);

  const lines = useMemo(() => (content || '').split('\n'), [content]);

  const highlighted = useMemo(() => {
    return lines.map(line => tokenizeLine(line, effectiveLang));
  }, [lines, effectiveLang]);

  return (
    <>
      {highlighted.map((tokens, i) => (
        <div key={i} className="flex">
          <span className="text-primary/25 select-none w-8 text-right pr-3 shrink-0">{i + 1}</span>
          <span className="whitespace-pre-wrap break-all flex-1">
            {tokens.length === 0 ? '\u00A0' : tokens.map((tok, j) => (
              <span key={j} style={{ color: COLORS[tok.type] || COLORS.default }}>{tok.text}</span>
            ))}
          </span>
        </div>
      ))}
    </>
  );
}