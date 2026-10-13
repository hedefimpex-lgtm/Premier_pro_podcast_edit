'use strict';
/**
 * Premiere Pro'nun dışa aktardığı Final Cut Pro 7 XML (xmeml) sekansını,
 * hesaplanan "parçalara" göre yeniden kurar:
 *   - kesilen bölümleri tüm kanallardan senkron şekilde çıkarır (ripple),
 *   - çoklu kamera kanallarında yalnızca aktif kamerayı etkin bırakır.
 * Orijinal sekansa dokunulmaz; sonuç yeni bir sekans olarak içe aktarılır.
 *
 * Yalnızca DOM Level 2 API'leri kullanılır (tarayıcı DOMParser ve @xmldom/xmldom uyumlu).
 */

var ITEM_TAGS = { clipitem: true, generatoritem: true };
var TICKS_PER_SECOND = 254016000000;

function elementChildren(el, tag) {
  var out = [];
  if (!el) return out;
  for (var n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!tag || n.nodeName === tag)) out.push(n);
  }
  return out;
}

function child(el, tag) {
  if (!el) return null;
  for (var n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.nodeName === tag) return n;
  }
  return null;
}

function text(el) {
  return el ? String(el.textContent).trim() : '';
}

function intOf(el, def) {
  var v = parseInt(text(el), 10);
  return isNaN(v) ? def : v;
}

function setText(el, value) {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(el.ownerDocument.createTextNode(String(value)));
}

function setChildText(el, tag, value) {
  var c = child(el, tag);
  if (!c) {
    c = el.ownerDocument.createElement(tag);
    el.appendChild(c);
  }
  setText(c, value);
  return c;
}

function hasElementChildren(el) {
  for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return true;
  return false;
}

function rateOf(el) {
  var r = child(el, 'rate');
  if (!r) return null;
  var tb = intOf(child(r, 'timebase'), 0);
  if (!tb) return null;
  var ntsc = text(child(r, 'ntsc')).toUpperCase() === 'TRUE';
  return { timebase: tb, ntsc: ntsc, fps: ntsc ? tb * 1000 / 1001 : tb };
}

function findMainSequence(root) {
  var seq = child(root, 'sequence');
  if (seq) return seq;
  // <xmeml><project><children><sequence>
  var project = child(root, 'project');
  var children = project ? child(project, 'children') : null;
  if (children) {
    seq = child(children, 'sequence');
    if (seq) return seq;
  }
  var all = root.getElementsByTagName('sequence');
  return all.length ? all[0] : null;
}

/** Klibin zaman çizelgesindeki konumu ve kaynak giriş/çıkış noktaları (kare). */
function readTimes(item) {
  var start = intOf(child(item, 'start'), -1);
  var end = intOf(child(item, 'end'), -1);
  var inP = intOf(child(item, 'in'), -1);
  var outP = intOf(child(item, 'out'), -1);
  var hasSrc = inP >= 0 && outP >= 0 && outP >= inP;
  if (start < 0 && end >= 0 && hasSrc) start = end - (outP - inP);
  if (end < 0 && start >= 0 && hasSrc) end = start + (outP - inP);
  if (start < 0 || end <= start) return null;
  if (!hasSrc) {
    inP = 0;
    outP = end - start;
  }
  // k: zaman çizelgesi karesi başına kaynak karesi (hız / kare hızı farkı)
  var k = (outP - inP) / (end - start);
  if (!isFinite(k) || k <= 0) k = 1;
  // Premiere'e özgü hassas kaynak konumu (tick); içe aktarmada kare değerlerine tercih edilir
  var ticksIn = parseFloat(text(child(item, 'pproTicksIn')));
  var rate = rateOf(item);
  var tpf = TICKS_PER_SECOND / (rate ? rate.fps : 30);
  return {
    start: start, end: end, in: inP, out: outP, k: k, hasSrc: hasSrc,
    ticksIn: isNaN(ticksIn) ? null : ticksIn, ticksPerFrame: tpf
  };
}

/**
 * xmlText: Premiere'in exportAsFinalCutProXML çıktısı
 * pieces: timeline.buildPieces() çıktısı (sekans kare cinsinden)
 * opts: {
 *   cameraTracks: [video kanalı indeksleri (0 tabanlı)],
 *   inactiveMode: 'disable' | 'remove',
 *   sequenceName: yeni sekans adı,
 *   fps: beklenen sekans kare hızı (doğrulama için, isteğe bağlı)
 * }
 * impl: { DOMParser, XMLSerializer }
 */
function transform(xmlText, pieces, opts, impl) {
  opts = opts || {};
  var warnings = [];
  var parser = new impl.DOMParser();
  var doc = parser.parseFromString(xmlText, 'text/xml');
  var root = doc.documentElement;
  if (!root || root.nodeName !== 'xmeml' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('XML okunamadı (geçerli bir Premiere/FCP XML dosyası değil).');
  }
  var seq = findMainSequence(root);
  if (!seq) throw new Error('XML içinde sekans bulunamadı.');
  var seqRate = rateOf(seq);
  if (!seqRate) throw new Error('Sekans kare hızı okunamadı.');
  if (opts.fps && Math.abs(seqRate.fps - opts.fps) > 0.01) {
    warnings.push('Sekans kare hızı uyuşmuyor (XML: ' + seqRate.fps.toFixed(3) + ', Premiere: ' + opts.fps.toFixed(3) + ').');
  }

  // Tam tanımları sakla (file ve iç içe sekanslar ilk kullanımda tam tanımlanır)
  var fileDefs = collectDefs(doc.getElementsByTagName('file'));
  var seqDefs = collectDefs(nestedSequences(doc, seq));

  var media = child(seq, 'media');
  if (!media) throw new Error('Sekansta medya bulunamadı.');
  var trackList = [];
  elementChildren(child(media, 'video'), 'track').forEach(function (t, i) { trackList.push({ el: t, kind: 'video', index: i }); });
  elementChildren(child(media, 'audio'), 'track').forEach(function (t, i) { trackList.push({ el: t, kind: 'audio', index: i }); });

  var cams = opts.cameraTracks || [];
  var removeInactive = opts.inactiveMode === 'remove';
  var idMap = {};       // "eskiId|parçaNo" -> yeniId
  var byNewId = {};     // yeniId -> { node, track, clipIndex, pi }
  var allNew = [];
  var stats = { clipsIn: 0, clipsOut: 0, transitionsRemoved: 0, dropped: 0 };
  var counter = 0;

  trackList.forEach(function (tr) {
    var items = elementChildren(tr.el).filter(function (n) { return ITEM_TAGS[n.nodeName]; });
    var transitions = elementChildren(tr.el, 'transitionitem');
    transitions.forEach(function (t) { tr.el.removeChild(t); });
    stats.transitionsRemoved += transitions.length;
    stats.clipsIn += items.length;
    var isCam = tr.kind === 'video' && cams.indexOf(tr.index) >= 0;
    var planned = [];

    items.forEach(function (item) {
      var t = readTimes(item);
      if (!t) {
        stats.dropped++;
        warnings.push('Konumu okunamayan bir klip atlandı: ' + text(child(item, 'name')));
        return;
      }
      var origId = item.getAttribute('id') || ('item' + (counter++));
      for (var pi = 0; pi < pieces.length; pi++) {
        var p = pieces[pi];
        if (p.origEnd <= t.start) continue;
        if (p.origStart >= t.end) break;
        var a = Math.max(t.start, p.origStart);
        var b = Math.min(t.end, p.origEnd);
        if (b <= a) continue;
        var active = !isCam || p.cam < 0 || p.cam === tr.index;
        if (!active && removeInactive) continue;
        var ns = p.outStart + (a - p.origStart);
        var ne = ns + (b - a);
        var nin = t.in + Math.round((a - t.start) * t.k);
        var nout = t.in + Math.round((b - t.start) * t.k);
        var prev = planned[planned.length - 1];
        var tIn = t.ticksIn === null ? null : t.ticksIn + Math.round((a - t.start) * t.k * t.ticksPerFrame);
        var tOut = t.ticksIn === null ? null : t.ticksIn + Math.round((b - t.start) * t.k * t.ticksPerFrame);
        if (prev && prev.origId === origId && prev.end === ns && prev.out === nin && prev.active === active) {
          prev.end = ne;
          prev.out = nout;
          prev.ticksOut = tOut;
          idMap[origId + '|' + pi] = prev.id;
          continue;
        }
        var nid = origId + '-pk' + (counter++);
        planned.push({
          src: item, origId: origId, id: nid, pi: pi, start: ns, end: ne, in: nin, out: nout,
          ticksIn: tIn, ticksOut: tOut, active: active, hasSrc: t.hasSrc
        });
        idMap[origId + '|' + pi] = nid;
      }
    });

    // Yeni klipleri oluştur, eskileri kaldır
    var anchor = items.length ? items[0] : null;
    planned.forEach(function (pl, ci) {
      var node = pl.src.cloneNode(true);
      node.setAttribute('id', pl.id);
      setChildText(node, 'start', pl.start);
      setChildText(node, 'end', pl.end);
      if (pl.hasSrc) {
        setChildText(node, 'in', pl.in);
        setChildText(node, 'out', pl.out);
      }
      if (pl.ticksIn !== null && child(node, 'pproTicksIn')) {
        setChildText(node, 'pproTicksIn', pl.ticksIn);
        setChildText(node, 'pproTicksOut', pl.ticksOut);
      }
      if (!pl.active) setChildText(node, 'enabled', 'FALSE');
      if (anchor) tr.el.insertBefore(node, anchor);
      else tr.el.appendChild(node);
      pl.node = node;
      pl.track = tr;
      pl.clipIndex = ci + 1;
      byNewId[pl.id] = pl;
      allNew.push(pl);
    });
    items.forEach(function (it) { tr.el.removeChild(it); });
    stats.clipsOut += planned.length;
  });

  fixLinks(allNew, idMap, byNewId);
  normalizeDefs(doc, seq, seqDefs, fileDefs);
  retimeMarkers(seq, pieces);

  var total = pieces.length ? pieces[pieces.length - 1].outStart + (pieces[pieces.length - 1].origEnd - pieces[pieces.length - 1].origStart) : 0;
  setChildText(seq, 'duration', total);
  if (opts.sequenceName) setChildText(seq, 'name', opts.sequenceName);
  var uuid = child(seq, 'uuid');
  if (uuid) seq.removeChild(uuid);
  seq.setAttribute('id', (seq.getAttribute('id') || 'sequence') + '-pk' + Date.now());

  var xml = new impl.XMLSerializer().serializeToString(root);
  return {
    xml: '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + xml + '\n',
    stats: stats,
    durationFrames: total,
    fps: seqRate.fps,
    warnings: warnings
  };
}

function collectDefs(nodes) {
  var defs = {};
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var id = el.getAttribute('id');
    if (id && !defs[id] && hasElementChildren(el)) defs[id] = el.cloneNode(true);
  }
  return defs;
}

/** Ana sekans dışındaki (kliplerin içindeki) sekans öğeleri. */
function nestedSequences(doc, mainSeq) {
  var all = doc.getElementsByTagName('sequence');
  var out = [];
  for (var i = 0; i < all.length; i++) if (all[i] !== mainSeq) out.push(all[i]);
  return out;
}

/**
 * Bağlantıları (link) yeni klip kimliklerine göre günceller. Tutarsız hale gelen
 * bağlantı grupları kaldırılır (klipler senkron kalır, yalnızca bağlantısız olur).
 */
function fixLinks(allNew, idMap, byNewId) {
  allNew.forEach(function (pl) {
    elementChildren(pl.node, 'link').forEach(function (link) {
      var refEl = child(link, 'linkclipref');
      var ref = text(refEl);
      var target = idMap[ref + '|' + pl.pi];
      if (!target || !byNewId[target]) {
        pl.node.removeChild(link);
        return;
      }
      setText(refEl, target);
      var ci = child(link, 'clipindex');
      if (ci) setText(ci, byNewId[target].clipIndex);
    });
  });
  // Tutarlılık: bir gruptaki her klip aynı kümeyi (kendisi dahil) göstermeli
  function group(pl) {
    var ids = elementChildren(pl.node, 'link').map(function (l) { return text(child(l, 'linkclipref')); });
    if (ids.indexOf(pl.id) < 0) ids.push(pl.id);
    return ids.sort().join('|');
  }
  var changed = true;
  var guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    allNew.forEach(function (pl) {
      var links = elementChildren(pl.node, 'link');
      if (!links.length) return;
      var mine = group(pl);
      var ok = true;
      links.forEach(function (l) {
        var other = byNewId[text(child(l, 'linkclipref'))];
        if (!other || group(other) !== mine) ok = false;
      });
      if (!ok) {
        links.forEach(function (l) { pl.node.removeChild(l); });
        changed = true;
      }
    });
  }
}

/** Her file/sequence kimliği belge sırasında ilk geçtiği yerde tam, sonrakilerde referans olarak bulunmalı. */
function normalizeDefs(doc, mainSeq, seqDefs, fileDefs) {
  for (var pass = 0; pass < 3; pass++) {
    if (!normalizeTag(nestedSequences(doc, mainSeq), seqDefs)) break;
  }
  normalizeTag(toArray(doc.getElementsByTagName('file')), fileDefs);
}

function toArray(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function normalizeTag(nodes, defs) {
  var seen = {};
  var changed = false;
  nodes.forEach(function (el) {
    if (!el.parentNode) return;
    var id = el.getAttribute('id');
    if (!id) return;
    if (!seen[id]) {
      seen[id] = true;
      if (!hasElementChildren(el) && defs[id]) {
        el.parentNode.replaceChild(defs[id].cloneNode(true), el);
        changed = true;
      }
    } else if (hasElementChildren(el)) {
      while (el.firstChild) el.removeChild(el.firstChild);
      changed = true;
    }
  });
  return changed;
}

function mapFrame(pieces, f) {
  for (var i = 0; i < pieces.length; i++) {
    var p = pieces[i];
    if (f >= p.origStart && f < p.origEnd) return p.outStart + (f - p.origStart);
  }
  return -1;
}

function retimeMarkers(seq, pieces) {
  elementChildren(seq, 'marker').forEach(function (m) {
    var inEl = child(m, 'in');
    var outEl = child(m, 'out');
    var nin = mapFrame(pieces, intOf(inEl, -1));
    if (nin < 0) {
      seq.removeChild(m);
      return;
    }
    setText(inEl, nin);
    if (outEl && intOf(outEl, -1) >= 0) {
      var nout = mapFrame(pieces, intOf(outEl, -1));
      setText(outEl, nout >= nin ? nout : -1);
    }
  });
}

/** Test/inceleme için: sekanstaki kanalları ve klipleri listeler. */
function describe(xmlText, impl) {
  var doc = new impl.DOMParser().parseFromString(xmlText, 'text/xml');
  var seq = findMainSequence(doc.documentElement);
  var media = child(seq, 'media');
  var res = { name: text(child(seq, 'name')), duration: intOf(child(seq, 'duration'), 0), rate: rateOf(seq), video: [], audio: [] };
  ['video', 'audio'].forEach(function (kind) {
    elementChildren(child(media, kind), 'track').forEach(function (t) {
      res[kind].push(elementChildren(t).filter(function (n) { return ITEM_TAGS[n.nodeName]; }).map(function (c) {
        return {
          id: c.getAttribute('id'),
          start: intOf(child(c, 'start'), -1),
          end: intOf(child(c, 'end'), -1),
          in: intOf(child(c, 'in'), -1),
          out: intOf(child(c, 'out'), -1),
          enabled: text(child(c, 'enabled')).toUpperCase() !== 'FALSE',
          links: elementChildren(c, 'link').map(function (l) { return text(child(l, 'linkclipref')); }),
          fullFile: (function () { var f = child(c, 'file'); return !!(f && hasElementChildren(f)); })(),
          fileId: (function () { var f = child(c, 'file'); return f ? f.getAttribute('id') : null; })()
        };
      }));
    });
  });
  return res;
}

module.exports = {
  transform: transform,
  describe: describe,
  readTimes: readTimes
};
