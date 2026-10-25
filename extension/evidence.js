/* Rouge Autofill — upload evidence helpers.
 * Plain functions shared by content.js, background.js and the Node tests; no browser APIs here.
 * Every input is page text, so it is treated as untrusted data and only ever parsed, never executed.
 */
(function (root) {
  'use strict';

  const FACTOR = { kb: 1e3, kib: 1024, mb: 1e6, mib: 1048576, gb: 1e9, gib: 1073741824 };

  // "10 MB", "2.5MB", "1,000 KB". A decimal comma ("2,5 MB") is ambiguous, so the lookbehind refuses it.
  const SIZE_RE = /(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(KB|KiB|MB|MiB|GB|GiB)\b/gi;

  // Words that make the size next to them a limit rather than a file's own size.
  const LIMIT_BEFORE = /(?:\bmax(?:imum)?\b\.?(?:\s+(?:file|upload))?(?:\s+size)?(?:\s+per\s+file)?(?:\s+(?:of|is|allowed))?|\blimit(?:\s+(?:of|is))?|\bup\s+to|\bunder|\bbelow|\bless\s+than|\bsmaller\s+than|\bno\s+(?:larger|bigger|more)\s+than|\bat\s+most|\bnot\s+(?:exceed|be\s+(?:more|larger|bigger)\s+than)|\bexceeds?|\bexceeding|\bover|\b(?:larger|bigger|greater)\s+than)\s*(?:the\s+)?[:(]?\s*$/i;
  const LIMIT_AFTER = /^\s*(?:\)|\.)?\s*(?:max(?:imum)?\b|limit\b|or\s+less|or\s+smaller|per\s+file)/i;

  // Wording of a rejection. "strong" is rejection language on its own; "weak" only means something
  // right after a PDF was chosen (a generic failure, or help text that names the size limit).
  const STRONG = [
    /\btoo\s+(?:large|big)\b/i,
    /\bexceed(?:s|ed|ing)?\b[^.]{0,60}\b(?:size|limit|maximum|max|allowed)\b/i,
    /\b(?:size|limit|maximum|allowed)\b[^.]{0,40}\bexceed(?:s|ed)?\b/i,
    /\b(?:larger|bigger|greater)\s+than\b[^.]{0,40}\b(?:allowed|limit|maximum|max|\d+\s*(?:KB|MB|GB|KiB|MiB|GiB))/i,
    /\bover\s+the\s+(?:file\s+)?(?:size\s+)?(?:limit|max)/i,
    /\bmust\s+be\s+(?:less|smaller|under|below|no\s+(?:larger|bigger|more))\b[^.]{0,30}\d+\s*(?:KB|MB|GB|KiB|MiB|GiB)\b/i,
    /\bfile\s+size\s+(?:limit\s+)?(?:exceeded|is\s+too)/i,
  ];
  const WEAK = [
    /\bupload\s+(?:failed|error)\b/i,
    /\b(?:failed|unable|couldn.?t|can.?t|cannot)\s+(?:to\s+)?upload\b/i,
    /\bcould\s+not\s+(?:be\s+)?upload/i,
    /\bmaximum\s+(?:file\s+)?size\b/i,
    /\bfile\s+size\s+limit\b/i,
    /\b(?:not\s+allowed|isn.?t\s+allowed)\b/i,
    /\b(?:file|size)\b[^.]{0,30}\b(?:limit|too|exceed|large|big)\b/i,
  ];

  const MAX_TEXT = 400;

  function sizesIn(text) {
    const out = [];
    SIZE_RE.lastIndex = 0;
    let m;
    while ((m = SIZE_RE.exec(String(text || ''))) !== null) {
      const bytes = Math.round(parseFloat(m[1].replace(/,/g, '')) * FACTOR[m[2].toLowerCase()]);
      if (Number.isFinite(bytes) && bytes > 0) out.push({ bytes, index: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  /** Is the size at `hit` described as a limit ("max 10 MB", "under 5 MB", "10 MB limit")? */
  function isLimit(text, hit) {
    return LIMIT_BEFORE.test(text.slice(Math.max(0, hit.index - 48), hit.index)) || LIMIT_AFTER.test(text.slice(hit.end, hit.end + 24));
  }

  /**
   * The size limit a message states, in bytes, or null. A lone size counts; when a message
   * holds several ("your 12 MB file exceeds the 10 MB limit"), only the one worded as a limit does.
   */
  function parseLimitBytes(text) {
    const s = String(text || '');
    const sizes = sizesIn(s);
    if (!sizes.length) return null;
    const limits = sizes.filter((h) => isLimit(s, h));
    if (limits.length) return Math.min(...limits.map((h) => h.bytes));
    return sizes.length === 1 ? sizes[0].bytes : null;
  }

  /** Every distinct limit-worded size in a block of page text ("Upload 1 supported file. Max 10 MB."). */
  function limitHints(text) {
    const s = String(text || '').slice(0, 20000);
    const found = new Set();
    for (const h of sizesIn(s)) if (isLimit(s, h)) found.add(h.bytes);
    return [...found].sort((a, b) => a - b);
  }

  /** 'strong' | 'weak' | null for one short piece of page text. */
  function classify(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length < 5 || s.length > MAX_TEXT) return null;
    if (STRONG.some((re) => re.test(s))) return 'strong';
    if (WEAK.some((re) => re.test(s))) return 'weak';
    return null;
  }

  /** A .pdf name quoted or bare in a message, or null. */
  function pdfNameIn(text) {
    const m = /(?:["'“‘]([^"'”’\\/:*?<>|\r\n]{1,200}\.pdf)["'”’]|(\S{1,200}\.pdf))/i.exec(String(text || ''));
    return m ? (m[1] || m[2]).replace(/^[("'[]+/, '') : null;
  }

  /**
   * Decide whether the evidence shows a PDF the page will not take.
   * @param {{name:string, size:number, at:number}|null} picked  the PDF the user chose
   * @param {{text:string, strength:'strong'|'weak', at:number, upload?:boolean}[]} errors  messages seen on the page
   * @param {number[]} hints  limits the page announces (all frames)
   * @returns {{limitBytes:number|null, errorText:string, why:'error'|'size'}|null}
   */
  function decide(picked, errors, hints) {
    const list = errors || [];
    const single = hints && hints.length === 1 ? hints[0] : null;
    if (picked) {
      const after = list.filter((e) => e.at >= picked.at - 1500);
      // The limit: the one a message states (strong wording wins), else the single one the page announces.
      let stated = null;
      let said = '';
      for (const e of after) {
        const l = parseLimitBytes(e.text);
        if (l && (stated === null || e.strength === 'strong')) { stated = l; said = e.text; }
      }
      const limit = stated || single;
      if (limit && picked.size <= limit) return null;   // it fits, so whatever was said is about something else
      const strong = after.find((e) => e.strength === 'strong');
      if (strong) return { limitBytes: limit, errorText: said || strong.text, why: 'error' };
      if (!limit) return null;
      if (single && picked.size > single) return { limitBytes: limit, errorText: said, why: 'size' };
      if (after.length) return { limitBytes: limit, errorText: after[0].text, why: 'error' };
      return null;
    }
    // Nothing was seen being chosen (a drag from another window, an unusual widget): only an upload
    // widget's explicit message that states its own limit is enough, and Rouge asks for the file.
    const own = list.find((e) => e.upload && e.strength === 'strong' && parseLimitBytes(e.text));
    return own ? { limitBytes: parseLimitBytes(own.text), errorText: own.text, why: 'error' } : null;
  }

  const api = { sizesIn, parseLimitBytes, limitHints, classify, pdfNameIn, decide, MAX_TEXT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RougeEvidence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
