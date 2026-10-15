/* ES5 only: the Kindle browser is an old WebKit. Polls for changed sections and swaps just those,
   so the e-ink screen redraws only where something actually changed. */
(function () {
  'use strict';

  var body = document.body;
  var refreshMs = (parseInt(body.getAttribute('data-refresh'), 10) || 60) * 1000;
  var net = document.getElementById('net');
  var netText = net ? net.innerHTML : '';
  var timer = null;
  var watchdog = null;
  var current = null;
  var failures = 0;
  var lastPoll = now();
  var lastOk = now();
  var seen = {};
  var initial = body.getAttribute('data-seen');
  if (initial) {
    var ids = initial.split('|');
    for (var i = 0; i < ids.length; i++) seen[ids[i]] = true;
  }

  function now() {
    return new Date().getTime();
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function setNet(text) {
    if (!net || text === netText) return;
    netText = text;
    net.innerHTML = text;
  }

  function sections() {
    var out = [];
    var nodes = document.getElementsByTagName('div');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-sec')) out.push(nodes[i]);
    }
    return out;
  }

  function nextDelay() {
    if (!failures) return refreshMs;
    return Math.min(15000 * Math.pow(2, failures - 1), Math.max(refreshMs, 300000));
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(poll, nextDelay());
  }

  function finish() {
    clearTimeout(watchdog);
    current = null;
  }

  function offline() {
    var d = new Date(lastOk);
    setNet('连接中断，数据停在 ' + pad(d.getHours()) + ':' + pad(d.getMinutes()));
  }

  function failed() {
    failures++;
    offline();
    schedule();
  }

  function notify(list) {
    var fresh = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      fresh[r.id] = true;
      if (seen[r.id] || !window.Notification || Notification.permission !== 'granted') continue;
      try {
        new Notification(r.title, { body: r.body, tag: r.id });
      } catch (e) { /* notifications unsupported here */ }
    }
    seen = fresh;
  }

  function apply(data) {
    if (data.reload) {
      location.reload();
      return;
    }
    var changed = data.s || {};
    for (var name in changed) {
      if (!changed.hasOwnProperty(name)) continue;
      var el = document.getElementById('s-' + name);
      if (!el) {
        location.reload();
        return;
      }
      el.innerHTML = changed[name];
      el.setAttribute('data-h', data.h[name]);
    }
    if (data.title && document.title !== data.title) document.title = data.title;
    setNet(data.clock + ' 更新');
    notify(data.u || []);
  }

  function poll(force) {
    if (current) {
      if (!force) return;
      var old = current;
      finish();
      try { old.abort(); } catch (e) { /* already done */ }
    }
    clearTimeout(timer);
    lastPoll = now();
    var secs = sections();
    var hashes = [];
    for (var i = 0; i < secs.length; i++) hashes.push(secs[i].getAttribute('data-sec') + ':' + secs[i].getAttribute('data-h'));
    var url = location.pathname + location.search + (location.search ? '&' : '?')
      + 'partial=1&h=' + encodeURIComponent(hashes.join(',')) + '&_=' + lastPoll;
    var req = new XMLHttpRequest();
    current = req;
    req.onreadystatechange = function () {
      if (req.readyState !== 4 || current !== req) return;
      finish();
      if (req.status === 401) {
        location.reload();
        return;
      }
      var data = null;
      if (req.status === 200) {
        try { data = JSON.parse(req.responseText); } catch (e) { data = null; }
      }
      if (!data) return failed();
      failures = 0;
      lastOk = now();
      apply(data);
      schedule();
    };
    watchdog = setTimeout(function () {
      if (current !== req) return;
      finish();
      try { req.abort(); } catch (e) { /* ignore */ }
      failed();
    }, 25000);
    try {
      req.open('GET', url, true);
      req.send(null);
    } catch (e) {
      finish();
      failed();
    }
  }

  function wake() {
    if (now() - lastPoll > Math.min(refreshMs, 60000)) poll();
  }

  function serialize(form) {
    var parts = [];
    for (var i = 0; i < form.elements.length; i++) {
      var el = form.elements[i];
      if (el.name) parts.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value));
    }
    return parts.join('&');
  }

  function onSubmit(e) {
    var form = e.target || e.srcElement;
    if (!form || !form.getAttribute || !form.getAttribute('data-xhr')) return;
    if (e.preventDefault) e.preventDefault();
    e.returnValue = false;
    var req = new XMLHttpRequest();
    req.onreadystatechange = function () {
      if (req.readyState !== 4) return;
      if (req.status === 200) poll(true);
      else form.submit();
    };
    req.open('POST', form.getAttribute('action'), true);
    req.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    req.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    req.send(serialize(form));
  }

  function setupNotify() {
    var wrap = document.getElementById('notify-wrap');
    var link = document.getElementById('notify');
    if (!wrap || !link || !window.Notification || window.isSecureContext === false) return;
    if (Notification.permission === 'denied') return;
    function render() {
      link.innerHTML = Notification.permission === 'granted' ? '桌面通知已开启' : '开启桌面通知';
    }
    render();
    wrap.style.display = '';
    link.onclick = function () {
      if (Notification.permission !== 'granted') {
        var p = Notification.requestPermission(render);
        if (p && p.then) p.then(render);
      }
      return false;
    };
  }

  if (document.addEventListener) {
    document.addEventListener('submit', onSubmit, false);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) wake();
    }, false);
    window.addEventListener('focus', wake, false);
    window.addEventListener('pageshow', wake, false);
  }
  // Timers stall while the Kindle sleeps; catch up as soon as it wakes.
  setInterval(function () {
    if (!current && now() - lastPoll > nextDelay() + 30000) poll();
  }, 30000);

  setupNotify();
  schedule();
})();
