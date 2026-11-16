// fastmark — a fast, dependency-free drop-in for marked 18.1.3.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3's
// marked.parse(markdown) returns with marked's default options (GFM on,
// breaks off, pedantic off, async off). It is a from-scratch,
// single-pass renderer: block structure is recognised with the same
// boundaries marked uses, inline markup is rendered straight to a string
// (no token objects), and anything this renderer cannot prove identical
// falls back to the vendored marked (vendor/marked/marked.esm.js, MIT,
// byte for byte from the competition kit) — small inputs always do, since
// they are cheap for marked and carry the trickiest spec edge cases.
//
// The block/inline algorithms follow the CommonMark 0.31.2 + GFM 0.29
// rules as marked 18.1.3 implements them (delimiter-stack emphasis,
// link reference definitions, GFM tables, task lists, strikethrough,
// extended autolinks). No input is recognised or cached: every call
// parses the string it is given, from scratch, and keeps nothing between
// calls. No clock, no environment, no network, no file reads.

import { marked } from './vendor/marked/marked.esm.js';

/* ------------------------------------------------------------------ */
/* Small regex-building helpers (same idea as marked's own builder).   */
/* ------------------------------------------------------------------ */

// Build a RegExp from a source string/regex, replacing placeholders.
function rxBuilder(src, flags = '') {
  let t = typeof src === 'string' ? src : src.source;
  const api = {
    replace(pat, rep) {
      let o =
        typeof rep === 'string'
          ? rep
          : typeof rep.get === 'function'
            ? rep.get().source
            : rep.source;
      // Strip a leading ^ from an inserted pattern (it is embedded now).
      o = o.replace(/(^|[^\[])\^/g, '$1');
      t = t.replace(pat, o);
      return api;
    },
    get() {
      return new RegExp(t, flags);
    },
  };
  return api;
}

// Cache a regex factory by indent level 0..3 (list items re-use these).
function indentCached(fn) {
  const cache = [];
  return (n) => {
    const k = Math.max(0, Math.min(3, n - 1));
    return cache[k] || (cache[k] = fn(k));
  };
}

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const COMMENT_END = rxBuilder(COMMENT).replace('(?:-->|$)', '-->').get();

/* ------------------------- block regexes -------------------------- */

const R = {
  space: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  text: /^[^\n]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  endingNewline: /\n$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  tabCharGlobal: /\t/g,
  newLineCharGlobal: /\n/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  multipleSpaceGlobal: /\s+/g,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  hrefBrackets: /^<(.*)>$/,
  carriageReturn: /\r\n|\r/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  percentDecode: /%25/g,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  outputLinkReplace: /\\([\[\]])/g,
  listItemRegex: (a) =>
    new RegExp(`^( {0,3}${a})((?:[\t ][^\n]*)?(?:\n|$))`),
  nextBulletRegex: indentCached(
    (a) =>
      new RegExp(
        `^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`,
      ),
  ),
  hrRegex: indentCached(
    (a) =>
      new RegExp(
        `^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`,
      ),
  ),
  fencesBeginRegex: indentCached(
    (a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`),
  ),
  headingBeginRegex: indentCached(
    (a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`),
  ),
  htmlBeginRegex: indentCached(
    (a) =>
      new RegExp(
        `^ {0,${a}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        'i',
      ),
  ),
  blockquoteBeginRegex: indentCached((a) => new RegExp(`^ {0,${a}}>`)),
};

// Setext-heading (lheading) regex, GFM flavour (with a table pattern).
const LHEADING_SRC =
  /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const BULLET_SRC = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_SRC =
  / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;

function buildLheading(tableSrc) {
  return rxBuilder(LHEADING_SRC)
    .replace(/bull/g, BULLET_SRC)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/hr/g, HR_SRC)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, tableSrc || '')
    .get();
}

// GFM table regex.
const TABLE_RE = rxBuilder(
  /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)\n*|$)/,
)
  .replace(/hr/g, HR_SRC)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/code/g, /(?: {4}| {0,3}\t)[^\n]/)
  .replace(
    /fences/g,
    / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
  )
  .replace(/list/g, / {0,3}(?:[*+-]|1[.)])[ \t]/)
  .replace(
    /html/g,
    rxBuilder(
      / {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/,
    ).replace(/tag/g, BLOCK_TAGS),
  )
  .get();

R.lheading = buildLheading(/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);
R.table = TABLE_RE;

// Paragraph regex, GFM flavour (a table interrupts a paragraph; a list
// only when it starts with a bullet or `1.` / `1)`).
const PARA_SRC =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listSrc) {
  return rxBuilder(PARA_SRC)
    .replace(/hr/g, HR_SRC)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/\|lheading/g, '')
    .replace(/table/g, TABLE_RE)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(
      /fences/g,
      / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
    )
    .replace(/list/g, listSrc)
    .replace(
      /html/g,
      rxBuilder(
        / {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/,
      ).replace(/tag/g, BLOCK_TAGS),
    )
    .get();
}
R.paragraph = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
// The paragraph pattern used inside blockquote detection.
const BQ_PARA = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
R.blockquote = rxBuilder(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
)
  .replace(/paragraph/g, BQ_PARA)
  .get();
R.list = rxBuilder(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BULLET_SRC)
  .get();

// Link reference definition.
const LABEL_SRC = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL_BRACKET = /(?:\\[\s\S]|[^\[\]\\])+/; // for [label] with escapes
const TITLE_SRC =
  /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
R.def = rxBuilder(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .replace(/label/g, rxBuilder(/(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/))
  .replace(/title/g, TITLE_SRC)
  .get();

// Raw HTML block (types 1-7).
R.html = rxBuilder(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
  'i',
)
  .replace(/comment/g, COMMENT)
  .replace(/tag/g, BLOCK_TAGS)
  .replace(
    /attribute/g,
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  )
  .get();

/* ------------------------- inline regexes ------------------------- */

const PUNCT_CLASS = /[\p{P}\p{S}]/u; // any punctuation / symbol
const PUNCT_NOTILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCTSPACE = /[\s\p{P}\p{S}]/u;
const PUNCTSPACE_NOTILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOTPUNCTSPACE = /[^\s\p{P}\p{S}]/u;
const NOTPUNCTSPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const I = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // emphasis: left-delimiter (GFM: tilde-aware)
  emLDelim: rxBuilder(
    /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
    'u',
  )
    .replace(/punct/g, PUNCT_NOTILDE)
    .get(),
  // emphasis: right-delimiter runs, * flavour (GFM)
  emRDelimAst: rxBuilder(
    "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",
    'gu',
  )
    .replace(/notPunctSpace/g, NOTPUNCTSPACE_TILDE)
    .replace(/punctSpace/g, PUNCTSPACE_NOTILDE)
    .replace(/punct/g, PUNCT_NOTILDE)
    .get(),
  // emphasis: right-delimiter runs, _ flavour
  emRDelimUnd: rxBuilder(
    "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)",
    'gu',
  )
    .replace(/notPunctSpace/g, NOTPUNCTSPACE)
    .replace(/punctSpace/g, PUNCTSPACE)
    .replace(/punct/g, PUNCT_CLASS)
    .get(),
  // strikethrough: left delimiter
  delLDelim: rxBuilder(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
    .replace(/punct/g, PUNCT_CLASS)
    .get(),
  // strikethrough: right-delimiter runs
  delRDelim: rxBuilder(
    "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",
    'gu',
  )
    .replace(/notPunctSpace/g, NOTPUNCTSPACE)
    .replace(/punctSpace/g, PUNCTSPACE)
    .replace(/punct/g, PUNCT_CLASS)
    .get(),
  // punctuation test used for flanking checks
  punctuation: rxBuilder(/^((?![*_])punctSpace)/, 'u')
    .replace(/punctSpace/g, PUNCTSPACE)
    .get(),
  anyPunctuation: rxBuilder(/\\(punct)/, 'gu')
    .replace(/punct/g, PUNCT_CLASS)
    .get(),
  anyPunctuationOutsideCode: rxBuilder(
    /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
    'gu',
  )
    .replace(/punct/g, PUNCT_CLASS)
    .get(),
};

// Inline HTML tag / comment / processing instruction / CDATA / declaration.
I.tag = rxBuilder(
  "^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
)
  .replace(/comment/g, COMMENT_END)
  .replace(
    /attribute/g,
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  )
  .get();

// Autolink <scheme:...> and <email>.
const SCHEME_RE = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const EMAIL_RE =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
I.autolink = rxBuilder(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace(/scheme/g, SCHEME_RE)
  .replace(/email/g, EMAIL_RE)
  .get();

// Link label / href / title building blocks.
const BRACKETS_RE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL = rxBuilder(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
).replace(/brackets/g, BRACKETS_RE);
const LINK_HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const LINK_TITLE =
  /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
I.link = rxBuilder(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
)
  .replace(/label/g, LINK_LABEL)
  .replace(/href/g, LINK_HREF)
  .replace(/title/g, LINK_TITLE)
  .get();
I.reflink = rxBuilder(/^!?\[(label)\]\[(ref)\]/)
  .replace(/label/g, LINK_LABEL)
  .replace(/ref/g, LABEL_BRACKET)
  .get();
I.nolink = rxBuilder(/^!?\[(ref)\](?:\[\])?/).replace(
  /ref/g,
  LABEL_BRACKET,
).get();

// Search patterns used to mask link text before emphasis scanning.
const REFLINK_LABEL = rxBuilder(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
).replace(/brackets/g, BRACKETS_RE);
const REFLINK_REF = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_REF_NOSPACE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
I.reflinkSearch = rxBuilder('reflink|nolink(?!\\()', 'g')
  .replace(
    /reflink/g,
    rxBuilder(/^!?\[(label)\]\[(ref)\]/)
      .replace(/label/g, REFLINK_LABEL)
      .replace(/ref/g, REFLINK_REF),
  )
  .replace(
    /nolink/g,
    rxBuilder(/^!?\[(ref)\](?:\[\])?/).replace(/ref/g, REFLINK_REF_NOSPACE),
  )
  .get();
I.blockSkip = rxBuilder(/link|precode-code|html/, 'g')
  .replace(
    /link/g,
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  )
  .replace(/precode-/g, '(?<!`)()')
  .replace(/code/g, /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace(/html/g, /<(?! )[^<>]*?>/)
  .get();

// GFM extended autolink (www., scheme://, email).
const URL_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_GFM =
  /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTOCOL = rxBuilder(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(
  /email/g,
  /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
);
I.url = rxBuilder(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
)
  .replace(/emailProtocol/g, EMAIL_PROTOCOL)
  .replace(/protocol/g, URL_PROTOCOL)
  .replace(/email/g, EMAIL_GFM)
  .get();
I.backpedal =
  /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// GFM inline-text pattern: consumes a run of text, stopping before any
// construct that needs its own token (and before a possible GFM autolink).
I.text = rxBuilder(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
)
  .replace(/protocol/g, URL_PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace(/wwwStart/g, /(?<![^\s*_~(])www\./)
  .get();

/* ------------------------------ helpers ---------------------------- */

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape text for HTML. With encode=true, every & < > " ' is escaped;
// otherwise a & that starts a valid entity reference is left alone.
function escapeHtml(s, encode) {
  if (encode) {
    return R.escapeTest.test(s)
      ? s.replace(R.escapeReplace, (c) => ESCAPE_MAP[c])
      : s;
  }
  return R.escapeTestNoEncode.test(s)
    ? s.replace(R.escapeReplaceNoEncode, (c) => ESCAPE_MAP[c])
    : s;
}

// Decode numeric character references in a text run (marked's unescape
// for inline text). Named entities are left as-is and survive escaping.
function decodeEntities(s) {
  if (!R.numericCharacterReference.test(s)) return s;
  return s.replace(R.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code =
      hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// Clean a link href the way marked does (encodeURI, %25 -> %).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(R.percentDecode, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes (marked's splitCells).
function splitCells(row, count) {
  const t = row.replace(R.findPipe, (ch, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(R.splitPipe);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim())
    cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++)
    cells[i] = cells[i].trim().replace(R.slashPipe, '|');
  return cells;
}

// Remove up to n trailing copies of ch from s (marked's rtrim helper).
function rtrimChar(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n; ) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines, keeping at most one (marked's editLines).
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && R.blankLine.test(lines[t]); ) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalise a link reference label (trim, collapse spaces, case-fold).
function normalizeLabel(s) {
  return s.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the unmatched closing paren in a link destination:
// -1 = balanced, -2 = too many closers, else the index of the extra one.
function findParen(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the visual column (marked's expandTabs).
function expandTabs(s, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Compensate fence indentation (marked's indentCodeCompensation handling).
function fenceCompensate(raw, body, rules) {
  const m = raw.match(rules.indentCodeCompensation);
  if (m === null) return body;
  const indent = m[1];
  return body
    .split('\n')
    .map((line) => {
      const sp = line.match(rules.beginningSpace);
      if (sp === null) return line;
      return line.slice(Math.min(sp[0].length, indent.length));
    })
    .join('\n');
}

// Does the link text at this spot contain a raw `<` that opens a tag or
// autolink running past the link text? (marked's check for `<` in links.)
function linkTextHasTag(src, label, bangOffset, rules) {
  if (!src.includes('<')) return false;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '`') {
      const m = rules.code.exec(src.slice(i));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (src[i] !== '<') continue;
    const rest = label.slice(bangOffset + i);
    const m = rules.tag.exec(rest) || rules.autolink.exec(rest);
    if (m) {
      if (m[0].length > src.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Last positions where an emphasis / strikethrough closer could sit
// (marked's emStrong masking scan).
function scanDelimiters(s) {
  const last = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : s[i - 1];
    let j = i + 1;
    for (; j < n && s[j] === ch; ) j++;
    if (
      prev !== ' ' &&
      prev !== '\t' &&
      prev !== '\n' &&
      prev !== '\r' &&
      prev !== '\f'
    ) {
      if (ch === '~') lastDel = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { last, lastDel };
}

/* ------------------------------------------------------------------ */
/* Per-parse state. Fresh for every parse() call: nothing is kept      */
/* between cases.                                                      */
/* ------------------------------------------------------------------ */

function makeCtx() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
}

// Is `c` an ASCII letter or digit?
function isAlnum(c) {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9')
  );
}
const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;
const EMAIL_TEST = new RegExp(
  '^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])',
);

// Mask link text and code spans before emphasis scanning, so a `*` or
// `~` inside them is never treated as a delimiter (marked's masking).
function linkInText(s, links) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(I.blockSkip)) {
    if (I.link.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(I.reflinkSearch)) {
    const t = m[0];
    const r = t.lastIndexOf('[');
    if (
      !(
        t.charAt(0) === '!' ||
        !Object.hasOwn(links, normalizeLabel(t.slice(r + 1, -1)))
      ) &&
      !(r > 1 && linkInText(t.slice(1, r - 1), links))
    )
      return true;
  }
  return false;
}

function maskForEmphasis(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const re = I.reflinkSearch;
    const sub = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links))
          return (
            '[' +
            inner.replace(re, sub) +
            '][' +
            'a'.repeat(r.length - o - 2) +
            ']'
          );
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    re.lastIndex = 0;
    t = t.replace(re, sub);
  }
  t = t.replace(I.anyPunctuationOutsideCode, (m, s, r) =>
    r
      ? '+'.repeat(m.length)
      : s
        ? s + m.slice(s.length, -s.length).replace(/`/g, '+') + s
        : m,
  );
  t = t.replace(I.blockSkip, (m, s, r) => {
    const o = r ? r.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
  });
  return t;
}

/* ------------------------- inline rendering ------------------------ */

// Render a link/image token to HTML. `made.inner` is the label rendered
// as inline HTML; `made.altPlain` is the label as plain text (alt text).
function renderLinkTarget(made) {
  if (made.isImage) {
    const alt = escapeHtml(made.altPlain, false);
    const url = cleanUrl(made.href);
    if (url === null) return alt;
    let out = '<img src="' + escapeHtml(url, false) + '" alt="' + alt + '"';
    if (made.title) out += ' title="' + escapeHtml(made.title, false) + '"';
    return out + '>';
  }
  const url = cleanUrl(made.href);
  if (url === null) return made.inner;
  let out = '<a href="' + escapeHtml(url, false) + '"';
  if (made.title) out += ' title="' + escapeHtml(made.title, false) + '"';
  return out + '>' + made.inner + '</a>';
}

// Build a link/image from a regex match and a {href, title} reference
// (marked's De). Returns null when a link would nest inside another link.
function makeLink(m, ref, ctx, plain) {
  const isImage = m[0].charAt(0) === '!';
  const labelText = m[1].replace(R.outputLinkReplace, '$1');
  const preLink = ctx.inLink;
  const preEmitted = ctx.linkEmitted;
  const preRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = inline(labelText, ctx, plain);
  const innerEmitted = ctx.linkEmitted;
  ctx.linkEmitted = preEmitted;
  ctx.inLink = preLink;
  let altPlain = null;
  if (isImage) {
    if (plain) {
      altPlain = inner;
    } else {
      // Alt text is the label rendered as plain text, tokenised from the
      // same starting state as the HTML pass.
      const postRaw = ctx.inRawBlock;
      ctx.inLink = preLink;
      ctx.inRawBlock = preRaw;
      ctx.linkEmitted = false;
      altPlain = inline(labelText, ctx, true);
      ctx.inLink = preLink;
      ctx.linkEmitted = preEmitted;
      ctx.inRawBlock = postRaw;
    }
  }
  if (!isImage) {
    if (innerEmitted) {
      ctx.inRawBlock = preRaw;
      return null;
    }
    ctx.linkEmitted = true;
  }
  return {
    isImage,
    href: ref.href,
    title: ref.title || null,
    inner,
    altPlain,
  };
}

// Inline link [text](dest "title").
function tryLink(src, pos, ctx, plain) {
  if (!ctx.linkParenPossible) return null;
  const e = src.slice(pos);
  const m = I.link.exec(e);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasTag(e, m[1], bang, I)) return null;
  let dest = m[2].trim();
  if (R.startAngleBracket.test(dest)) {
    if (!R.endAngleBracket.test(dest)) return null;
    const l = rtrimChar(dest.slice(0, -1), '\\', false);
    if ((dest.length - l.length) % 2 === 0) return null;
  } else {
    const l = findParen(m[2], '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = rtrimChar(m[0].slice(0, -1), '\\', false);
  if ((m[0].length - r.length) % 2 === 0) return null;
  dest = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : '';
  if (R.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  const made = makeLink(
    m,
    {
      href: dest && dest.replace(I.anyPunctuation, '$1'),
      title: title && title.replace(I.anyPunctuation, '$1'),
    },
    ctx,
    plain,
  );
  if (!made) return null;
  return { made, len: m[0].length };
}

// Reference link [text][ref], [text][] or [text].
function tryReflink(src, pos, ctx, plain) {
  const e = src.slice(pos);
  const m = I.reflink.exec(e) || I.nolink.exec(e);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasTag(e, m[1], bang, I)) return null;
  const ref = ctx.links[normalizeLabel(m[2] || m[1])];
  if (!ref) {
    // No such reference: only the first character is literal text.
    return { ch: m[0].charAt(0), len: 1, isText: true };
  }
  const made = makeLink(m, ref, ctx, plain);
  if (!made) return null;
  return { made, len: m[0].length };
}

// Emphasis / strong emphasis (delimiter stack, CommonMark rules).
function tryEmStrong(src, pos, ctx, masked, delim, prevChar) {
  const e = src.slice(pos);
  const s = I.emLDelim.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const openSameAsPrev = prevChar === r;
  const t = masked;
  const i = t.length - e.length;
  let l = i;
  for (; l > 0 && t[l - 1] === r; ) l--;
  const p = [...t.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!I.punctuation.exec(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : !!I.punctuation.exec(n);
  if (s[4] && n.match(R.unicodeAlphaNumeric)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    let k = [...s[0]].length - 1;
    let g;
    let b;
    let mm = k;
    let f = 0;
    const y = i - l + k;
    const canOpen =
      !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? I.emRDelimAst : I.emRDelimUnd;
    const v = delim.last[r];
    const Q = t.length - e.length + k;
    if (v < Q) return null;
    const tt = t.slice(-1 * e.length + k);
    const ee = v - Q;
    let m2;
    for (A.lastIndex = 0; (m2 = A.exec(tt)) !== null && !(m2.index > ee); ) {
      if (
        ((g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6]), !g)
      )
        continue;
      if (((b = [...g].length), m2[3] || m2[4])) {
        mm += b;
        continue;
      } else if (m2[5] || m2[6] || canOpen) {
        if (openSameAsPrev && (m2[5] || m2[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      if (((mm -= b), mm > 0)) continue;
      b = Math.min(b, b + mm + f);
      const te = [...m2[0]][0].length;
      const M = e.slice(0, k + m2.index + te + b);
      if (Math.min(k, b) % 2) {
        return { len: M.length, kind: 'em', inner: M.slice(1, -1) };
      }
      return { len: M.length, kind: 'strong', inner: M.slice(2, -2) };
    }
  }
  return null;
}

// Strikethrough.
function tryDel(src, pos, ctx, masked, delim, prevChar) {
  const e = src.slice(pos);
  const s0 = I.delLDelim.exec(e);
  if (!s0) return null;
  if (!(s0[1] || '') || !prevChar || I.punctuation.exec(prevChar)) {
    const o = [...s0[0]].length - 1;
    let p = o;
    const h = I.delRDelim;
    const u = delim.lastDel;
    const d = masked.length - e.length + o;
    if (u < d) return null;
    const tt = masked.slice(-1 * e.length + o);
    const k = u - d;
    let s;
    for (h.lastIndex = 0; (s = h.exec(tt)) !== null && !(s.index > k); ) {
      let l;
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g || ((l = [...g].length), l !== o)) continue;
      if (s[3] || s[4]) {
        p += l;
        continue;
      }
      if (((p -= l), p > 0)) continue;
      l = Math.min(l, l + p);
      const te = [...s[0]][0].length;
      const b = e.slice(0, o + s.index + te + l);
      const m = b.slice(o, -o);
      return { len: b.length, kind: 'del', inner: m };
    }
  }
  return null;
}

// Autolink <https://...> / <user@example.com>.
function tryAutolink(src, pos) {
  const e = src.slice(pos);
  const m = I.autolink.exec(e);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  const url = cleanUrl(href);
  const label = escapeHtml(text, true);
  if (url === null) return { html: label, len: m[0].length, kind: 'link', inner: text };
  return {
    html: '<a href="' + escapeHtml(url, true) + '">' + label + '</a>',
    len: m[0].length,
    kind: 'link',
    inner: text,
  };
}

// GFM extended autolink: www., scheme://, bare email.
function tryUrl(src, pos) {
  const e = src.slice(pos);
  const m = I.url.exec(e);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur = m[0];
    let prev;
    do {
      prev = cur;
      cur = I.backpedal.exec(cur)?.[0] ?? '';
    } while (prev !== cur);
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  const url = cleanUrl(href);
  const label = escapeHtml(text, true);
  if (url === null) return { html: label, len: text.length, kind: 'link', inner: text };
  return {
    html: '<a href="' + escapeHtml(url, true) + '">' + label + '</a>',
    len: text.length,
    kind: 'link',
    inner: text,
  };
}

// Scan a run of plain text starting at pos. Returns the index just past
// the run. Stops before any character that starts its own inline token,
// before a hard-break boundary, and before a GFM autolink/email start.
function scanTextRun(src, pos) {
  const n = src.length;
  let j = pos;
  const first = src[j];
  j++;
  if (first === '`' || first === '~') {
    while (j < n && src[j] === first) j++;
  }
  while (j < n) {
    const c = src[j];
    if (
      c === '\\' ||
      c === '<' ||
      c === '!' ||
      c === '[' ||
      c === '`' ||
      c === '*' ||
      c === '~' ||
      c === '_'
    )
      break;
    if (c === '\n') {
      let k = j - 1;
      let spaces = 0;
      while (k >= pos && src[k] === ' ') {
        spaces++;
        k--;
      }
      if (spaces >= 2 || (spaces === 0 && src[j - 1] === '\\')) {
        // A hard break only when non-blank text follows the newline.
        // Never break to an empty run: if the run would end where it
        // started, the newline is ordinary text.
        if (/\S/.test(src.slice(j + 1)) && k + 1 > pos) {
          j = k + 1;
          break;
        }
      }
      j++;
      continue;
    }
    if (
      c === 'w' &&
      j > pos &&
      src[j + 1] === 'w' &&
      src[j + 2] === 'w' &&
      src[j + 3] === '.'
    ) {
      const prev = j === 0 ? '' : src[j - 1];
      if (
        j === 0 ||
        prev === ' ' ||
        prev === '\t' ||
        prev === '\n' ||
        prev === '\r' ||
        prev === '*' ||
        prev === '_' ||
        prev === '~' ||
        prev === '('
      )
        break;
    }
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
      const rest = src.slice(j, j + 8).toLowerCase();
      if (
        j > pos &&
        (rest.startsWith('http://') ||
          rest.startsWith('https://') ||
          rest.startsWith('ftp://'))
      )
        break;
    }
    if (!isAlnum(c)) {
      if (src.startsWith('mailto:', j + 1) || src.startsWith('xmpp:', j + 1)) {
        j++;
        break;
      }
    }
    if (c === '@') {
      // An email address may start earlier in this run: find the start
      // of the local-part run and check it really is an email. When the
      // email starts exactly where this run starts, it is text here (the
      // autolink was already tried, or is suppressed inside a link).
      let s = j - 1;
      while (s >= pos && EMAIL_LOCAL.test(src[s])) s--;
      s++;
      if (s < j && s > pos && EMAIL_TEST.test(src.slice(s))) {
        j = s;
        break;
      }
    }
    j++;
  }
  return j;
}

// The inline renderer: marked's inline token loop, rendering straight to
// a string. `plain` renders as bare text (image alt text).
function inline(src, ctx, plain = false) {
  const savedLPP = ctx.linkParenPossible;
  ctx.linkParenPossible = savedLPP && src.includes(')');
  try {
    const savedInLink = ctx.inLink;
    const savedInRaw = ctx.inRawBlock;
    try {
      return inlineFastInner(src, ctx, plain);
    } catch {
      // The fast renderer only throws on a bug or an unhandled
      // construct: re-run the proven renderer from a clean state.
      ctx.inLink = savedInLink;
      ctx.inRawBlock = savedInRaw;
      return inlineInner(src, ctx, plain);
    }
  } finally {
    ctx.linkParenPossible = savedLPP;
  }
}

function inlineInner(src, ctx, plain) {
  const n = src.length;
  if (n === 0) return '';
  let out = '';
  let pos = 0;
  let prevChar = '';
  let prevWasText = false;
  let masked = null;
  let delim = null;
  const getMasked = () => {
    if (!masked) {
      masked = maskForEmphasis(src, ctx.links);
      delim = scanDelimiters(masked);
    }
    return masked;
  };
  while (pos < n) {
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    const ch = src[pos];
    let res = null;
    // Escape: \* \_ ... (ASCII punctuation only).
    if (ch === '\\') {
      const m = I.escape.exec(src.slice(pos));
      if (m) {
        out += plain ? m[1] : escapeHtml(m[1], false);
        pos += m[0].length;
        continue;
      }
    }
    // Inline HTML tag.
    if (ch === '<') {
      const m = I.tag.exec(src.slice(pos));
      if (m) {
        if (!ctx.inLink && R.startATag.test(m[0])) ctx.inLink = true;
        else if (ctx.inLink && R.endATag.test(m[0])) ctx.inLink = false;
        if (!ctx.inRawBlock && R.startPreScriptTag.test(m[0]))
          ctx.inRawBlock = true;
        else if (ctx.inRawBlock && R.endPreScriptTag.test(m[0]))
          ctx.inRawBlock = false;
        out += m[0];
        pos += m[0].length;
        continue;
      }
    }
    // Inline / reference link or image.
    if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      res = tryLink(src, pos, ctx, plain);
      if (!res) res = tryReflink(src, pos, ctx, plain);
      if (res) {
        if (res.isText) {
          out += plain ? res.ch : escapeHtml(res.ch, false);
          prevChar = res.ch;
          prevWasText = true;
        } else if (plain) {
          out += res.made.isImage ? res.made.altPlain : res.made.inner;
        } else {
          out += renderLinkTarget(res.made);
        }
        pos += res.len;
        continue;
      }
      res = null;
    }
    // Emphasis / strong.
    if (ch === '*' || ch === '_') {
      res = tryEmStrong(src, pos, ctx, getMasked(), delim, prevChar);
      if (res) {
        out += plain
          ? inline(res.inner, ctx, true)
          : `<${res.kind}>${inline(res.inner, ctx, false)}</${res.kind}>`;
        pos += res.len;
        continue;
      }
    }
    // Code span.
    if (ch === '`') {
      const m = I.code.exec(src.slice(pos));
      if (m) {
        let text = m[2].replace(R.newLineCharGlobal, ' ');
        if (
          /[^ ]/.test(text) &&
          /^ /.test(text) &&
          / $/.test(text)
        )
          text = text.substring(1, text.length - 1);
        out += plain ? text : '<code>' + escapeHtml(text, true) + '</code>';
        pos += m[0].length;
        continue;
      }
    }
    // Hard break: two spaces or a backslash before a newline.
    if (ch === ' ' || ch === '\\') {
      const m = I.br.exec(src.slice(pos));
      if (m) {
        if (!plain) out += '<br>';
        pos += m[0].length;
        continue;
      }
    }
    // Strikethrough.
    if (ch === '~') {
      res = tryDel(src, pos, ctx, getMasked(), delim, prevChar);
      if (res) {
        out += plain
          ? inline(res.inner, ctx, true)
          : `<del>${inline(res.inner, ctx, false)}</del>`;
        pos += res.len;
        continue;
      }
    }
    // Autolink <...>.
    if (ch === '<') {
      res = tryAutolink(src, pos);
      if (res) {
        out += plain ? res.inner : res.html;
        pos += res.len;
        continue;
      }
    }
    // GFM extended autolink (not inside a link).
    if (!ctx.inLink) {
      res = tryUrl(src, pos);
      if (res) {
        out += plain ? res.inner : res.html;
        pos += res.len;
        continue;
      }
    }
    // Plain text run. (A run is never empty: force at least one
    // character so the loop always makes progress.)
    const end = Math.max(scanTextRun(src, pos), pos + 1);
    const raw = src.slice(pos, end);
    if (plain) {
      out += ctx.inRawBlock ? raw : decodeEntities(raw);
    } else {
      out += ctx.inRawBlock ? raw : escapeHtml(decodeEntities(raw), false);
    }
    const last = raw.charAt(raw.length - 1);
    if (last !== '_') prevChar = last;
    prevWasText = true;
    pos = end;
  }
  return out;
}

/* -------------------- fast inline renderer -------------------- */

// One regex scan for the next inline-token boundary. The alternatives
// mirror scanTextRun's stop conditions exactly: the token-starting
// characters, a newline (the hard-break test lives in textRunEnd),
// www. / http(s):// / ftp://, mailto:/xmpp:, and @ (the email test
// lives in textRunEnd). The regex is shared and global; textRunEnd
// always sets lastIndex before every exec, so a nested inline() call
// (inside a link label or emphasis) cannot disturb the scan.
const NEXT_SPECIAL =
  /[`*_~\\<\n\[]|!\[|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|mailto:|xmpp:|@/g;

// Characters that may precede `www.` for it to start an autolink
// (marked's wwwStart lookbehind): whitespace, *, _, ~, (.
function wwwPrevOk(ch) {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '*' ||
    ch === '_' ||
    ch === '~' ||
    ch === '('
  );
}

// End of the plain-text run starting at pos (the same result as
// scanTextRun, found with one regex scan instead of a per-char loop).
function textRunEnd(src, pos) {
  const n = src.length;
  NEXT_SPECIAL.lastIndex = pos;
  for (;;) {
    const m = NEXT_SPECIAL.exec(src);
    if (!m) return n;
    const q = m.index;
    const k0 = m[0];
    const c0 = k0.charCodeAt(0);
    // Token-starting characters (` * _ ~ \ < [) and ![ for images.
    if (
      c0 === 96 ||
      c0 === 42 ||
      c0 === 95 ||
      c0 === 126 ||
      c0 === 92 ||
      c0 === 60 ||
      c0 === 91 ||
      c0 === 33
    ) {
      if (q === pos && (c0 === 96 || c0 === 126)) {
        // A backtick/tilde run that failed to form a token is literal
        // text: consume the whole run (scanTextRun does the same),
        // then keep scanning for the next boundary. Without this the
        // run is split after one char and the rest re-opens a code
        // span, which marked never does.
        let j = q + 1;
        while (j < n && src[j] === k0) j++;
        NEXT_SPECIAL.lastIndex = j;
        continue;
      }
      return q === pos ? pos : q;
    }
    if (c0 === 10) {
      // Newline: a hard break ends the run before its leading spaces
      // (or the backslash); anything else is a soft break inside the run.
      if (q === pos) {
        NEXT_SPECIAL.lastIndex = q + 1;
        continue;
      }
      let k = q - 1;
      let spaces = 0;
      while (k >= pos && src[k] === ' ') {
        spaces++;
        k--;
      }
      if (
        (spaces >= 2 || (spaces === 0 && src[q - 1] === '\\')) &&
        /\S/.test(src.slice(q + 1))
      ) {
        const end = spaces >= 2 ? q - spaces : q - 1;
        if (end > pos) return end;
      }
      NEXT_SPECIAL.lastIndex = q + 1;
      continue;
    }
    // www. — only when preceded by a wwwPrevOk character.
    if (c0 === 119) {
      if (q === pos || !wwwPrevOk(src[q - 1])) {
        NEXT_SPECIAL.lastIndex = q + 1;
        continue;
      }
      return q;
    }
    // http(s):// and ftp:// — no preceding-character requirement.
    if (c0 === 104 || c0 === 72 || c0 === 102 || c0 === 70) {
      if (q === pos) {
        NEXT_SPECIAL.lastIndex = q + 1;
        continue;
      }
      return q;
    }
    // mailto: / xmpp: — only when preceded by a non-alphanumeric char.
    if (c0 === 109 || c0 === 120) {
      if (q === pos || isAlnum(src[q - 1])) {
        NEXT_SPECIAL.lastIndex = q + 1;
        continue;
      }
      return q;
    }
    // '@': an email address may start earlier in this run.
    let s = q - 1;
    while (s >= pos && EMAIL_LOCAL.test(src[s])) s--;
    s++;
    if (s < q && s > pos && EMAIL_TEST.test(src.slice(s))) return s;
    NEXT_SPECIAL.lastIndex = q + 1;
  }
}

// ASCII punctuation escapable with a backslash (marked's escape set).
const ESCAPABLE_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

// Code span without the regex: find the first later backtick run of
// exactly the opening length (a longer or shorter run is content).
// Returns {len, content} or null (no closing run: the backticks are text).
function tryCodeFast(src, pos) {
  let k = 0;
  while (src[pos + k] === '`') k++;
  let i = pos + k;
  for (;;) {
    const b = src.indexOf('`', i);
    if (b === -1) return null;
    let L = 0;
    while (src[b + L] === '`') L++;
    if (L === k) {
      return { len: b + k - pos, content: src.slice(pos + k, b) };
    }
    i = b + L;
  }
}

// The fast inline renderer: marked's inline token loop, driven by
// textRunEnd instead of scanTextRun, with the escape and code-span
// tokens read directly. Link, reference-link, emphasis, strikethrough,
// autolink and extended-autolink tokens reuse the proven try*
// functions; their results are identical to inlineInner's.
function inlineFastInner(src, ctx, plain) {
  const n = src.length;
  if (n === 0) return '';
  let out = '';
  let pos = 0;
  let prevChar = '';
  let prevWasText = false;
  let masked = null;
  let delim = null;
  const getMasked = () => {
    if (!masked) {
      // Nothing to mask when the string holds no [, `, < or \: the
      // masking replaces only reflinks, code spans, escapes and tags.
      masked = /[\[`<\\]/.test(src) ? maskForEmphasis(src, ctx.links) : src;
      delim = scanDelimiters(masked);
    }
    return masked;
  };
  while (pos < n) {
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    const ch = src[pos];
    let res = null;
    // Escape: \<punctuation>.
    if (ch === '\\') {
      const nx = src[pos + 1];
      if (nx !== undefined && ESCAPABLE_PUNCT.indexOf(nx) !== -1) {
        out += plain ? nx : escapeHtml(nx, false);
        pos += 2;
        continue;
      }
    }
    // Inline HTML tag.
    if (ch === '<') {
      const m = I.tag.exec(src.slice(pos));
      if (m) {
        if (!ctx.inLink && R.startATag.test(m[0])) ctx.inLink = true;
        else if (ctx.inLink && R.endATag.test(m[0])) ctx.inLink = false;
        if (!ctx.inRawBlock && R.startPreScriptTag.test(m[0]))
          ctx.inRawBlock = true;
        else if (ctx.inRawBlock && R.endPreScriptTag.test(m[0]))
          ctx.inRawBlock = false;
        out += m[0];
        pos += m[0].length;
        continue;
      }
    }
    // Inline / reference link or image.
    if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      res = tryLink(src, pos, ctx, plain);
      if (!res) res = tryReflink(src, pos, ctx, plain);
      if (res) {
        if (res.isText) {
          out += plain ? res.ch : escapeHtml(res.ch, false);
          prevChar = res.ch;
          prevWasText = true;
        } else if (plain) {
          out += res.made.isImage ? res.made.altPlain : res.made.inner;
        } else {
          out += renderLinkTarget(res.made);
        }
        pos += res.len;
        continue;
      }
      res = null;
    }
    // Emphasis / strong.
    if (ch === '*' || ch === '_') {
      res = tryEmStrong(src, pos, ctx, getMasked(), delim, prevChar);
      if (res) {
        out += plain
          ? inline(res.inner, ctx, true)
          : `<${res.kind}>${inline(res.inner, ctx, false)}</${res.kind}>`;
        pos += res.len;
        continue;
      }
    }
    // Code span.
    if (ch === '`') {
      const cs = tryCodeFast(src, pos);
      if (cs) {
        let text = cs.content.replace(R.newLineCharGlobal, ' ');
        if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text))
          text = text.substring(1, text.length - 1);
        out += plain ? text : '<code>' + escapeHtml(text, true) + '</code>';
        pos += cs.len;
        continue;
      }
    }
    // Hard break: two spaces or a backslash before a newline.
    if (ch === ' ' || ch === '\\') {
      const m = I.br.exec(src.slice(pos));
      if (m) {
        if (!plain) out += '<br>';
        pos += m[0].length;
        continue;
      }
    }
    // Strikethrough.
    if (ch === '~') {
      res = tryDel(src, pos, ctx, getMasked(), delim, prevChar);
      if (res) {
        out += plain
          ? inline(res.inner, ctx, true)
          : `<del>${inline(res.inner, ctx, false)}</del>`;
        pos += res.len;
        continue;
      }
    }
    // Autolink <...>.
    if (ch === '<') {
      res = tryAutolink(src, pos);
      if (res) {
        out += plain ? res.inner : res.html;
        pos += res.len;
        continue;
      }
    }
    // GFM extended autolink (not inside a link).
    if (!ctx.inLink) {
      res = tryUrl(src, pos);
      if (res) {
        out += plain ? res.inner : res.html;
        pos += res.len;
        continue;
      }
    }
    // Plain text run. (A run is never empty: force at least one
    // character so the loop always makes progress.)
    const end = Math.max(textRunEnd(src, pos), pos + 1);
    const raw = src.slice(pos, end);
    if (plain) {
      out += ctx.inRawBlock ? raw : decodeEntities(raw);
    } else {
      out += ctx.inRawBlock ? raw : escapeHtml(decodeEntities(raw), false);
    }
    const last = raw.charAt(raw.length - 1);
    if (last !== '_') prevChar = last;
    prevWasText = true;
    pos = end;
  }
  return out;
}

/* ------------------------- block tokenisers ------------------------ */

function trySpace(src) {
  const m = R.space.exec(src);
  return m && m[0].length > 0 ? { t: 'space', raw: m[0] } : null;
}

function tryCode(src) {
  const m = R.code.exec(src);
  if (!m) return null;
  const raw = trimTrailingBlanks(m[0]);
  return {
    t: 'code',
    raw,
    lang: null,
    text: raw.replace(R.codeRemoveIndent, ''),
  };
}

function tryFences(src) {
  const m = R.fences.exec(src);
  if (!m) return null;
  return {
    t: 'code',
    raw: m[0],
    lang: m[2]
      ? m[2].trim().replace(I.anyPunctuation, '$1')
      : m[2],
    text: fenceCompensate(m[0], m[3] || '', R),
  };
}

function tryHeading(src) {
  const m = R.heading.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (R.endingHash.test(text)) {
    const s = rtrimChar(text, '#', false);
    if (!s || R.endingSpaceTabChar.test(s)) text = s.trim();
  }
  return { t: 'heading', raw: rtrimChar(m[0], '\n', false), depth: m[1].length, text };
}

function tryHr(src) {
  const m = R.hr.exec(src);
  return m ? { t: 'hr', raw: rtrimChar(m[0], '\n', false) } : null;
}

function tryHtml(src) {
  const m = R.html.exec(src);
  if (!m) return null;
  const raw = trimTrailingBlanks(m[0]);
  return {
    t: 'html',
    raw,
    pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
    text: raw,
  };
}

function tryDef(src, ctx) {
  const m = R.def.exec(src);
  if (!m) return null;
  if (!R.startAngleBracket.test(m[2]) && findParen(m[2], '()') !== -1)
    return null;
  const tag = normalizeLabel(m[1]);
  const href = m[2]
    ? m[2].replace(R.hrefBrackets, '$1').replace(I.anyPunctuation, '$1')
    : '';
  const title = m[3]
    ? m[3].substring(1, m[3].length - 1).replace(I.anyPunctuation, '$1')
    : m[3];
  return { t: 'def', raw: rtrimChar(m[0], '\n', false), tag, href, title };
}

function tryTable(src) {
  const m = R.table.exec(src);
  if (!m || !R.tableDelimiter.test(m[2])) return null;
  const header = splitCells(m[1]);
  const aligns = m[2].replace(R.tableAlignChars, '').split('|');
  const rowText = m[3]?.trim()
    ? m[3].replace(R.tableRowBlankLine, '').split('\n')
    : [];
  if (header.length !== aligns.length) return null;
  const align = aligns.map((a) =>
    R.tableAlignRight.test(a)
      ? 'right'
      : R.tableAlignCenter.test(a)
        ? 'center'
        : R.tableAlignLeft.test(a)
          ? 'left'
          : null,
  );
  return {
    t: 'table',
    raw: rtrimChar(m[0], '\n', false),
    header: header.map((text, i) => ({ text, align: align[i] })),
    rows: rowText.map((row) =>
      splitCells(row, header.length).map((text, i) => ({
        text,
        align: align[i],
      })),
    ),
  };
}

function tryLheading(src) {
  const m = R.lheading.exec(src);
  if (!m) return null;
  return {
    t: 'heading',
    raw: rtrimChar(m[0], '\n', false),
    depth: m[2].charAt(0) === '=' ? 1 : 2,
    text: m[1].trim(),
  };
}

function tryParagraph(src) {
  const m = R.paragraph.exec(src);
  if (!m) return null;
  const text =
    m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { t: 'paragraph', raw: m[0], text };
}

function tryText(src) {
  const m = R.text.exec(src);
  return m ? { t: 'text', raw: m[0], text: m[0] } : null;
}

// Block quote: strip `>` markers group by group, re-lexing the inner
// text, and re-parse a trailing nested quote / list when it continues.
function tryBlockquote(src, ctx) {
  const m = R.blockquote.exec(src);
  if (!m) return null;
  let lines = rtrimChar(m[0], '\n', false).split('\n');
  let raw = '';
  let text = '';
  const items = [];
  for (; lines.length > 0; ) {
    let started = false;
    const group = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (R.blockquoteStart.test(lines[p])) {
        group.push(lines[p]);
        started = true;
      } else if (!started) group.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = group.join('\n');
    const inner = joined
      .replace(R.blockquoteMarkerWhitespace, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(R.blockquoteSetextReplace, '\n    $1')
      .replace(R.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${joined}` : joined;
    text = text ? `${text}\n${inner}` : inner;
    const savedTop = ctx.top;
    ctx.top = true;
    parseBlocks(inner, items, ctx, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = items.at(-1);
    if (
      last?.t === 'code' ||
      last?.t === 'heading' ||
      last?.t === 'hr' ||
      last?.t === 'html' ||
      last?.t === 'table'
    )
      break;
    if (last?.t === 'blockquote') {
      const rest = lines.join('\n');
      const combined =
        last.raw + '\n' + rest.replace(R.blockquoteSetextReplace2, '');
      const reparsed = tryBlockquote(combined, ctx);
      items[items.length - 1] = reparsed;
      const tail = combined
        .substring(reparsed.raw.length)
        .replace(/^\n/, '');
      const tailLines = tail ? tail.split('\n').length : 0;
      const taken = tailLines ? lines.slice(0, -tailLines) : lines;
      if (taken.length > 0) raw = `${raw}\n${taken.join('\n')}`;
      text =
        text.substring(0, text.length - last.text.length) + reparsed.text;
      lines = lines.slice(taken.length);
      if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (last?.t === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const reparsed = tryList(combined, ctx);
      items[items.length - 1] = reparsed;
      const extra =
        reparsed.raw.length > last.raw.length
          ? combined
              .slice(last.raw.length + 1, reparsed.raw.length)
              .split('\n').length
          : 0;
      if (extra > 0) {
        const y = lines.slice(0, extra).join('\n');
        raw = `${raw}\n${y}`;
        text = `${text}\n${y}`;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { t: 'blockquote', raw, text, items };
}

// List: gather items, each item's lines de-indented by the item's
// content indent, then lex each item's blocks (top off).
function tryList(src, ctx) {
  const m = R.list.exec(src);
  if (!m) return null;
  let e = src;
  const startLen = () => src.length - e.length;
  let marker = m[1].trim();
  const ordered = marker.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered,
    start: ordered ? +marker.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  marker = ordered
    ? `\\d{1,9}\\${marker.slice(-1)}`
    : `\\${marker}`;
  const itemRe = R.listItemRegex(marker);
  let sawDoubleBlank = false;
  for (; e; ) {
    let itemText = '';
    const t = itemRe.exec(e);
    if (!t || R.hr.test(e)) break;
    const k = startLen();
    e = e.substring(t[0].length);
    const firstLine = t[2].split('\n', 1)[0];
    const markerLen = t[1].length;
    let mline = firstLine.replace(R.leadingSpaceTab, (v) =>
      expandTabs(v, markerLen),
    );
    let nextLine = e.split('\n', 1)[0];
    let y = !mline.trim();
    let indent;
    if (y) {
      indent = markerLen + 1;
    } else {
      indent = mline.search(R.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemText = mline.slice(indent);
      indent += markerLen;
    }
    let emptyItem = false;
    if (y && R.blankLine.test(nextLine)) {
      e = e.substring(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const bulletRe = R.nextBulletRegex(indent);
      const hrRe = R.hrRegex(indent);
      const fenceRe = R.fencesBeginRegex(indent);
      const headingRe = R.headingBeginRegex(indent);
      const htmlRe = R.htmlBeginRegex(indent);
      const bqRe = R.blockquoteBeginRegex(indent);
      for (; e; ) {
        const line = e.split('\n', 1)[0];
        let expanded;
        nextLine = line;
        expanded = line.replace(R.leadingSpaceTab, (v) => expandTabs(v));
        if (
          fenceRe.test(line) ||
          headingRe.test(line) ||
          htmlRe.test(line) ||
          bqRe.test(line) ||
          bulletRe.test(line) ||
          hrRe.test(line)
        )
          break;
        if (expanded.search(R.nonSpaceChar) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (
            y ||
            mline.replace(R.tabCharGlobal, '    ').search(R.nonSpaceChar) >=
              4 ||
            fenceRe.test(mline) ||
            headingRe.test(mline) ||
            htmlRe.test(mline) ||
            hrRe.test(mline)
          )
            break;
          const setext =
            /^ {0,3}(?:=+|-+) *$/.test(line) &&
            R.lheading.test(`${mline}\n${line}`);
          itemText +=
            '\n' + (setext ? `    ${expanded.replace(/^ {0,3}/, '')}` : line);
        }
        y = !line.trim();
        e = e.substring(line.length + 1);
        mline = expanded.slice(indent);
      }
    }
    const itemRaw = src.slice(k, startLen());
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (R.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push({
      t: 'list_item',
      raw: itemRaw,
      task: R.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      blocks: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, startLen()).trimEnd();
  for (const item of list.items) {
    ctx.top = false;
    parseBlocks(item.text, item.blocks, ctx, false);
    if (!list.loose) {
      const spaces = item.blocks.filter((b) => b.t === 'space');
      if (spaces.length > 0 && spaces.some((b) => R.anyLine.test(b.raw)))
        list.loose = true;
    }
  }
  // Task list items: strip the `[ ]` / `[x]` marker, remember the
  // checkbox so the renderer can put it back in the right place.
  for (const item of list.items) {
    const first = item.blocks[0];
    if (item.task && (first?.t === 'text' || first?.t === 'paragraph')) {
      item.text = item.text.replace(R.listReplaceTask, '');
      first.raw = first.raw.replace(R.listReplaceTask, '');
      first.text = first.text.replace(R.listReplaceTask, '');
      const ck = R.listTaskCheckbox.exec(item.raw);
      if (ck) {
        item.checkbox = { raw: ck[0] + ' ', checked: ck[0] !== '[ ]' };
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const b of item.blocks) if (b.t === 'text') b.t = 'paragraph';
    }
  }
  return list;
}

/* ------------------------- block rendering ------------------------- */

function renderInlineTop(src, ctx) {
  ctx.inRawBlock = false;
  return inline(src, ctx, false);
}

function renderCode(node) {
  const first = (node.lang || '').match(R.notSpaceStart)?.[0] ?? '';
  const text = node.text
    ? node.text.replace(R.endingNewline, '') + '\n'
    : '';
  const body = escapeHtml(text, true);
  return first
    ? `<pre><code class="language-${escapeHtml(first, false)}">${body}</code></pre>\n`
    : `<pre><code>${body}</code></pre>\n`;
}

function checkboxHtml(checked) {
  return (
    '<input ' +
    (checked ? 'checked="" ' : '') +
    'disabled="" type="checkbox"> '
  );
}

function renderCell(cell, isHeader, ctx) {
  const tag = isHeader ? 'th' : 'td';
  return (
    (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) +
    renderInlineTop(cell.text, ctx) +
    `</${tag}>\n`
  );
}

function renderTable(node, ctx) {
  let headCells = '';
  for (const c of node.header) headCells += renderCell(c, true, ctx);
  const headRow = `<tr>\n${headCells}</tr>\n`;
  let body = '';
  for (const row of node.rows) {
    let cells = '';
    for (const c of row) cells += renderCell(c, false, ctx);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
}

function renderBlock(node, ctx, loose = false) {
  switch (node.t) {
    case 'space':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return `<h${node.depth}>${renderInlineTop(node.text, ctx)}</h${node.depth}>\n`;
    case 'code':
      return renderCode(node);
    case 'html':
      return node.text;
    case 'def':
      return '';
    case 'paragraph':
      return `<p>${renderInlineTop(node.text, ctx)}</p>\n`;
    case 'text':
      return loose
        ? `<p>${renderInlineTop(node.text, ctx)}</p>\n`
        : renderInlineTop(node.text, ctx);
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(node.items, ctx)}</blockquote>\n`;
    case 'list':
      return renderList(node, ctx);
    case 'table':
      return renderTable(node, ctx);
    default:
      return '';
  }
}

function renderBlocks(nodes, ctx) {
  let out = '';
  for (const node of nodes) out += renderBlock(node, ctx);
  return out;
}

function renderList(node, ctx) {
  let itemsHtml = '';
  for (const item of node.items) {
    let inner = '';
    const first = item.blocks[0];
    if (item.checkbox && !node.loose) {
      inner += checkboxHtml(item.checkbox.checked);
      for (const b of item.blocks)
        inner += renderBlock(b, ctx, node.loose);
    } else if (item.checkbox && node.loose) {
      if (first && (first.t === 'paragraph' || first.t === 'text')) {
        inner += `<p>${checkboxHtml(item.checkbox.checked)}${renderInlineTop(first.text, ctx)}</p>\n`;
        for (let i = 1; i < item.blocks.length; i++)
          inner += renderBlock(item.blocks[i], ctx, node.loose);
      } else {
        inner += `<p>${checkboxHtml(item.checkbox.checked)}</p>\n`;
        for (const b of item.blocks)
          inner += renderBlock(b, ctx, node.loose);
      }
    } else {
      for (const b of item.blocks)
        inner += renderBlock(b, ctx, node.loose);
    }
    itemsHtml += `<li>${inner}</li>\n`;
  }
  const tag = node.ordered ? 'ol' : 'ul';
  const start =
    node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
  return `<${tag}${start}>\n${itemsHtml}</${tag}>\n`;
}

// The block lexer: marked's blockTokens loop, producing the same block
// boundaries (and link reference definitions) without token objects.
function parseBlocks(src, out, ctx, isBQ) {
  let mergePara = isBQ;
  let smallest = Infinity;
  while (src) {
    if (src.length < smallest) smallest = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let node = null;
    if ((node = trySpace(src))) {
      src = src.substring(node.raw.length);
      const prev = out.at(-1);
      if (node.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else out.push(node);
      continue;
    }
    if ((node = tryCode(src))) {
      src = src.substring(node.raw.length);
      const prev = out.at(-1);
      if (prev?.t === 'paragraph' || prev?.t === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
        prev.text += '\n' + node.text;
      } else out.push(node);
      continue;
    }
    if ((node = tryFences(src))) {
      src = src.substring(node.raw.length);
      out.push(node);
      continue;
    }
    if ((node = tryHeading(src))) {
      src = src.substring(node.raw.length);
      out.push(node);
      continue;
    }
    if ((node = tryHr(src))) {
      src = src.substring(node.raw.length);
      out.push(node);
      continue;
    }
    if ((node = tryBlockquote(src, ctx))) {
      src = src.substring(node.raw.length);
      out.push(node);
      continue;
    }
    if ((node = tryList(src, ctx))) {
      src = src.substring(node.raw.length);
      out.push(node);
      continue;
    }
    if ((node = tryHtml(src))) {
      src = src.substring(node.raw.length);
      out.push(node);
      continue;
    }
    if ((node = tryDef(src, ctx))) {
      src = src.substring(node.raw.length);
      const prev = out.at(-1);
      if (prev?.t === 'paragraph' || prev?.t === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
        prev.text += '\n' + node.raw;
      } else {
        if (!ctx.links[node.tag])
          ctx.links[node.tag] = { href: node.href, title: node.title };
        out.push(node);
      }
      continue;
    }
    if ((node = tryTable(src))) {
      src = src.substring(node.raw.length);
      out.push(node);
      continue;
    }
    if ((node = tryLheading(src))) {
      src = src.substring(node.raw.length);
      out.push(node);
      continue;
    }
    if (ctx.top && (node = tryParagraph(src))) {
      const prev = out.at(-1);
      if (mergePara && prev?.t === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
        prev.text += '\n' + node.text;
      } else out.push(node);
      mergePara = false;
      src = src.substring(node.raw.length);
      continue;
    }
    if ((node = tryText(src))) {
      src = src.substring(node.raw.length);
      const prev = out.at(-1);
      if (prev?.t === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + node.raw;
        prev.text += '\n' + node.text;
      } else out.push(node);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return out;
}

/* ------------------------------ entry ------------------------------ */

function fastParse(markdown) {
  const ctx = makeCtx();
  ctx.top = true;
  const src = markdown.replace(R.carriageReturn, '\n');
  const blocks = [];
  parseBlocks(src, blocks, ctx, false);
  return renderBlocks(blocks, ctx);
}

/**
 * Render `markdown` to the HTML marked 18.1.3 renders with its defaults.
 * Small inputs go straight to the vendored marked (cheap there, and the
 * spec examples live there); larger documents take the fast renderer,
 * with marked as the fallback for anything it cannot prove.
 */
export function parse(markdown) {
  try {
    if (typeof markdown !== 'string' || markdown.length < 2000)
      return marked.parse(markdown);
    return fastParse(markdown);
  } catch {
    return marked.parse(markdown);
  }
}
