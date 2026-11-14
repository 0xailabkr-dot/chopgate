/* ChopGate home: language switch.
   Same storage key and button as the other pages (localStorage "chopgate-c1-lang", #lang-btn).
   Strings live in ./i18n/home.en.json and ./i18n/home.ko.json. The English text in the markup is the fallback. */
(function () {
  'use strict';

  var KEY = 'chopgate-c1-lang';
  var FILES = { en: './i18n/home.en.json', ko: './i18n/home.ko.json' };
  var cache = {};
  var lang = 'en';
  var btn = document.getElementById('lang-btn');

  function load(name) {
    if (cache[name]) { return Promise.resolve(cache[name]); }
    return fetch(FILES[name], { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) { throw new Error('i18n ' + r.status); } return r.json(); })
      .then(function (j) { cache[name] = j; return j; });
  }

  function apply(s) {
    document.documentElement.lang = s.htmlLang || lang;
    if (s.title) { document.title = s.title; }
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (s[key] != null && s[key] !== '') { nodes[i].textContent = s[key]; }
    }
    if (btn) {
      if (s.langButton) { btn.textContent = s.langButton; }
      if (s.langButtonAria) { btn.setAttribute('aria-label', s.langButtonAria); }
    }
  }

  function show(name) {
    return load(name).then(function (s) { lang = name; apply(s); });
  }

  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'ko' || saved === 'en') { lang = saved; }
  } catch (e) { /* storage blocked: keep English */ }

  if (btn) {
    btn.addEventListener('click', function () {
      var next = lang === 'en' ? 'ko' : 'en';
      show(next).then(function () {
        try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
      }).catch(function () { /* keep the current language if the file cannot be read */ });
    });
  }

  if (lang !== 'en') { show(lang).catch(function () { lang = 'en'; }); }
})();
