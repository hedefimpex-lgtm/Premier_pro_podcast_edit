/*
 * Adobe CEP için küçük yardımcı katman (CSInterface.js'in ihtiyaç duyulan kısmı).
 */
(function (global) {
  'use strict';

  var cep = global.__adobe_cep__;

  function inCEP() {
    return !!cep;
  }

  /** Dizedeki ASCII dışı karakterleri \uXXXX'e çevirir (ExtendScript'e güvenli aktarım). */
  function jsxLiteral(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  /** PK.<fn>(args...) çağırır, JSON sonucu çözümler. */
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1).map(jsxLiteral).join(',');
    var script = 'PK.' + fn + '(' + args + ')';
    return new Promise(function (resolve, reject) {
      if (!cep) {
        reject(new Error('Premiere Pro bağlantısı yok (panel CEP dışında çalışıyor).'));
        return;
      }
      cep.evalScript(script, function (res) {
        if (res === 'EvalScript error.' || res === undefined || res === null) {
          reject(new Error('ExtendScript hatası: ' + fn + ' (host.jsx yüklenemedi mi?)'));
          return;
        }
        var data;
        try {
          data = JSON.parse(res);
        } catch (e) {
          reject(new Error('Beklenmeyen yanıt: ' + String(res).slice(0, 200)));
          return;
        }
        if (data && data.ok === false) {
          var err = new Error(data.error || data.code || 'Bilinmeyen hata');
          err.code = data.code;
          err.data = data;
          reject(err);
          return;
        }
        resolve(data);
      });
    });
  }

  function extensionPath() {
    if (!cep) return null;
    var p = decodeURI(cep.getSystemPath('extension'));
    if (/^file:\/{3}[A-Za-z]:/.test(p)) return p.replace(/^file:\/{3}/, '');
    return p.replace(/^file:\/\//, '');
  }

  function hostEnv() {
    try { return JSON.parse(cep.getHostEnvironment()); } catch (e) { return null; }
  }

  function openUrl(url) {
    try {
      if (global.cep && global.cep.util) global.cep.util.openURLInDefaultBrowser(url);
    } catch (e) { /* yoksay */ }
  }

  function saveDialog(title, defaultName, types) {
    try {
      if (global.cep && global.cep.fs && global.cep.fs.showSaveDialogEx) {
        var r = global.cep.fs.showSaveDialogEx(title, '', types || [], defaultName || '');
        return r && r.err === 0 && r.data ? r.data : null;
      }
    } catch (e) { /* yoksay */ }
    return null;
  }

  function openDialog(title, types) {
    try {
      if (global.cep && global.cep.fs && global.cep.fs.showOpenDialogEx) {
        var r = global.cep.fs.showOpenDialogEx(false, false, title, '', types || []);
        return r && r.err === 0 && r.data && r.data.length ? r.data[0] : null;
      }
    } catch (e) { /* yoksay */ }
    return null;
  }

  global.PKHost = {
    inCEP: inCEP,
    call: call,
    jsxLiteral: jsxLiteral,
    extensionPath: extensionPath,
    hostEnv: hostEnv,
    openUrl: openUrl,
    saveDialog: saveDialog,
    openDialog: openDialog
  };
}(window));
