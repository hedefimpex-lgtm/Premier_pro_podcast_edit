/*
 * Podcast Kurgu Asistani - Premiere Pro ExtendScript koprusu.
 * ES3 uyumludur (ExtendScript). Tum donus degerleri JSON metnidir.
 * Not: Dosya ASCII tutulur; Turkce karakterler \u kacislariyla yazilir.
 */

var PK = (function () {
    var TICKS = 254016000000;
    var VERSION = '1.0.0';

    // ---------- JSON ----------
    function quote(s) {
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            var c = s.charCodeAt(i);
            if (ch === '"') { out += '\\"'; }
            else if (ch === '\\') { out += '\\\\'; }
            else if (c < 32 || c > 126) {
                var h = c.toString(16);
                while (h.length < 4) { h = '0' + h; }
                out += '\\u' + h;
            } else { out += ch; }
        }
        return out + '"';
    }

    function toJSON(v) {
        if (v === null || v === undefined) { return 'null'; }
        var t = typeof v;
        if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
        if (t === 'boolean') { return v ? 'true' : 'false'; }
        if (t === 'string') { return quote(v); }
        var parts = [];
        var i;
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) { parts.push(toJSON(v[i])); }
            return '[' + parts.join(',') + ']';
        }
        for (var k in v) {
            if (v.hasOwnProperty(k)) { parts.push(quote(k) + ':' + toJSON(v[k])); }
        }
        return '{' + parts.join(',') + '}';
    }

    function ok(data) {
        var r = data || {};
        r.ok = true;
        return toJSON(r);
    }

    function fail(code, msg, extra) {
        var r = extra || {};
        r.ok = false;
        r.code = code;
        r.error = msg || code;
        return toJSON(r);
    }

    function wrap(fn) {
        return function () {
            try {
                return fn.apply(null, arguments);
            } catch (e) {
                return fail('EXCEPTION', String(e) + (e.line ? (' (satir ' + e.line + ')') : ''));
            }
        };
    }

    // ---------- yardimcilar ----------
    function secondsOf(t) {
        if (t === undefined || t === null) { return 0; }
        if (typeof t === 'number') { return t; }
        if (t.seconds !== undefined) { return Number(t.seconds); }
        if (t.ticks !== undefined) { return Number(t.ticks) / TICKS; }
        return Number(t);
    }

    function findSequence(id) {
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            if (String(seqs[i].sequenceID) === String(id)) { return seqs[i]; }
        }
        return null;
    }

    function seqOrActive(id) {
        var s = id ? findSequence(id) : null;
        return s || app.project.activeSequence;
    }

    function sequenceIds() {
        var map = {};
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) { map[String(seqs[i].sequenceID)] = true; }
        return map;
    }

    function normPath(p) {
        return String(p || '').replace(/\\/g, '/').toLowerCase();
    }

    function findItemByPath(item, target, name, depth) {
        if (!item || depth > 8) { return null; }
        var n = item.children ? item.children.numItems : 0;
        for (var i = 0; i < n; i++) {
            var c = item.children[i];
            var p = '';
            try { p = c.getMediaPath(); } catch (e1) { p = ''; }
            if ((p && normPath(p) === target) || (name && c.name === name)) { return c; }
            if (c.type === 2) { // BIN
                var r = findItemByPath(c, target, name, depth + 1);
                if (r) { return r; }
            }
        }
        return null;
    }

    function getOrCreateBin(name) {
        var root = app.project.rootItem;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            if (c.type === 2 && c.name === name) { return c; }
        }
        var bin = root.createBin(name);
        if (bin) { return bin; }
        for (i = 0; i < root.children.numItems; i++) {
            if (root.children[i].type === 2 && root.children[i].name === name) { return root.children[i]; }
        }
        return root;
    }

    // ---------- API ----------
    function ping() {
        return ok({ version: VERSION, app: app.version, build: app.build });
    }

    function getSequenceInfo(seqId) {
        var seq = seqOrActive(seqId);
        if (!seq) { return fail('NO_SEQUENCE', 'Aktif sekans yok'); }
        var timebase = Number(seq.timebase);
        var fps = timebase > 0 ? TICKS / timebase : 30;
        var info = {
            id: String(seq.sequenceID),
            name: seq.name,
            fps: fps,
            duration: Number(seq.end) / TICKS,
            videoTracks: [],
            audioTracks: []
        };
        var i, j, t;
        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            t = seq.videoTracks[i];
            info.videoTracks.push({ index: i, name: t.name, clips: t.clips.numItems, muted: safeMuted(t) });
        }
        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            t = seq.audioTracks[i];
            var clips = [];
            for (j = 0; j < t.clips.numItems; j++) {
                var c = t.clips[j];
                var path = '';
                try { path = c.projectItem ? c.projectItem.getMediaPath() : ''; } catch (e2) { path = ''; }
                var disabled = false;
                try { disabled = c.disabled === true; } catch (e3) { disabled = false; }
                var speed = 1;
                try { speed = c.getSpeed ? Number(c.getSpeed()) : 1; } catch (e4) { speed = 1; }
                clips.push({
                    name: c.name,
                    path: path,
                    start: secondsOf(c.start),
                    end: secondsOf(c.end),
                    inPoint: secondsOf(c.inPoint),
                    outPoint: secondsOf(c.outPoint),
                    disabled: disabled,
                    speed: speed
                });
            }
            info.audioTracks.push({ index: i, name: t.name, muted: safeMuted(t), clips: clips });
        }
        return ok({ sequence: info });
    }

    function safeMuted(t) {
        try { return t.isMuted() ? true : false; } catch (e) { return false; }
    }

    function exportXml(seqId, outPath) {
        var seq = seqOrActive(seqId);
        if (!seq) { return fail('NO_SEQUENCE', 'Sekans bulunamadi'); }
        var f = new File(outPath);
        if (f.exists) { f.remove(); }
        var res = seq.exportAsFinalCutProXML(outPath, 1);
        f = new File(outPath);
        if (!f.exists) { return fail('EXPORT_FAILED', 'XML disa aktarilamadi', { result: String(res) }); }
        return ok({ path: outPath });
    }

    function importXml(xmlPath, expectedName, binName) {
        var before = sequenceIds();
        var bin = getOrCreateBin(binName || 'Podcast Kurgu');
        var res = app.project.importFiles([xmlPath], true, bin, false);
        var seqs = app.project.sequences;
        var found = null;
        for (var i = 0; i < seqs.numSequences; i++) {
            var s = seqs[i];
            if (!before[String(s.sequenceID)]) {
                if (!found || s.name === expectedName) { found = s; }
            }
        }
        if (!found) { return fail('IMPORT_FAILED', 'XML ice aktarildi ama yeni sekans bulunamadi', { result: String(res) }); }
        try { app.project.openSequence(found.sequenceID); } catch (e1) { /* yoksay */ }
        try { app.project.activeSequence = found; } catch (e2) { /* yoksay */ }
        return ok({ id: String(found.sequenceID), name: found.name });
    }

    function addMarkers(seqId, markers) {
        var seq = seqOrActive(seqId);
        if (!seq) { return fail('NO_SEQUENCE', 'Sekans bulunamadi'); }
        var count = 0;
        for (var i = 0; i < markers.length; i++) {
            var m = markers[i];
            var mk = seq.markers.createMarker(m.start);
            if (!mk) { continue; }
            mk.name = m.name || '';
            mk.comments = 'PK: ' + (m.comment || '');
            if (m.end > m.start) {
                try { mk.end = m.end; } catch (e1) { /* eski surumler */ }
            }
            if (m.color !== undefined) {
                try { mk.setColorByIndex(m.color); } catch (e2) { /* eski surumler */ }
            }
            count++;
        }
        return ok({ count: count });
    }

    function clearMarkers(seqId) {
        var seq = seqOrActive(seqId);
        if (!seq) { return fail('NO_SEQUENCE', 'Sekans bulunamadi'); }
        var markers = seq.markers;
        var m = markers.getFirstMarker();
        var removed = 0;
        while (m) {
            var next = markers.getNextMarker(m);
            if (String(m.comments).indexOf('PK:') === 0) {
                markers.deleteMarker(m);
                removed++;
            }
            m = next;
        }
        return ok({ removed: removed });
    }

    function importCaptions(seqId, srtPath, binName) {
        var seq = seqOrActive(seqId);
        if (!seq) { return fail('NO_SEQUENCE', 'Sekans bulunamadi'); }
        var bin = getOrCreateBin(binName || 'Podcast Kurgu');
        app.project.importFiles([srtPath], true, bin, false);
        var fileName = new File(srtPath).name;
        try { fileName = decodeURI(fileName); } catch (e0) { /* yoksay */ }
        var item = findItemByPath(app.project.rootItem, normPath(srtPath), fileName, 0);
        if (!item) { return fail('CAPTION_IMPORT_FAILED', 'Altyazi dosyasi projeye eklenemedi'); }
        var created = false;
        try {
            var fmt = (typeof Sequence !== 'undefined' && Sequence.CAPTION_FORMAT_SUBTITLE !== undefined) ? Sequence.CAPTION_FORMAT_SUBTITLE : undefined;
            created = fmt !== undefined ? seq.createCaptionTrack(item, 0, fmt) : seq.createCaptionTrack(item, 0);
        } catch (e1) {
            return fail('NO_CAPTION_API', 'Bu Premiere surumu altyazi kanali olusturmayi desteklemiyor; SRT projeye eklendi, zaman cizelgesine surukleyin.', { imported: true });
        }
        return ok({ created: created !== false, item: item.name });
    }

    function setPlayhead(seqId, seconds) {
        var seq = seqOrActive(seqId);
        if (!seq) { return fail('NO_SEQUENCE', 'Sekans bulunamadi'); }
        seq.setPlayerPosition(String(Math.round(seconds * TICKS)));
        return ok({});
    }

    function activeSequenceId() {
        var seq = app.project.activeSequence;
        return ok({ id: seq ? String(seq.sequenceID) : null, name: seq ? seq.name : null });
    }

    function projectPath() {
        return ok({ path: app.project.path || '' });
    }

    return {
        ping: wrap(ping),
        getSequenceInfo: wrap(getSequenceInfo),
        exportXml: wrap(exportXml),
        importXml: wrap(importXml),
        addMarkers: wrap(addMarkers),
        clearMarkers: wrap(clearMarkers),
        importCaptions: wrap(importCaptions),
        setPlayhead: wrap(setPlayhead),
        activeSequenceId: wrap(activeSequenceId),
        projectPath: wrap(projectPath)
    };
}());

if (typeof $ !== 'undefined' && $.global) { $.global.PK = PK; }
