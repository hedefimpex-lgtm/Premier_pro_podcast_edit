/*
 * Podcast Kurgu Asistanı — panel denetleyicisi.
 * Node.js modülleri CEP'in "mixed context" modu sayesinde doğrudan kullanılır.
 */
(function () {
  'use strict';

  var nodeRequire = (window.cep_node && window.cep_node.require) || (typeof window.require === 'function' ? window.require : null);
  if (!nodeRequire) {
    document.body.innerHTML = '<div style="padding:16px">Bu panel Node.js desteği gerektirir. Lütfen eklentiyi kurulum programıyla yeniden kurun.</div>';
    return;
  }
  var path = nodeRequire('path');
  var fs = nodeRequire('fs');
  var childProcess = nodeRequire('child_process');
  var ROOT = window.PK_DEV_ROOT || PKHost.extensionPath();

  function lib(name) {
    return nodeRequire(path.join(ROOT, 'js', 'lib', name + '.js'));
  }

  var settingsLib = lib('settings');
  var planner = lib('planner');
  var timeline = lib('timeline');
  var subtitles = lib('subtitles');
  var fillersLib = lib('fillers');
  var fcpxml = lib('fcpxml');
  var pipeline = lib('pipeline');
  var paths = lib('paths');
  var downloader = lib('downloader');
  var ffmpegLib = lib('ffmpeg');

  var VERSION = '1.0.0';
  var STORE_KEY = 'pk.settings.v1';
  var CAM_COLORS = ['#2d8ceb', '#3fb950', '#a371f7', '#e3a52a', '#ff7b72', '#39c5cf', '#d2a8ff', '#7ee787'];
  var BIN = 'Podcast Kurgu';

  var S = {
    settings: loadSettings(),
    seq: null,
    analysis: null,
    plan: null,
    disabled: {},
    tools: { ffmpeg: null, whisper: null, models: [] },
    dirs: null,
    busy: false,
    cancel: null,
    planTimer: null
  };

  // ------------------------------------------------------------------ yardımcılar
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(sec, precise) {
    sec = Math.max(0, sec || 0);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var ss = precise ? s.toFixed(1) : String(Math.floor(s));
    if (parseFloat(ss) < 10) ss = '0' + ss;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + ss;
  }

  function fmtDur(sec) {
    if (sec < 60) return sec.toFixed(1) + ' sn';
    return fmtTime(sec);
  }

  function fmtVal(v, f) {
    switch (f) {
      case 'ms': return v >= 1000 ? (v / 1000).toFixed(2).replace(/\.?0+$/, '') + ' sn' : Math.round(v) + ' ms';
      case 'msOff': return v ? fmtVal(v, 'ms') : 'kapalı';
      case 'db': return (Math.round(v * 10) / 10) + ' dB';
      case 'pct': return Math.round(v * 100) + '%';
      case 'words': return v ? String(v) : 'sınırsız';
      case 'auto': return v ? String(v) : 'otomatik';
      default: return String(v);
    }
  }

  function log(msg, type) {
    var box = $('#log');
    var div = document.createElement('div');
    div.className = type || '';
    div.textContent = msg;
    box.insertBefore(div, box.firstChild);
    while (box.children.length > 30) box.removeChild(box.lastChild);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // ------------------------------------------------------------------ ayarlar
  function loadSettings() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (raw) return settingsLib.mergeDeep(settingsLib.defaults(), JSON.parse(raw));
    } catch (e) { /* yoksay */ }
    return settingsLib.defaults();
  }

  function saveSettings() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(S.settings)); } catch (e) { /* yoksay */ }
  }

  function get(key) { return settingsLib.getPath(S.settings, key); }

  function readEl(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'radio') return el.value;
    if (el.type === 'range' || el.type === 'number' || el.getAttribute('data-num')) return parseFloat(el.value);
    return el.value;
  }

  function renderSettings() {
    $$('[data-k]').forEach(function (el) {
      var v = get(el.getAttribute('data-k'));
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'radio') el.checked = el.value === v;
      else if (v !== undefined && v !== null) el.value = String(v);
    });
    renderValueLabels();
    renderVisibility();
  }

  function renderValueLabels() {
    $$('[data-v]').forEach(function (el) {
      el.textContent = fmtVal(get(el.getAttribute('data-v')), el.getAttribute('data-fmt'));
    });
  }

  function renderVisibility() {
    $$('[data-show]').forEach(function (el) { el.classList.toggle('hidden', !get(el.getAttribute('data-show'))); });
    $$('[data-hide]').forEach(function (el) { el.classList.toggle('hidden', !!get(el.getAttribute('data-hide'))); });
  }

  function bindSettings() {
    $$('[data-k]').forEach(function (el) {
      var live = el.type === 'range' || el.type === 'text' || el.tagName === 'TEXTAREA';
      el.addEventListener(live ? 'input' : 'change', function () {
        onSettingChange(el.getAttribute('data-k'), readEl(el));
      });
    });
  }

  function onSettingChange(key, value) {
    settingsLib.setPath(S.settings, key, value);
    saveSettings();
    renderValueLabels();
    renderVisibility();
    if (key.indexOf('paths.') === 0) scanTools();
    updateReanalyzeNote();
    schedulePlan();
  }

  function initPresets() {
    var sel = $('#presetSelect');
    Object.keys(settingsLib.PRESETS).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      o.textContent = settingsLib.PRESETS[k].label;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      if (!sel.value) return;
      S.settings = settingsLib.applyPreset(S.settings, sel.value);
      saveSettings();
      renderSettings();
      log('Hazır ayar uygulandı: ' + settingsLib.PRESETS[sel.value].label, 'ok');
      sel.value = '';
      schedulePlan();
    });
  }

  // ------------------------------------------------------------------ araçlar
  function modelPath() {
    var want = get('whisper.model');
    var models = S.tools.models;
    for (var i = 0; i < models.length; i++) if (models[i].name === want) return models[i].path;
    return models.length ? models[0].path : null;
  }

  function scanTools() {
    try {
      S.dirs = paths.dirs();
      S.tools.ffmpeg = paths.findFfmpeg(get('paths.ffmpeg'), S.dirs);
      S.tools.whisper = paths.findWhisper(get('paths.whisper'), S.dirs);
      S.tools.models = paths.listModels(S.dirs);
      $('#toolsPath').textContent = 'Araç klasörü: ' + S.dirs.root;
    } catch (e) {
      log('Araç klasörü hazırlanamadı: ' + e.message, 'err');
    }
    renderComponents();
    updateReanalyzeNote();
  }

  function renderComponents() {
    function comp(el, okPath, label, key) {
      el.innerHTML =
        '<span class="dot ' + (okPath ? 'ok' : '') + '"></span>' +
        '<div><b>' + esc(label) + '</b><small>' + esc(okPath || 'Bulunamadı') + '</small></div>' +
        (okPath ? '<span class="muted">Hazır</span>' : '<button class="primary small" data-install="' + key + '">İndir</button>');
    }
    comp($('#compFfmpeg'), S.tools.ffmpeg, 'FFmpeg (ses çözme — zorunlu)', 'ffmpeg');
    comp($('#compWhisper'), S.tools.whisper, 'Whisper (konuşma tanıma)', 'whisper');

    var list = $('#modelList');
    var current = modelPath();
    list.innerHTML = downloader.MODELS.map(function (m) {
      var inst = null;
      S.tools.models.forEach(function (x) { if (x.name === m.file) inst = x; });
      return '<div class="m">' +
        '<input type="radio" name="model" value="' + esc(m.file) + '" ' + (inst ? '' : 'disabled ') + (inst && inst.path === current ? 'checked' : '') + '>' +
        '<div>' + esc(m.label) + '<br><small>' + esc(m.file) + ' · ' + esc(m.size) + '</small></div>' +
        (inst ? '<span class="muted">Yüklü</span>' : '<button class="ghost small" data-model="' + esc(m.file) + '">İndir</button>') +
        '</div>';
    }).join('');
    S.tools.models.forEach(function (x) {
      var known = downloader.MODELS.some(function (m) { return m.file === x.name; });
      if (known) return;
      list.insertAdjacentHTML('beforeend', '<div class="m"><input type="radio" name="model" value="' + esc(x.name) + '" ' + (x.path === current ? 'checked' : '') + '><div>' + esc(x.name) + '<br><small>özel model</small></div><span class="muted">Yüklü</span></div>');
    });
    $$('#modelList input[name=model]').forEach(function (r) {
      r.addEventListener('change', function () { onSettingChange('whisper.model', r.value); });
    });
    $$('[data-install]').forEach(function (b) {
      b.addEventListener('click', function () { install('tool', b.getAttribute('data-install')); });
    });
    $$('[data-model]').forEach(function (b) {
      b.addEventListener('click', function () { install('model', b.getAttribute('data-model')); });
    });
  }

  async function install(kind, name) {
    if (S.busy) return;
    setBusy(true);
    var wrap = $('#dlWrap');
    wrap.classList.remove('hidden');
    S.cancel = { cancelled: false, procs: [] };
    var label = kind === 'tool' ? downloader.COMPONENTS[name].label : name;
    function prog(got, total) {
      var pct = total ? got / total : 0;
      $('#dlBar').style.width = (pct * 100).toFixed(1) + '%';
      $('#dlText').textContent = label + ' indiriliyor… ' + (got / 1048576).toFixed(1) + (total ? ' / ' + (total / 1048576).toFixed(1) : '') + ' MB';
    }
    try {
      if (kind === 'tool') {
        var p = await downloader.installTool(name, prog, S.cancel);
        log(label + ' kuruldu: ' + p, 'ok');
      } else {
        await downloader.installModel(name, prog, S.cancel);
        settingsLib.setPath(S.settings, 'whisper.model', name);
        saveSettings();
        log('Model indirildi: ' + name, 'ok');
      }
    } catch (e) {
      log(label + ' kurulamadı: ' + e.message, 'err');
    } finally {
      wrap.classList.add('hidden');
      setBusy(false);
      scanTools();
    }
  }

  // ------------------------------------------------------------------ sekans
  function trackSetting(t) {
    var st = (S.settings.tracks || {})[t.index];
    if (st) return st;
    return { analyze: !t.muted && t.clips.length > 0, channel: 0 };
  }

  function setTrackSetting(idx, key, value) {
    if (!S.settings.tracks) S.settings.tracks = {};
    var t = null;
    S.seq.audioTracks.forEach(function (x) { if (x.index === idx) t = x; });
    var cur = trackSetting(t);
    var next = { analyze: cur.analyze, channel: cur.channel };
    next[key] = value;
    S.settings.tracks[idx] = next;
    saveSettings();
    updateReanalyzeNote();
  }

  async function refreshSequence(quiet) {
    try {
      var res = await PKHost.call('getSequenceInfo');
      var seq = res.sequence;
      if (S.seq && S.seq.id !== seq.id) {
        // farklı sekans: kanal tercihleri sekansa özgüdür
        S.settings.tracks = {};
      }
      S.seq = seq;
      $('#seqLabel').textContent = seq.name;
      $('#seqMeta').textContent = fmtTime(seq.duration) + ' · ' + (Math.round(seq.fps * 100) / 100) + ' fps';
      renderTracks();
      renderCamMap();
      return seq;
    } catch (e) {
      if (!quiet) log(e.code === 'NO_SEQUENCE' ? 'Önce Premiere Pro\'da bir sekans açın.' : e.message, 'err');
      return null;
    }
  }

  function renderTracks() {
    var box = $('#trackList');
    if (!S.seq || !S.seq.audioTracks.length) {
      box.innerHTML = '<p class="muted">Sekansta ses kanalı yok.</p>';
      return;
    }
    box.innerHTML = S.seq.audioTracks.map(function (t) {
      var st = trackSetting(t);
      var chOpts = ['Karışım', 'Kanal 1', 'Kanal 2', 'Kanal 3', 'Kanal 4'].map(function (n, i) {
        return '<option value="' + i + '"' + (st.channel === i ? ' selected' : '') + '>' + n + '</option>';
      }).join('');
      return '<div class="trk">' +
        '<input type="checkbox" data-trk="' + t.index + '"' + (st.analyze ? ' checked' : '') + (t.clips.length ? '' : ' disabled') + '>' +
        '<div class="name">A' + (t.index + 1) + ' · ' + esc(t.name) + ' <small>(' + t.clips.length + ' klip' + (t.muted ? ', sessiz' : '') + ')</small></div>' +
        '<select data-ch="' + t.index + '" title="Çok kanallı kayıtta hangi kanal analiz edilsin">' + chOpts + '</select>' +
        '</div>';
    }).join('');
    $$('[data-trk]').forEach(function (el) {
      el.addEventListener('change', function () { setTrackSetting(+el.getAttribute('data-trk'), 'analyze', el.checked); });
    });
    $$('[data-ch]').forEach(function (el) {
      el.addEventListener('change', function () { setTrackSetting(+el.getAttribute('data-ch'), 'channel', +el.value); });
    });
  }

  function renderCamMap() {
    var box = $('#camMap');
    var wide = $('#wideSelect');
    if (!S.seq) return;
    var vOpts = function (selected) {
      var html = '<option value="-1">—</option>';
      S.seq.videoTracks.forEach(function (v) {
        html += '<option value="' + v.index + '"' + (selected === v.index ? ' selected' : '') + '>V' + (v.index + 1) + (v.name ? ' · ' + esc(v.name) : '') + '</option>';
      });
      return html;
    };
    var map = get('multicam.speakers') || {};
    var audio = S.seq.audioTracks.filter(function (t) { return t.clips.length; });
    box.innerHTML = audio.length ? audio.map(function (t) {
      var cur = map[t.index] == null ? -1 : +map[t.index];
      return '<div class="cm"><span>A' + (t.index + 1) + ' · ' + esc(t.name) + '</span><select data-spk="' + t.index + '">' + vOpts(cur) + '</select></div>';
    }).join('') : '<p class="muted">Ses kanalı yok.</p>';
    wide.innerHTML = vOpts(+get('multicam.wideTrack'));
    $$('[data-spk]').forEach(function (el) {
      el.addEventListener('change', function () {
        var m = settingsLib.clone(get('multicam.speakers') || {});
        var v = +el.value;
        if (v < 0) delete m[el.getAttribute('data-spk')];
        else m[el.getAttribute('data-spk')] = v;
        onSettingChange('multicam.speakers', m);
      });
    });
  }

  // ------------------------------------------------------------------ analiz
  function requirements() {
    var t = S.settings.tasks;
    var m = get('fillers.method');
    var hasAi = !!(S.tools.whisper && modelPath());
    return {
      words: !!(t.subtitles || (t.fillers && (m === 'ai' || m === 'both' || (m === 'auto' && hasAi)))),
      acoustic: !!(t.fillers && (m === 'acoustic' || m === 'both' || (m === 'auto' && !hasAi)))
    };
  }

  function selectedTracks() {
    if (!S.seq) return [];
    return S.seq.audioTracks.filter(function (t) { return t.clips.length && trackSetting(t).analyze; })
      .map(function (t) { return { index: t.index, channel: trackSetting(t).channel || 0 }; });
  }

  function trackKey() { return JSON.stringify(selectedTracks()); }
  function whisperKey() {
    var w = S.settings.whisper;
    return [path.basename(modelPath() || ''), w.language, w.prompt, w.extraArgs].join('|');
  }

  function needsReanalysis() {
    var a = S.analysis;
    if (!a) return false;
    var req = requirements();
    if (req.words && (!a.words || a.whisperKey !== whisperKey())) return true;
    if (req.acoustic && !a.features) return true;
    if (S.seq && a.sequenceId === S.seq.id && a.trackKey !== trackKey()) return true;
    return false;
  }

  function updateReanalyzeNote() {
    $('#needReanalyze').classList.toggle('hidden', !needsReanalysis());
  }

  function setBusy(b) {
    S.busy = b;
    $('#btnAnalyze').disabled = b;
    $('#btnApply').disabled = b;
    $('#btnCancel').classList.toggle('hidden', !b);
    $$('[data-install],[data-model]').forEach(function (el) { el.disabled = b; });
  }

  function setProgress(p, msg) {
    $('#progressWrap').classList.remove('hidden');
    $('#progressBar').style.width = (Math.max(0, Math.min(1, p)) * 100).toFixed(1) + '%';
    if (msg) $('#progressText').textContent = msg;
  }

  async function analyze() {
    if (S.busy) return;
    var seq = await refreshSequence(false);
    if (!seq) return;
    var tracks = selectedTracks();
    if (!tracks.length) { log('Analiz için en az bir ses kanalı işaretleyin.', 'warn'); return; }
    if (!S.tools.ffmpeg) {
      log('FFmpeg bulunamadı. Ayarlar sekmesinden indirin.', 'err');
      switchTab('setup');
      return;
    }
    var req = requirements();
    if (req.words && (!S.tools.whisper || !modelPath())) {
      log('Altyazı / yapay zeka takılma tespiti için Whisper ve bir model gerekiyor (Ayarlar sekmesi). Takılmalar için "Akustik" yöntemi modelsiz çalışır.', 'err');
      switchTab('setup');
      return;
    }
    S.cancel = { cancelled: false, procs: [] };
    setBusy(true);
    setProgress(0, 'Başlatılıyor…');
    var t0 = Date.now();
    try {
      var analysis = await pipeline.analyze({
        seq: seq,
        tracks: tracks,
        settings: S.settings,
        ffmpegPath: S.tools.ffmpeg,
        whisperPath: S.tools.whisper,
        modelPath: modelPath(),
        needWords: req.words,
        needAcoustic: req.acoustic,
        dirs: S.dirs,
        onProgress: setProgress,
        cancel: S.cancel
      });
      analysis.fingerprint = timeline.sequenceFingerprint(seq);
      analysis.trackKey = trackKey();
      analysis.whisperKey = whisperKey();
      S.analysis = analysis;
      S.disabled = {};
      (analysis.warnings || []).forEach(function (w) { log(w, 'warn'); });
      log('Analiz tamamlandı (' + ((Date.now() - t0) / 1000).toFixed(1) + ' sn)' + (analysis.words ? ' · ' + analysis.words.length + ' kelime' : ''), 'ok');
      runPlan();
    } catch (e) {
      log(e.message, S.cancel && S.cancel.cancelled ? 'warn' : 'err');
    } finally {
      setBusy(false);
      updateReanalyzeNote();
      setTimeout(function () { if (!S.busy) $('#progressWrap').classList.add('hidden'); }, 1500);
    }
  }

  function cancelWork() {
    if (!S.cancel) return;
    S.cancel.cancelled = true;
    (S.cancel.procs || []).forEach(function (p) { try { p.kill(); } catch (e) { /* yoksay */ } });
  }

  // ------------------------------------------------------------------ plan & sonuç
  function schedulePlan() {
    if (!S.analysis) return;
    clearTimeout(S.planTimer);
    S.planTimer = setTimeout(runPlan, 120);
  }

  function runPlan() {
    if (!S.analysis) return;
    try {
      S.plan = planner.plan(S.analysis, S.settings, S.disabled);
    } catch (e) {
      log('Planlama hatası: ' + e.message, 'err');
      return;
    }
    $('#resultCard').classList.remove('hidden');
    $('#applyCard').classList.remove('hidden');
    renderResults();
    renderSubPreview();
  }

  function renderResults() {
    var p = S.plan;
    var a = S.analysis;
    $('#stOrig').textContent = fmtTime(p.originalDuration);
    $('#stNew').textContent = fmtTime(p.newDuration);
    var saved = p.originalDuration - p.newDuration;
    $('#stSaved').textContent = '−' + fmtDur(saved) + ' (' + Math.round(100 * saved / Math.max(1e-6, p.originalDuration)) + '%)';
    $('#thresholdInfo').textContent = 'eşik ' + p.threshold.toFixed(1) + ' dB';
    $('#levelInfo').textContent = 'gürültü ' + a.levels.noise.toFixed(0) + ' dB · konuşma ' + a.levels.speech.toFixed(0) + ' dB · eşik ' + p.threshold.toFixed(1) + ' dB';
    var chips = [
      '<span class="chip">Boşluk <b>' + p.stats.silence.count + '</b> <i>' + fmtDur(p.stats.silence.total) + '</i></span>',
      '<span class="chip">Takılma <b>' + p.stats.filler.count + '</b> <i>' + fmtDur(p.stats.filler.total) + '</i></span>'
    ];
    if (S.settings.tasks.multicam) chips.push('<span class="chip">Kamera geçişi <b>' + p.cameraSwitches + '</b></span>');
    if (a.words) chips.push('<span class="chip">Kelime <b>' + a.words.length + '</b></span>');
    $('#chips').innerHTML = chips.join('');
    var cams = {};
    p.shots.forEach(function (s) { cams[s.cam] = true; });
    $('#camLegend').innerHTML = Object.keys(cams).map(function (c) {
      return '<span><i class="sw" style="background:' + CAM_COLORS[c % CAM_COLORS.length] + '"></i>V' + (+c + 1) + '</span>';
    }).join(' ');
    drawOverview();
    renderRows();
  }

  function drawOverview() {
    var cv = $('#overview');
    var p = S.plan, a = S.analysis;
    if (!p || !a) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 380, h = 74;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var dur = a.duration;
    var env = a.envDb;
    var n = env.length;
    var lo = a.levels.noise - 6, hi = Math.max(a.levels.speech + 6, lo + 20);
    var waveH = 52;
    // dalga formu
    g.fillStyle = '#5b6b7d';
    for (var x = 0; x < w; x++) {
      var i0 = Math.floor(x / w * n), i1 = Math.max(i0 + 1, Math.floor((x + 1) / w * n));
      var mx = -200;
      for (var i = i0; i < i1 && i < n; i++) if (env[i] > mx) mx = env[i];
      var v = Math.max(0, Math.min(1, (mx - lo) / (hi - lo)));
      var bh = v * (waveH - 4);
      g.fillRect(x, (waveH - bh) / 2, 1, Math.max(1, bh));
    }
    // eşik çizgisi
    var tv = Math.max(0, Math.min(1, (p.threshold - lo) / (hi - lo))) * (waveH - 4);
    g.strokeStyle = 'rgba(227,165,42,.6)';
    g.beginPath();
    g.moveTo(0, (waveH - tv) / 2 + 0.5); g.lineTo(w, (waveH - tv) / 2 + 0.5);
    g.moveTo(0, (waveH + tv) / 2 + 0.5); g.lineTo(w, (waveH + tv) / 2 + 0.5);
    g.stroke();
    // kesimler
    p.rows.forEach(function (r) {
      var x0 = r.start / dur * w, x1 = r.end / dur * w;
      g.fillStyle = !r.enabled ? 'rgba(130,130,130,.35)' : (r.type === 'filler' ? 'rgba(240,136,62,.55)' : 'rgba(229,83,75,.45)');
      g.fillRect(x0, 0, Math.max(1, x1 - x0), waveH);
    });
    // kamera şeridi (orijinal zamana eşlenmiş)
    if (p.shots.length) {
      var map = timeline.createTimeMap(p.keepSec);
      p.shots.forEach(function (s) {
        var x0 = map.toOrig(s.start) / dur * w, x1 = map.toOrig(s.end) / dur * w;
        g.fillStyle = CAM_COLORS[s.cam % CAM_COLORS.length];
        g.fillRect(x0, waveH + 6, Math.max(1, x1 - x0), 12);
      });
    } else {
      g.fillStyle = '#333';
      g.fillRect(0, waveH + 6, w, 12);
      g.fillStyle = '#777';
      g.font = '10px sans-serif';
      g.fillText(S.settings.tasks.multicam ? 'Kamera eşlemesi yapılmadı' : 'Çoklu kamera kapalı', 6, waveH + 16);
    }
  }

  function renderRows() {
    var p = S.plan;
    var filter = $('#rowFilter').value;
    var rows = p.rows.filter(function (r) {
      if (filter === 'off') return !r.enabled;
      if (filter === 'all') return true;
      return r.type === filter;
    });
    var LIMIT = 600;
    var html = rows.slice(0, LIMIT).map(function (r) {
      var label = r.type === 'filler' ? (r.source === 'acoustic' ? 'Uzatma (akustik)' : r.label) : r.label;
      var ctx = r.context ? ' <span class="ctx">' + esc(r.context.replace(/^… /, '')) + '</span>' : '';
      return '<div class="rowi' + (r.enabled ? '' : ' off') + '" data-id="' + esc(r.id) + '" title="' + esc(r.context || label) + '">' +
        '<input type="checkbox"' + (r.enabled ? ' checked' : '') + '>' +
        '<span>' + fmtTime(r.start, true) + '</span>' +
        '<span class="muted">' + (r.end - r.start).toFixed(1) + 's</span>' +
        '<span class="lbl"><span class="tag ' + r.type + '"></span>' + esc(label) + ctx + '</span>' +
        '<button title="Oynatma kafasını buraya taşı">▶</button>' +
        '</div>';
    }).join('');
    if (rows.length > LIMIT) html += '<div class="more">+' + (rows.length - LIMIT) + ' kayıt daha (filtre kullanın)</div>';
    if (!rows.length) html = '<div class="more">Kayıt yok</div>';
    $('#rows').innerHTML = html;
  }

  function onRowsClick(ev) {
    var row = ev.target.closest('.rowi');
    if (!row) return;
    var id = row.getAttribute('data-id');
    var r = null;
    S.plan.rows.forEach(function (x) { if (x.id === id) r = x; });
    if (!r) return;
    if (ev.target.tagName === 'BUTTON') {
      seek(Math.max(0, r.start - 0.6));
    } else if (ev.target.tagName === 'INPUT') {
      if (ev.target.checked) delete S.disabled[id]; else S.disabled[id] = true;
      runPlan();
    }
  }

  function seek(t) {
    if (!S.analysis) return;
    PKHost.call('setPlayhead', S.analysis.sequenceId, t).catch(function (e) { log(e.message, 'warn'); });
  }

  function setAll(on) {
    if (!S.plan) return;
    var filter = $('#rowFilter').value;
    var match = function (r) { return filter === 'all' || filter === 'off' || r.type === filter; };
    // Bir takılma kapatılınca çevresindeki boşluk ayrı bir satır olarak çıkabilir: kararlı olana kadar tekrarla
    for (var pass = 0; pass < 4; pass++) {
      var changed = false;
      S.plan.rows.forEach(function (r) {
        if (!match(r) || r.enabled === on) return;
        if (on) delete S.disabled[r.id]; else S.disabled[r.id] = true;
        changed = true;
      });
      S.plan = planner.plan(S.analysis, S.settings, S.disabled);
      if (!changed) break;
    }
    runPlan();
  }

  // ------------------------------------------------------------------ altyazı
  function buildCues(useCuts) {
    var a = S.analysis;
    if (!a || !a.words) return [];
    var map = useCuts && S.plan ? timeline.createTimeMap(S.plan.keepSec) : null;
    var set = fillersLib.parseFillerList(get('fillers.words'));
    return subtitles.buildCues(a.words, map, set, S.settings.subtitles);
  }

  function willCreateSequence() {
    var p = S.plan;
    if (!p || get('output.mode') !== 'sequence') return false;
    return !!(p.hasCuts || (S.settings.tasks.multicam && p.shots.length > 1));
  }

  function renderSubPreview() {
    var box = $('#subPreview');
    if (!S.analysis || !S.analysis.words) {
      box.innerHTML = '<p class="muted">Altyazı için "Altyazı ekle" görevini açıp analiz edin.</p>';
      $('#subCount').textContent = '';
      return;
    }
    var cues = buildCues(willCreateSequence());
    $('#subCount').textContent = cues.length + ' altyazı';
    box.innerHTML = cues.slice(0, 200).map(function (c) {
      return '<div class="cue"><time>' + fmtTime(c.start, true) + '</time><div>' + c.lines.map(esc).join('<br>') + '</div></div>';
    }).join('') + (cues.length > 200 ? '<p class="muted">…</p>' : '');
  }

  function saveText(defName, ext, content) {
    var target = PKHost.saveDialog('Kaydet', defName, [ext]);
    if (!target) {
      target = path.join(S.dirs.work, defName);
    }
    if (!new RegExp('\\.' + ext + '$', 'i').test(target)) target += '.' + ext;
    fs.writeFileSync(target, content, 'utf8');
    log('Kaydedildi: ' + target, 'ok');
    return target;
  }

  // ------------------------------------------------------------------ uygula
  function cameraTracks() {
    var m = get('multicam.speakers') || {};
    var cams = [];
    Object.keys(m).forEach(function (k) { if (+m[k] >= 0 && cams.indexOf(+m[k]) < 0) cams.push(+m[k]); });
    var w = +get('multicam.wideTrack');
    if (w >= 0 && cams.indexOf(w) < 0) cams.push(w);
    return cams;
  }

  async function apply() {
    if (S.busy || !S.plan) return;
    var a = S.analysis, p = S.plan, s = S.settings;
    setBusy(true);
    try {
      // Analizden sonra zaman çizelgesi değiştiyse kesimler yanlış yere düşer: önce doğrula
      var now = (await PKHost.call('getSequenceInfo', a.sequenceId)).sequence;
      if (now.id !== a.sequenceId || timeline.sequenceFingerprint(now) !== a.fingerprint) {
        log('Sekans analizden sonra değiştirilmiş (ya da bulunamadı). Lütfen yeniden analiz edin.', 'err');
        return;
      }
      var base = paths.safeName(a.sequenceName) + '-' + stamp();
      if (s.output.mode === 'markers') {
        await applyMarkers();
        if (s.tasks.subtitles && a.words) await addCaptions(a.sequenceId, buildCues(false), base);
        return;
      }
      var target = a.sequenceId;
      if (willCreateSequence()) {
        setProgress(0.2, 'Sekans XML olarak dışa aktarılıyor…');
        var srcXml = path.join(S.dirs.work, base + '-kaynak.xml');
        await PKHost.call('exportXml', a.sequenceId, srcXml);
        setProgress(0.5, 'Kesimler uygulanıyor…');
        var res = fcpxml.transform(fs.readFileSync(srcXml, 'utf8'), p.pieces, {
          cameraTracks: s.tasks.multicam ? cameraTracks() : [],
          inactiveMode: s.multicam.inactiveMode,
          sequenceName: a.sequenceName + (s.output.suffix || ''),
          fps: a.fps
        }, { DOMParser: window.DOMParser, XMLSerializer: window.XMLSerializer });
        res.warnings.forEach(function (w) { log(w, 'warn'); });
        if (res.stats.transitionsRemoved) log(res.stats.transitionsRemoved + ' geçiş efekti kaldırıldı (kesimlerle uyumsuz).', 'warn');
        var outXml = path.join(S.dirs.work, base + '.xml');
        fs.writeFileSync(outXml, res.xml, 'utf8');
        setProgress(0.75, 'Yeni sekans Premiere\'e aktarılıyor…');
        var imp = await PKHost.call('importXml', outXml, a.sequenceName + (s.output.suffix || ''), BIN);
        target = imp.id;
        log('Yeni sekans oluşturuldu: "' + imp.name + '" (' + fmtTime(p.newDuration) + ', ' + res.stats.clipsOut + ' klip)', 'ok');
      } else if (!s.tasks.subtitles) {
        log('Uygulanacak kesim ya da kamera değişikliği yok.', 'warn');
      }
      if (s.tasks.subtitles && a.words) {
        setProgress(0.9, 'Altyazılar ekleniyor…');
        await addCaptions(target, buildCues(willCreateSequence()), base);
      }
      setProgress(1, 'Tamamlandı');
    } catch (e) {
      log('Uygulama hatası: ' + e.message, 'err');
    } finally {
      setBusy(false);
      setTimeout(function () { if (!S.busy) $('#progressWrap').classList.add('hidden'); }, 1500);
    }
  }

  async function addCaptions(seqId, cues, base) {
    if (!cues.length) { log('Altyazı oluşturulacak kelime yok.', 'warn'); return; }
    var srtPath = path.join(S.dirs.work, base + '.srt');
    fs.writeFileSync(srtPath, subtitles.toSrt(cues), 'utf8');
    try {
      await PKHost.call('importCaptions', seqId, srtPath, BIN);
      log(cues.length + ' altyazı eklendi (altyazı kanalı oluşturuldu).', 'ok');
    } catch (e) {
      if (e.code === 'NO_CAPTION_API') log(e.message, 'warn');
      else throw e;
    }
  }

  async function applyMarkers() {
    var a = S.analysis, p = S.plan;
    var markers = p.rows.filter(function (r) { return r.enabled; }).map(function (r) {
      return {
        start: r.start,
        end: r.end,
        name: r.type === 'filler' ? 'Takılma: ' + r.label : 'Boşluk',
        comment: (r.context || r.label) + ' (' + (r.end - r.start).toFixed(2) + ' sn)',
        color: r.type === 'filler' ? 3 : 1
      };
    });
    if (S.settings.tasks.multicam && p.shots.length) {
      var map = timeline.createTimeMap(p.keepSec);
      p.shots.forEach(function (s) {
        markers.push({ start: map.toOrig(s.start), end: 0, name: 'Kamera V' + (s.cam + 1), comment: 'kamera geçişi', color: 6 });
      });
    }
    var res = await PKHost.call('addMarkers', a.sequenceId, markers);
    log(res.count + ' işaretçi eklendi. Kırmızı: boşluk, turuncu: takılma, mavi: kamera.', 'ok');
  }

  // ------------------------------------------------------------------ çeşitli
  function switchTab(name) {
    $$('#tabs button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.id === 'tab-' + name); });
    if (name === 'main' && S.plan) drawOverview();
  }

  function openFolder(p) {
    try {
      var cmd = process.platform === 'win32' ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      childProcess.spawn(cmd, [p], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      log('Klasör açılamadı: ' + p, 'warn');
    }
  }

  function clearCache() {
    var n = 0;
    [S.dirs.cache, S.dirs.work].forEach(function (d) {
      try {
        fs.readdirSync(d).forEach(function (f) {
          try { fs.unlinkSync(path.join(d, f)); n++; } catch (e) { /* yoksay */ }
        });
      } catch (e) { /* yoksay */ }
    });
    log(n + ' geçici dosya silindi.', 'ok');
  }

  function bindUI() {
    $$('#tabs button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });
    $('#btnRefresh').addEventListener('click', function () { refreshSequence(false).then(function () { updateReanalyzeNote(); }); });
    $('#btnAnalyze').addEventListener('click', analyze);
    $('#btnCancel').addEventListener('click', cancelWork);
    $('#btnApply').addEventListener('click', apply);
    $('#rows').addEventListener('click', onRowsClick);
    $('#rowFilter').addEventListener('change', renderRows);
    $('#btnAllOn').addEventListener('click', function () { setAll(true); });
    $('#btnAllOff').addEventListener('click', function () { setAll(false); });
    $('#overview').addEventListener('click', function (ev) {
      if (!S.analysis) return;
      var rect = ev.currentTarget.getBoundingClientRect();
      seek((ev.clientX - rect.left) / rect.width * S.analysis.duration);
    });
    $('#btnSaveSrt').addEventListener('click', function () {
      var cues = buildCues(willCreateSequence());
      if (!cues.length) { log('Önce altyazı görevini açıp analiz edin.', 'warn'); return; }
      saveText(paths.safeName(S.analysis.sequenceName) + '.srt', 'srt', subtitles.toSrt(cues));
    });
    $('#btnSaveTxt').addEventListener('click', function () {
      var cues = buildCues(willCreateSequence());
      if (!cues.length) { log('Önce altyazı görevini açıp analiz edin.', 'warn'); return; }
      saveText(paths.safeName(S.analysis.sequenceName) + '-transkript.txt', 'txt', '﻿' + subtitles.toTranscript(cues));
    });
    $('#btnClearMarkers').addEventListener('click', function () {
      var id = S.analysis ? S.analysis.sequenceId : (S.seq ? S.seq.id : null);
      PKHost.call('clearMarkers', id).then(function (r) { log(r.removed + ' işaretçi silindi.', 'ok'); }, function (e) { log(e.message, 'err'); });
    });
    $('#btnRecheck').addEventListener('click', scanTools);
    $('#btnOpenTools').addEventListener('click', function () { openFolder(S.dirs.root); });
    $('#btnClearCache').addEventListener('click', clearCache);
    $('#btnReset').addEventListener('click', function () {
      S.settings = settingsLib.defaults();
      saveSettings();
      renderSettings();
      renderTracks();
      renderCamMap();
      log('Ayarlar varsayılana döndü.', 'ok');
      schedulePlan();
    });
    $$('[data-browse]').forEach(function (b) {
      b.addEventListener('click', function () {
        var f = PKHost.openDialog('Dosya seçin', ['exe']);
        if (f) {
          var key = b.getAttribute('data-browse');
          $('[data-k="' + key + '"]').value = f;
          onSettingChange(key, f);
        }
      });
    });
    window.addEventListener('resize', function () { if (S.plan) drawOverview(); });
  }

  async function init() {
    bindSettings();
    initPresets();
    renderSettings();
    bindUI();
    scanTools();
    try { paths.cleanWork(S.dirs, 48); } catch (e) { /* yoksay */ }
    var info = 'Sürüm ' + VERSION;
    if (PKHost.inCEP()) {
      try {
        var r = await PKHost.call('ping');
        info += ' · Premiere Pro ' + r.app;
      } catch (e) {
        log('Premiere bağlantısı kurulamadı: ' + e.message, 'err');
      }
      await refreshSequence(true);
    }
    if (S.tools.ffmpeg) {
      ffmpegLib.version(S.tools.ffmpeg).then(function (v) {
        $('#versionInfo').textContent = info + (v ? ' · FFmpeg ' + v : '');
      });
    }
    $('#versionInfo').textContent = info;
    if (!S.tools.ffmpeg) log('İlk kurulum: Ayarlar sekmesinden FFmpeg\'i (ve isterseniz Whisper modelini) indirin.', 'warn');
  }

  window.PKApp = { state: S, runPlan: runPlan, analyze: analyze, apply: apply, switchTab: switchTab };
  init();
}());
