'use strict';
/**
 * Zaman aralıklarıyla ilgili yardımcılar.
 * Aralıklar [başlangıç, bitiş] şeklinde, saniye ya da kare (frame) cinsindendir.
 */

function sortRanges(ranges) {
  return ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
}

/** Çakışan (veya joinGap'ten yakın) aralıkları birleştirir. */
function mergeRanges(ranges, joinGap) {
  joinGap = joinGap || 0;
  var sorted = sortRanges(ranges.filter(function (r) { return r[1] > r[0]; }));
  var out = [];
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    var last = out[out.length - 1];
    if (last && r[0] <= last[1] + joinGap) {
      if (r[1] > last[1]) last[1] = r[1];
    } else {
      out.push([r[0], r[1]]);
    }
  }
  return out;
}

/** [0, duration] içinde kesimlerin tümleyeni (kalacak bölümler). */
function invertRanges(cuts, duration) {
  var merged = mergeRanges(cuts);
  var keep = [];
  var t = 0;
  for (var i = 0; i < merged.length; i++) {
    var a = Math.max(0, merged[i][0]);
    var b = Math.min(duration, merged[i][1]);
    if (b <= a) continue;
    if (a > t) keep.push([t, a]);
    t = Math.max(t, b);
  }
  if (t < duration) keep.push([t, duration]);
  return keep;
}

/** Saniye aralıklarını tam karelere yuvarlar; boş kalanları atar, bitişikleri birleştirir. */
function secondsToFrames(ranges, fps) {
  var out = [];
  for (var i = 0; i < ranges.length; i++) {
    var a = Math.round(ranges[i][0] * fps);
    var b = Math.round(ranges[i][1] * fps);
    if (b <= a) continue;
    var last = out[out.length - 1];
    if (last && a <= last[1]) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

function framesToSeconds(ranges, fps) {
  return ranges.map(function (r) { return [r[0] / fps, r[1] / fps]; });
}

function totalLength(ranges) {
  var s = 0;
  for (var i = 0; i < ranges.length; i++) s += ranges[i][1] - ranges[i][0];
  return s;
}

/**
 * Orijinal zaman çizelgesi ile kurgulanmış (kesilmiş) zaman çizelgesi arasında eşleme.
 * keep: sıralı ve çakışmayan kalacak aralıklar.
 */
function createTimeMap(keep) {
  var offsets = [];
  var acc = 0;
  for (var i = 0; i < keep.length; i++) {
    offsets.push(acc);
    acc += keep[i][1] - keep[i][0];
  }

  // t'yi içeren ya da t'den sonra gelen ilk aralığın indeksi
  function findOrig(t) {
    var lo = 0, hi = keep.length - 1, ans = keep.length;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (keep[mid][1] > t) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
  }

  function findEdited(te) {
    var lo = 0, hi = keep.length - 1, ans = keep.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (offsets[mid] + (keep[mid][1] - keep[mid][0]) > te) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
  }

  return {
    keep: keep,
    duration: acc,
    /** t kalan bir bölümdeyse true */
    isKept: function (t) {
      var i = findOrig(t);
      return i < keep.length && keep[i][0] <= t;
    },
    /** Orijinal zamanı kurgu zamanına çevirir. Kesilen bölgedeki zaman, sonraki kalan bölümün başına düşer. */
    toEdited: function (t) {
      var i = findOrig(t);
      if (i >= keep.length) return acc;
      if (t < keep[i][0]) return offsets[i];
      return offsets[i] + (t - keep[i][0]);
    },
    /** Kurgu zamanını orijinal zamana çevirir. */
    toOrig: function (te) {
      if (!keep.length) return 0;
      if (te <= 0) return keep[0][0];
      if (te >= acc) return keep[keep.length - 1][1];
      var i = findEdited(te);
      return keep[i][0] + (te - offsets[i]);
    }
  };
}

/**
 * Kalan aralıkları (kare) ve kamera çekimlerini (kurgu zamanında, kare) birleştirerek
 * XML'e uygulanacak "parçaları" üretir.
 * Her parça: { origStart, origEnd, outStart, cam }  (cam: aktif video kanalı indeksi, -1: yok)
 */
function buildPieces(keepFrames, shotsFrames) {
  var pieces = [];
  var out = 0;
  var si = 0;
  var shots = shotsFrames || [];
  for (var k = 0; k < keepFrames.length; k++) {
    var a = keepFrames[k][0];
    var b = keepFrames[k][1];
    while (a < b) {
      while (si < shots.length - 1 && shots[si].end <= out) si++;
      var shot = shots.length ? shots[si] : null;
      var len = b - a;
      if (shot && shot.end > out) len = Math.min(len, shot.end - out);
      pieces.push({ origStart: a, origEnd: a + len, outStart: out, cam: shot ? shot.cam : -1 });
      a += len;
      out += len;
    }
  }
  return pieces;
}

module.exports = {
  mergeRanges: mergeRanges,
  invertRanges: invertRanges,
  secondsToFrames: secondsToFrames,
  framesToSeconds: framesToSeconds,
  totalLength: totalLength,
  createTimeMap: createTimeMap,
  buildPieces: buildPieces
};
