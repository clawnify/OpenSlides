// Builds a self-contained reveal.js HTML document from a deck. A deck is one
// document split into slides on a line of `---`. Every slide is a designed HTML
// slide (markdown is not supported). A slide may begin with an optional
// `<!-- .slide: ATTRS -->` line that sets reveal slide attributes (e.g.
// data-background-image) on the <section>; a leading legacy `<!-- html -->`
// marker is tolerated and stripped.
//
// Two modes:
//   "view"  — interactive deck (editor preview + in-app fullscreen present).
//   "print" — print-pdf layout (one slide per page) for PDF export.
//
// `content` must already have its media references resolved by the caller
// (view: /api/uploads/<key>; print: inlined data: URIs). Brand markup is
// injected via brandHeadHtml (<head>) and brandLogoHtml (per-page overlay).

const REVEAL = "https://cdn.jsdelivr.net/npm/reveal.js@5.1.0";

import { printScale, type PageFormat } from "./formats";

// Deterministic, dependency-free SVG charts. A slide includes a chart with:
//   <div class="chart" style="height:..." data-chart='{"type":"bar","labels":[...],"data":[...]}'></div>
// This script computes & draws an on-brand SVG (bar / line / donut) into it,
// picking up the brand accent/muted colors. SVG renders identically in the
// canvas, while presenting, and in the exported PDF.
export const CHART_FNS = `
  function _bv(n,f){var v=getComputedStyle(document.documentElement).getPropertyValue(n).trim();return v||f;}
  function _arc(cx,cy,r,ir,a0,a1,fill){
    function p(rad,a){return [cx+rad*Math.cos(a),cy+rad*Math.sin(a)];}
    var lg=(a1-a0)>Math.PI?1:0,o0=p(r,a0),o1=p(r,a1),i1=p(ir,a1),i0=p(ir,a0);
    return '<path d="M'+o0[0]+' '+o0[1]+' A'+r+' '+r+' 0 '+lg+' 1 '+o1[0]+' '+o1[1]+' L'+i1[0]+' '+i1[1]+' A'+ir+' '+ir+' 0 '+lg+' 0 '+i0[0]+' '+i0[1]+' Z" fill="'+fill+'"/>';
  }
  function renderCharts(root){
    var nodes=(root||document).querySelectorAll('[data-chart]:not([data-charted])');
    for(var k=0;k<nodes.length;k++){(function(el){
      el.setAttribute('data-charted','1');
      var cfg; try{cfg=JSON.parse(el.getAttribute('data-chart'));}catch(e){return;}
      var w=el.clientWidth||640,h=el.clientHeight||340;
      var accent=_bv('--brand-accent','#6D4CFF'),muted=_bv('--brand-muted','#9a9a9a'),text=_bv('--brand-text','#333');
      var type=cfg.type||'bar',labels=cfg.labels||[],data=(cfg.data||[]).map(Number);
      var s='<svg width="100%" height="100%" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">';
      var pL=44,pB=30,pT=12,pR=12,cw=w-pL-pR,ch=h-pT-pB,max=Math.max.apply(null,data.concat([1]));
      if(type==='bar'){
        var n=data.length||1,step=cw/n,bw=step*0.62;
        for(var i=0;i<data.length;i++){var bh=ch*(data[i]/max),x=pL+i*step+(step-bw)/2,y=pT+ch-bh;
          s+='<rect x="'+x+'" y="'+y+'" width="'+bw+'" height="'+Math.max(bh,1)+'" rx="3" fill="'+accent+'"/>';
          s+='<text x="'+(x+bw/2)+'" y="'+(h-10)+'" fill="'+muted+'" font-size="13" text-anchor="middle">'+(labels[i]||'')+'</text>';}
      } else if(type==='line'){
        var n=data.length,pts=[];for(var i=0;i<n;i++){pts.push([pL+(n<=1?cw/2:i*(cw/(n-1))),pT+ch-ch*(data[i]/max)]);}
        var d='';for(var i=0;i<pts.length;i++){d+=(i?'L':'M')+pts[i][0]+' '+pts[i][1]+' ';}
        s+='<path d="'+d+'" fill="none" stroke="'+accent+'" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';
        for(var i=0;i<pts.length;i++){s+='<circle cx="'+pts[i][0]+'" cy="'+pts[i][1]+'" r="4" fill="'+accent+'"/>';
          s+='<text x="'+pts[i][0]+'" y="'+(h-10)+'" fill="'+muted+'" font-size="13" text-anchor="middle">'+(labels[i]||'')+'</text>';}
      } else if(type==='donut'||type==='pie'){
        var total=0;for(var i=0;i<data.length;i++)total+=data[i];total=total||1;
        var cx=w/2,cy=(h-14)/2+pT,r=Math.min(cw,ch)/2,ir=type==='donut'?r*0.62:0,a0=-Math.PI/2;
        var pal=[accent,muted,text,'#cfcfcf','#e6e6e6'];
        for(var i=0;i<data.length;i++){var a1=a0+2*Math.PI*(data[i]/total);s+=_arc(cx,cy,r,ir,a0,a1,pal[i%pal.length]);a0=a1;}
      }
      s+='</svg>';el.innerHTML=s;
    })(nodes[k]);}
  }`;

export const THEMES = [
  "white", "black", "league", "beige", "sky", "night",
  "serif", "simple", "solarized", "moon", "dracula", "blood",
] as const;

export function safeTheme(theme: string | undefined): string {
  return (THEMES as readonly string[]).includes(theme ?? "") ? (theme as string) : "white";
}

/** Split a deck document into its slide chunks (on lines of `---`). */
export function splitSlides(content: string): string[] {
  const normalized = ("\n" + content + "\n").replace(/\r\n/g, "\n");
  return normalized
    .split(/\n[ \t]*---[ \t]*\n/)
    .map((raw) => raw.replace(/^\n+|\n+$/g, ""))
    .filter((c) => c.trim());
}

function buildSections(content: string, only?: number): string {
  let chunks = splitSlides(content);
  if (only != null && only >= 0 && only < chunks.length) chunks = [chunks[only]];
  const sections: string[] = [];

  for (const chunk of chunks) {
    // Every slide is a designed HTML slide. The legacy `<!-- html -->` marker is
    // optional now; strip it plus an optional `<!-- .slide: ATTRS -->` line that
    // sets reveal slide attributes (e.g. data-background-image) on the <section>.
    let rest = chunk.trim().replace(/^<!--\s*html\s*-->\s*\n?/i, "");
    let attrs = "";
    const attrMatch = rest.match(/^<!--\s*\.slide:\s*([\s\S]*?)-->\s*\n?/i);
    if (attrMatch) {
      attrs = " " + attrMatch[1].trim();
      rest = rest.slice(attrMatch[0].length);
    }
    sections.push(`<section class="design"${attrs}>\n${rest}\n</section>`);
  }

  return sections.join("\n") || `<section class="design"><h2>Empty deck</h2></section>`;
}

interface DocOpts {
  mode: "view" | "print";
  content: string;
  theme: string;
  format: PageFormat; // canvas + physical page size (16:9 deck / A4 document)
  brandHeadHtml: string;
  brandLogoHtml: string;
  h?: number;
  v?: number;
  only?: number; // render just this slide (for Pages thumbnails)
  thumb?: boolean; // chrome-less, non-interactive (thumbnail)
  // Pagination is a single mutually-exclusive mode:
  //   dots    — centered dots paginator (present-only)
  //   arrows  — arrow controls + progress bar (present-only)
  //   numbers — page numbers c/t (shown in editor, present, and PDF)
  //   none    — no pagination chrome
  nav?: { mode: "dots" | "arrows" | "numbers" | "none" };
}

// Deterministic PDF document: every slide is a fixed canvas-sized block inside a
// physical-page-sized wrapper, paginated purely by CSS. We deliberately do NOT
// use reveal's print-pdf mode — its layout scales to the render viewport and
// re-lays-out at page.pdf() time, which makes Cloudflare's renderer overflow the
// page and surface stray speaker-notes. Here layout is fixed: slides are
// authored at the format's canvas size and (for formats whose physical page
// differs, e.g. A4) shrunk onto the page with one transform. preferCSSPageSize +
// the @page rule give exact pages.
function buildPrintDoc(opts: DocOpts): string {
  const f = opts.format;
  const scale = printScale(f);
  const showNum = opts.nav?.mode === "numbers";
  const chunks = splitSlides(opts.content);
  const total = chunks.length;
  const clean = (s: string) => s.replace(/["<>]/g, "");
  const slides =
    chunks
      .map((chunk, i) => {
        let rest = chunk.trim().replace(/^<!--\s*html\s*-->\s*\n?/i, "");
        let bg = "";
        const m = rest.match(/^<!--\s*\.slide:\s*([\s\S]*?)-->\s*\n?/i);
        if (m) {
          rest = rest.slice(m[0].length);
          const col = m[1].match(/data-background-color="([^"]*)"/i);
          const grad = m[1].match(/data-background-gradient="([^"]*)"/i);
          const img = m[1].match(/data-background-image="([^"]*)"/i);
          if (col) bg += `background:${clean(col[1])};`;
          if (grad) bg += `background:${clean(grad[1])};`;
          if (img) bg += `background-image:url("${clean(img[1])}");background-size:cover;background-position:center;`;
        }
        const num = showNum ? `<div class="pdf-num">${i + 1} / ${total}</div>` : "";
        return `<div class="pdf-page"><div class="pdf-slide" style="${bg}">\n${rest}\n${num}\n</div></div>`;
      })
      .join("\n") || `<div class="pdf-page"><div class="pdf-slide"></div></div>`;

  return `<!doctype html><html><head><meta charset="utf-8" />
<link rel="stylesheet" href="${REVEAL}/plugin/highlight/monokai.css" />
<style>
  @page { size: ${f.pageSizeCss}; margin: 0; }
  html,body{ margin:0; padding:0; }
  body{ background: var(--brand-bg, #fff); color: var(--r-main-color, #111); font-family: var(--r-main-font, -apple-system, sans-serif); }
  /* One physical page per slide; the canvas-sized slide box is scaled onto it. */
  .pdf-page{ position: relative; width: ${f.page.width}px; height: ${f.page.height}px; overflow: hidden; background: var(--brand-bg, #fff); break-after: page; page-break-after: always; }
  /* Content (often position:absolute;inset:0) fills the authoring canvas. */
  .pdf-slide{ position: relative; width: ${f.canvas.width}px; height: ${f.canvas.height}px; overflow: hidden; box-sizing: border-box; background: var(--brand-bg, #fff);${scale !== 1 ? ` transform: scale(${scale}); transform-origin: top left;` : ""} }
  /* Brand defaults (a guideline, not forced): alignment + type scale. Inline
     per-slide styles win, so a slide can deviate. */
  .pdf-slide > div{ text-align: var(--brand-align, left); align-items: var(--brand-justify, flex-start); }
  .pdf-slide h1{ font-size: var(--brand-heading-size); }
  .pdf-slide h2{ font-size: var(--brand-subheading-size); }
  .pdf-slide h3{ font-size: calc(var(--brand-subheading-size) * 0.82); }
  .pdf-slide :is(p, li, blockquote, td, th, figcaption){ font-size: var(--brand-body-size); }
  .pdf-slide .infographic{ flex: 0 1 auto !important; min-height: 0; }
  .pdf-slide .infographic svg{ font-family: var(--r-main-font); }
  .pdf-page:last-child{ break-after: auto; page-break-after: avoid; }
  .pdf-num{ position: absolute; bottom: 22px; right: 28px; font: 500 18px/1 var(--r-main-font); color: var(--brand-muted, #999); }
  /* Speaker notes are presenter-only; never print them (reveal hides them in the
     editor/view, but this doc doesn't load reveal core CSS). */
  aside.notes, .notes{ display: none !important; }
  /* Brand helpers are scoped to .reveal in brandHead; redeclare unscoped here. */
  .muted{ color: var(--brand-muted); }
  .accent{ color: var(--brand-accent); }
  .kicker{ font: 600 0.42em/1 var(--r-heading-font); letter-spacing: 0.18em; text-transform: uppercase; color: var(--brand-accent); }
</style>
${opts.brandHeadHtml}
</head><body>
${opts.brandLogoHtml}
${slides}
<script src="${REVEAL}/plugin/highlight/highlight.js"></script>
<script>${CHART_FNS}</script>
<script>
  try { if (window.hljs) document.querySelectorAll('pre code').forEach(function (b) { hljs.highlightElement(b); }); } catch (e) {}
  renderCharts(document);
</script>
</body></html>`;
}

export function revealViewScript(opts: Pick<DocOpts, "format" | "thumb" | "nav">): string {
  // Fixed design canvas (the deck format's size). center:false — designed slides
  // position their own content (absolute / flex) inside the canvas, so reveal
  // must not re-center. fragments:false so animated elements are always visible
  // in the editor and thumbnails; the view harness turns fragments on only while
  // presenting.
  const SIZING = `width: ${opts.format.canvas.width}, height: ${opts.format.canvas.height}, margin: 0, center: false,`;

  const harness =
    opts.thumb
      ? `Reveal.initialize({
           plugins: [RevealHighlight],
           ${SIZING}
           fragments: false,
           controls: false, progress: false, embedded: false, transition: 'none',
           minScale: 0.05, maxScale: 1,
         }).then(function () { renderCharts(document); });`
      : `var params = new URLSearchParams(location.search);
         var NAV_MODE = ${JSON.stringify(opts.nav?.mode ?? "dots")};
         var NAV = { arrows: NAV_MODE === 'arrows', progress: NAV_MODE === 'arrows', dots: NAV_MODE === 'dots' };
         Reveal.initialize({
           plugins: [RevealHighlight, RevealNotes],
           ${SIZING}
           fragments: false,
           embedded: false,
           controls: false,
           progress: false,
           hash: false,
           slideNumber: ${opts.nav?.mode === "numbers" ? "'c/t'" : "false"},
           transition: 'slide',
         }).then(function () {
           var h = parseInt(params.get('h') || '0', 10) || 0;
           var v = parseInt(params.get('v') || '0', 10) || 0;
           if (h || v) Reveal.slide(h, v);
           // Present mode = fullscreen. Only then do fragment animations play and
           // the arrows + progress bar appear; in the editor canvas everything is
           // visible and chrome-free, and clicks edit rather than navigate.
           // The parent fullscreens the IFRAME ELEMENT, so document.fullscreenElement
           // is null inside this document — the parent tells us via a 'present'
           // message instead. We OR in the local check for a standalone fullscreen.
           var presentFlag = false;
           function presenting() { return presentFlag || !!(document.fullscreenElement || document.webkitFullscreenElement); }
           function syncPresentMode() {
             var p = presenting();
             // Switching fragments on (entering present) hides the already-visible
             // fragments on the current slide — which would animate them backwards
             // (a fade-up looks like fade-down). Kill fragment transitions across
             // the switch, then restore them so later clicks animate normally.
             var rv = document.querySelector('.reveal');
             if (rv) rv.classList.add('no-frag-anim');
             Reveal.configure({ fragments: p, controls: p && NAV.arrows, progress: p && NAV.progress });
             if (dotsEl) dotsEl.style.display = (p && NAV.dots) ? 'flex' : 'none';
             setTimeout(function () { if (rv) rv.classList.remove('no-frag-anim'); }, 60);
           }
           // Centered dots paginator: one dot per slide, click to jump. Built
           // once, refreshed on slide add/remove, active dot tracks the position.
           var dotsEl = document.createElement('div');
           dotsEl.className = 'sv-dots';
           (document.querySelector('.reveal') || document.body).appendChild(dotsEl);
           dotsEl.addEventListener('click', function (e) {
             var i = e.target && e.target.getAttribute && e.target.getAttribute('data-i');
             if (i != null) try { Reveal.slide(parseInt(i, 10)); } catch (_) {}
           });
           function buildDots() {
             var n = Reveal.getHorizontalSlides().length;
             var html = '';
             for (var i = 0; i < n; i++) html += '<button class="sv-dot" data-i="' + i + '" aria-label="Go to slide ' + (i + 1) + '"></button>';
             dotsEl.innerHTML = html;
             updateDots();
           }
           function updateDots() {
             var h = Reveal.getIndices().h, dots = dotsEl.children;
             for (var i = 0; i < dots.length; i++) dots[i].className = 'sv-dot' + (i === h ? ' on' : '');
           }
           buildDots();
           document.addEventListener('fullscreenchange', syncPresentMode);
           document.addEventListener('webkitfullscreenchange', syncPresentMode);
           renderCharts(Reveal.getCurrentSlide());
           Reveal.on('slidechanged', function (e) { renderCharts(e.currentSlide); });
           Reveal.on('slidechanged', updateDots);
           Reveal.on('slidechanged', report);
           addEventListener('message', function (e) {
             var m = e.data || {};
             if (!m || m.target !== 'slides-view') return;
             if (m.type === 'goto') {
               try { Reveal.slide(m.h || 0, m.v || 0); } catch (_) {}
             } else if (m.type === 'present') {
               presentFlag = !!m.on;
               syncPresentMode();
             }
           });
           // Tag editable elements of the active slide with a stable index so
           // the editor can map a click back to the source element. A plain div
           // is included so text-only divs (a kicker, a big stat) are editable;
           // container divs are excluded at click time via isLeaf().
           var SEL = 'div,h1,h2,h3,h4,h5,h6,p,li,blockquote,span,strong,em,code,td,th,figcaption,img';
           var BLOCK = 'div,h1,h2,h3,h4,h5,h6,p,ul,ol,li,img,table,blockquote,section';
           function isLeaf(el) { return !el.querySelector(BLOCK) && (el.textContent || '').trim().length > 0; }
           var EFFECTS = ['fade-up','fade-down','fade-left','fade-right','zoom-in','grow','shrink'];
           function tagSids() {
             var sec = document.querySelector('.reveal .slides section.present');
             if (sec) sec.querySelectorAll(SEL).forEach(function (el, i) { el.setAttribute('data-sid', String(i)); });
           }
           Reveal.on('slidechanged', tagSids); tagSids();
           function animOf(el) {
             var cls = el.className || '';
             for (var i = 0; i < EFFECTS.length; i++) if (cls.indexOf(EFFECTS[i]) >= 0) return EFFECTS[i];
             return /\bfragment\b/.test(cls) ? 'fade' : 'none';
           }

           // Click-to-edit: text element → select + inline edit; image → replace;
           // empty background → change the slide's background.
           var TEXT = {H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,P:1,LI:1,BLOCKQUOTE:1,SPAN:1,STRONG:1,EM:1,CODE:1,TD:1,TH:1,FIGCAPTION:1};
           document.addEventListener('click', function (e) {
             if (presenting()) return; // presenting: clicks navigate, never edit
             if (e.target && e.target.isContentEditable) return; // already editing
             var node = e.target, img = null, textEl = null;
             while (node && node !== document.body) {
               var tag = (node.tagName || '').toUpperCase();
               if (tag === 'IMG') { img = node; break; }
               if (TEXT[tag]) { textEl = node; break; }
               if (tag === 'DIV' && isLeaf(node)) { textEl = node; break; }
               if (tag === 'A' || tag === 'BUTTON') return;
               node = node.parentElement;
             }
             if (img) {
               parent.postMessage({ source: 'slides-preview', type: 'img-click', sid: parseInt(img.getAttribute('data-sid') || '-1', 10), src: img.getAttribute('src') || '' }, '*');
             } else if (textEl) {
               var sid = parseInt(textEl.getAttribute('data-sid') || '-1', 10);
               parent.postMessage({ source: 'slides-preview', type: 'el-select', sid: sid, tag: textEl.tagName, anim: animOf(textEl), text: textEl.textContent }, '*');
               startEdit(textEl, sid);
             } else {
               // Overlay-covered images (a hero photo under a gradient scrim +
               // caption): the IMG never receives the click, so before treating
               // this as a background click, look through the element stack
               // beneath the pointer for one — clicking the scrim then swaps
               // the photo, exactly like clicking a bare image.
               var covered = null;
               var under = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
               for (var ui = 0; ui < under.length; ui++) {
                 if ((under[ui].tagName || '').toUpperCase() === 'IMG') { covered = under[ui]; break; }
               }
               if (covered) {
                 parent.postMessage({ source: 'slides-preview', type: 'img-click', sid: parseInt(covered.getAttribute('data-sid') || '-1', 10), src: covered.getAttribute('src') || '' }, '*');
               } else {
                 parent.postMessage({ source: 'slides-preview', type: 'bg-click' }, '*');
               }
             }
           });
           function startEdit(el, sid) {
             var old = el.textContent;
             el.setAttribute('contenteditable', 'true');
             el.focus();
             var r = document.createRange(); r.selectNodeContents(el);
             var s = getSelection(); s.removeAllRanges(); s.addRange(r);
             function finish() {
               el.removeAttribute('contenteditable');
               el.removeEventListener('blur', finish);
               el.removeEventListener('keydown', onKey);
               var now = el.textContent;
               if (now !== old) parent.postMessage({ source: 'slides-preview', type: 'el-edit', sid: sid, oldText: old, newText: now }, '*');
             }
             function onKey(ev) {
               if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.blur(); }
               else if (ev.key === 'Escape') { el.textContent = old; el.blur(); }
             }
             el.addEventListener('blur', finish);
             el.addEventListener('keydown', onKey);
           }
           parent.postMessage({ source: 'slides-preview', type: 'ready', slides: Reveal.getTotalSlides() }, '*');
           report();
         });
         function report() {
           var i = Reveal.getIndices();
           parent.postMessage({ source: 'slides-preview', type: 'slidechanged', h: i.h, v: i.v }, '*');
         }`;

  return CHART_FNS + "\n" + harness;
}

export function revealDoc(opts: DocOpts): string {
  if (opts.mode === "print") return buildPrintDoc(opts);
  const REVEAL = "/vendor/reveal";
  const theme = safeTheme(opts.theme);
  const sections = buildSections(opts.content, opts.only);

  // The base theme provides layout/sizing rules; the brand head overrides the
  // reveal --r-* color/font variables on top of it.
  return `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${REVEAL}/dist/reveal.css" />
<link rel="stylesheet" href="${REVEAL}/dist/theme/${theme}.css" id="theme" />
<link rel="stylesheet" href="${REVEAL}/plugin/highlight/monokai.css" />
<style>
  html,body{margin:0;padding:0;height:100%}
  /* Slides are designed HTML, left-aligned by default; each slide positions its
     own content (often with inset:0), so the section must fill the slide box in
     EVERY mode. Use a descendant selector, not a direct child: in print reveal
     moves each section into a pdf-page wrapper, so a direct-child selector would
     stop matching and the slide would collapse and overflow onto the next PDF
     page. height:100% resolves against the slides box (screen) and the sized
     pdf-page (print), so each slide fills exactly one page. */
  .reveal .slides { text-align: var(--brand-align, left); }
  .reveal .slides section { height: 100%; box-sizing: border-box; }
  /* Brand DEFAULTS (a guideline, not forced): alignment + type scale come from
     the brand, but any slide can override by setting its own inline style — e.g.
     a left-aligned data slide while the brand default is centered. No !important,
     so inline per-slide styles win. */
  .reveal .slides section.design > div { text-align: var(--brand-align, left); align-items: var(--brand-justify, flex-start); }
  /* reveal's base themes force UPPERCASE on headings — show authored case instead
     (a slide/brand can still opt into uppercase via its own text-transform). The
     kicker keeps its own uppercase rule. */
  .reveal .slides section.design :is(h1, h2, h3, h4, h5, h6) { text-transform: none; }
  /* reveal's themes cap media at 95% (.reveal img/video/iframe {max-width/height:
     95%}) — a markdown-era nicety that shears ~5% off designed full-bleed images
     (a hero photo with width:100% stops short of its rounded container in the
     EDITOR only; the brand preview and the PDF don't load theme CSS, which made
     this maddening to spot). Designed slides size media explicitly — uncap. */
  .reveal .slides section.design :is(img, video, iframe) { max-width: none; max-height: none; }
  /* Suppress fragment transitions while toggling present mode (see syncPresentMode). */
  .reveal.no-frag-anim .fragment { transition: none !important; }
  .reveal .slides section.design h1 { font-size: var(--brand-heading-size); }
  .reveal .slides section.design h2 { font-size: var(--brand-subheading-size); }
  .reveal .slides section.design h3 { font-size: calc(var(--brand-subheading-size) * 0.82); }
  .reveal .slides section.design :is(p, li, blockquote, td, th, figcaption) { font-size: var(--brand-body-size); }
  /* Infographics: don't let the box balloon (override an authored flex:1) so it
     takes the SVG's natural height; use the brand font instead of antv's default. */
  .reveal .slides section.design .infographic { flex: 0 1 auto !important; min-height: 0; }
  .reveal .slides section.design .infographic svg { font-family: var(--r-main-font); }
  /* Centered dots paginator — present-only, on-brand. Shown via JS only while
     presenting (like the arrows + progress bar); hidden in the editor and PDF. */
  .sv-dots{ position: fixed; left: 0; right: 0; bottom: 26px; z-index: 40;
    display: none; justify-content: center; align-items: center; gap: 12px; padding: 0; }
  .sv-dots .sv-dot{ width: 9px; height: 9px; padding: 0; border: 0; border-radius: 999px;
    background: var(--brand-muted, #999); opacity: .35; cursor: pointer; transition: opacity .2s, transform .2s, background .2s; }
  .sv-dots .sv-dot:hover{ opacity: .7; }
  .sv-dots .sv-dot.on{ background: var(--brand-accent, #fff); opacity: 1; transform: scale(1.35); }
</style>
${opts.brandHeadHtml}
</head><body>
${opts.brandLogoHtml}
<div class="reveal"><div class="slides">
${sections}
</div></div>
<script src="${REVEAL}/dist/reveal.js"></script>
<script src="${REVEAL}/plugin/highlight/highlight.js"></script>
${opts.mode === "view" && !opts.thumb ? `<script src="${REVEAL}/plugin/notes/notes.js"></script>` : ""}
<script src="/api/view-script.js?format=${encodeURIComponent(opts.format.id)}&amp;thumb=${opts.thumb ? "1" : "0"}&amp;nav=${encodeURIComponent(opts.nav?.mode ?? "dots")}"></script>
</body></html>`;
}
