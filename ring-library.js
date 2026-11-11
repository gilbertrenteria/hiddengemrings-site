/* Hidden Gem ring library: every shape in every setting style, in yellow,
   white and rose gold. Renders hosted at ring.gilbertrenteria.dev. Used by
   /call (ring creator + 6 ring builder). */
(function () {
  var BASE = 'https://ring.gilbertrenteria.dev/img/ring/';
  var SHAPES = [
    { id: 'oval', label: 'Oval', note: 'Elegant and elongating. Looks bigger than a round of the same carat.' },
    { id: 'round', label: 'Round', note: 'The classic. The most sparkle of any shape.' },
    { id: 'pear', label: 'Pear', note: 'A teardrop that feels romantic and a little unexpected.' },
    { id: 'emerald', label: 'Emerald', note: 'Long step cuts with a glassy, old Hollywood look.' },
    { id: 'elcushion', label: 'Elongated Cushion', note: 'Soft corners and a long, modern silhouette.' },
    { id: 'cushion', label: 'Cushion', note: 'Pillow shaped with soft corners and big fire.' },
    { id: 'radiant', label: 'Radiant', note: 'Crisp corners with the sparkle of a round.' },
    { id: 'princess', label: 'Princess', note: 'Clean square lines and bold brilliance.' },
    { id: 'marquise', label: 'Marquise', note: 'Long and pointed. Vintage glamour, maximum finger coverage.' },
    { id: 'asscher', label: 'Asscher', note: 'A square step cut with an art deco hall of mirrors.' }
  ];
  var STYLES = [
    { id: 'solitaire', label: 'Solitaire', note: 'One stone, all the attention.' },
    { id: 'hidden', label: 'Hidden Halo', note: 'A secret ring of diamonds under the stone.' },
    { id: 'halo', label: 'Halo', note: 'A ring of diamonds that makes the center look bigger.' },
    { id: 'side', label: 'Pavé Band', note: 'Diamonds down the band for sparkle from every angle.' },
    { id: 'three', label: 'Three Stone', note: 'Past, present and future.' },
    { id: 'five', label: 'Five Stone', note: 'A row of brilliance across the finger.' },
    { id: 'bezel', label: 'Bezel', note: 'A sleek metal rim. Modern and secure for everyday life.' },
    { id: 'toi', label: 'Toi et Moi', note: '"You and me." Two stones side by side.' }
  ];
  var HAS = {
    asscher: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel'],
    cushion: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'],
    elcushion: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'],
    emerald: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'],
    marquise: ['solitaire', 'hidden', 'halo', 'side', 'three', 'bezel', 'toi'],
    oval: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'],
    pear: ['solitaire', 'hidden', 'halo', 'side', 'three', 'bezel', 'toi'],
    princess: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel'],
    radiant: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel', 'toi'],
    round: ['solitaire', 'hidden', 'halo', 'side', 'three', 'five', 'bezel']
  };
  function shape(id) { return SHAPES.filter(function (s) { return s.id === id; })[0]; }
  function style(id) { return STYLES.filter(function (s) { return s.id === id; })[0]; }
  window.HGLIB = {
    SHAPES: SHAPES, STYLES: STYLES, HAS: HAS, shape: shape, style: style,
    url: function (sh, st, metal) { return BASE + sh + '-' + st + '-' + (metal || 'yellow') + '.webp'; },
    name: function (sh, st) { var a = shape(sh), b = style(st); return (a ? a.label : sh) + ' ' + (b ? b.label : st); },
    // map form/call answers to library ids
    shapeId: function (label) { label = String(label || '').toLowerCase(); if (/elongated/.test(label)) return 'elcushion'; var s = SHAPES.filter(function (x) { return x.label.toLowerCase() === label; })[0]; return s ? s.id : ''; },
    styleId: function (label) { label = String(label || '').toLowerCase(); var s = STYLES.filter(function (x) { return x.label.toLowerCase() === label; })[0]; return s ? s.id : ''; },
    metalKey: function (m) { m = String(m || '').toLowerCase(); return m.indexOf('rose') > -1 ? 'rose' : (m.indexOf('white') > -1 || m.indexOf('platinum') > -1) ? 'white' : 'yellow'; },
    all: function () { var r = []; SHAPES.forEach(function (s) { (HAS[s.id] || []).forEach(function (t) { r.push(s.id + '-' + t); }); }); return r; }
  };
})();
