/* Small syntax highlighter: one tokenizer, a rule set per language family. Output is escaped HTML. */
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

  const JS = set('async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield null undefined true false NaN Infinity interface type enum implements public private protected readonly as namespace declare abstract keyof satisfies module require');
  const PY = set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self cls match case print');
  const SH = set('if then else elif fi for while until do done case esac in function select time return exit break continue local export readonly declare unset source alias echo cd ls cat grep sed awk npm npx git curl wget sudo mkdir rm cp mv chmod pip python node docker');
  const SQL = set('select from where and or not insert into values update set delete create table drop alter add column index primary key foreign references join left right inner outer full cross on group by order having limit offset as distinct union all null is in like between exists case when then else end count sum avg min max with view default unique check constraint begin commit rollback');
  const GO = set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false string int int64 float64 bool byte error');
  const RS = set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err String Vec Option Result Box');
  const JAVA = set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while null true false var record String');
  const C = set('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override new delete this nullptr true false bool using std string vector include define ifdef ifndef endif');
  const CS = set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record');
  const PHP = set('abstract and array as break case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include include_once instanceof interface isset list match namespace new or print private protected public require require_once return static switch throw trait try unset use var while yield null true false');
  const RB = set('alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts require attr_accessor');
  const SWIFT = set('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self throw throws true try async await');
  const KT = set('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam value where abstract actual annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg');
  const YAML = set('true false null yes no on off');
  const JSONK = set('true false null');

  const LANGS = {
    js: { kw: JS, line: '//', block: true, tpl: true, ty: true },
    py: { kw: PY, line: '#', triple: true, ty: true },
    sh: { kw: SH, line: '#', vars: true, flags: true },
    sql: { kw: SQL, line: '--', block: true, ci: true },
    go: { kw: GO, line: '//', block: true, tpl: true, ty: true },
    rs: { kw: RS, line: '//', block: true, ty: true },
    java: { kw: JAVA, line: '//', block: true, ty: true },
    c: { kw: C, line: '//', block: true, ty: true, pre: true },
    cs: { kw: CS, line: '//', block: true, ty: true },
    php: { kw: PHP, line: '//', hash: true, block: true, vars: true, ty: true },
    rb: { kw: RB, line: '#', ty: true },
    swift: { kw: SWIFT, line: '//', block: true, ty: true },
    kt: { kw: KT, line: '//', block: true, ty: true },
    yaml: { kw: YAML, line: '#', keys: true },
    toml: { kw: YAML, line: '#', keys: true },
    json: { kw: JSONK, json: true },
    css: { css: true },
    html: { html: true },
    plain: {},
  };
  const ALIAS = {
    js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', node: 'js',
    py: 'py', python: 'py', python3: 'py', ipynb: 'py',
    sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', terminal: 'sh', fish: 'sh',
    sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
    go: 'go', golang: 'go', rs: 'rs', rust: 'rs', java: 'java',
    c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c', 'c++': 'c', objc: 'c',
    cs: 'cs', csharp: 'cs', 'c#': 'cs', php: 'php', rb: 'rb', ruby: 'rb', swift: 'swift', kt: 'kt', kotlin: 'kt',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'toml', env: 'toml',
    json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json',
    css: 'css', scss: 'css', less: 'css', sass: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', xhtml: 'html', rss: 'html',
  };
  const norm = (l) => ALIAS[String(l || '').toLowerCase().replace(/^\./, '')] || 'plain';

  const sp = (c, t) => `<span class="t-${c}">${esc(t)}</span>`;

  const cache = {};
  function engine(k) {
    if (cache[k]) return cache[k];
    const spec = LANGS[k], parts = [];
    const add = (c, src) => parts.push([c, src]);
    if (spec.triple) add('s', '"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)');
    if (spec.block) add('c', '/\\*[\\s\\S]*?(?:\\*/|$)');
    if (spec.line) add('c', spec.line + '[^\\n]*');
    if (spec.hash) add('c', '#[^\\n]*');
    if (spec.pre) add('m', '^[ \\t]*#[ \\t]*\\w+');
    if (spec.tpl) add('s', '`(?:\\\\[\\s\\S]|[^`\\\\])*`?');
    add('s', '"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?');
    if (spec.vars) add('a', '\\$\\{?[A-Za-z_]\\w*\\}?|\\$[0-9@#?*]');
    if (spec.flags) add('n', '(?<=\\s)--?[A-Za-z][\\w-]*');
    add('n', '\\b0[xX][\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b');
    add('i', '[A-Za-z_$][\\w$]*');
    return (cache[k] = { re: new RegExp(parts.map((p) => '(' + p[1] + ')').join('|'), 'gm'), cls: parts.map((p) => p[0]), spec });
  }

  function code(src, k) {
    const { re, cls, spec } = engine(k); re.lastIndex = 0;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(src.slice(last, m.index)); last = m.index + m[0].length;
      let gi = 1; while (gi < m.length && m[gi] === undefined) gi++;
      let c = cls[gi - 1]; const t = m[0];
      if (c === 'i') {
        const w = spec.ci ? t.toLowerCase() : t;
        if (spec.kw.has(w)) c = 'k';
        else if (src[last] === '(' ) c = 'f';
        else if (spec.ty && /^[A-Z][A-Za-z0-9_]*$/.test(t) && t.length > 1) c = 't';
        else { out += esc(t); continue; }
      }
      if (c === 's' && spec.keys && /^\s*:/.test(src.slice(last, last + 4))) c = 'a';
      if (c === 's' && spec.json && /^\s*:/.test(src.slice(last, last + 6))) c = 'a';
      out += sp(c, t);
    }
    out += esc(src.slice(last));
    if (spec.keys) out = out.replace(/^(\s*-?\s*)([A-Za-z_][\w.-]*)(?=:)/gm, '$1<span class="t-a">$2</span>');
    return out;
  }

  function css(src) {
    const re = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(@[\w-]+)|(#[\da-fA-F]{3,8}\b)|(-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|pt)?\b)|(--[\w-]+|[A-Za-z-]+(?=\s*:(?!:)))|(\.[\w-]+|#[\w-]+|:{1,2}[A-Za-z][\w-]*)|([{}])/g;
    let out = '', last = 0, m, depth = 0;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index)); last = m.index + m[0].length; const t = m[0];
      if (m[1]) out += sp('c', t);
      else if (m[2]) out += sp('s', t);
      else if (m[3]) out += sp('k', t);
      else if (m[4] || m[5]) out += depth > 0 ? sp('n', t) : esc(t);
      else if (m[6]) out += depth > 0 ? sp('a', t) : esc(t);
      else if (m[7]) out += depth > 0 ? esc(t) : sp('t', t);
      else { depth += t === '{' ? 1 : -1; if (depth < 0) depth = 0; out += esc(t); }
    }
    return out + esc(src.slice(last));
  }

  function html(src) {
    let out = '', i = 0;
    const re = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<\/?[A-Za-z][^>]*>?|<![A-Za-z][^>]*>?|<\?[\s\S]*?(?:\?>|$)/g;
    let m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(i, m.index)); i = m.index + m[0].length; const t = m[0];
      if (t.startsWith('<!--')) out += sp('c', t);
      else if (m[1]) {
        const open = t.match(/^<[^>]*>/)[0], rest = t.slice(open.length), ci = rest.search(/<\/(script|style)\s*>/i);
        const body = ci < 0 ? rest : rest.slice(0, ci), tail = ci < 0 ? '' : rest.slice(ci);
        out += tag(open) + (m[1] === 'style' ? css(body) : code(body, 'js')) + (tail ? tag(tail) : '');
      } else out += tag(t);
    }
    return out + esc(src.slice(i));
  }
  function tag(t) {
    const m = t.match(/^(<\/?)([^\s>/]+)([\s\S]*?)(\/?>?)$/); if (!m) return esc(t);
    const attrs = esc(m[3]).replace(/([\w:@.-]+)(=)?(&quot;[^&]*&quot;|"[^"]*"|'[^']*')?/g, (a, n, eq, v) => {
      if (!n) return a;
      return '<span class="t-a">' + n + '</span>' + (eq ? '=' : '') + (v ? '<span class="t-s">' + v + '</span>' : '');
    });
    return '<span class="t-p">' + esc(m[1]) + '</span><span class="t-t">' + esc(m[2]) + '</span>' + attrs + '<span class="t-p">' + esc(m[4]) + '</span>';
  }

  /* highlight a string; lines:true wraps each line in <span class="l"> (for a line-number gutter). */
  function render(src, lang, opt) {
    const k = norm(lang);
    let h;
    if (!src || src.length > 120000 || k === 'plain') h = esc(src || '');
    else { try { h = k === 'html' ? html(src) : k === 'css' ? css(src) : code(src, k); } catch { h = esc(src); } }
    if (!(opt && opt.lines)) return h;
    // split on newlines but keep spans balanced across lines
    const rows = h.split('\n'), stack = []; let o = '';
    rows.forEach((row, idx) => {
      let line = stack.join('') + row;
      const re = /<span class="([^"]+)">|<\/span>/g; let mm;
      while ((mm = re.exec(row))) { if (mm[0] === '</span>') stack.pop(); else stack.push(mm[0]); }
      line += '</span>'.repeat(stack.length);
      o += '<span class="l">' + line + '</span>' + (idx < rows.length - 1 ? '\n' : '');
    });
    return o;
  }
  window.HL = { html: render, norm };
})();
