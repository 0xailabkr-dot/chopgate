/* ChopGate home: motion stage state machine.
   This file holds no user-facing text and never writes text. It only toggles
   classes/attributes and positions the coin element. */
(function () {
  'use strict';

  var demo = document.getElementById('hm-demo');
  var stage = document.getElementById('hm-stage');
  if (!demo || !stage) { return; }

  document.documentElement.classList.add('hm-js');

  var coin = stage.querySelector('.hm-coin');
  var fx = Array.prototype.slice.call(stage.querySelectorAll('.hm-fx[data-k]'));
  var caps = Array.prototype.slice.call(demo.querySelectorAll('.hm-cap'));
  var dots = Array.prototype.slice.call(demo.querySelectorAll('[data-scene-btn]'));
  var btnPrev = document.getElementById('hm-prev');
  var btnNext = document.getElementById('hm-next');
  var btnToggle = document.getElementById('hm-toggle');

  var BASE = {
    slip: '1', chip: 'closed', rule: 0, jobs: 0, used: 0, bal: '100', rcv: 0,
    approval: 0, ledger: 0, pos: 'home', doors: 'shut', shake: '0', coin: 'none'
  };

  var SCENES = {
    1: { dur: 4500, steps: [
      { t: 0, p: {} },
      { t: 600, p: { pos: 'push', chip: 'checking' } },
      { t: 1300, p: { pos: 'back', chip: 'refused', shake: '1', ledger: 1 } },
      { t: 2400, p: { pos: 'home' } }
    ] },
    2: { dur: 4500, steps: [
      { t: 0, p: { ledger: 1 } },
      { t: 500, p: { jobs: 1 } },
      { t: 1300, p: { jobs: 2 } },
      { t: 1800, p: { jobs: 3 } }
    ] },
    3: { dur: 4500, steps: [
      { t: 0, p: { jobs: 3, ledger: 1, slip: '3' } },
      { t: 500, p: { pos: 'push', chip: 'checking' } },
      { t: 1500, p: { chip: 'open', doors: 'open', coin: 'escrow' } },
      { t: 2000, p: { coin: 'rcv1', bal: '099' } },
      { t: 2600, p: { coin: 'none', rcv: 1, used: 1, ledger: 2 } },
      { t: 3400, p: { pos: 'home' } }
    ] },
    4: { dur: 6000, steps: [
      { t: 0, p: { jobs: 3, used: 1, bal: '099', rcv: 1, ledger: 2, slip: '4a' } },
      { t: 300, p: { pos: 'push', chip: 'checking' } },
      { t: 800, p: { pos: 'back', chip: 'refused', shake: '1', ledger: 3 } },
      { t: 1400, p: { slip: '4b', pos: 'home', chip: 'closed' } },
      { t: 1700, p: { pos: 'push', chip: 'checking' } },
      { t: 2200, p: { pos: 'back', chip: 'refused', shake: '2', ledger: 4 } },
      { t: 2800, p: { slip: '4c', pos: 'home', chip: 'closed' } },
      { t: 3100, p: { pos: 'push', chip: 'checking' } },
      { t: 3600, p: { pos: 'back', chip: 'refused', shake: '3', ledger: 5 } }
    ] },
    5: { dur: 7000, steps: [
      { t: 0, p: { jobs: 3, used: 1, bal: '099', rcv: 1, ledger: 5, slip: '5', rule: 1 } },
      { t: 400, p: { pos: 'push', chip: 'checking' } },
      { t: 1000, p: { chip: 'holding', coin: 'escrow' } },
      { t: 1300, p: { coin: 'held', ledger: 6, approval: 1 } },
      { t: 3800, p: { approval: 2 } },
      { t: 4300, p: { chip: 'open', doors: 'open', coin: 'rcv2' } },
      { t: 4900, p: { coin: 'none', rcv: 2, used: 2, ledger: 7, bal: '091', pos: 'home' } }
    ] }
  };
  var COUNT = 5;

  var scene = 1;
  var step = 0;
  var cur = null;
  var playing = false;   /* auto-advancing loop */
  var once = false;      /* playing through one scene after a manual change */
  var wantAuto = true;   /* the visitor has not paused */
  var inView = false;
  var timers = [];
  var lastCoin = 'none';

  function assign(target, src) {
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) { target[k] = src[k]; }
    }
    return target;
  }

  function stateAt(n, i) {
    var st = assign({}, BASE);
    var steps = SCENES[n].steps;
    for (var j = 0; j <= i; j++) { assign(st, steps[j].p); }
    return st;
  }

  function placeCoin(name, jump) {
    if (!coin) { return; }
    var a = stage.querySelector('[data-anchor="' + name + '"]');
    if (!a) { return; }
    var ar = a.getBoundingClientRect();
    var sr = stage.getBoundingClientRect();
    var x = ar.left - sr.left - stage.clientLeft + (ar.width - coin.offsetWidth) / 2;
    var y = ar.top - sr.top - stage.clientTop + (ar.height - coin.offsetHeight) / 2;
    if (jump) { coin.classList.add('hm-jump'); }
    coin.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    if (jump) {
      void coin.offsetWidth;
      coin.classList.remove('hm-jump');
    }
  }

  function render() {
    var st = cur;
    var i;
    for (i = 0; i < fx.length; i++) {
      var el = fx[i];
      var val = st[el.getAttribute('data-k')];
      var on;
      if (el.hasAttribute('data-v')) {
        on = String(val) === el.getAttribute('data-v');
      } else {
        var min = el.getAttribute('data-min');
        var max = el.getAttribute('data-max');
        on = (min === null || val >= Number(min)) && (max === null || val <= Number(max));
      }
      el.classList.toggle('hm-on', on);
    }
    if (st.coin !== 'none') {
      placeCoin(st.coin, lastCoin === 'none');
    }
    lastCoin = st.coin;

    stage.setAttribute('data-scene', String(scene));
    stage.setAttribute('data-step', String(step + 1));
    stage.setAttribute('data-pos', st.pos);
    stage.setAttribute('data-doors', st.doors);
    stage.setAttribute('data-shake', st.shake);
    stage.setAttribute('data-coin', st.coin);
    stage.setAttribute('data-chip', st.chip);
    stage.setAttribute('data-slip', st.slip);

    for (i = 0; i < caps.length; i++) {
      caps[i].classList.toggle('hm-on', i === scene - 1);
    }
    for (i = 0; i < dots.length; i++) {
      if (Number(dots[i].getAttribute('data-scene-btn')) === scene) {
        dots[i].setAttribute('aria-current', 'true');
      } else {
        dots[i].removeAttribute('aria-current');
      }
    }
  }

  function setPlayingAttr() {
    demo.setAttribute('data-playing', playing ? 'true' : 'false');
  }

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) { clearTimeout(timers[i]); }
    demo.setAttribute('data-run', 'paused');
    timers = [];
  }

  function enter(n) {
    scene = n;
    step = 0;
    cur = stateAt(n, 0);
    render();
  }

  function setStep(i) {
    step = i;
    assign(cur, SCENES[scene].steps[i].p);
    render();
  }

  function snapToEnd() {
    step = SCENES[scene].steps.length - 1;
    cur = stateAt(scene, step);
    render();
  }

  function onEnd() {
    timers = [];
    if (playing) {
      enter(scene % COUNT + 1);
      schedule();
    } else {
      once = false;
    }
  }

  function schedule() {
    clearTimers();
    var sc = SCENES[scene];
    var t0 = sc.steps[step].t;
    demo.setAttribute('data-run', 'off');
    void demo.offsetWidth;
    demo.style.setProperty('--hm-dur', sc.dur + 'ms');
    demo.style.setProperty('--hm-t0', (-t0) + 'ms');
    demo.setAttribute('data-run', 'on');
    function at(i) {
      return function () { setStep(i); };
    }
    for (var i = step + 1; i < sc.steps.length; i++) {
      timers.push(setTimeout(at(i), sc.steps[i].t - t0));
    }
    timers.push(setTimeout(onEnd, sc.dur - t0));
  }

  function canRun() {
    return inView && !document.hidden;
  }

  function start() {
    playing = true;
    once = false;
    setPlayingAttr();
    schedule();
  }

  function suspend() {
    /* tab hidden or stage off-screen: no timers may keep running */
    if (once) {
      once = false;
      clearTimers();
      snapToEnd();
    }
    if (playing) {
      playing = false;
      clearTimers();
      setPlayingAttr();
    }
  }

  function resume() {
    if (wantAuto && !playing && canRun()) { start(); }
  }

  function play() {
    wantAuto = true;
    if (!playing && canRun()) { start(); }
  }

  function pause() {
    wantAuto = false;
    playing = false;
    once = false;
    clearTimers();
    setPlayingAttr();
  }

  function goTo(n) {
    n = Math.round(Number(n));
    if (!(n >= 1 && n <= COUNT)) { return; }
    pause();
    enter(n);
    if (canRun()) {
      /* play this one scene through, then stop */
      once = true;
      schedule();
    } else {
      snapToEnd();
    }
  }

  function prev() { goTo(scene === 1 ? COUNT : scene - 1); }
  function next() { goTo(scene === COUNT ? 1 : scene + 1); }
  function toggle() { if (playing) { pause(); } else { play(); } }

  /* controls */
  dots.forEach(function (d) {
    d.addEventListener('click', function () {
      goTo(d.getAttribute('data-scene-btn'));
    });
  });
  if (btnPrev) { btnPrev.addEventListener('click', prev); }
  if (btnNext) { btnNext.addEventListener('click', next); }
  if (btnToggle) { btnToggle.addEventListener('click', toggle); }

  /* keyboard: arrows anywhere in the demo; Space on the stage itself.
     On the buttons Space keeps its native "activate" behaviour, so the
     play/pause button still toggles with Space. */
  demo.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) { return; }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if ((e.key === ' ' || e.key === 'Spacebar') && e.target === stage) {
      e.preventDefault();
      toggle();
    }
  });

  /* visibility */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { suspend(); } else { resume(); }
  });

  if ('IntersectionObserver' in window) {
    var thresholds = [];
    for (var t = 0; t <= 20; t++) { thresholds.push(t / 20); }
    var io = new IntersectionObserver(function (entries) {
      var e = entries[entries.length - 1];
      var enough = e.intersectionRatio >= 0.35 ||
        (e.rootBounds && e.intersectionRect.height >= e.rootBounds.height * 0.35);
      inView = Boolean(e.isIntersecting && enough);
      if (inView) { resume(); } else { suspend(); }
    }, { threshold: thresholds });
    io.observe(stage);
  } else {
    inView = true;
  }

  window.addEventListener('resize', function () {
    if (cur && cur.coin !== 'none') { placeCoin(cur.coin, true); }
  });

  enter(1);
  setPlayingAttr();
  resume();

  window.ChopGateHome = {
    goTo: goTo,
    play: play,
    pause: pause,
    state: function () {
      return { scene: scene, step: step + 1, playing: playing };
    }
  };
})();
