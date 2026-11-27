(function () {
  'use strict';

  // src/engine/attachment_parsers.ts
  var MAX_PARSED_CONTENT_CHARS = 2e5;
  var _parsers = [];
  function registerAttachmentParser(parser) {
    if (parser && typeof parser.match === "function" && typeof parser.parse === "function" && _parsers.indexOf(parser) === -1) {
      _parsers.push(parser);
    }
  }
  function findAttachmentParser(name, mime) {
    for (let i = 0; i < _parsers.length; i++) {
      try {
        if (_parsers[i].match({ name, mime })) return _parsers[i];
      } catch {
      }
    }
    return void 0;
  }
  async function parseAttachmentContent(file, name, mime) {
    const parser = findAttachmentParser(name, mime);
    if (!parser) return null;
    let raw;
    try {
      raw = await parser.parse(file);
    } catch (err) {
      console.error(
        `[chat-engine] attachment parser ${parser.name || "(unnamed)"} failed for ${name}:`,
        err
      );
      return null;
    }
    let text = (raw == null ? "" : String(raw)).trim();
    if (!text) return null;
    if (text.length > MAX_PARSED_CONTENT_CHARS) {
      text = text.slice(0, MAX_PARSED_CONTENT_CHARS) + `
...[truncated for length; original ${text.length} characters]`;
    }
    return text;
  }

  // src/engine/project_settings.ts
  var UPLOAD_ACCESS_GROUPS = ["public", "authorized", "private"];
  var DEFAULT_UPLOAD_ACCESS_GROUP = "authorized";
  var PROJECT_SETTINGS_UNIQUE_ID = "bq::settings";
  var UPLOAD_ACCESS_LABELS = {
    public: "Public",
    authorized: "Signed in users",
    private: "Only me"
  };
  var UPLOAD_ACCESS_HINTS = {
    public: "Anyone can ask about this file, including visitors who are not logged in.",
    authorized: "Only users signed in to this project can ask about this file.",
    private: "Only you can ask about this file."
  };
  var DEFAULT_WEB_ACCESS = false;
  function normalizeWebAccess(value) {
    return value === true;
  }
  function webAccessFrom(data) {
    return data ? normalizeWebAccess(data.web_access) : DEFAULT_WEB_ACCESS;
  }
  var DEFAULT_SKIP_DUPLICATE_FILES = true;
  function normalizeSkipDuplicateFiles(value) {
    return value !== false;
  }
  function skipDuplicateFilesFrom(data) {
    return data ? normalizeSkipDuplicateFiles(data.skip_duplicate_files) : DEFAULT_SKIP_DUPLICATE_FILES;
  }
  var DEFAULT_SHARE_IDENTICAL_FILES = true;
  function normalizeShareIdenticalFiles(value) {
    return value !== false;
  }
  function shareIdenticalFilesFrom(data) {
    return data ? normalizeShareIdenticalFiles(data.share_identical_files) : DEFAULT_SHARE_IDENTICAL_FILES;
  }
  var DEFAULT_ANSWER_MODE = "standard";
  function normalizeAnswerMode(value) {
    return value === "fast" || value === "thorough" ? value : DEFAULT_ANSWER_MODE;
  }
  function answerModeFrom(data) {
    return normalizeAnswerMode(data ? data.answer_mode : void 0);
  }
  var CHAT_GREETING_MAX_LENGTH = 400;
  function normalizeChatGreeting(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return trimmed.slice(0, CHAT_GREETING_MAX_LENGTH);
  }
  function chatGreetingFrom(data) {
    return normalizeChatGreeting(data?.chat_greeting);
  }
  function normalizeUploadAccessGroup(value) {
    return UPLOAD_ACCESS_GROUPS.indexOf(value) === -1 ? DEFAULT_UPLOAD_ACCESS_GROUP : value;
  }
  function normalizeProjectAccessSetting(value) {
    if (value === "ask") return "ask";
    return UPLOAD_ACCESS_GROUPS.indexOf(value) === -1 ? null : value;
  }
  function accessSettingFrom(data) {
    return normalizeProjectAccessSetting(data?.upload_access_group);
  }
  function uploadAccessGroupFrom(data) {
    const v = accessSettingFrom(data);
    return v && v !== "ask" ? v : DEFAULT_UPLOAD_ACCESS_GROUP;
  }
  function asksUploadAccessFrom(data) {
    return accessSettingFrom(data) === "ask";
  }
  var reader = null;
  var cache = /* @__PURE__ */ new Map();
  function configureProjectSettings(fn) {
    reader = fn;
  }
  function entry(service) {
    let e = cache.get(service);
    if (!e) {
      e = { data: null, settled: false, inflight: null };
      cache.set(service, e);
    }
    return e;
  }
  function loadProjectSettings(service) {
    if (!service) return Promise.resolve(null);
    const e = entry(service);
    if (e.settled) return Promise.resolve(e.data);
    if (e.inflight) return e.inflight;
    if (!reader) return Promise.resolve(null);
    const run = reader(service).then((data) => data && typeof data === "object" ? data : null).catch(() => null).then((data) => {
      const cur = entry(service);
      if (cur.inflight === run) {
        cur.data = data;
        cur.settled = true;
        cur.inflight = null;
      }
      return data;
    });
    e.inflight = run;
    return run;
  }
  function primeProjectSettings(service) {
    void loadProjectSettings(service);
  }
  function readyProjectSettings(service) {
    return loadProjectSettings(service);
  }
  function cachedProjectSettings(service) {
    const e = cache.get(service);
    return e && e.settled ? e.data : null;
  }
  function projectUploadAccessGroup(service) {
    return uploadAccessGroupFrom(cachedProjectSettings(service));
  }
  function projectAsksUploadAccess(service) {
    return asksUploadAccessFrom(cachedProjectSettings(service));
  }
  function projectChatGreeting(service) {
    return chatGreetingFrom(cachedProjectSettings(service));
  }
  function projectShareIdenticalFiles(service) {
    return shareIdenticalFilesFrom(cachedProjectSettings(service));
  }

  // src/engine/config.ts
  var _config = null;
  function configureChatEngine(config) {
    _config = config;
    if (config.attachmentParsers) {
      for (const parser of config.attachmentParsers) registerAttachmentParser(parser);
    }
  }
  function chatEngineConfig() {
    if (!_config) {
      throw new Error(
        "[chat-engine] configureChatEngine() must be called before using the engine."
      );
    }
    return _config;
  }
  function resolveForwardRequest() {
    const cfg = chatEngineConfig();
    const fwd = cfg.forwardRequest;
    if (typeof fwd === "function") {
      return (opts) => fwd.call(cfg, null, opts);
    }
    throw new Error(
      "[chat-engine] No request transport: configureChatEngine() needs forwardRequest, bound to a skapi instance (skapi-js 2.1.0 or newer). The clientSecretRequest key is no longer read."
    );
  }
  function resolveForwardRequestHistory() {
    const cfg = chatEngineConfig();
    const hist = cfg.forwardRequestHistory;
    if (typeof hist === "function") {
      return (params, fetchOptions) => hist.call(cfg, params, fetchOptions);
    }
    throw new Error(
      "[chat-engine] No history transport: configureChatEngine() needs forwardRequestHistory, bound to a skapi instance (skapi-js 2.1.0 or newer). The clientSecretRequestHistory key is no longer read."
    );
  }
  function resolveForwardRequestFinalize() {
    const cfg = chatEngineConfig();
    return typeof cfg.forwardRequestFinalize === "function" ? cfg.forwardRequestFinalize : void 0;
  }
  function resolveForwardRequestStream() {
    const cfg = chatEngineConfig();
    return typeof cfg.forwardRequestStream === "function" ? cfg.forwardRequestStream : void 0;
  }
  function resolveForwardRequestStatus() {
    if (!_config || typeof _config.forwardRequestStatus !== "function") return void 0;
    const cfg = _config;
    return (requests, opts) => cfg.forwardRequestStatus.call(cfg, requests, opts);
  }
  function resolveForwardRequestRead() {
    if (!_config || typeof _config.forwardRequestRead !== "function") return void 0;
    const cfg = _config;
    return (params) => cfg.forwardRequestRead.call(cfg, params);
  }
  function resolveForwardRequestQueueCounters() {
    if (!_config || typeof _config.forwardRequestQueueCounters !== "function") return void 0;
    const cfg = _config;
    return (queues, opts) => cfg.forwardRequestQueueCounters.call(cfg, queues, opts);
  }
  function reconcilerReadsEnabled() {
    return !!resolveForwardRequestStatus() && !!resolveForwardRequestRead();
  }
  function crefSupported() {
    return reconcilerReadsEnabled();
  }
  function windowedIndexingEnabled() {
    return _config?.windowedIndexing === true;
  }
  function workerIndexEndingsEnabled() {
    return _config?.workerIndexEndings === true;
  }
  function statusPushEnabled() {
    return _config?.statusPush === true && typeof _config?.onRequestStatus === "function";
  }
  function statusPushLive() {
    if (!statusPushEnabled() || typeof _config?.isRequestStatusLive !== "function") return false;
    try {
      return !!_config.isRequestStatusLive();
    } catch (e) {
      return false;
    }
  }
  function liveStreamingSocketEnabled() {
    return liveStreamingEnabled() && _config?.liveStreaming === true;
  }
  function liveStreamingEnabled() {
    return typeof resolveForwardRequestFinalize() === "function" && typeof resolveForwardRequestStream() === "function";
  }
  function underCeiling(projectSetting, option, override) {
    if (!projectSetting) return false;
    if (option === false) return false;
    if (override === false) return false;
    return true;
  }
  function webAccessEnabled(service) {
    const opt = _config ? _config.webAccess : void 0;
    return underCeiling(webAccessFrom(service ? cachedProjectSettings(service) : null), opt);
  }
  function resolveWebAccess(service, override) {
    const opt = _config ? _config.webAccess : void 0;
    if (!service) return Promise.resolve(underCeiling(webAccessFrom(null), opt, override));
    return loadProjectSettings(service).then(webAccessFrom, () => false).then((setting) => underCeiling(setting, opt, override));
  }
  function resolveAnswerMode(service) {
    if (!service) return Promise.resolve(answerModeFrom(null));
    return loadProjectSettings(service).then(answerModeFrom, () => answerModeFrom(null));
  }
  function resolveSkipDuplicateFiles(service) {
    const opt = _config ? _config.skipDuplicateFiles : void 0;
    if (!service) return Promise.resolve(underCeiling(skipDuplicateFilesFrom(null), opt));
    return loadProjectSettings(service).then(skipDuplicateFilesFrom, () => skipDuplicateFilesFrom(null)).then((setting) => underCeiling(setting, opt));
  }
  function streamRecoveryEnabled() {
    if (!_config) return false;
    if (_config.streamRecovery === false) return false;
    return typeof resolveForwardRequestStream() === "function";
  }
  function skapiSupportsStreaming(sk) {
    if (!sk) return false;
    return typeof sk.forwardRequestStream === "function" && typeof sk.forwardRequestFinalize === "function";
  }
  function pollOpt() {
    const p = _config?.poll;
    return p === void 0 ? {} : { poll: p };
  }

  // src/engine/reconciler.ts
  var LOOK_DEADLINE_MS = 15 * 1e3;
  var LOOK_FAST_MS = 3 * 1e3;
  var LOOK_SLOW_MS = 60 * 1e3;
  var LOOK_STALE_MS = 60 * 1e3;
  var WAKE_GAP_MS = 30 * 1e3;
  var BACKOFF_MAX_MS = 30 * 1e3;
  var RETURN_TRIGGERS = {
    return: true,
    visible: true,
    wake: true,
    online: true,
    pageshow: true,
    reconnect: true,
    view: true,
    unknown: true,
    signin: true
  };
  var _g = typeof globalThis !== "undefined" ? globalThis : {};
  function perfNow() {
    return _g.performance && typeof _g.performance.now === "function" ? _g.performance.now() : Date.now();
  }
  function tabHidden() {
    var doc = _g.document;
    return !!doc && doc.visibilityState === "hidden";
  }
  var LookScheduler = class {
    constructor(hooks) {
      this.timer = null;
      /** When the pending timer should fire, on both clocks (wake detection). */
      this.expectPerf = 0;
      this.expectWall = 0;
      this.running = false;
      /** Triggers that arrived while a look ran: exactly one more look runs with them. */
      this.pending = null;
      /** Resolvers of trigger() promises, by the look that will serve them. */
      this.waitCurrent = [];
      this.waitNext = [];
      this.backoff = 0;
      this.listening = false;
      this.stopped = false;
      this.gen = 0;
      this.reconnecting = false;
      this.signInNeeded = false;
      /** Diagnostics (and the throwaway checks): looks started, timers armed. */
      this.looks = 0;
      this.timersArmed = 0;
      /** Triggers gathered for a look about to start (see trigger). */
      this.starting = null;
      this.waitStarting = [];
      this.scheduling = false;
      this.hooks = hooks;
    }
    /** Pull the next look forward to now. Resolves when the look that serves it ends. */
    trigger(kind) {
      var self = this;
      this.stopped = false;
      this._listen();
      return new Promise(function(resolve) {
        if (self.running) {
          if (!self.pending) self.pending = {};
          self.pending[kind] = true;
          self.waitNext.push(resolve);
          return;
        }
        if (!self.starting) {
          self.starting = {};
          setTimeout(function() {
            var t = self.starting || {};
            self.starting = null;
            if (self.running) {
              if (!self.pending) self.pending = {};
              for (var k in t) self.pending[k] = true;
              self.waitNext = self.waitNext.concat(self.waitStarting);
              self.waitStarting = [];
              return;
            }
            self.waitCurrent = self.waitCurrent.concat(self.waitStarting);
            self.waitStarting = [];
            self._start(t);
          }, 0);
        }
        self.starting[kind] = true;
        self.waitStarting.push(resolve);
      });
    }
    /** Make sure the chain runs at its cadence when there is work. Never adds a timer when
     *  one is armed or a look is running, so calling it from every add is free. */
    ensure() {
      this.stopped = false;
      this._listen();
      if (this.running || this.timer || this.starting) return;
      this._scheduleNext("ok");
    }
    /** The sign-in came back (or the host says so): looks resume at once. */
    signedIn() {
      if (!this.signInNeeded) {
        this.ensure();
        return;
      }
      this.signInNeeded = false;
      this.backoff = 0;
      this._flags();
      void this.trigger("signin");
    }
    /** Stop the chain (tests, teardown). A later trigger or ensure starts it again. */
    stop() {
      this.stopped = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
    isRunning() {
      return this.running;
    }
    _flags() {
      try {
        this.hooks.onFlags({ reconnecting: this.reconnecting, signInNeeded: this.signInNeeded });
      } catch (e) {
      }
    }
    _listen() {
      if (this.listening) return;
      this.listening = true;
      var self = this;
      var doc = _g.document;
      if (doc && typeof doc.addEventListener === "function") {
        doc.addEventListener("visibilitychange", function() {
          if (doc.visibilityState === "hidden") {
            if (!self.running && self.timer) {
              clearTimeout(self.timer);
              self.timer = null;
              self._scheduleNext("ok");
            }
            return;
          }
          void self.trigger("visible");
        });
      }
      var win = _g.window;
      if (win && typeof win.addEventListener === "function") {
        win.addEventListener("online", function() {
          if (!tabHidden()) void self.trigger("online");
        });
        win.addEventListener("pageshow", function(ev) {
          if (ev && ev.persisted) void self.trigger("pageshow");
        });
      }
    }
    _start(triggers) {
      var self = this;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.running = true;
      var gen = ++this.gen;
      this.looks++;
      var isReturn = false;
      for (var k in triggers) if (RETURN_TRIGGERS[k]) isReturn = true;
      var ac = typeof _g.AbortController === "function" ? new _g.AbortController() : null;
      var startedAt = perfNow();
      var done = false;
      var deadline = setTimeout(function() {
        if (done) return;
        done = true;
        try {
          if (ac) ac.abort();
        } catch (e) {
        }
        console.warn("[chat-engine] a reconciler look ran past its deadline; nothing it read is applied");
        self._finish("transient");
      }, LOOK_DEADLINE_MS);
      var req = {
        gen,
        triggers,
        isReturn,
        signal: ac ? ac.signal : void 0,
        alive: function() {
          return !done && self.gen === gen;
        },
        remaining: function() {
          return Math.max(1, Math.round(LOOK_DEADLINE_MS - (perfNow() - startedAt)));
        }
      };
      var run;
      try {
        run = Promise.resolve(this.hooks.runLook(req));
      } catch (e) {
        run = Promise.reject(e);
      }
      run.then(function(outcome) {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        self._finish(outcome || "ok");
      }, function(err) {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        console.warn("[chat-engine] a reconciler look threw", err);
        self._finish("transient");
      });
    }
    _finish(outcome) {
      this.running = false;
      var served = this.waitCurrent;
      this.waitCurrent = [];
      if (outcome === "transient") {
        this.backoff = this.backoff ? Math.min(BACKOFF_MAX_MS, this.backoff * 2) : 1e3;
        if (!this.reconnecting) {
          this.reconnecting = true;
          this._flags();
        }
      } else if (outcome === "auth") {
        this.backoff = 0;
        var changed = !this.signInNeeded || this.reconnecting;
        this.signInNeeded = true;
        this.reconnecting = false;
        if (changed) this._flags();
      } else {
        this.backoff = 0;
        if (this.reconnecting || this.signInNeeded) {
          this.reconnecting = false;
          this.signInNeeded = false;
          this._flags();
        }
      }
      for (var i = 0; i < served.length; i++) {
        try {
          served[i]();
        } catch (e) {
        }
      }
      if (this.pending) {
        var next = this.pending;
        this.pending = null;
        this.waitCurrent = this.waitNext;
        this.waitNext = [];
        this._start(next);
        return;
      }
      this._scheduleNext(outcome);
    }
    _scheduleNext(outcome) {
      if (this.stopped || this.scheduling) return;
      this.scheduling = true;
      try {
        this._arm(outcome);
      } finally {
        this.scheduling = false;
      }
    }
    _arm(outcome) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      var hidden = tabHidden();
      var work;
      try {
        work = this.hooks.work();
      } catch (e) {
        work = { visible: true, hidden: false };
      }
      var delay = -1;
      if (this.signInNeeded) {
        if (!hidden && work.visible) delay = LOOK_SLOW_MS;
      } else if (outcome === "transient" && this.backoff) {
        if (!hidden && work.visible || work.hidden) delay = hidden ? Math.max(this.backoff, LOOK_SLOW_MS) : this.backoff;
      } else if (!hidden && work.visible) {
        var live = false;
        try {
          live = this.hooks.pushLive();
        } catch (e) {
          live = false;
        }
        delay = live ? LOOK_SLOW_MS : LOOK_FAST_MS;
      } else if (hidden && work.hidden) {
        delay = LOOK_SLOW_MS;
      }
      if (delay < 0) return;
      var self = this;
      this.expectPerf = perfNow() + delay;
      this.expectWall = Date.now() + delay;
      this.timersArmed++;
      this.timer = setTimeout(function() {
        self.timer = null;
        var t = { tick: true };
        var lateWall = Date.now() - self.expectWall;
        var latePerf = perfNow() - self.expectPerf;
        if (!tabHidden() && (lateWall > WAKE_GAP_MS || latePerf > WAKE_GAP_MS || Date.now() < self.expectWall - delay)) t.wake = true;
        self._start(t);
      }, delay);
    }
  };
  var FX_PREFIX = "bq-fx:";
  var FXI_PREFIX = "bq-fxi:";
  var LOCK_HOLD_MAX_MS = 20 * 1e3;
  var FX_TTL_MS = 24 * 60 * 60 * 1e3;
  var FX_INFLIGHT_MS = 60 * 1e3;
  var FX_MAX_TRIES = 5;
  var FX_RETRY_BASE_MS = 2e3;
  var _fxDone = {};
  var _fxBusy = {};
  var _fxPrunedAt = 0;
  function storage() {
    try {
      var ls = _g.localStorage;
      return ls && typeof ls.getItem === "function" ? ls : null;
    } catch (e) {
      return null;
    }
  }
  function fxIsDone(key) {
    if (_fxDone[key]) return true;
    var ls = storage();
    if (!ls) return false;
    try {
      var v = Number(ls.getItem(FX_PREFIX + key));
      return isFinite(v) && v > 0 && Date.now() - v < FX_TTL_MS;
    } catch (e) {
      return false;
    }
  }
  function fxBusyAt(key) {
    var now = Date.now();
    var t = _fxBusy[key] || 0;
    if (t && now - t < FX_INFLIGHT_MS) return t;
    var ls = storage();
    if (!ls) return 0;
    try {
      var v = Number(ls.getItem(FXI_PREFIX + key));
      return isFinite(v) && v > 0 && now - v < FX_INFLIGHT_MS ? v : 0;
    } catch (e) {
      return 0;
    }
  }
  function fxMarkBusy(key) {
    var now = Date.now();
    _fxBusy[key] = now;
    var ls = storage();
    if (!ls) return;
    try {
      ls.setItem(FXI_PREFIX + key, String(now));
    } catch (e) {
    }
  }
  function fxClearBusy(key) {
    delete _fxBusy[key];
    var ls = storage();
    if (!ls) return;
    try {
      ls.removeItem(FXI_PREFIX + key);
    } catch (e) {
    }
  }
  function fxPrune(now) {
    if (now - _fxPrunedAt <= 60 * 60 * 1e3) return;
    _fxPrunedAt = now;
    var k;
    for (k in _fxDone) if (now - _fxDone[k] > FX_TTL_MS) delete _fxDone[k];
    for (k in _fxBusy) if (now - _fxBusy[k] > FX_INFLIGHT_MS) delete _fxBusy[k];
    var ls = storage();
    if (!ls) return;
    try {
      var drop = [];
      for (var i = 0; i < ls.length; i++) {
        var lk = ls.key(i);
        if (!lk) continue;
        var life = lk.indexOf(FX_PREFIX) === 0 ? FX_TTL_MS : lk.indexOf(FXI_PREFIX) === 0 ? FX_INFLIGHT_MS : 0;
        if (!life) continue;
        var t = Number(ls.getItem(lk));
        if (!isFinite(t) || now - t > life) drop.push(lk);
      }
      for (var d = 0; d < drop.length; d++) ls.removeItem(drop[d]);
    } catch (e) {
    }
  }
  function fxMarkDone(key) {
    var now = Date.now();
    _fxDone[key] = now;
    delete _fxBusy[key];
    var ls = storage();
    if (ls) {
      try {
        ls.setItem(FX_PREFIX + key, String(now));
        ls.removeItem(FXI_PREFIX + key);
      } catch (e) {
      }
    }
    fxPrune(now);
  }
  function sideEffectDone(key) {
    return fxIsDone(key);
  }
  function claimSideEffect(key) {
    if (!key || fxIsDone(key) || fxBusyAt(key)) return false;
    fxMarkDone(key);
    return true;
  }
  var _fxDepth = 0;
  function runSettleSideEffect(projectId, queue, key, fn, attempt, tries) {
    if (!key || fxIsDone(key)) return;
    var tryNo = tries || 0;
    var again = function(delay, nextTry) {
      setTimeout(function() {
        runSettleSideEffect(projectId, queue, key, fn, 0, nextTry);
      }, delay);
    };
    var run = function() {
      if (fxIsDone(key)) return;
      var busy = fxBusyAt(key);
      if (busy) {
        if (!_fxBusy[key] && tryNo < FX_MAX_TRIES) again(Math.max(1e3, FX_INFLIGHT_MS - (Date.now() - busy) + 1e3), tryNo + 1);
        return;
      }
      fxMarkBusy(key);
      var failed = function(e) {
        fxClearBusy(key);
        if (tryNo + 1 < FX_MAX_TRIES) {
          console.warn("[chat-engine] a settle side effect failed; trying again", key, e);
          again(FX_RETRY_BASE_MS * Math.pow(2, tryNo), tryNo + 1);
        } else {
          console.warn("[chat-engine] a settle side effect failed " + FX_MAX_TRIES + " times; left for a later settle", key, e);
        }
      };
      var out;
      _fxDepth++;
      try {
        out = fn();
      } catch (e) {
        _fxDepth--;
        failed(e);
        return;
      }
      _fxDepth--;
      return Promise.resolve(out).then(function() {
        fxMarkDone(key);
      }, failed);
    };
    if (_fxDepth > 0 || !locks()) {
      run();
      return;
    }
    var lk = locks();
    var name = "bq-settle:" + (projectId || "") + ":" + (queue || "");
    var n = attempt || 0;
    var p;
    try {
      p = lk.request(name, { ifAvailable: true }, function(lock) {
        if (!lock) return false;
        return new Promise(function(resolve) {
          var t = setTimeout(function() {
            resolve(true);
          }, LOCK_HOLD_MAX_MS);
          Promise.resolve(run()).then(function() {
            clearTimeout(t);
            resolve(true);
          }, function() {
            clearTimeout(t);
            resolve(true);
          });
        });
      });
    } catch (e) {
      run();
      return;
    }
    Promise.resolve(p).then(function(got) {
      if (got !== false) return;
      if (n >= 30) {
        run();
        return;
      }
      setTimeout(function() {
        runSettleSideEffect(projectId, queue, key, fn, n + 1, tryNo);
      }, Math.min(5e3, 250 * Math.pow(2, n)));
    }, function() {
      run();
    });
  }
  function locks() {
    var l = _g.navigator && _g.navigator.locks;
    return l && typeof l.request === "function" ? l : null;
  }
  function newClientRef() {
    var rnd = "";
    var c = _g.crypto;
    if (c && typeof c.getRandomValues === "function") {
      var a = new Uint32Array(2);
      c.getRandomValues(a);
      rnd = a[0].toString(36) + a[1].toString(36);
    } else {
      rnd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    return ("c" + Date.now().toString(36) + "_" + rnd).slice(0, 64);
  }
  function queueNameOf(q) {
    if (typeof q !== "string" || !q) return "";
    var head = q.split("|")[0];
    var i = head.lastIndexOf(":");
    return i === -1 ? head : head.slice(i + 1);
  }

  // src/engine/office.ts
  var OFFICE_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
    "doc",
    "docx",
    "docm",
    "xls",
    "xlsx",
    "xlsm",
    "ppt",
    "pptx",
    "pptm",
    "hwp",
    "hwpx",
    "ods",
    "odt",
    "odp",
    "epub",
    "eml"
  ]);
  var TEXT_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
    "csv",
    "tsv",
    "tab",
    "txt",
    "text",
    "log",
    "md",
    "markdown",
    "rst",
    "json",
    "ndjson",
    "jsonl",
    "geojson",
    "xml",
    "yaml",
    "yml",
    "toml",
    "ini",
    "conf",
    "cfg",
    "properties",
    "env",
    "rtf",
    "html",
    "htm",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "c",
    "h",
    "cpp",
    "cc",
    "hpp",
    "cs",
    "php",
    "swift",
    "sh",
    "bash",
    "zsh",
    "sql",
    "css",
    "scss",
    "less",
    "vue",
    "svelte",
    "tex",
    "srt",
    "vtt"
  ]);
  function isTextMime(m) {
    return m.startsWith("text/") || m.endsWith("+json") || m.endsWith("+xml") || m.endsWith("+yaml") || m === "application/json" || m === "application/ld+json" || m === "application/xml" || m === "application/yaml" || m === "application/x-yaml" || m === "application/javascript" || m === "application/x-javascript" || m === "application/x-sh" || m === "application/x-ndjson" || m === "application/csv" || m === "application/rtf" || m === "application/sql" || m === "application/toml";
  }
  function isServerExtractable(name, mime) {
    const ext = (name || "").split(".").pop()?.toLowerCase() || "";
    if (OFFICE_FILE_EXTENSIONS.has(ext)) return true;
    if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
    const m = (mime || "").toLowerCase();
    if (isTextMime(m)) return true;
    return m.includes("officedocument") || m.includes("opendocument") || m.includes("hwp") || m.includes("epub") || m === "application/msword" || m === "application/vnd.ms-excel" || m === "application/vnd.ms-powerpoint";
  }
  var PAGED_READ_EXTENSIONS = /* @__PURE__ */ new Set([
    // grids
    "xls",
    "xlsx",
    "xlsm",
    "ods",
    // delimited text (row-windowed by the layer)
    "csv",
    "tsv",
    "tab",
    // documents
    "pdf",
    "docx",
    "docm",
    "pptx",
    "pptm",
    "doc",
    "ppt",
    // Korean word processor (OLE/CFB and OOXML-style variants)
    "hwp",
    "hwpx",
    // opendocument text/presentation (ods is a grid, listed above)
    "odt",
    "odp",
    // other long-form documents
    "epub",
    "rtf",
    "html",
    "htm",
    "eml",
    // email (RFC822): body plus attachment text, char-windowed
    // plain text / data / markup
    "txt",
    "md",
    "markdown",
    "log",
    "json",
    "jsonl",
    "ndjson",
    "xml",
    "yaml",
    "yml"
  ]);
  function isPagedReadFile(name, mime) {
    const ext = (name || "").split(".").pop()?.toLowerCase() || "";
    if (PAGED_READ_EXTENSIONS.has(ext)) return true;
    const m = (mime || "").toLowerCase();
    return m === "application/pdf" || m === "application/vnd.ms-excel" || m.includes("spreadsheetml") || m.includes("opendocument.spreadsheet");
  }
  function isImageVisionFile(name, mime) {
    const ext = (name || "").split(".").pop()?.toLowerCase() || "";
    return ext === "pdf" || (mime || "").toLowerCase() === "application/pdf";
  }
  var _extractPlaceholderSeq = 0;
  function makeExtractPlaceholder(seed) {
    _extractPlaceholderSeq += 1;
    const slug = (seed || "file").replace(/[^a-zA-Z0-9]+/g, "_").slice(-48);
    return `{{SKAPI_FILE_CONTENT::${slug}-${_extractPlaceholderSeq}}}`;
  }
  var _renderPlaceholderSeq = 0;
  function makeRenderPlaceholder(seed) {
    _renderPlaceholderSeq += 1;
    const slug = (seed || "file").replace(/[^a-zA-Z0-9]+/g, "_").slice(-48);
    return `{{SKAPI_RENDER::${slug}-${_renderPlaceholderSeq}}}`;
  }
  var RENDER_PAGES_PER_WINDOW = 5;
  var _windowPlaceholderSeq = 0;
  function makeWindowPlaceholder(seed) {
    _windowPlaceholderSeq += 1;
    const slug = (seed || "file").replace(/[^a-zA-Z0-9]+/g, "_").slice(-48);
    return `{{SKAPI_WINDOW::${slug}-${_windowPlaceholderSeq}}}`;
  }
  function isWindowedReadFile(name, mime) {
    if (isImageVisionFile(name, mime)) return false;
    return isPagedReadFile(name, mime);
  }
  function composeUserMessage(text, attachmentUrls, opts) {
    let composed = text;
    let composedForLlm = composed;
    if (attachmentUrls.length > 0) {
      const lines = attachmentUrls.map((u) => `- [${u.name}](${u.url})`);
      composed = `${text}

Attached files:
${lines.join("\n")}`;
      composedForLlm = composed;
    }
    let extractContent;
    let fileUrls;
    if (attachmentUrls.length > 0) {
      const extractFiles = [];
      if (extractFiles.length > 0) {
        const directives = [];
        const sections = extractFiles.map((u) => {
          const storagePath = u.storagePath || u.name;
          const placeholder = makeExtractPlaceholder(storagePath);
          directives.push({ path: storagePath, placeholder, name: u.name });
          return `===== ${u.name} =====
----- BEGIN FILE CONTENT -----
${placeholder}
----- END FILE CONTENT -----`;
        });
        extractContent = directives;
        composedForLlm = `${composedForLlm}

Extracted content of attached office files (read inline below; do NOT fetch their URLs):

` + sections.join("\n\n");
      }
      const urlFiles = attachmentUrls.filter((u) => u.url && !isServerExtractable(u.name)) ;
      if (urlFiles.length > 0) {
        fileUrls = urlFiles.map((u) => ({ path: u.storagePath || u.name, url: u.url }));
      }
    }
    return { composed, composedForLlm, extractContent, fileUrls };
  }

  // src/engine/prompts/chat_system_prompt.ts
  function buildChatSystemPrompt(params) {
    const { projectId, serviceName, serviceDescription, greeting, canUpload} = params;
    const webAccess = params.webAccess === true;
    const g = params.indexAccessGroup;
    const indexGroupLiteral = typeof g === "number" ? String(g) : g === "public" || g === "private" || g === "authorized" || g === "admin" ? `"${g}"` : '"authorized"';
    const reindexHint = canUpload === false ? `asking the project's owner to re-index that file` : `re-indexing that file (attach the same file again and choose to reindex it)`;
    const groundingRules = `ANSWER ONLY FROM THE DATA. Every fact you state about this project's data - a name, a number, a date, a status, what a document says, whether something exists - must come from one of four places: a tool result returned in THIS conversation, a file or image attached to it (including one you read through its attachment link), the project description at the end of this prompt, or what the user told you themselves in this chat. Your general knowledge, the open internet and a plausible guess are NOT sources. Never use them to answer a question about the user's data, to fill a gap in it, or to complete a record that came back partial. A value that is not in what you retrieved is unknown: say it is not in the data instead of supplying a likely one.
FILES IN ANOTHER LANGUAGE. The files may be written in another language than the question, in another alphabet or in the same one (a Russian or English manual asked about in Korean, German documents asked about in English). When searches in the question's language find nothing, or searchText reports query_language_mismatch (its text_language names the files' language), search again with the question's key terms translated into the language the files' TEXT is in: searchText names that language for each file ("its text is in German"; only when it cannot tell, the alphabet, "Latin script, e.g. English"), and earlier hits show it; passing the question as the DOCUMENTS rule says lets searchText tell the question's language; a file NAME can be in another language than its text (a "\u0420\u042D" manual written in English), so go by the text. One or two short queries of the main terms (e.g. "oil leak", "gearbox"), and if the first translation finds nothing, try the other likely language (English is the most common for technical manuals), before concluding anything.
WHEN THE DATA DOES NOT HAVE IT, SAY SO. Once you have searched the way these rules require (in the files' language too) and nothing answers the question, tell the user plainly, in their language, that this project's data does not contain it, and say what you searched (the tables, files or terms) so they can tell missing data from a missed search. Do not answer from memory instead, and do not turn a missing answer into a general explanation of the topic. Offer what would let you answer it: ${canUpload === false ? `another name or file to look under, or asking the project's owner to add it` : `the document to upload, or another name or file to look under`}.
A CODE, NUMBER OR EXACT QUOTE THAT searchText DID NOT FIND (an identifier or a quote, not a topic or how-to question, which follows FILES IN ANOTHER LANGUAGE first): when it answers search_complete with no hit, and what its message says was NOT searched has been checked as it says (the skipped_without_page_text files; the records ONLY when the value could be a spreadsheet cell or a row, and then with ONE filtered getRecords on that value, never by paging through a whole table), keep the answer short. The text read from photos, scans and other images IS in the page text searchText covered, so a code, serial or phrase asked about a photo needs no records read: say plainly that it was not found, name what was searched (the file, and its pages when you searched only some of them, or files_searched files and total_pages_searched pages), and when a recently uploaded file or a photo should hold it, suggest ${reindexHint}, since small or handwritten characters can be misread at indexing. Never present a different file as the match, and never guess the value.
KEEP WHAT THE DATA SAYS APART FROM WHAT YOU WORKED OUT. A total you computed, a comparison, a trend, an interpretation or a recommendation is yours, not the data's: label it as such ("calculated from...", "this suggests...") and name the rows or files it was made from. Never present an estimate, an assumption or an inference as something the data states.
These rules govern every claim about the project's data. They do not limit the About BunnyQuery section (answer product questions from it), a greeting, or text the user explicitly asks you to write.`;
    const webRule = webAccess ? `WEB ACCESS IS ON for this project: when the user asks for something that is not in the project's data, you may search the web for it, but every such fact must be marked as coming from the web (name the site), kept apart from what the project's data says, and never used to fill in or complete a document's content or a record. This is the one exception to the four sources named above.` : `This chat has no web tool: the web is never a source here.`;
    const documentRules = `DOCUMENTS (a contract, a report, a manual, a letter, any uploaded file the user asks about the content of): when the user NAMED a file (its file name; a document title, a quote or a code they mention is NOT a file name: searchText finds those inside the files), first find its storage path by its "src::" record (see WHERE INDEXED CONTENT LIVES) using the name the user used, then find the page with searchText and that path. A spreadsheet's sheets are page text too: a hit names its sheet and rows, and the row itself is a record (its unique_id is the hit's row_id_prefix plus the row number); a spreadsheet indexed before 2026-11-25 has no page text, so read its rows instead (readFileContent, or its records). When they did not name a file, your FIRST call is searchText without a path: no table list, no file lookup before it. Never list or look up files (getUniqueId on "src::") to find out whether a document, quote or title exists before searching: searchText's hits name the file, and a search that finds nothing says what it could not cover. Either way follow searchText's description to the end, including asking the user once, after quick results, before it searches all files. QUOTE THE EXACT TEXT it returned and CITE THE FILE AND THE PAGE ("report.pdf, page 7"), or for a hit with "sheet" THE FILE AND THE SHEET ("quote.xlsx, sheet \uCD1D\uAD04"), never a sheet page's number; never present a paraphrase as a quote. A file with no page text is read with readFileContent instead and cited by its file name. In a long file (a manual, a book), when a search of the whole file gives too many hits or none that fit, call getFileOutline and search the chapter that fits with searchText page_from and page_to. When the user asks about the content of the documents, pass searchText "question": that question in the user's own words, without names or personal details that are not about the documents. Leave "question" out for anything else.
WRONG ANSWER: when the user says an answer is wrong (or sends "This answer seems wrong. Please check it again against the documents."), re-read the pages you cited (for a sheet hit, the rows: by its row_id_prefix, never readFileContent on a sheet page) and search again, passing searchText "question" = the user's ORIGINAL question that the disputed answer answered, never the complaint message itself. Then do exactly one of: correct the answer only; correct the answer and call correctSearchLink (when it is among your tools); or keep the answer and quote the text that supports it. Call correctSearchLink only with the page and an exact quote that prove it, and never change data on the user's word alone.`;
    const groupIsPublic = indexGroupLiteral === '"public"' || indexGroupLiteral === "0";
    const accessGroupRule = `THIS PROJECT INDEXES AT access_group ${indexGroupLiteral}: pass access_group ${indexGroupLiteral} EXPLICITLY on EVERY query that names a table_name, whether it filters by index, by tag or by nothing, and never rely on a default: a group left off is NOT "all groups", and any user but the project's owner is then answered from access_group 0 (public) alone${groupIsPublic ? "" : `, so a table indexed at ${indexGroupLiteral} would look empty with its records sitting right there`}. Files uploaded before the project's setting changed may sit at another group, so when a table query comes back empty, retry it in the other groups among 0, 1 and "private" before concluding there is nothing. Reference is the exception: reference ALONE spans EVERY table and EVERY access group, so getRecords with reference "src::<the file's storage path>" is the one call that returns a whole file's records wherever the indexer put them; adding table_name narrows it to that table, and access_group WITHOUT table_name fails.`;
    let systemPrompt = `
You are a dedicated assistant for the project ID: "${projectId}".
Scope: Only answer questions about this project and its data. Do not answer questions about other projects or topics unrelated to this project. When the user refers to "my database", "my data", or "my files", treat those as references to this project's database and file storage. The ONE exception is BunnyQuery itself - what this app is, what it can do, and how to use it - which is always in scope: answer it from the "About BunnyQuery" section at the end of this prompt.
Knowledge lookup: before saying you don't know, or that something isn't in the chat history, ALWAYS search this project's data with the tools: the project's data lives in its database, not in the earlier messages of this chat.
${groundingRules}
${webRule}
FINDING THE DATA: the database is the way in, for every kind of file. A question about what the documents SAY (a procedure, a passage, a definition, how to fix or do something), or one that names a code, a number or a phrase to find (a quote no., a part no., a name), starts with searchText (DOCUMENTS below), not with getTables: the sheets of spreadsheets are in page text too. searchText finds WHICH file, sheet and row holds a value; a total, count or list over rows is still computed from the full row set (NUMBERS FROM A SPREADSHEET below). Everything else (numbers, rows, records, lists, counts, files) follows the search path in getTables' description, with one exception for this project: when getTables' one page is the whole list (end_of_list true), skip its table-name search even when no name fits: you already see every table, and a table is never named after a company, a person or a single fact, so when no table fits, the answer is in a document's text: use searchText (DOCUMENTS below). Pick EVERY table that could hold the answer, not the first that fits. Read getIndexes and getTags one page each, never with fetch_all: name and tag lists can be millions of characters long and are never read whole, so when the name is not on that page, search for it with the user's words as their descriptions say. Never call getTags with neither table_name nor tag: that lists every tag of every table. Then getRecords in that table and group with the selector that matched (an index, one exact tag, or none for the whole table), always with fetch_all true. WHERE INDEXED CONTENT LIVES: a document's extracted content (PDF, Word, slides, scans) is in table "document_entries", one record per row / entry / section, with its page in "page"; spreadsheet rows are in "spreadsheet_rows". Files indexed before 2026-11-20 may still hold theirs in other tables, so a file's records are found wherever they are with getRecords reference "src::<path>" (see the access group rule below); every later mention of a file's records means this call. Every stored file has a record whose unique_id is "src::<its storage path>", so getUniqueId with unique_id "src::" and condition "gte" lists every file across every table (add the start of a path to narrow it; condition "lte" with a file name alone finds it in any folder).
NUMBERS FROM A SPREADSHEET are computed from the ROWS, never from one page and never from a guess. Each row of each sheet is one record in its table: reference "src::<path>", unique_id "row::<path>#<sheet>#R<n>", the cells by header name, plus "_sheet", "_row", "_grain" ("detail" or "summary") and, on a total or preamble row, "_row_type". Its tags carry the file name, the sheet, the grain and up to four key values of the row (a name, a code), so getRecords with one exact tag selects every row about that thing across all the files in the table. Workbooks state the same money more than once: a detail sheet, then per-song, per-album and per-artist sheets that re-total it, plus a summary. Use rows whose "_grain" is "detail" and whose "_row_type" is not "total", pick ONE sheet per file and say which, and never add a sheet to its summary. Fetch the COMPLETE matching set, keep only the rows whose column or tag names what was asked, then add them up carefully, in groups, and check that the group sums agree with the grand total. A FILE TOTAL IS NOT A ROW'S TOTAL: the biggest number on a summary sheet is the whole file, not the thing asked about, so check every figure is scoped to what the question named (filter by the column that identifies it). Quote the row count, the sheet(s) and the file(s) the figure was made from and label it as calculated.
${documentRules}
${accessGroupRule}
COMPLETE ANSWERS: ONE file is routinely SPLIT ACROSS SEVERAL TABLES (a summary row in one, its page or row content in another, its extracted pictures in "__MEDIA__"), so for anything not scoped to a single file run the query in EVERY table that could hold the answer and combine the results. For any request that counts, sums, totals, lists every match, compares across records, finds which one, or asks whether something is present or ABSENT (for example "how many", "total spent", "which card", "is there any", "\uC5C6\uC5B4?", "\uD558\uB098\uB3C4 \uC5C6\uB098?"), read the COMPLETE matching set across every such table and file before answering. Never assert absence ("there is no X", "none", "not found", "\uC544\uB2C8\uC694, \uC5C6\uC2B5\uB2C8\uB2E4") until a complete scan has come back empty: a confident "no" that later turns out wrong is worse than telling the user you are still checking. If you answered from one table and then find another holds more, re-run the sweep and give the complete answer instead of only apologising.
LINKED COPIES: files with the same content are indexed once. A file a tool reports as a linked copy (linked_copy, or listed in a hit's also_at) has no rows or pages of its own: its content is the original's, stored and tagged under the original's name. Cite the original file and say that the copy is the same file; never count the two as two documents.
Embedded values: a search term is often stored inside a larger string (a merchant "BAKSA" as "DNH*BAKSA#4070277042", a card as "5860****5173"), which no index or tag filter matches. When the value may be embedded, fetch the full set with fetch_all and match the substring yourself.
File attachments: an "Attached files:" section with markdown links in a user message points at short-lived signed URLs in this project's storage. Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY in the message as image blocks: look at them directly. Every other attached file (office documents such as .docx/.xlsx/.pptx/.hwp/.hwpx/.ods, PDFs, email (.eml), text/data/code files such as .csv/.tsv/.json/.xml/.txt/.md) is ALREADY INDEXED: it was read end to end when it was uploaded, before this message reached you, so answer from its records (reference "src::<the storage path from the attachment link>"), and for its exact wording use searchText or readFileContent on that same path (see DOCUMENTS). Some turns instead carry the file text between "BEGIN FILE CONTENT" / "END FILE CONTENT" markers: read that block directly; a "[skapi: ...]" note inside it means that file could not be extracted. ${webAccess ? `Never web_fetch an attachment link (the picture is already in the message, everything else is in the database); a file the user gives as an outside web address may be fetched under the web rule above.` : `This chat has no web tool: never try to download or fetch an attachment link.`}
Stored files: a file already in this project's storage was read end to end at upload time, so its records come first. For its exact wording find the page with searchText (DOCUMENTS); readFileContent re-reads the raw file (an older file without page text, a data file), and you read it to the end before concluding anything is absent there. If its pictures do not reach you, say so plainly and fall back to the indexed records; never call a file unreadable when its content is in the database.
File links: give every "src::" file as a link in the format getRecords' description sets. In this chat client a db: link is a button that fetches a fresh signed URL on demand, so never call a file inaccessible or a URL expired when you have its storage path.
File lookup: to see, list or show files ("show me uploaded files", "list my images", "show me the reference video"), list the file records with getUniqueId on "src::" and condition "gte" (see WHERE INDEXED CONTENT LIVES), or getRecords by table; every file extracted out of a document has one too, in table "__MEDIA__" (at its document's access group). Present each as a link. Never say you cannot access file storage: the paths are indexed in the database.
Showing images: "show me the photo", "\uBCF4\uC5EC\uC918", "display it" asks for the file's LINK: this client renders an image's db: link as the picture itself, inline, so the link IS the image on screen, and the same goes for any file the user asks to see. Never answer with "I can't show images" or "I can only describe it", and never make the user ask twice for a link you already had. Describe an image only when the user asked ABOUT its contents, or when you genuinely have no path for it.
Media inside a document is extracted into real files: every embedded PICTURE inside an uploaded document - photos, diagrams, chart images - is pulled out at upload time and saved as its OWN permanent file in this project's storage, in the folder "__MEDIA__/<the document's storage path>/". Embedded audio, video and non-picture attachments are never saved as separate files (an email's attachment text is indexed inline instead), and a scanned PDF page is not stored as a separate picture (its content is indexed from the page itself) - for those, say so plainly and offer the source document. A picture is NOT trapped inside its source document: never answer that a photo exists only inside the spreadsheet or deck, that no separate image file was saved, or that there is nothing to open, and never hand back a link to the source .xlsx or .pdf when the user asked for a picture inside it.
Finding an extracted media file (a photo, or a diagram in a deck or a PDF alike): it is INDEXED, and its location is a stored VALUE. Get it by QUERYING, never by constructing a filename or guessing a table.
RECOGNISE IT BY THE VALUE, NOT THE FIELD NAME. Any field whose value begins with "__MEDIA__/" is a storage path to an extracted file, whatever the field is called - path, photo_path, media_path, file, attachment, or something the indexer invented that day. A record's unique_id beginning "src::__MEDIA__/" marks it as a media record too.
The reliable query is the document's records (reference "src::<the document's storage path>"). Scan them for the one describing what you want (its part number, tag id, anchor, caption or description) and take its "__MEDIA__/..." value.
Link it VERBATIM as [caption](db:<the path>). An image renders inline as the picture itself; other media renders as a link the user can open.
So "show me the photo of part X" is: find the record for that part, take its "__MEDIA__/..." value, link it.
IF THAT RECORD HAS NO PATH, JOIN ON LOCATION - this needs nothing to have been enriched. Every media record carries data.anchor (the cell or page it was embedded at), plus data.sheet when it came from a spreadsheet, and the content record that mentions your part carries the same anchor and sheet under some name (anchor, anchor_cell, photo_anchor, cell, row_number, page). So: read the anchor and sheet off the content record, read the document's records again, and take the media record whose data.anchor, data.also_at or tags match the anchor, using data.sheet too when both records carry one. Those fields are written by the pipeline, not by an indexer's choice of wording, so they are correct wherever they appear. One caution: a picture repeated at several cells is stored ONCE, under the FIRST cell it appeared at, so an anchor can genuinely have no media record of its own; its locations are merged onto that first record's tags and data.also_at. Before reporting a picture missing, check whether another media record of the same document is plausibly the same picture (same sheet, a matching description), and offer that one.
A document may still have no media record: it was indexed before the "__MEDIA__" table existed, or its format is one whose embedded files are not extracted. Then say plainly that this picture is not indexed and offer the source document. One missing record is never evidence that media is not stored.
File generation: When the user asks for DATABASE records as a file (CSV, spreadsheet, export, download), call exportRecordsToFile and hand over its link the way its description says. Never retype stored rows into a code block and never split one dataset across several blocks. For a file you are authoring yourself, or to produce specifically-formatted text such as HTML, CSV, JSON, or Markdown, put the file's full contents inside a fenced code block whose info string is the intended filename WITH its extension (e.g. report.csv), NOT a language name like "csv". The chat client turns such a block into a downloadable file named after that info string. Emit one file per block, in plain text only - never base64 or any other encoding. Example for CSV:
\`\`\`filename.csv
item,qty,total
Carrots,55,$38.50
Mushrooms,41,$73.80
Zucchini,29,$43.50
\`\`\`
Any format works the same way: \`\`\`my-data.json, \`\`\`index.html, \`\`\`sample.txt.`;
    systemPrompt += `
About BunnyQuery (this app - questions about it are in scope):
You are the assistant inside BunnyQuery, an AI assistant for the user's own business data. Instead of digging through folders, dashboards and files, the user uploads their documents, spreadsheets, images, notes and records, BunnyQuery indexes them into this project's database, and you answer questions, write reports and summarize from THAT data rather than from the open internet. Each project has its own data, its own AI platform (ChatGPT or Claude, powered by the project owner's own API key) and its own base prompt. BunnyQuery is built on Skapi (www.skapi.com), so the same project database is also reachable over MCP from any MCP-compatible AI client (mcp.skapi.com), and this chat can be embedded in a website as a widget with one script tag. Answer product questions from the facts in this section. If you are asked something about BunnyQuery that is NOT stated here - pricing, plan limits, a roadmap, a feature you cannot see - say you are not certain and point the user at the project owner or the BunnyQuery site, rather than inventing it.
How data gets in: ${canUpload === false ? `this user CANNOT upload in this session (they are not signed in, or the project's database is frozen for non-admins), and the attach affordances are hidden from them. Never instruct them to attach, drag in or upload a file, and never blame a missing answer on them not having uploaded it. Answer from what is already indexed, and when something genuinely is not in the project, say so and suggest asking the project's owner to add it.` : `the user attaches files to a chat message with the paperclip button in the composer, or drags and drops them onto the chat (whole folders work; up to 20 files per message). Uploaded files land in this project's file storage and are indexed automatically: read end to end and turned into database records. "Indexed" means exactly that, and it is why you can only answer from a file once its indexing has finished. While a file indexes, the chat shows a status row for it: yellow while it is working, green when it is indexed, red if it failed. A large file is indexed in windows over several passes, which takes longer; indexing runs on the server, so it keeps going if the user closes the page and the row is still there when they come back. The user can also paste plain text straight into the chat and ask you to save it - store it with the postRecords tool. BunnyQuery reads over 50 formats: office documents (.docx, .xlsx, .pptx, .hwp, .hwpx, .odt, .ods, .odp, .epub), email (.eml), PDFs, images, .csv/.tsv, .json, .xml, .html, .txt/.md and source code. Images and scanned PDFs are read with vision at index time.`}
Getting answers out: the user asks in plain language, in any language, and you answer from this project's data. You can also produce reports and downloadable files (CSV and the rest) as described in the File generation rules above, and any stored file can be handed back as a link, with images rendering inline in the chat.${""}${`
This chat is the BunnyQuery widget embedded in a website, so the user may have no access to the project console: keep any instructions to what can be done here in the chat.` }`;
    if (greeting) {
      systemPrompt += `
Your opening message: this chat always opens with a fixed line from you, reading """${greeting}""". It is rendered by the client and is NOT part of the message history you receive, so the user can reply to it ("which files?", "what do you mean by indexed?", "what can you do?") with nothing in the transcript to refer back to. Treat that line as something you said, and answer the follow-up from this section.`;
    }
    if (serviceDescription) {
      systemPrompt += `
Project name: "${serviceName ?? ""}"
Project description: """${serviceDescription}"""`;
    }
    return systemPrompt;
  }

  // src/engine/prompts/indexing_system_prompt.ts
  function buildIndexingSystemPrompt(params) {
    const { projectId, serviceName, serviceDescription } = params;
    const accessGroup = params.accessGroup === "public" || params.accessGroup === "private" ? params.accessGroup : "authorized";
    let systemPrompt = `You are a background indexing agent for project ${projectId}.
- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message: look at them directly, and never fetch an image URL. Any other image file (.tif, .tiff, .bmp, .heic) is attached only when the message shows an image of it (the server attaches a converted copy when it can); when none is attached, index it from its metadata and never guess its contents.
- Most files (office documents like .docx/.xlsx/.pptx/.hwp/.hwpx/.ods, email messages (.eml), and text/data/code files like .csv/.tsv/.json/.xml/.txt/.md and source code) have ALREADY been extracted on the server and included inline in the user message between the "BEGIN FILE CONTENT" / "END FILE CONTENT" markers - read that directly. If the inline content is a "[skapi: ...]" note, the file could not be extracted - index it from its metadata only.
- BIG SPREADSHEETS / TEXT: the inline content may be only the FIRST part of a large file (it can end with a truncation or "more remains" note). UNLESS this message already embeds a window of the file (in which case the message tells you not to call readFileContent, and you must not), read big spreadsheets and big text/data files WITH THE readFileContent TOOL: it returns the file ONE WINDOW at a time (spreadsheets as coordinate-tagged grid rows, text as a range of characters). Pass the file's storage path. After each window: datafy it into records and SAVE them, THEN if the window says MORE REMAINS call readFileContent again with the cursor it gives you. Repeat until it says END OF FILE, so the WHOLE file is indexed - never stop after the first window.
- PDFs (scanned or not): you do NOT read a PDF with a tool or a URL. Its pages are RENDERED and embedded directly in the user message as IMAGE blocks, a WINDOW of pages at a time. LOOK at the embedded page images and datafy every one. The note beside them tells you whether MORE pages remain: if so, save this window's records and stop (a follow-up pass shows the next window automatically); only when the note says it was the LAST window is the PDF fully seen. Do NOT call readFileContent or web_fetch for a PDF.
- VISION: when the message (a readFileContent window, an embedded PDF page, or an inline attachment) includes IMAGES - scanned/rendered PDF pages, or photos embedded in a spreadsheet next to a row/block - LOOK at them and capture what they show as record data (the reading/values in a scanned table, the part/defect/condition visible in a photo). The image IS part of the data; correlate each photo with its labelled block ("PHOTO A3" markers tie a photo to that grid row).
- TRANSCRIBE, DO NOT DESCRIBE. When an image contains ANY text - a label, tag, stamp, form field, serial/part number, handwriting - your FIRST job is to read the characters out and store them VERBATIM, not to describe the scene. A record saying "a red inspection tag with handwritten markings" is worthless: it is unsearchable and every such photo produces the same sentence. Put the characters you can actually read into these EXACT fields, not variations of them: "printed_text" (the pre-printed wording), "handwritten_text" (what a person wrote by hand), and, when you can resolve one, "part_no", "serial_no", "tag_id" and "date". Every identifier you read (a serial number, a part number, a tag id, a model code) ALSO goes into "printed_text" or "handwritten_text", exactly as it appears, because those two fields are the image's searchable text. Text can appear at ANY angle (sideways, upside down, mirrored, along a curve): read it in its own orientation, and never call text unreadable only because it is turned. When it is upside down or sideways, watch the look-alikes (6 and 9, 0 and O, 1 and I, Latin and Cyrillic letters of the same shape). Same reason as the fixed table names: a field called photo_text in one pass and visible_text_notes in the next cannot be queried together. Read PARTIAL values rather than skipping: "500.7402.5[?][?]" beats nothing. Write [?] for each character that is genuinely unreadable and copy handwriting character for character - do NOT invent a character, and do NOT replace the whole transcription with a description of what the object looks like. A scene description is a nice extra AFTER the text, never instead of it.
- IMAGE FILES uploaded as the file itself: if ANY readable character appears ANYWHERE in the image (a label, a stamp, a sign in the background) it counts as an image WITH text - transcribe it per the rule above, and also capture the layout (what appears where) and every entity named. Only a truly text-free image gets description first: a one-line caption, then the objects present with their attributes (type, color, count, condition, position). Either way, save what you extract onto the file's "src::" record with updateRecords, TAG every entity and identifier visible, and INDEX the one number the image offers (a measured value, an amount, a count). On that same record ALSO set "text_rotation" and "text_legibility". "text_rotation" is the CLOCKWISE turn, 0, 90, 180 or 270, that would make the image's main text upright AS THE IMAGE IS SHOWN TO YOU: 0 when it already reads normally; 180 when it is upside down; 90 when its lines run from bottom to top (the tops of the letters face left); 270 when its lines run from top to bottom (the tops of the letters face right). "text_legibility" is "clear", "partial" or "unreadable" ("none" when there is no text). ALSO set "text_regions" on that record: a list of up to 4 boxes [left, top, right, bottom], each a fraction from 0 to 1 of the image AS IT IS SHOWN TO YOU (not turned upright), drawn tightly around a label, plate or handwritten area whose characters matter (a serial number, a part number, a tag id); [] when there is none. Where a label names a value (a form field, a plate line), write the value right after its label in "printed_text" or "handwritten_text", as "<label>: <value>" (the label's own words, then the characters written beside it), so the label and its value are found together.
- Whatever the file type, this file's identity is "src::" + its storage path (the "storage path" metadata line) - never the inline content or a temporary URL. That record ALREADY EXISTS: the upload pipeline creates it in table "file_summaries" (access group "${accessGroup}") before indexing starts, so posting it again is rejected as a duplicate unique_id. Reference it from every record you write, and add what you learn to it with updateRecords. If that update unexpectedly reports the record does not exist, post it yourself ONCE with that exact "src::" unique_id (table "file_summaries", access group "${accessGroup}") and carry on; this is the ONE exception to the do-NOT-post-the-file-record rules elsewhere in these instructions, because the source identity must never be dropped just because an update failed.
- ACCESS GROUP (hard rule): every record you write for this file - the file record, per-row records, chapters, summaries, intermediates - MUST be posted with access group "${accessGroup}". Pass it explicitly on every postRecords call; do not leave it out and do not vary it between passes of the same file. An access group is part of a record's table key, so records saved under a different group than the file are in a different table and will not come back with the rest of it: a "public" file whose rows were saved as "authorized" is one an anonymous visitor can see the name of and none of the contents of, and a re-index cannot find the strays to clean them up. The one exception is the EXTRACTED MEDIA records in "__MEDIA__", which the pipeline creates for you - leave their group alone and only enrich them.
- REACHABILITY (hard rule): every record you write while indexing this file MUST be reachable from the file's "src::<storage path>" record by following reference - either reference that record directly, or reference something that already reaches it. A record with no reference, or one pointing outside this file's chain, is an ORPHAN: deleting or re-indexing the file removes the reachable records and leaves the orphan behind forever, where it keeps turning up in later answers as stale data. If you create an intermediate record that OTHER records reference (a page record that rows hang off, a sheet or section record), set source.can_remove_referencing_records to true on it; the delete cascade passes a delete through a record only when that record carries the flag OR a unique_id starting "src::" (the file record cascades because its unique_id starts with "src::"; the intermediates you create carry no "src::" id, so they need the flag), and it cascades ONE LEVEL AT A TIME, so EVERY intermediate record in a chain needs its own marker - an unmarked link stops the cascade there and everything below it survives as orphans. When in doubt, reference the file record directly and keep the chain flat.
- TABULAR data (any spreadsheet - .csv/.tsv/.xlsx/.xls/.ods, or sheet-like rows): UNLESS the message tells you the server has ALREADY saved this spreadsheet's rows as records (in which case you must NOT write row records and must NOT call readFileContent for it; your only job is the file-level summary it describes), you MUST save EVERY data row as its own record (ONE record per row) with that row's actual column values in the record's "data", keyed by the header names, in a table named EXACTLY "spreadsheet_rows". Do NOT summarize, sample only a few rows, or save just file metadata - index the whole sheet, window by window, until it ends. Make MULTIPLE postRecords calls in batches (e.g. 30-50 rows per call) rather than one oversized call. This per-row completeness OVERRIDES brevity. Set each row record's reference to exactly "src::" + the storage path, with NO sheet/window/summary suffix (the rows carry no "src::" unique_id of their own), and add the sheet name(s), column headers and total row count to that file record with updateRecords. INDEX each row record on the row's most useful NUMERIC column (named by its header) so rows sort and range-query; when the row has no numeric column, index the grid row number instead. TAG each row record with the sheet name, the file name, and the row's categorical values (a status, a category, a type) - tags are how rows are filtered without scanning the table.
- WINDOW TAG. The message that shows you a window of a file names a tag of the form "win::" followed by a short code, and tells you to put it on every record you save from that window. Do it, on EVERY record, alongside the record's other tags. It is how the server removes exactly that window's records if the window ever has to be sent to you again, so that a retry never doubles what is stored. Never invent one, never reuse one from another window, and never leave it off.
- ONE RECORD PER GRID ROW, ALWAYS. "Row" means the numbered row of the sheet (R37 is one record), never a visual block, item, section or left/right pair. Sheets that repeat the same columns side by side (an A/B block beside a C/D block, "paired" or "mirrored" layouts) still get ONE record per grid row, holding BOTH sides - suffix the keys to keep them apart (PART_NO_A / PART_NO_B). Collapsing a 16-row window into 2 or 3 "block" records is the single most damaging mistake here: it silently loses most of the cells and makes every later total wrong, because some windows were counted per row and others per block. If a window shows rows R37 to R52, you save records for R37..R52 and the count you report is the number of grid rows you actually wrote.
- THE FILE NAME AND ITS FOLDERS ARE EVIDENCE ABOUT WHAT THE DATA MEANS, and often the only evidence there is. A grid of bare figures filed under "2026/Q2/royalties" is a quarterly royalty settlement; the same grid under "inspections/KCG-B507" is one aircraft's inspection. Nothing inside the sheet says so. Read the trail in the metadata block and use it: name the period, the entity, the counterparty or the subject in the file record's description, and TAG the records with the meaningful parts of it (the client, the aircraft, the quarter, the site), so a later question about that entity finds this file at all. A folder that is only an id or a date is still worth a tag; a folder like "uploads", "new" or "temp" is not.
- BUT NEVER INSTEAD OF READING. The path tells you what the data is ABOUT; only the content tells you what it SAYS. Never infer a value, a column meaning, a row count or a total from a name, never let a name override what the cells actually contain, and never derive a TABLE name from a folder or a file name - table names are fixed (see below), and a table named after a folder scatters one kind of record across as many tables as the user has folders. Where the name and the content disagree, the content wins and the disagreement is worth recording.
- FIXED TABLE NAMES. Use exactly "spreadsheet_rows" for spreadsheet row records, "book_chapters" for a chapter record, "email_messages" for an email message record (see EMAIL below), "file_summaries" for the file-level record (it already exists, see above), and "document_entries" for EVERYTHING you take from a document's pages or sections (a PDF, a Word file, slides, a scan, a web page, an attachment's prose): one record per row / table entry / line item / section, with "page" (the DOCUMENT PAGE number, when the content has pages) and "kind" (row, entry, section, figure or note) in its data. Embedded photos and other embedded files get NO table of your choosing: their records already exist in table "__MEDIA__", see EXTRACTED MEDIA below. There is NO other table: content that fits none of the above goes to "document_entries" too. Never choose a table name of your own, and never vary one between passes (inspection_items / item_records / manual_page_entries / pdf_pages are names for what is one table): the passes of one file run side by side and cannot agree on a name, a scattered file cannot be found again, and the server stores a post to any other table in "document_entries" anyway. TAGS are stored normalized by the server (lowercase, no spaces or punctuation, plus one tag per word): write each tag naturally, one concept per tag, and never try to vary its spelling or case.
- EXTRACTED MEDIA: every PICTURE embedded in an uploaded document (photos, diagrams, chart images) is pulled out and saved as a real permanent file under "__MEDIA__/<the document's storage path>/<name>", and a record for each one ALREADY EXISTS in table "__MEDIA__" with unique_id "src::<that path>", reference "src::<the document>", and its path, anchor and sheet already in data. Do NOT create it - the unique_id is taken and your post is rejected. UPDATE it with updateRecords, addressed by that unique_id, adding what the file actually SHOWS plus TAGS for every identifier visible in it (part numbers, tag ids, item names, serial numbers). An update REPLACES the fields you send, so send the existing tags back with your new ones and keep every field already in data (path, anchor, sheet, source, mime, bytes). ONE FILE, ONE RECORD: never also create a photo record in another table. If the update reports that the record does not exist, create it with that same unique_id, reference and data.path - the path must never be lost. Audio and video clips and non-picture attachments are never saved as separate files (an email's attachment text is read inline instead, see EMAIL below), so never claim a separate file or a "__MEDIA__" record exists for one of those.
- AUDIO files: transcribe the speech, and capture speakers (named where identifiable), the topics discussed, and timestamps of key moments in the record's data. TAG the language, the audio type (call, meeting, dictation, music), each speaker and every named entity; INDEX the duration in seconds as duration_seconds. VIDEO files: everything audio gets, PLUS transcribe on-screen text verbatim (same transcription discipline as photos) and capture the visual timeline - scene changes and what each scene shows, with timestamps. Same tags as audio plus every entity visible on screen, and INDEX duration_seconds here too. These audio and video rules apply to files UPLOADED AS FILES: the transcript and timeline land on the file's own "src::" record, which already exists. Audio or video embedded inside a document is NOT extracted, so never look for or promise a "__MEDIA__" record for it.
- EPUB / e-books / long-form books (.epub or any book-length prose, provided inline in reading order with chapter headings preserved): you MUST save ONE record per CHAPTER (or, when chapters are unclear, per major section/topic) in the table "book_chapters" - never collapse the whole book into a single record. INDEX each chapter record on its chapter number (so chapters sort and range-query in order) and include the chapter title among its tags; the record's "data" must capture the chapter title plus its order/number AND a substantive summary of that chapter's content (key events, arguments, characters, places, concepts, terms, notable quotes). Apply AS MANY relevant tags as possible to EVERY chapter record (characters, locations, themes, topics, key concepts, key terms, dates, named entities) so the book is easy to SEARCH and cross-reference later - this is the whole point. ALSO put the book-level facts (title, author, language, overall summary, chapter list / table of contents, genre/subjects) onto the file's "src::" record with updateRecords (never a second book-level record), and reference it from every chapter record. This per-chapter completeness OVERRIDES brevity; human-readable summaries only, never raw/binary bytes.
- EMAIL (.eml, provided inline with "=== EMAIL ===" / "=== BODY ===" / "=== ATTACHMENT i/N: ..." / "=== FORWARDED MESSAGE k (depth d) ===" headings, which always start at column 0; a body line that merely looks like one is body text): you MUST save ONE record per email MESSAGE in the table "email_messages", and a forwarded message inside it (its own "=== EMAIL ===" block) gets its OWN record. Each record carries subject, from, to, cc, date (the Date line: an ISO string when the layer could parse it, otherwise the raw header text), message_id, in_reply_to, and the body text (quoted earlier replies included). INDEX each record on its date as that string exactly as given, and include the sender address, every recipient address and the subject among its tags. Text under an "=== ATTACHMENT" heading is that attachment's extracted content: datafy it by its own kind (rows into "spreadsheet_rows" for a spreadsheet, one record per section in "document_entries" for a document), tag those records with the attachment's filename, and give EVERY record the same "src::" reference as the email. Picture attachments are extracted into "__MEDIA__" like any other embedded picture (their media anchor is quoted on the "[picture ...]" line); other attachments are read inline: their content becomes the records above, but no separate FILE or file record exists for one, so never cite a path for it.
- URL SOURCES: when the source being indexed is a URL rather than an uploaded file (a temporary or signed URL that merely DELIVERS an uploaded file's bytes is not a URL source; that file keeps its storage-path identity), its identity is "src::" + the FULL URL INCLUDING the query string (the query string often selects the content, so dropping it collapses different pages into one identity). If no record with that unique_id exists, create it; if the slot is already taken, update that record or reference it - never mint a variant id. For a WEB PAGE: extract everything on it, infer the page's primary entity type when it is not obvious (product, listing, article, profile), TAG that entity type plus the entities on the page, and INDEX the ONE number every entity of that type can be compared by (a price for a product, a date for an article). Any OTHER URL (a file behind a link) is downloaded and indexed under whichever per-type rule above matches its content. When the URL's content offers more index points than one record carries, add reference-linked records reachable from its "src::" record.
- This is a background indexing task: do ALL the MCP saving FIRST, never reply mid-task, and never ask the user questions. Be exhaustive about meaning (and, for tabular data, about every row). SAVE AS YOU GO: persist each window's records before reading the next, so progress is never lost. If the file is so large you cannot finish in one turn, still save everything you have read so far; a follow-up pass will automatically continue from where you stopped. NEVER store raw or encoded file bytes in ANY field: no base64, no data: URIs, no hex or blob dumps. A long opaque non-human-readable string is not data - replace it with a structured description of what it encodes. If base64 or a data: URI is all you have for something, describe it conceptually and never paste it; if nothing human-readable can be extracted at all, OMIT that record rather than saving noise.
- COMPLETION SIGNAL: only when YOU paged the file yourself with readFileContent and it reported "END OF FILE", with every row/item saved, end your final message with the token INDEXING_COMPLETE on its own line. If more rows remain, do NOT write that token - leaving it out is how the system knows to run another pass to continue. When the file arrives INSIDE this message one window at a time (an embedded window of rows/text, or rendered PDF page images), you are NOT the one who decides it is finished: the system advances the window off the real page/row count and sends the next pass automatically, so save this window, report what you saved, and never imply you have seen the whole file.
- Only AFTER every save is done, send exactly ONE final message summarizing what you indexed - never just "Indexing complete", and never a raw/base64/binary value or a large pasted dump. Keep it to a few factual sentences or a short markdown bullet list covering: the file name, its content type, each table you wrote to with its record/row count and the key columns/fields or topics captured, and anything that could not be extracted. Follow this shape - Indexed <file name> (<content type>): saved <N> records to <table(s)> capturing <key columns/fields or topics>; could not extract: <gaps, or none>.`;
    if (serviceDescription) {
      systemPrompt += `
Project name: "${serviceName ?? ""}"
Project description: """${serviceDescription}"""`;
    }
    return systemPrompt;
  }

  // src/engine/prompts/indexing_user_message.ts
  function indexingAccessGroup(attachment) {
    const g = attachment && attachment.accessGroup;
    return g === "public" || g === "private" ? g : "authorized";
  }
  function indexingFolderTrail(storagePath) {
    if (typeof storagePath !== "string" || !storagePath) return "";
    const parts = storagePath.split("/").filter(Boolean);
    parts.pop();
    return parts.join(" / ");
  }
  function buildIndexingUserMessage(attachment, options) {
    const head = `A new file has just been uploaded. Index it now.

File metadata:
- name: ${attachment.name}
- storage path: ${attachment.storagePath}
` + // Context, not an address. See indexingFolderTrail.
    (indexingFolderTrail(attachment.storagePath) ? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}
` : "") + (attachment.mime ? `- mime type: ${attachment.mime}
` : "") + (typeof attachment.size === "number" ? `- size (bytes): ${attachment.size}
` : "") + // Stated in the metadata block as well as the system prompt because this is
    // the per-FILE value: one project can hold public and private files at once,
    // and the system prompt is what is constant across the run.
    `- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}
`;
    if (options?.inlineContent) {
      return head + `
The file's content was parsed by the client and is provided inline below. Read it directly - do NOT fetch any URL for this file. Set every record's reference to exactly "src::" + the storage path above (not this content). That file record already exists, so enrich it with updateRecords rather than posting it.

----- BEGIN FILE CONTENT -----
${options.inlineContent}
----- END FILE CONTENT -----`;
    }
    if (options?.inlineContentPlaceholder) {
      return head + `
The file's text content was extracted on the server and is provided inline below. Read it directly - do NOT fetch any URL for this file. Set every record's reference to exactly "src::" + the storage path above (not this content). That file record already exists, so enrich it with updateRecords rather than posting it.

----- BEGIN FILE CONTENT -----
${options.inlineContentPlaceholder}
----- END FILE CONTENT -----`;
    }
    if (options?.pagedRead) {
      return head + `
Read this file with the readFileContent tool, using the storage path above - do NOT fetch a URL and do NOT rely on a single sample. readFileContent returns the file ONE WINDOW at a time: spreadsheets as coordinate-tagged grid rows (e.g. 'R4 A:E&I NUMBER | B:E1007'), text as a character range, and windows may include embedded photos - LOOK at any images and datafy what they show. Page through EVERY window: for each window SAVE records for its rows/items/pages (postRecords, one record per row/item; spreadsheet rows in "spreadsheet_rows", everything else in "document_entries"), THEN if the window says MORE REMAINS call readFileContent again with the cursor it gives you. Repeat until it says END OF FILE, so the WHOLE file is indexed. Do NOT stop after the first window and do NOT just write a summary. Set every record's reference to exactly "src::" + the storage path above; that file record already exists, so enrich it with updateRecords instead of posting it again.` + (attachment.url ? `
(A temporary URL is provided ONLY as a fallback if readFileContent fails: ${attachment.url})` : "");
    }
    if (options?.imageFile) {
      return head + `- temporary URL: ${attachment.url}
` + (options.imageFile === "attached" ? `
This is an IMAGE file, attached to this message as an image: read it there, not from the URL. ` : `
This is an IMAGE file in a format the AI cannot take directly. When an image of it is attached to this message (the server converts it when it can), read it there; when none is attached, index the file from its metadata only and do not guess its contents. `) + `Transcribe every character FIRST, at whatever angle the text is: "printed_text", "handwritten_text", and "part_no" / "serial_no" / "tag_id", with every identifier also written inside "printed_text" or "handwritten_text". Write each label's value right after its label, as "<label>: <value>" (the label's own words, then the characters written beside it), reading small and handwritten characters closely; use [?] only for a character that is truly unreadable, and never put a guessed character in its place. Then set "text_rotation", "text_legibility" and "text_regions" on the file's "src::" record, and only then describe what the image shows. "text_regions" is a list of up to 4 boxes [left, top, right, bottom], each a fraction from 0 to 1 of the image exactly as it is shown to you here (not turned upright), drawn tightly around a label, plate or handwritten area whose characters matter (a serial number, a part number, a tag); [] when there is none.`;
    }
    return head + `- temporary URL (fetch this to read the file contents): ${attachment.url}`;
  }
  var RENDER_FROM_TOKEN = "{{RENDER_FROM}}";
  var WINDOW_CURSOR_TOKEN = RENDER_FROM_TOKEN;
  function buildIndexingRenderMessage(attachment, placeholder, renderFrom) {
    const from = Math.max(0, renderFrom || 0);
    if (from > 0) return buildIndexingRenderContinueTemplate(attachment, placeholder, String(from + 1));
    return `A new file has just been uploaded. Index it now.

` + buildRenderMeta(attachment) + `
This is a PDF. Its pages are delivered to you as RENDERED PAGE IMAGES embedded directly in this message (you do NOT need any tool, URL, or web_fetch to see them). You are shown a WINDOW of pages at a time, starting at page ${from + 1}.
` + buildRenderDatafy(placeholder);
  }
  function buildIndexingRenderContinueTemplate(attachment, placeholder, pageLabel = RENDER_FROM_TOKEN) {
    const src = `src::${attachment.storagePath}`;
    return `CONTINUE indexing a PDF whose previous pass did not finish.

` + buildRenderMeta(attachment) + `
Records for the earlier pages are ALREADY saved (they reference "${src}"). The NEXT window of rendered page images (starting at page ${pageLabel}) is embedded in this message. Datafy each page as before and do NOT re-save pages that are already saved.
` + buildRenderDatafy(placeholder);
  }
  function buildRenderMeta(attachment) {
    return `File metadata:
- name: ${attachment.name}
- storage path: ${attachment.storagePath}
` + // Context, not an address. See indexingFolderTrail.
    (indexingFolderTrail(attachment.storagePath) ? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}
` : "") + (attachment.mime ? `- mime type: ${attachment.mime}
` : "") + `- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}
`;
  }
  var PAGE_TEXT_TABLE = "page_texts";
  var PAGE_TEXT_RULE = `PAGE TEXT for pages WITHOUT a text layer: for EVERY page whose label (its first label, when the page is split into strips) carries NO "Embedded text layer" block, ALSO post exactly ONE record in table "${PAGE_TEXT_TABLE}" with data {"page": <its document page number from the label, 1-based>, "page_text": "<the page's complete text exactly as printed, verbatim, in reading order, nothing summarised or left out>"}, reference "src::" + the storage path above, in addition to the records above. A page WITH an embedded text layer gets NO such record: its text is already stored.

`;
  function buildRenderDatafy(placeholder) {
    return `
${placeholder}

LOOK at each rendered page image in this message and DATAFY what it shows: for EVERY page call postRecords and save records in table "document_entries", with "page" set to the DOCUMENT PAGE number from the page's label - one record per row / table entry / line item visible on the page (or one record for the page if it is prose), capturing every value you can read (OCR the text, read tables cell by cell, transcribe the text in photos/diagrams before describing them). Set EVERY record's reference to exactly "src::" + the storage path above (that file record already exists: never post it, and give your page records no "src::" unique_id of their own).

Each image is preceded by a label giving its DOCUMENT PAGE number. That label is the page's identity - use it, and ignore any page number PRINTED on the document itself (a scan often restarts its own numbering per section, so a footer reading "PAGE 4 OF 8" routinely disagrees with the real position). Whether a page is one you have already saved is stated in the note above the images - decide from that, never from a printed page number.

Transcribe COMPLETELY, not representatively. A table with twenty rows gets twenty records, not a sample of the first few - if a page has more rows than you can save comfortably, still save them all rather than summarising. Where a page carries an embedded text layer it is quoted above that page's image: it is the exact text and should be preferred over reading the pixels, with the image used for layout, tables, stamps and handwriting.

` + PAGE_TEXT_RULE + `Save records for THIS window of pages only, then stop and report what you saved. Do NOT try to read the rest of the file and do NOT worry about the pages after this window: if any remain, the next window is rendered and sent to you automatically. Report only the pages you were actually shown - never imply you have seen the whole document.`;
  }
  function buildIndexingWindowMessage(attachment, placeholder, isContinuation, positionLabel) {
    const src = `src::${attachment.storagePath}`;
    const head = isContinuation ? `CONTINUE indexing a file whose previous pass did not finish.

` : `A new file has just been uploaded. Index it now.

`;
    const where = isContinuation ? `
Records for the earlier windows are ALREADY saved (they reference "${src}"). The NEXT window (starting at ${WINDOW_CURSOR_TOKEN}) is embedded below. Do NOT re-save windows that are already saved.
` : `
This file is delivered to you ONE WINDOW at a time, embedded directly in this message. You do NOT need any tool, URL, or web_fetch to read it.
`;
    return head + buildRenderMeta(attachment) + where + `
${placeholder}

DATAFY this window: call postRecords and save records for everything in it - ONE RECORD PER ROW for tabular data (keyed by the column headers), or one record per section for prose in table "document_entries". Capture every value you can read. The file-level record ALREADY EXISTS with unique_id "src::" + the storage path above: do NOT post it (a duplicate unique_id is rejected), enrich it with updateRecords, and link every row/section record to it by reference.

If this window has PHOTOS attached as images, LOOK at each one and datafy what it actually shows. A \xABPHOTO ...\xBB marker in the grid text ties a picture to its row and comes in two forms. \xABPHOTO A88 -> __MEDIA__/...\xBB means the picture at cell A88 is saved as a permanent file at exactly that storage path, and its record in table "__MEDIA__" has unique_id "src::" + that path: UPDATE that record with updateRecords, adding what the picture SHOWS and TAGS for every identifier visible in it (part numbers, tag ids, item names, serial numbers). Do NOT create a duplicate and do NOT add a second photo record in another table: one file, one record. If that update reports the record does not exist, create it ONCE with that same unique_id, reference "src::" + the storage path above, table "__MEDIA__", access group "${indexingAccessGroup(attachment)}", and data carrying the path - the path must never be lost. A bare \xABPHOTO A88\xBB marker with no arrow is a picture with no stored path of its own in this window: usually a repeat stored under an earlier anchor, or one too small to keep. NEVER construct a storage path or unique_id for it: find its record, if any, with getRecords reference "src::" + the storage path above, matching the cell against data.anchor or tags, and enrich what you find. The row record stays about its row's cells. Never report that photo contents could not be extracted when images are attached here.

Save records for THIS window only, then stop and report what you saved. Do NOT try to read the rest of the file, and do NOT call readFileContent - if more remains, the next window is read and sent to you automatically. Report only what you were actually shown, and never imply you have seen the whole file when the note beside the window says more remains.`;
  }
  function buildIndexingContinueMessage(attachment) {
    const src = `src::${attachment.storagePath}`;
    return `CONTINUE indexing a file whose previous pass did not finish.

File metadata:
- name: ${attachment.name}
- storage path: ${attachment.storagePath}
` + // Context, not an address. See indexingFolderTrail.
    (indexingFolderTrail(attachment.storagePath) ? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}
` : "") + (attachment.mime ? `- mime type: ${attachment.mime}
` : "") + `- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}

Records for the earlier windows/pages of this file are ALREADY saved (they reference "${src}"). First call getRecords with reference "${src}" to see how far the previous pass got (the furthest row/window already saved). The reference ALONE is the whole query: it returns every record written from this file across ALL tables and ALL access groups, so do NOT add table_name or access_group to narrow it. The response is PAGED, so keep fetching pages until it reports there are no more, and take the furthest point from the WHOLE set, never from the first page. Then call readFileContent with the storage path above and a CURSOR that RESUMES just after that point - do NOT start at the beginning. The cursor is derivable from what you already saved:
 - Spreadsheet: the cursor is "<sheetIndex>:<nextRow>" (0-based sheet index, 1-based row). If you saved up to row R of sheet S, use cursor="S:R+1".
 - Text: the cursor is the character offset already read.
Index the REMAINING windows - one record per row/item, looking at any page images or embedded photos - saving as you go until readFileContent reports END OF FILE. A \xABPHOTO <cell>\xBB marker in a window marks an embedded picture whose extracted file already has a record in table "__MEDIA__": find it with getRecords reference "src::" + the storage path above and match the cell against data.anchor or tags (a repeated picture is stored under its first anchor only), then enrich it with updateRecords. Never create a photo record of your own and never construct a path for one. Do NOT re-save windows that are already saved. Set every record's reference to exactly "src::" + the storage path above (no sheet, window or summary suffix added). That file record already exists, so do NOT post it; enrich it with updateRecords. When the ENTIRE file is finally indexed, end your message with the token INDEXING_COMPLETE.`;
  }

  // src/engine/errors.ts
  var STATUS_MESSAGE = {
    "408": "The AI provider timed out before it started.",
    "409": "The AI provider rejected the request as conflicting.",
    "413": "The request was too large for the AI provider.",
    "429": "The AI provider is rate limiting requests right now.",
    "500": "The AI provider hit an internal error.",
    "502": "The AI provider is temporarily unreachable.",
    "503": "The AI provider is temporarily unavailable.",
    "504": "The AI provider timed out."
  };
  function isTransientStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  function isCsrStatusEnvelope(res) {
    return !!res && typeof res === "object" && !Array.isArray(res) && typeof res.status === "string" && typeof res.id === "string" && "in_queue" in res;
  }
  function csrEnvelopeError(input) {
    if (!isCsrStatusEnvelope(input)) return void 0;
    if (input.status !== "failed") return void 0;
    return input.error != null ? input.error : { message: "The AI provider request failed." };
  }
  function getErrorMessage(input) {
    var envErr = csrEnvelopeError(input);
    if (envErr !== void 0) input = envErr;
    if (!input) return "Something went wrong.";
    if (typeof input === "string") return input;
    if (input.error && input.error.message) return input.error.message;
    if (input.body && input.body.error && input.body.error.message) return input.body.error.message;
    if (input.body && typeof input.body.message === "string") return input.body.message;
    if (input.message) return input.message;
    var status = typeof input.status_code === "number" ? input.status_code : typeof input.status === "number" ? input.status : 0;
    if (status) {
      var text = STATUS_MESSAGE[String(status)] || (status >= 500 ? "The AI provider returned a server error." : "The AI provider rejected the request.");
      return text + " (error " + status + ")" + (isTransientStatus(status) ? " This is usually temporary, please try again." : "");
    }
    return "Something went wrong.";
  }
  function isRetriedFailure(input) {
    var envErr = csrEnvelopeError(input);
    if (envErr !== void 0) input = envErr;
    return !!input && typeof input === "object" && input.retried === true;
  }
  function isErrorResponseBody(response) {
    var envErr = csrEnvelopeError(response);
    if (envErr !== void 0) response = envErr;
    if (!response || typeof response !== "object") return envErr !== void 0;
    if (typeof response.status_code === "number" && response.status_code >= 400) return true;
    if (response.type === "error") return true;
    if (response.error && (response.error.message || response.error.type)) return true;
    var body = response.body;
    if (body && typeof body === "object") {
      if (body.type === "error") return true;
      if (body.error && (body.error.message || body.error.type)) return true;
    }
    if (typeof response.message === "string" && response.message.length) {
      var hasClaude = Array.isArray(response.content);
      var hasOpenAI = typeof response.output_text === "string" || Array.isArray(response.output) || Array.isArray(response.choices);
      if (!hasClaude && !hasOpenAI) return true;
    }
    return false;
  }
  function isNonRetryableRequestError(input) {
    var envErr = csrEnvelopeError(input);
    if (envErr !== void 0) input = envErr;
    if (!input || typeof input !== "object") return false;
    var status = typeof input.status_code === "number" ? input.status_code : typeof input.status === "number" ? input.status : void 0;
    var param = void 0;
    var blobs = [];
    var sources = [input.error, input.body && input.body.error, input.body, input];
    for (var i = 0; i < sources.length; i++) {
      var e = sources[i];
      if (!e) continue;
      if (typeof e === "string") {
        blobs.push(e);
        continue;
      }
      if (typeof e !== "object") continue;
      if (param === void 0 && e.param != null) param = e.param;
      if (typeof e.code === "string") blobs.push(e.code);
      if (typeof e.type === "string") blobs.push(e.type);
      if (typeof e.message === "string") blobs.push(e.message);
    }
    var hay = blobs.join(" | ").toLowerCase();
    if (hay.indexOf("unknown_parameter") !== -1 || hay.indexOf("unknown parameter") !== -1 || hay.indexOf("unsupported_parameter") !== -1 || hay.indexOf("unsupported parameter") !== -1) {
      return true;
    }
    var isClientReqStatus = status === 400 || status === 422;
    if (isClientReqStatus && param != null && param !== "") return true;
    if (isClientReqStatus && hay.indexOf("invalid_request") !== -1 && (hay.indexOf("parameter") !== -1 || hay.indexOf("param") !== -1)) {
      return true;
    }
    return false;
  }
  function isAuthExpiredError(input) {
    var envErr = csrEnvelopeError(input);
    if (envErr !== void 0) input = envErr;
    if (!input) return false;
    var blobs = [];
    var push = function(v) {
      if (typeof v === "string" && v) blobs.push(v);
    };
    if (typeof input === "string") push(input);
    else {
      push(input.message);
      push(input.code);
      if (input.error) {
        push(input.error.message);
        push(input.error.code);
        push(input.error.type);
      }
      if (input.body) {
        push(input.body.message);
        if (input.body.error) {
          push(input.body.error.message);
          push(input.body.error.code);
          push(input.body.error.type);
        }
      }
      if (typeof input.status === "number" && input.status === 401) return true;
      if (typeof input.status_code === "number" && input.status_code === 401) return true;
    }
    var hay = blobs.join(" | ").toLowerCase();
    if (!hay) return false;
    return hay.indexOf("token has expired") !== -1 || hay.indexOf("token is expired") !== -1 || hay.indexOf("expired_token") !== -1 || hay.indexOf("invalid_token") !== -1 || hay.indexOf("unauthorized") !== -1 || hay.indexOf("not authorized") !== -1 || hay.indexOf("invalid_request") !== -1 && hay.indexOf("token") !== -1;
  }
  function isNotExistsError(err) {
    return !!err && typeof err === "object" && (err.code === "NOT_EXISTS" || !!err.body && err.body.code === "NOT_EXISTS");
  }
  var TRANSPORT_FAILURE_CODES = ["NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED", "TOO_MANY_REQUESTS", "SERVER_ERROR", "ABORTED", "TOKEN_REFRESH_FAILED"];
  function isTransportFailure(err) {
    if (err === void 0 || err === null) return true;
    if (typeof err === "string") {
      var s = err.toLowerCase();
      return s.indexOf("network") !== -1 || s.indexOf("abort") !== -1 || s.indexOf("too many") !== -1 || s.indexOf("timeout") !== -1 || s.indexOf("timed out") !== -1 || s.indexOf("no response for") !== -1;
    }
    if (typeof err !== "object") return false;
    if (typeof TypeError !== "undefined" && err instanceof TypeError) return true;
    var code = err.code !== void 0 && err.code !== null ? String(err.code) : "";
    if (TRANSPORT_FAILURE_CODES.indexOf(code) !== -1) return true;
    if (code === "429" || /^5\d\d$/.test(code)) return true;
    var status = typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : 0;
    if (status === 429 || status >= 500) return true;
    var msg = typeof err.message === "string" ? err.message.toLowerCase() : "";
    return msg.indexOf("network error") !== -1 || msg.indexOf("failed to fetch") !== -1 || msg.indexOf("no response for") !== -1 || msg.indexOf("timed out") !== -1 || msg === "aborted";
  }

  // src/engine/links.ts
  var EXPIRED_ATTACHMENT_URL_HOST = "_expired_.url";
  var EXPIRED_ATTACHMENT_URL_ORIGIN = "https://" + EXPIRED_ATTACHMENT_URL_HOST;
  var LINK_LABEL_MAX_DISPLAY_CHARS = 32;
  var EXPIRED_LINK_REFRESH_EXPIRES_SECONDS = 20 * 60;
  var PREVIEW_URL_EXPIRES_SECONDS = 60 * 60;
  var PREVIEW_BROWSER_CACHE_SECONDS = 7 * 24 * 60 * 60;
  var LINK_REFRESH_WINDOW_MS = (EXPIRED_LINK_REFRESH_EXPIRES_SECONDS - 5 * 60) * 1e3;
  var MINT_CACHE_GENERATION = 2;
  function mintCacheBustStamp(now) {
    return Math.floor((Date.now() ) / LINK_REFRESH_WINDOW_MS);
  }
  function previewMintCacheToken(refresh) {
    if (!refresh) return String(MINT_CACHE_GENERATION);
    return MINT_CACHE_GENERATION + "." + mintCacheBustStamp();
  }
  var PRESIGN_SAFETY_MARGIN_MS = 60 * 1e3;
  function presignExpiryEpochMs(url) {
    if (!url) return null;
    var q = url.indexOf("?");
    if (q < 0) return null;
    var params;
    try {
      params = new URLSearchParams(url.slice(q + 1));
    } catch (e) {
      return null;
    }
    var v2 = params.get("Expires");
    if (v2 && /^\d+$/.test(v2)) return parseInt(v2, 10) * 1e3;
    var signed = params.get("X-Amz-Date");
    var lifetime = params.get("X-Amz-Expires");
    if (signed && lifetime && /^\d+$/.test(lifetime)) {
      var m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(signed);
      if (m) {
        var at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        return at + parseInt(lifetime, 10) * 1e3;
      }
    }
    return null;
  }
  function createInlineLinkRegex() {
    return /src::(\S+)|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)|(https?:\/\/[^\s<>"']+)/g;
  }
  function safeDecodeURIComponent(v) {
    try {
      return decodeURIComponent(v);
    } catch (e) {
      return v;
    }
  }
  function encodePathSegments(path) {
    return path.split("/").filter(Boolean).map(function(s) {
      return encodeURIComponent(s);
    }).join("/");
  }
  function normalizeStoredPathTarget(value) {
    var p = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
    if (!/\s/.test(p) && /%[0-9A-Fa-f]{2}/.test(p)) p = safeDecodeURIComponent(p);
    return p;
  }
  function normalizeAttachmentPathCandidate(value) {
    return safeDecodeURIComponent((value || "").trim()).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  }
  function extractRemotePathFromAttachmentHref(href, projectId) {
    try {
      var parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      var path = normalizeAttachmentPathCandidate(parsed.pathname || "");
      var segs = path.split("/").filter(Boolean);
      if (!segs.length) return null;
      var HEX = /^[a-f0-9]{32,}$/i;
      var sid = projectId || "";
      var start = 0;
      while (start < segs.length) {
        var seg = segs[start];
        if (seg === sid || HEX.test(seg)) {
          start++;
          continue;
        }
        break;
      }
      var real = segs.slice(start).join("/");
      return real || null;
    } catch (e) {
      return null;
    }
  }
  function getExpiredAttachmentVisiblePath(remotePath, fallback) {
    var n = normalizeAttachmentPathCandidate(remotePath);
    if (n) return n;
    return normalizeAttachmentPathCandidate(fallback || "file") || "file";
  }
  function buildDisplayExpiredAttachmentHref(remotePath, fallback) {
    return EXPIRED_ATTACHMENT_URL_ORIGIN + "/" + encodePathSegments(getExpiredAttachmentVisiblePath(remotePath, fallback));
  }
  function isServiceDbAttachmentHref(href, projectId) {
    if (!projectId) return false;
    try {
      var parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      var segs = normalizeAttachmentPathCandidate(parsed.pathname || "").split("/").filter(Boolean);
      return segs.length > 0 && segs[0] === projectId;
    } catch (e) {
      return false;
    }
  }
  function readExpiredAttachmentHref(href) {
    if (!href) return null;
    try {
      var parsed = new URL(href);
      if (parsed.hostname !== EXPIRED_ATTACHMENT_URL_HOST) return null;
      return normalizeAttachmentPathCandidate(parsed.pathname || "") || null;
    } catch (e) {
      return null;
    }
  }
  function sanitizeAttachmentLinksForHistory(content, projectId, forAssistant) {
    if (!content) return content;
    if (!forAssistant && content.indexOf("Attached files:") === -1) return content;
    return content.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function(_m, label, href) {
      if (!isServiceDbAttachmentHref(href, projectId)) return _m;
      var remotePath = extractRemotePathFromAttachmentHref(href, projectId);
      var fullPath = remotePath || normalizeAttachmentPathCandidate(label);
      if (!fullPath) return _m;
      return "[" + label + "](" + buildDisplayExpiredAttachmentHref(fullPath, label) + ")";
    });
  }
  function isHttpUrlLike(target) {
    return /^https?:\/\//i.test((target || "").trim());
  }
  function repairUrlWhitespace(href) {
    if (!href || !/\s/.test(href)) return href;
    var stripped = href.replace(/\s+/g, "");
    if (/^https?:\/\/[^/\s]+\/download\/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/i.test(stripped)) return stripped;
    return href.trim().replace(/\s/g, "%20");
  }
  function repairUrlEntities(href) {
    if (!href || href.indexOf("&") === -1) return href;
    var out = href, prev = "";
    while (out !== prev) {
      prev = out;
      out = out.replace(/&amp;/gi, "&").replace(/&#0*38;/g, "&").replace(/&#x0*26;/gi, "&");
    }
    return out;
  }
  function normalizeTrailingInlineToken(value) {
    if (!value) return value;
    var out = value.replace(/[.,;:!?]+$/, "");
    var trimUnmatched = function(openCh, closeCh) {
      while (out.charAt(out.length - 1) === closeCh) {
        var openCount = (out.match(new RegExp("\\" + openCh, "g")) || []).length;
        var closeCount = (out.match(new RegExp("\\" + closeCh, "g")) || []).length;
        if (closeCount > openCount) out = out.slice(0, -1);
        else break;
      }
    };
    trimUnmatched("(", ")");
    trimUnmatched("[", "]");
    trimUnmatched("{", "}");
    out = out.replace(/[`'"*>]+$/, "");
    return out;
  }
  var PREVIEWABLE_IMAGE_CONTENT_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp"
  };
  function previewableExtOf(nameOrPath) {
    var v = String(nameOrPath || "");
    var cut = v.search(/[?#]/);
    if (cut !== -1) v = v.slice(0, cut);
    v = v.replace(/[\\/]+$/, "");
    var dot = v.lastIndexOf(".");
    if (dot <= 0) return "";
    var ext = v.slice(dot + 1).trim().toLowerCase();
    return /^[a-z0-9]+$/.test(ext) ? ext : "";
  }
  function classifyInlineLink(full, groups, ctx) {
    var g1 = groups[0], g2 = groups[1], g3 = groups[2], g4 = groups[3], g5 = groups[4], g6 = groups[5];
    var dbHostPrefix = (ctx.dbHostPrefix || "").toLowerCase();
    var fresh = function(expiredHref) {
      return ctx.resolveFreshHref ? ctx.resolveFreshHref(expiredHref) : void 0;
    };
    var isDbHost = function(url) {
      return !!dbHostPrefix && url.toLowerCase().indexOf(dbHostPrefix) === 0;
    };
    var asStoredFile = function(remotePath2, label) {
      if (!remotePath2) return null;
      var expiredHref = buildDisplayExpiredAttachmentHref(remotePath2, label);
      var cached = fresh(expiredHref);
      var part = {
        type: "link",
        label: truncateLabelForDisplay(label),
        fullLabel: label,
        href: cached || expiredHref,
        expired: !cached,
        expiredHref,
        remotePath: remotePath2
      };
      var ext = previewableExtOf(remotePath2);
      var ct = PREVIEWABLE_IMAGE_CONTENT_TYPES[ext];
      if (ct) part.image = { ext, contentType: ct };
      return { part };
    };
    if (g1) {
      var rawPath = normalizeTrailingInlineToken(g1);
      var tail = full.slice(("src::" + rawPath).length);
      var srcIsUrl = isHttpUrlLike(rawPath);
      if (srcIsUrl && !isDbHost(rawPath) && !readExpiredAttachmentHref(rawPath)) {
        var srcUrl = repairUrlEntities(rawPath);
        return {
          part: { type: "link", label: truncateLabelForDisplay(srcUrl), fullLabel: srcUrl, href: srcUrl, expired: false },
          tail
        };
      }
      var srcPath = readExpiredAttachmentHref(rawPath) || (srcIsUrl ? extractRemotePathFromAttachmentHref(rawPath, ctx.projectId) || normalizeAttachmentPathCandidate(rawPath) : normalizeStoredPathTarget(rawPath));
      var srcBuilt = asStoredFile(srcPath, srcPath);
      return srcBuilt ? { part: srcBuilt.part, tail } : null;
    }
    if (g4 && g5) {
      var dbTarget = /^db:(.+)$/i.exec(g5.trim());
      if (dbTarget) {
        var rawDbPath = normalizeStoredPathTarget(dbTarget[1].replace(/\s+"[^"\n]*"\s*$/, ""));
        var declared = asStoredFile(rawDbPath, g4);
        if (!declared) return null;
        declared.part.label = truncateLabelForDisplay(g4);
        declared.part.fullLabel = g4;
        return declared;
      }
      if (isHttpUrlLike(g5)) {
        return classifyInlineLink(full, [void 0, g4, repairUrlWhitespace(g5), void 0, void 0, void 0], ctx);
      }
      var trimmedTarget = g5.trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedTarget) || trimmedTarget.charAt(0) === "#") {
        return {
          part: { type: "link", label: truncateLabelForDisplay(g4), fullLabel: g4, href: trimmedTarget, expired: false }
        };
      }
      var built = asStoredFile(normalizeAttachmentPathCandidate(g5), g4);
      if (!built) return null;
      built.part.label = truncateLabelForDisplay(g4);
      built.part.fullLabel = g4;
      return built;
    }
    var originalHref = g3 || g6 || "";
    if (!originalHref) return null;
    originalHref = repairUrlEntities(originalHref);
    var urlTail;
    if (!g3 && g6) {
      var trimmedUrl = normalizeTrailingInlineToken(originalHref);
      if (trimmedUrl !== originalHref) urlTail = originalHref.slice(trimmedUrl.length);
      originalHref = trimmedUrl;
    }
    var withTail = function(r) {
      return urlTail ? { part: r.part, tail: urlTail } : r;
    };
    var urlLabel = g2 || originalHref;
    var carried = readExpiredAttachmentHref(originalHref);
    if (carried) {
      var carriedBuilt = asStoredFile(carried, g2 || carried);
      if (carriedBuilt) {
        if (g2) {
          carriedBuilt.part.label = truncateLabelForDisplay(g2);
          carriedBuilt.part.fullLabel = g2;
        }
        return withTail(carriedBuilt);
      }
    }
    if (isServiceDbAttachmentHref(originalHref, ctx.projectId)) {
      var remotePath = extractRemotePathFromAttachmentHref(originalHref, ctx.projectId);
      if (remotePath) {
        var dbBuilt = asStoredFile(remotePath, getExpiredAttachmentVisiblePath(remotePath, urlLabel));
        if (dbBuilt) return withTail(dbBuilt);
      }
    }
    return withTail({
      part: { type: "link", label: truncateLabelForDisplay(urlLabel), fullLabel: urlLabel, href: originalHref, expired: false }
    });
  }
  function canonicalizePathForm(value) {
    if (!value) return value;
    try {
      return value.normalize("NFC");
    } catch (e) {
      return value;
    }
  }
  function linkUnavailableKeyForPath(remotePath) {
    return "path:" + canonicalizePathForm(remotePath || "");
  }
  function linkUnavailableKeyForHref(href) {
    var carried = readExpiredAttachmentHref(href);
    if (carried) return linkUnavailableKeyForPath(carried);
    return "href:" + canonicalizePathForm(href || "");
  }
  function linkUnavailableKeysForPath(remotePath) {
    if (!remotePath) return [];
    var keys = [
      linkUnavailableKeyForPath(remotePath),
      linkUnavailableKeyForHref(buildDisplayExpiredAttachmentHref(remotePath))
    ];
    return keys.filter(function(k, i) {
      return keys.indexOf(k) === i;
    });
  }
  function isLinkUnavailable(link, map) {
    if (!link || !map) return false;
    if (link.remotePath && map[linkUnavailableKeyForPath(link.remotePath)]) return true;
    if (link.expiredHref && map[linkUnavailableKeyForHref(link.expiredHref)]) return true;
    if (link.href && map[linkUnavailableKeyForHref(link.href)]) return true;
    return false;
  }
  function truncateLabelForDisplay(label) {
    if (!label) return label;
    if (label.length <= LINK_LABEL_MAX_DISPLAY_CHARS) return label;
    return "\u2026" + label.slice(label.length - (LINK_LABEL_MAX_DISPLAY_CHARS - 1));
  }

  // src/engine/retrieval_memory.ts
  var RETRIEVAL_NOTES_MAX = 6;
  var RETRIEVAL_NOTES_TOKEN_BUDGET = 1200;
  var RETRIEVAL_NOTE_MAX_ITEMS = 8;
  var RETRIEVAL_NOTE_MAX_CHARS = 600;
  var RETRIEVAL_NOTE_PREFIX = "[Retrieval note, not shown to the user";
  var FILE_KEYS = ["path", "storage_path", "storagePath", "file", "file_path", "filePath"];
  var TABLE_KEYS = ["table_name", "tableName"];
  var GROUP_KEYS = ["access_group", "accessGroup"];
  var SRC_PREFIX = "src::";
  var RESULT_WALK_MAX_NODES = 400;
  var RESULT_WALK_MAX_DEPTH = 5;
  function isWebToolName(name) {
    return typeof name === "string" && /^web_(search|fetch)/.test(name);
  }
  function pushUnique(list, value) {
    if (typeof value !== "string") return;
    var v = value.trim();
    if (!v || list.indexOf(v) !== -1 || list.length >= RETRIEVAL_NOTE_MAX_ITEMS) return;
    list.push(v);
  }
  function pushGroup(list, value) {
    if (typeof value === "number" && isFinite(value)) pushUnique(list, String(value));
    else pushUnique(list, value);
  }
  function pushHit(list, path, page, sheet) {
    if (typeof path !== "string" || !path.trim()) return;
    var n = typeof page === "number" ? page : Number(page);
    if (!isFinite(n) || n <= 0) return;
    n = Math.floor(n);
    var sh = typeof sheet === "string" && sheet.trim() ? sheet.trim() : "";
    for (var i = 0; i < list.length; i++) {
      if (sh ? list[i].path === path && list[i].sheet === sh : list[i].path === path && list[i].page === n) return;
    }
    if (list.length >= RETRIEVAL_NOTE_MAX_ITEMS) return;
    var hit = { path: path.trim(), page: n };
    if (sh) hit.sheet = sh;
    list.push(hit);
  }
  function pathFromSrcId(value) {
    if (typeof value !== "string") return null;
    if (value.indexOf(SRC_PREFIX) !== 0) return null;
    var rest = value.slice(SRC_PREFIX.length).trim();
    return rest ? rest : null;
  }
  function parseJsonLoose(value) {
    if (typeof value !== "string") return value;
    var t = value.trim();
    if (!t || t[0] !== "{" && t[0] !== "[") return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      return null;
    }
  }
  function readArguments(note, args) {
    if (!args || typeof args !== "object") return;
    var i;
    for (i = 0; i < FILE_KEYS.length; i++) pushUnique(note.files, args[FILE_KEYS[i]]);
    for (i = 0; i < TABLE_KEYS.length; i++) pushUnique(note.tables, args[TABLE_KEYS[i]]);
    for (i = 0; i < GROUP_KEYS.length; i++) pushGroup(note.accessGroups, args[GROUP_KEYS[i]]);
    if (typeof args.table === "string") pushUnique(note.tables, args.table);
    else if (args.table && typeof args.table === "object") {
      pushUnique(note.tables, args.table.name);
      pushGroup(note.accessGroups, args.table.access_group);
    }
    var ref = pathFromSrcId(args.reference);
    if (ref) pushUnique(note.files, ref);
    var uid = pathFromSrcId(args.unique_id);
    if (uid) pushUnique(note.files, uid);
  }
  var RESULT_STRING_MAX_CHARS = 2 * 1024 * 1024;
  function readHits(note, result) {
    var parsed = parseJsonLoose(result);
    if (!parsed || typeof parsed !== "object") return;
    var visited = 0;
    var walk = function(node, depth) {
      if (!node || typeof node !== "object" || depth > RESULT_WALK_MAX_DEPTH) return;
      if (++visited > RESULT_WALK_MAX_NODES) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length && visited <= RESULT_WALK_MAX_NODES; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node.path === "string" && node.page !== void 0) {
        pushHit(note.hits, node.path, node.page, node.sheet);
      }
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        if (v && typeof v === "object") walk(v, depth + 1);
        else if (typeof v === "string" && v.length > 1 && v.length <= RESULT_STRING_MAX_CHARS && (v.charAt(0) === "{" || v.charAt(0) === "[")) {
          var inner = parseJsonLoose(v);
          if (inner && typeof inner === "object") walk(inner, depth + 1);
        }
      }
    };
    walk(parsed, 0);
  }
  function claudeResultText(block) {
    var c = block && block.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map(function(part) {
        return part && typeof part.text === "string" ? part.text : "";
      }).join("\n");
    }
    return "";
  }
  function emptyNote(source) {
    return { files: [], tables: [], accessGroups: [], hits: [], tools: [], web: false, source };
  }
  function noteHasContent(note) {
    return note.files.length > 0 || note.tables.length > 0 || note.accessGroups.length > 0 || note.hits.length > 0 || note.tools.length > 0 || note.web;
  }
  function noteFromToolBlocks(body) {
    if (!body || typeof body !== "object") return null;
    var note = emptyNote("tools");
    var sawTool = false;
    var i;
    var content = body.content;
    if (Array.isArray(content)) {
      var callNames = {};
      for (i = 0; i < content.length; i++) {
        var block = content[i];
        if (!block || typeof block !== "object") continue;
        var type = block.type;
        if (type === "mcp_tool_use" || type === "tool_use") {
          sawTool = true;
          pushUnique(note.tools, block.name);
          if (typeof block.id === "string" && typeof block.name === "string") callNames[block.id] = block.name;
          readArguments(note, block.input);
        } else if (type === "server_tool_use" || type === "web_search_tool_use") {
          sawTool = true;
          if (isWebToolName(block.name) || type === "web_search_tool_use") note.web = true;
          pushUnique(note.tools, block.name || type);
        } else if (type === "mcp_tool_result" || type === "tool_result") {
          sawTool = true;
          var name = typeof block.tool_use_id === "string" ? callNames[block.tool_use_id] : void 0;
          if (!block.is_error && (name === void 0 || name === "searchText")) readHits(note, claudeResultText(block));
        } else if (type === "web_search_tool_result" || type === "web_fetch_tool_result") {
          sawTool = true;
          note.web = true;
        }
      }
    }
    var output = body.output;
    if (Array.isArray(output)) {
      for (i = 0; i < output.length; i++) {
        var item = output[i];
        if (!item || typeof item !== "object") continue;
        var kind = typeof item.type === "string" ? item.type : "";
        if (kind === "mcp_call" || kind === "function_call") {
          sawTool = true;
          pushUnique(note.tools, item.name);
          readArguments(note, parseJsonLoose(item.arguments) || item.arguments);
          if (!item.error && item.name === "searchText") readHits(note, item.output);
        } else if (kind.indexOf("web_search") === 0 || kind.indexOf("web_fetch") === 0) {
          sawTool = true;
          note.web = true;
          pushUnique(note.tools, kind);
        }
      }
    }
    return sawTool ? note : null;
  }
  function retrievalNoteFromText(text) {
    if (typeof text !== "string" || !text) return null;
    var note = emptyNote("answer");
    var link = /\]\(db:((?:[^()\n"]|\([^()\n"]*\))+)(?:"[^"\n]*")?\)/g;
    var m;
    while ((m = link.exec(text)) !== null) pushUnique(note.files, normalizeStoredPathTarget(m[1]));
    var src = /src::(\S+)/g;
    while ((m = src.exec(text)) !== null) {
      pushUnique(note.files, normalizeStoredPathTarget(normalizeTrailingInlineToken(m[1])));
    }
    return noteHasContent(note) ? note : null;
  }
  function extractRetrievalNote(body, answerText) {
    var fromTools = noteFromToolBlocks(body);
    var fromText = retrievalNoteFromText(answerText);
    if (!fromTools) {
      if (fromText) return fromText;
      return providerBodyWasRead(body) ? emptyNote("body") : null;
    }
    if (fromText) {
      for (var i = 0; i < fromText.files.length; i++) pushUnique(fromTools.files, fromText.files[i]);
    }
    return noteHasContent(fromTools) ? fromTools : emptyNote("body");
  }
  function providerBodyWasRead(body) {
    if (!body || typeof body !== "object") return false;
    return Array.isArray(body.content) || Array.isArray(body.output);
  }
  function isRetrievalNote(value) {
    return !!value && typeof value === "object" && Array.isArray(value.files) && Array.isArray(value.tables) && Array.isArray(value.accessGroups) && Array.isArray(value.hits) && Array.isArray(value.tools);
  }
  function formatRetrievalNote(note) {
    if (!note || !noteHasContent(note)) return "";
    var parts = [];
    if (note.files.length) parts.push("files " + note.files.join(", "));
    if (note.tables.length) parts.push("tables " + note.tables.join(", "));
    if (note.accessGroups.length) parts.push("access_group " + note.accessGroups.join(", "));
    if (note.hits.length) {
      var byFile = {};
      var order = [];
      for (var i = 0; i < note.hits.length; i++) {
        var h = note.hits[i];
        if (!byFile[h.path]) {
          byFile[h.path] = [];
          order.push(h.path);
        }
        byFile[h.path].push(h.page);
      }
      var sheetsOf = {};
      for (var s2 = 0; s2 < note.hits.length; s2++) {
        var hs = note.hits[s2];
        if (hs.sheet) {
          if (!sheetsOf[hs.path]) sheetsOf[hs.path] = [];
          if (sheetsOf[hs.path].indexOf(hs.sheet) === -1) sheetsOf[hs.path].push(hs.sheet);
        }
      }
      parts.push("searchText hits " + order.map(function(p) {
        return sheetsOf[p] ? p + " sheet " + sheetsOf[p].join(", sheet ") : p + " p" + byFile[p].join(", p");
      }).join("; "));
    }
    if (note.tools.length) parts.push("tools " + note.tools.join(", "));
    if (note.web) parts.push("web tool used");
    var line = RETRIEVAL_NOTE_PREFIX + ": this turn used " + parts.join(" | ") + "]";
    if (line.length > RETRIEVAL_NOTE_MAX_CHARS) {
      line = line.slice(0, RETRIEVAL_NOTE_MAX_CHARS - 4) + "...]";
    }
    return line;
  }

  // src/engine/budget.ts
  var CONTEXT_WINDOW_DEFAULT = { claude: 2e5, openai: 128e3 };
  var CONTEXT_WINDOW_BY_MODEL = {
    // claude, exact ids
    "claude-fable-5-1": 1e6,
    "claude-opus-5-5": 1e6,
    "claude-sonnet-5-5": 1e6,
    "claude-haiku-5-5": 1e6,
    "claude-fable-5": 1e6,
    "claude-opus-5": 1e6,
    "claude-opus-4-8": 1e6,
    "claude-opus-4-7": 1e6,
    "claude-opus-4-6": 1e6,
    "claude-opus-4-5": 2e5,
    "claude-sonnet-5": 1e6,
    "claude-sonnet-4-6": 1e6,
    "claude-sonnet-4-5": 1e6,
    "claude-sonnet-4": 2e5,
    "claude-haiku-4-5": 2e5,
    "claude-3-5-sonnet": 2e5,
    // openai, exact ids
    // gpt-6.1: OpenAI's listing carries no window; taken as the gpt-6 family's until a
    // published figure says otherwise (2026-10-12, the default model).
    "gpt-6.1-sol": 105e4,
    "gpt-6-astra": 105e4,
    "gpt-6-sol": 105e4,
    "gpt-6-luna": 105e4,
    "gpt-5.6-sol": 105e4,
    "gpt-5.6-terra": 105e4,
    "gpt-5.6-luna": 105e4,
    "gpt-5.5": 1e6,
    "gpt-5.4": 105e4,
    "gpt-5.4-mini": 4e5,
    "gpt-5.4-nano": 4e5,
    "gpt-4.1": 104e4,
    "gpt-4o": 128e3,
    "o1": 2e5,
    "o1-pro": 2e5,
    // family keys
    "claude-fable": 1e6,
    "claude-opus": 1e6,
    "claude-sonnet": 1e6,
    "claude-haiku": 2e5,
    "gpt-6.1": 105e4,
    "gpt-6": 105e4,
    "gpt-5.6": 105e4,
    "gpt-5": 128e3
  };
  var MAX_OUTPUT_BY_MODEL = {
    // claude
    "claude-fable-5-1": 128e3,
    "claude-opus-5-5": 128e3,
    "claude-sonnet-5-5": 128e3,
    "claude-haiku-5-5": 128e3,
    "claude-fable-5": 128e3,
    "claude-opus-5": 128e3,
    "claude-opus-4-8": 128e3,
    "claude-sonnet-5": 128e3,
    "claude-sonnet-4-6": 64e3,
    "claude-haiku-4-5": 64e3,
    "claude-3-5-sonnet": 8e3,
    // openai
    "gpt-6.1-sol": 128e3,
    "gpt-6-astra": 128e3,
    "gpt-6-sol": 128e3,
    "gpt-6-luna": 128e3,
    "gpt-5.6-sol": 128e3,
    "gpt-5.6-terra": 128e3,
    "gpt-5.6-luna": 128e3,
    "gpt-5.5": 128e3,
    "gpt-5.4": 128e3,
    "gpt-5.4-mini": 128e3,
    "gpt-5.4-nano": 128e3,
    "gpt-4.1": 16e3,
    "gpt-4o": 4e3,
    "o1": 1e5,
    "o1-pro": 1e5,
    // family keys
    "claude-fable": 128e3,
    "claude-opus": 128e3,
    "claude-sonnet": 64e3,
    "claude-haiku": 64e3,
    "gpt-6.1": 128e3,
    "gpt-6": 128e3,
    "gpt-5.6": 128e3,
    "gpt-5": 128e3
  };
  var DEFAULT_CONTEXT_WINDOW = 88e4;
  var apiReportedContextWindows = {};
  var apiReportedMaxOutput = {};
  var projectContextWindows = {};
  function setProjectContextWindow(projectId, tokens) {
    var key = (projectId || "").trim();
    if (!key) return;
    var n = Number(tokens);
    if (Number.isFinite(n) && n > 0) projectContextWindows[key] = Math.floor(n);
    else delete projectContextWindows[key];
  }
  function getProjectContextWindow(projectId) {
    var key = (projectId || "").trim();
    return key && projectContextWindows[key] ? projectContextWindows[key] : null;
  }
  var MAX_OUTPUT_TOKENS = 25e3;
  var INDEXING_MAX_OUTPUT_TOKENS = 64e3;
  var TOOL_AND_RESPONSE_BUFFER = 4e3;
  var MIN_INPUT_TOKEN_BUDGET = 8e3;
  var MIN_PER_REQUEST_INPUT_CAP = 28e3;
  var MAX_HISTORY_MESSAGES = 20;
  var HISTORY_TOKEN_BUDGET = 8e3;
  var INPUT_CAP_RATIO = 0.16;
  var HISTORY_BUDGET_RATIO = 0.08;
  function estimateTextTokens(text) {
    return Math.ceil((text || "").length / 3);
  }
  function estimateMessageTokens(msg) {
    return estimateTextTokens(msg.content) + estimateTextTokens(msg.role) + 6;
  }
  function resolveByModelId(apiTable, staticTable, model) {
    var normalized = (model || "").trim().toLowerCase();
    if (!normalized) return 0;
    if (apiTable[normalized]) return apiTable[normalized];
    if (staticTable[normalized]) return staticTable[normalized];
    var parts = normalized.split("-");
    for (var end = parts.length - 1; end > 0; end--) {
      var family = parts.slice(0, end).join("-");
      if (staticTable[family]) return staticTable[family];
    }
    return 0;
  }
  function getModelContextWindow(platform, model) {
    return resolveByModelId(apiReportedContextWindows, CONTEXT_WINDOW_BY_MODEL, model) || CONTEXT_WINDOW_DEFAULT[platform];
  }
  function getMaxOutputTokens(platform, model, purpose) {
    var want = purpose === "indexing" ? INDEXING_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;
    var cap = resolveByModelId(apiReportedMaxOutput, MAX_OUTPUT_BY_MODEL, model);
    return cap ? Math.min(want, cap) : want;
  }
  function getContextWindow(platform, model, projectId) {
    var ceiling = getModelContextWindow(platform, model);
    var override = projectId ? getProjectContextWindow(projectId) : null;
    return Math.min(override || DEFAULT_CONTEXT_WINDOW, ceiling);
  }
  function contextBasedBudgetFor(platform, model, projectId) {
    var contextWindow = getContextWindow(platform, model, projectId);
    return Math.max(
      MIN_INPUT_TOKEN_BUDGET,
      contextWindow - getMaxOutputTokens(platform, model) - TOOL_AND_RESPONSE_BUFFER
    );
  }
  function getInputTokenBudget(platform, model, projectId) {
    var contextBasedBudget = contextBasedBudgetFor(platform, model, projectId);
    return Math.min(
      contextBasedBudget,
      Math.max(MIN_PER_REQUEST_INPUT_CAP, Math.round(contextBasedBudget * INPUT_CAP_RATIO))
    );
  }
  function stripFileBlocksFromHistory(content) {
    if (!content) return content;
    return content.replace(/```([^\n`]+?\.[^\s.`]+)\n[\s\S]*?```/g, "[file previously attached: $1]");
  }
  function applyRetrievalNotes(messages, latestIndex) {
    var out = messages.slice();
    var used = 0, tokens = 0;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (used >= RETRIEVAL_NOTES_MAX) break;
      var m = messages[i];
      if (i === latestIndex || !m || m.role !== "assistant" || !isRetrievalNote(m._retrieval)) continue;
      var line = formatRetrievalNote(m._retrieval);
      if (!line) continue;
      var cost = estimateTextTokens(line) + 2;
      if (tokens + cost > RETRIEVAL_NOTES_TOKEN_BUDGET) break;
      tokens += cost;
      used++;
      out[i] = Object.assign({}, m, { content: (m.content || "") + "\n\n" + line });
    }
    return { messages: out, notesUsed: used, noteTokens: tokens };
  }
  function buildBoundedChatMessages(options) {
    var contextBasedBudget = contextBasedBudgetFor(options.platform, options.model, options.projectId);
    var availableInputBudget = getInputTokenBudget(options.platform, options.model, options.projectId);
    var systemCost = estimateTextTokens(options.systemPrompt) + 12;
    var historyAllowance = Math.max(
      HISTORY_TOKEN_BUDGET,
      Math.round(contextBasedBudget * HISTORY_BUDGET_RATIO)
    );
    var budgetForHistory = Math.max(1e3, Math.min(historyAllowance, availableInputBudget - systemCost));
    var maxHistoryMessages = Math.max(
      MAX_HISTORY_MESSAGES,
      Math.round(MAX_HISTORY_MESSAGES * (budgetForHistory / HISTORY_TOKEN_BUDGET))
    );
    var windowed = options.history.slice(-maxHistoryMessages);
    var latestIndex = windowed.length - 1;
    if (options.retrievalNotes !== false) windowed = applyRetrievalNotes(windowed, latestIndex).messages;
    var trimmed = windowed.map(function(m, i2) {
      if (i2 === latestIndex) return m;
      var stripped = stripFileBlocksFromHistory(m.content);
      var sanitized = sanitizeAttachmentLinksForHistory(stripped, options.projectId, m.role !== "user");
      return Object.assign({}, m, { content: sanitized });
    });
    var bounded = [], used = 0;
    for (var i = trimmed.length - 1; i >= 0; i--) {
      var cost = estimateMessageTokens(trimmed[i]);
      if (used + cost > budgetForHistory && bounded.length > 0) break;
      bounded.unshift(trimmed[i]);
      used += cost;
    }
    return {
      messages: bounded.map(function(m) {
        return { role: m.role, content: m.content };
      }),
      droppedCount: Math.max(0, options.history.length - bounded.length),
      estimatedInputTokens: used + systemCost,
      estimatedBudget: availableInputBudget
    };
  }

  // src/engine/requests.ts
  var ANTHROPIC_MESSAGES_API_URL = "https://api.anthropic.com/v1/messages";
  var ANTHROPIC_VERSION = "2023-06-01";
  var ANTHROPIC_MCP_BETA = "mcp-client-2025-11-20";
  var ANTHROPIC_WEB_FETCH_BETA = "web-fetch-2025-09-10";
  var ANTHROPIC_PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";
  var ANTHROPIC_BETA_HEADER = `${ANTHROPIC_MCP_BETA},${ANTHROPIC_WEB_FETCH_BETA},${ANTHROPIC_PROMPT_CACHING_BETA}`;
  var WEB_FETCH_MAX_USES = 40;
  var WEB_FETCH_MAX_CONTENT_TOKENS = 2e5;
  var claudeWebFetchTool = () => ({
    type: "web_fetch_20250910",
    name: "web_fetch",
    max_uses: WEB_FETCH_MAX_USES,
    citations: { enabled: true },
    max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS
  });
  var OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
  var DEFAULT_OPENAI_IMAGE_DETAIL = "auto";
  var OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS = true;
  var openaiWebSearchTool = () => ({
    type: "web_search",
    external_web_access: OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS
  });
  var webToolsForChat = (platform, webAccess) => {
    if (webAccess !== true) return [];
    if (platform === "claude") return [claudeWebFetchTool()];
    return [openaiWebSearchTool()] ;
  };
  var MCP_NAME = "BunnyQuery";
  var DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
  var DEFAULT_OPENAI_MODEL = "gpt-6-luna";
  var mcpUrl = () => chatEngineConfig().mcpBaseUrl;
  function withMcpParams(base, params) {
    if (!base) return base;
    const pairs = Object.keys(params).filter((k) => params[k] !== void 0 && params[k] !== null && params[k] !== "").map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])));
    if (!pairs.length) return base;
    const [addr, existing] = base.split("?");
    const hasPath = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/./i.test(addr);
    const path = hasPath ? addr : addr.replace(/\/+$/, "") + "/";
    return path + "?" + (existing ? existing + "&" : "") + pairs.join("&");
  }
  var mcpContextParam = (platform, model) => getModelContextWindow(platform, model);
  var mcpIndexingUrl = (platform = "openai", model) => withMcpParams(mcpUrl(), { profile: "index", ctx: mcpContextParam(platform, model) });
  var mcpChatUrl = (endpointUrl, platform, model) => withMcpParams(endpointUrl, { profile: "chat", ctx: mcpContextParam(platform, model) });
  function mcpEndpointFor(anonymous, publicProjectId, service) {
    if (!anonymous) return { url: mcpUrl(), token: "$ACCESS_TOKEN" };
    const project = publicProjectId || service;
    return { url: String(mcpUrl()).replace(/\/+$/, "") + "/p/" + project };
  }
  var forwardRequest = (opts) => resolveForwardRequest()(opts);
  var CHAT_STREAM_ON = Object.freeze({
    transport: Object.freeze({ stream: true }),
    body: Object.freeze({ stream: true })
  });
  var CHAT_STREAM_OFF = Object.freeze({
    transport: Object.freeze({}),
    body: Object.freeze({})
  });
  var CHAT_STREAM_ON_REALTIME = Object.freeze({
    // `realtime` rides on the TRANSPORT arm only. It is a skapi option, not a field
    // the destination understands, so it must never reach `data`: the body arm stays
    // exactly what it is with the socket off.
    transport: Object.freeze({ stream: true, realtime: true }),
    body: Object.freeze({ stream: true })
  });
  function chatStreamWiring(queue) {
    if (!liveStreamingEnabled()) return CHAT_STREAM_OFF;
    if (isBgIndexingQueue(queue)) return CHAT_STREAM_OFF;
    return liveStreamingSocketEnabled() ? CHAT_STREAM_ON_REALTIME : CHAT_STREAM_ON;
  }
  var VARIANT_IMAGE_DETAIL = "original";
  var VARIANT_TEXT_VERBOSITY = "high";
  var OLDEST_NANO_REASONING_EFFORT = "high";
  var isOpenAINano = (model) => {
    const normalized = (model).trim().toLowerCase();
    if (!/(^|-)nano(-|$)/.test(normalized)) return false;
    return openAITakesReasoningEffort(normalized);
  };
  var openAITakesReasoningEffort = (model) => {
    const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
    const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = match[2] === void 0 ? null : Number(match[2]);
    return major > 5 || major === 5 && minor !== null && minor >= 4;
  };
  var claudeTakesEffort = (model) => {
    const normalized = (model || DEFAULT_CLAUDE_MODEL).trim().toLowerCase().replace(/\[1m\]$/, "");
    const match = normalized.match(/^claude-([a-z]+)(?:-(\d{1,2}))?(?:-(\d{1,2}))?(?:-\d{8})?$/);
    if (!match) return false;
    const family = match[1];
    if (family === "fable" || family === "mythos") return true;
    if (match[2] === void 0) return false;
    const major = Number(match[2]);
    const minor = match[3] === void 0 ? 0 : Number(match[3]);
    if (family === "opus") return major > 4 || major === 4 && minor >= 5;
    if (family === "sonnet") return major > 4 || major === 4 && minor >= 6;
    if (family === "haiku") return major > 5 || major === 5 && minor >= 5;
    return false;
  };
  var ANSWER_MODE_EFFORT = {
    standard: null,
    fast: "low",
    thorough: "high"
  };
  function chatEffortFields(platform, model, mode) {
    const effort = mode ? ANSWER_MODE_EFFORT[mode] : null;
    if (!effort) return {};
    if (platform === "openai") return openAITakesReasoningEffort(model) ? { reasoning: { effort } } : {};
    return claudeTakesEffort(model) ? { output_config: { effort } } : {};
  }
  var variantIndexingOptions = (model) => {
    if (!isOpenAINano(model) || !isOldestNano(model)) return {};
    return {
      ...{ text: { verbosity: VARIANT_TEXT_VERBOSITY } } ,
      ...{ reasoning: { effort: OLDEST_NANO_REASONING_EFFORT } } 
    };
  };
  var getOpenAIImageDetail = (model) => {
    const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
    const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
    if (!match) {
      return DEFAULT_OPENAI_IMAGE_DETAIL;
    }
    const major = Number(match[1]);
    const minor = match[2] === void 0 ? null : Number(match[2]);
    const isVariant = !!match[3];
    const supportsOriginal = major > 5 || major === 5 && minor !== null && minor >= 4;
    if (!supportsOriginal) {
      return DEFAULT_OPENAI_IMAGE_DETAIL;
    }
    return isVariant ? VARIANT_IMAGE_DETAIL : "original";
  };
  var getRenderImageDetail = (model) => {
    const detail = getOpenAIImageDetail(model);
    return detail === DEFAULT_OPENAI_IMAGE_DETAIL ? "high" : detail;
  };
  var OPENAI_VERSIONED_ID = /^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/;
  var isRecognisedOpenAIVersion = (model) => OPENAI_VERSIONED_ID.test((model).trim().toLowerCase());
  var isOldestNano = (model) => {
    const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
    if (!/(^|-)nano(-|$)/.test(normalized)) return false;
    const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
    if (!match) return true;
    const major = Number(match[1]);
    const minor = match[2] === void 0 ? null : Number(match[2]);
    if (major < 5) return true;
    if (major > 5) return false;
    return minor === null || minor <= 4;
  };
  var SMALL_TIER_PAGES_PER_WINDOW = 2;
  var DOWNSAMPLED_TIER_TILE = 2;
  function getVisionProfile(model) {
    const detail = getRenderImageDetail(model);
    if (!isRecognisedOpenAIVersion(model)) {
      return { detail, pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
    }
    if (detail !== "original") {
      return { detail, pagesPerWindow: SMALL_TIER_PAGES_PER_WINDOW, tile: DOWNSAMPLED_TIER_TILE };
    }
    if (isOldestNano(model)) {
      return { detail, pagesPerWindow: SMALL_TIER_PAGES_PER_WINDOW, tile: 1 };
    }
    return { detail, pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
  }
  var IMAGE_URL_REGEX = /\bhttps?:\/\/[^\s<>"'()\[\]]+?\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>"'()\[\]]*)?/gi;
  var INDEX_IMAGE_OTHER_EXT = /\.(?:tiff?|bmp|heic|heif)$/i;
  function indexingImageFile(attachment) {
    const url = typeof attachment.url === "string" ? attachment.url : "";
    if (url && new RegExp(IMAGE_URL_REGEX.source, "i").test(url)) return "attached";
    if (INDEX_IMAGE_OTHER_EXT.test(attachment.name || "") || INDEX_IMAGE_OTHER_EXT.test(attachment.storagePath || "")) return "maybe";
    return void 0;
  }
  function transformContentWithImages(content) {
    if (typeof content !== "string" || !content) {
      return content;
    }
    const matches = content.match(IMAGE_URL_REGEX);
    if (!matches || !matches.length) {
      return content;
    }
    const seen = /* @__PURE__ */ new Set();
    const imageBlocks = [];
    for (const url of matches) {
      if (seen.has(url)) continue;
      seen.add(url);
      imageBlocks.push({
        type: "image",
        source: { type: "url", url }
      });
    }
    return [...imageBlocks, { type: "text", text: content }];
  }
  function prepareClaudeMessages(messages) {
    if (!messages.length) return messages;
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (last.role !== "user") return messages;
    const content = transformContentWithImages(last.content);
    if (content === last.content) return messages;
    const next = messages.slice();
    next[lastIndex] = { role: last.role, content };
    return next;
  }
  function transformContentWithOpenAIImages(content, detail = DEFAULT_OPENAI_IMAGE_DETAIL) {
    if (typeof content !== "string" || !content) {
      return content;
    }
    const matches = content.match(IMAGE_URL_REGEX);
    if (!matches || !matches.length) {
      return content;
    }
    const seen = /* @__PURE__ */ new Set();
    const imageBlocks = [];
    for (const url of matches) {
      if (seen.has(url)) continue;
      seen.add(url);
      imageBlocks.push({
        type: "input_image",
        image_url: url,
        detail
      });
    }
    return [{ type: "input_text", text: content }, ...imageBlocks];
  }
  function prepareOpenAIMessages(messages, detail = DEFAULT_OPENAI_IMAGE_DETAIL) {
    if (!messages.length) return messages;
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (last.role !== "user") return messages;
    const content = transformContentWithOpenAIImages(last.content, detail);
    if (content === last.content) return messages;
    const next = messages.slice();
    next[lastIndex] = { role: last.role, content };
    return next;
  }
  function applyHistoryCacheBreakpoint(messages) {
    if (messages.length < 2) return messages;
    const breakpointIndex = messages.length - 2;
    return messages.map((m, i) => {
      if (i !== breakpointIndex) return m;
      const blocks = Array.isArray(m.content) ? m.content.slice() : [{ type: "text", text: m.content }];
      if (!blocks.length) return m;
      const lastBlockIndex = blocks.length - 1;
      blocks[lastBlockIndex] = {
        ...blocks[lastBlockIndex],
        cache_control: { type: "ephemeral" }
      };
      return { ...m, content: blocks };
    });
  }
  var POLL_INTERVAL = 3e3;
  var STREAM_POLL_INTERVAL = 1e3;
  var MAX_CONCURRENT_BG_POLLS = 6;
  var mcpListToolsCache = /* @__PURE__ */ new Map();
  var mcpListToolsReuseOff = false;
  var MCP_LIST_TOOLS_OFF_PREFIX = "bunnyquery:mcp-list-tools-off:";
  function mcpListToolsOffStored(service) {
    try {
      return typeof localStorage !== "undefined" && !!localStorage.getItem(MCP_LIST_TOOLS_OFF_PREFIX + service);
    } catch (_) {
      return false;
    }
  }
  function storeMcpListToolsOff(service) {
    if (!service) return;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(MCP_LIST_TOOLS_OFF_PREFIX + service, String(Date.now()));
    } catch (_) {
    }
  }
  var SERVER_PLACEHOLDERS = ["$CLIENT_SECRET", "$ACCESS_TOKEN", "$ID_TOKEN"];
  function failureText(failure) {
    const env = csrEnvelopeError(failure);
    const f = env !== void 0 ? env : failure;
    if (f == null) return "";
    if (typeof f === "string") return f.toLowerCase();
    let text = "";
    try {
      text = JSON.stringify(f) || "";
    } catch (_) {
      text = "";
    }
    if (typeof f.message === "string") text += " " + f.message;
    return text.toLowerCase();
  }
  function failureStatus(failure) {
    const env = csrEnvelopeError(failure);
    const f = env !== void 0 ? env : failure;
    if (!f || typeof f !== "object") return void 0;
    const v = typeof f.status_code === "number" ? f.status_code : typeof f.status === "number" ? f.status : void 0;
    return v;
  }
  function mcpListToolsKey(serverUrl, anonymous, service, publicProjectId, userId) {
    return JSON.stringify([serverUrl, anonymous ? "anonymous" : "signed-in", service, publicProjectId || "", userId || ""]);
  }
  function rememberMcpListTools(turn, body) {
    if (!turn || !turn.mcpToolsKey || mcpListToolsReuseOff) return;
    const output = body && Array.isArray(body.output) ? body.output : null;
    if (!output) return;
    for (let i = output.length - 1; i >= 0; i--) {
      const item = output[i];
      if (!item || item.type !== "mcp_list_tools" || item.server_label !== MCP_NAME) continue;
      if (item.error || typeof item.id !== "string" || !item.id || !Array.isArray(item.tools)) continue;
      let toolsText = "";
      try {
        toolsText = JSON.stringify(item.tools);
      } catch (_) {
        return;
      }
      if (SERVER_PLACEHOLDERS.some((ph) => toolsText.indexOf(ph) !== -1)) return;
      mcpListToolsCache.set(turn.mcpToolsKey, { type: "mcp_list_tools", id: item.id, server_label: item.server_label, tools: item.tools });
      return;
    }
  }
  function forgetMcpListToolsOnFailure(turn, failure) {
    if (!turn || !turn.mcpToolsInjected) return;
    if (turn.mcpToolsKey) mcpListToolsCache.delete(turn.mcpToolsKey);
    const text = failureText(failure);
    const status = failureStatus(failure);
    const namesItem = text.indexOf("mcp_list_tools") !== -1 || !!turn.mcpToolsItemId && text.indexOf(turn.mcpToolsItemId.toLowerCase()) !== -1;
    if (namesItem) {
      mcpListToolsReuseOff = true;
      storeMcpListToolsOff(turn.mcpToolsService);
      return;
    }
    if (status === 400 || status === 422 || text.indexOf("invalid_request_error") !== -1) mcpListToolsReuseOff = true;
  }
  async function callClaudeWithMcp({
    prompt,
    messages,
    service,
    owner,
    userId,
    model = DEFAULT_CLAUDE_MODEL,
    maxTokens = 1e3,
    system,
    mcpServer,
    extractContent,
    fileUrls,
    webAccess,
    cref
  }) {
    const web = await resolveWebAccess(service, typeof webAccess === "boolean" ? webAccess : void 0);
    const effortFields = chatEffortFields("claude", model, await resolveAnswerMode(service));
    const mcpServerDefinition = {
      type: "url",
      name: mcpServer.name,
      url: mcpServer.url
    };
    if (mcpServer.authorizationToken) {
      mcpServerDefinition.authorization_token = mcpServer.authorizationToken;
    }
    const stream = chatStreamWiring(userId || service);
    return forwardRequest({
      secretName: "claude",
      queue: userId || service,
      service,
      owner,
      ...pollOpt(),
      ...stream.transport,
      ...cref ? { cref } : {},
      url: ANTHROPIC_MESSAGES_API_URL,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "$CLIENT_SECRET",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA_HEADER
      },
      data: {
        model,
        max_tokens: maxTokens,
        // `output_config: {effort}` for a fast or thorough project, nothing otherwise.
        ...effortFields,
        // Top level beside model/messages/mcp_servers, which is where the
        // Messages API takes it.
        ...stream.body,
        ...extractContent && extractContent.length ? { _skapi_extract: extractContent } : {},
        ...fileUrls && fileUrls.length ? { _skapi_file_urls: fileUrls } : {},
        ...system ? {
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" }
            }
          ]
        } : {},
        messages: (() => {
          const prepared = messages && messages.length ? prepareClaudeMessages(messages) : [
            {
              role: "user",
              content: transformContentWithImages(prompt)
            }
          ];
          return applyHistoryCacheBreakpoint(prepared);
        })(),
        mcp_servers: [mcpServerDefinition],
        tools: [
          {
            type: "mcp_toolset",
            mcp_server_name: mcpServer.name,
            ...mcpServer.defaultConfig ? { default_config: mcpServer.defaultConfig } : {},
            ...mcpServer.configs ? { configs: mcpServer.configs } : {}
          },
          // `web_fetch` rides here only when the project's web switch is on. The
          // beta header above is left as it is: it only makes the tool TYPE
          // available, and a request that does not list the tool cannot use it.
          ...webToolsForChat("claude", web)
        ]
      }
    });
  }
  async function callClaudeWithPublicMcp(prompt, service, owner, messages, system, model, userId, extractContent, fileUrls, onResponse, onError, mcpScope, turn) {
    const endpoint = mcpEndpointFor(mcpScope?.anonymous, mcpScope?.publicProjectId, service);
    return callClaudeWithMcp({
      cref: turn?.cref,
      prompt,
      messages,
      service,
      owner,
      userId,
      model: model || DEFAULT_CLAUDE_MODEL,
      maxTokens: getMaxOutputTokens("claude", model || DEFAULT_CLAUDE_MODEL),
      system,
      extractContent,
      fileUrls,
      mcpServer: {
        name: MCP_NAME,
        url: mcpChatUrl(endpoint.url, "claude", model || DEFAULT_CLAUDE_MODEL),
        // Omitted entirely for an anonymous turn; the `if (mcpServer.authorizationToken)`
        // guard below drops the key rather than sending an empty one.
        authorizationToken: endpoint.token
      }});
  }
  async function callOpenAIWithPublicMcp(prompt, service, owner, messages, system, model, userId, extractContent, fileUrls, onResponse, onError, mcpScope, turn) {
    const endpoint = mcpEndpointFor(mcpScope?.anonymous, mcpScope?.publicProjectId, service);
    const resolvedModel = model || DEFAULT_OPENAI_MODEL;
    const imageDetail = getOpenAIImageDetail(resolvedModel);
    const serverUrl = mcpChatUrl(endpoint.url, "openai", resolvedModel);
    const web = await resolveWebAccess(service);
    const effortFields = chatEffortFields("openai", resolvedModel, await resolveAnswerMode(service));
    let listedTools;
    if (turn) {
      turn.mcpToolsKey = void 0;
      turn.mcpToolsInjected = false;
      turn.mcpToolsService = void 0;
      turn.mcpToolsItemId = void 0;
      if (turn.reuseMcpToolList && !mcpListToolsReuseOff && !mcpListToolsOffStored(service)) {
        turn.mcpToolsKey = mcpListToolsKey(serverUrl, mcpScope?.anonymous, service, mcpScope?.publicProjectId, turn.userId);
        turn.mcpToolsService = service;
        listedTools = mcpListToolsCache.get(turn.mcpToolsKey);
        turn.mcpToolsInjected = !!listedTools;
        if (listedTools) turn.mcpToolsItemId = listedTools.id;
      }
    }
    const messageList = messages && messages.length ? prepareOpenAIMessages(messages, imageDetail) : [
      {
        role: "user",
        content: transformContentWithOpenAIImages(prompt, imageDetail)
      }
    ];
    const responseInput = [
      ...system ? [
        {
          role: "system",
          content: system
        }
      ] : [],
      // Right after the system message, exactly as OpenAI returned it, so OpenAI
      // skips asking the MCP server for its tools again. Absent unless stored.
      // This item passes through the server's $CLIENT_SECRET / $ACCESS_TOKEN /
      // $ID_TOKEN substitution; rememberMcpListTools never stores a listing that
      // contains one of those literals.
      ...listedTools ? [{ type: listedTools.type, id: listedTools.id, server_label: listedTools.server_label, tools: listedTools.tools }] : [],
      ...messageList.map((m) => ({
        role: m.role,
        content: m.content
      }))
    ];
    const stream = chatStreamWiring(userId || service);
    return forwardRequest({
      secretName: "openai",
      queue: userId || service,
      service,
      owner,
      ...pollOpt(),
      ...stream.transport,
      ...turn && turn.cref ? { cref: turn.cref } : {},
      url: OPENAI_RESPONSES_API_URL,
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer $CLIENT_SECRET"
      },
      data: {
        model: resolvedModel,
        max_output_tokens: getMaxOutputTokens("openai", resolvedModel),
        // `reasoning: {effort}` for a fast or thorough project, nothing otherwise.
        ...effortFields,
        // Top level beside model/input/tools, which is where the Responses API
        // takes it.
        ...stream.body,
        ...extractContent && extractContent.length ? { _skapi_extract: extractContent } : {},
        ...fileUrls && fileUrls.length ? { _skapi_file_urls: fileUrls } : {},
        input: responseInput,
        tools: [
          {
            type: "mcp",
            server_label: MCP_NAME,
            server_url: serverUrl,
            require_approval: "never",
            // No `headers` at all for an anonymous turn: `Bearer ` with an
            // empty token is a credential the MCP server rejects, and the
            // project-scoped endpoint needs none.
            ...endpoint.token ? { headers: { Authorization: "Bearer " + endpoint.token } } : {}
          },
          // `web_search` rides here only when the project's web switch is on.
          ...webToolsForChat("openai", web)
        ]
      }
    });
  }
  async function notifyAgentContinueIndexing(info) {
    return notifyAgentSaveAttachment({ ...info, continueIndexing: true });
  }
  async function notifyAgentSaveAttachment(info) {
    const { platform, service, owner, attachment, parsedContent } = info;
    const continuing = !!info.continueIndexing;
    if (!continuing) {
      upsertIndexRunRecordSafe(service, attachment.storagePath, {
        status: "working",
        filename: attachment.name,
        started: Date.now(),
        queue: bgIndexingQueueName(info.userId, service),
        platform
      });
    }
    const tapDispatchFailure = (p) => {
      if (continuing) return p;
      return p.then(
        (ack) => ack,
        (err) => {
          upsertIndexRunRecordSafe(service, attachment.storagePath, {
            status: "error",
            finished: Date.now(),
            error: err && (err.message || String(err)) || "The indexing request could not be enqueued."
          });
          throw err;
        }
      );
    };
    const visionFile = !parsedContent && isImageVisionFile(attachment.name, attachment.mime);
    const renderFrom = Math.max(0, info.renderFrom || 0);
    const renderPlaceholder = visionFile ? makeRenderPlaceholder(attachment.storagePath) : void 0;
    const renderDetail = platform === "openai" ? getRenderImageDetail(info.model || DEFAULT_OPENAI_MODEL) : void 0;
    const visionProfile = platform === "openai" ? getVisionProfile(info.model || DEFAULT_OPENAI_MODEL) : { pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
    const skapiRender = visionFile && renderPlaceholder ? {
      _skapi_render: [
        {
          path: attachment.storagePath,
          from: renderFrom,
          count: visionProfile.pagesPerWindow,
          placeholder: renderPlaceholder,
          name: attachment.name,
          mime: attachment.mime,
          detail: renderDetail,
          tile: visionProfile.tile,
          auto_continue: true,
          continue_text: buildIndexingRenderContinueTemplate(attachment, renderPlaceholder)
        }
      ]
    } : {};
    const windowedRead = !visionFile && !parsedContent && windowedIndexingEnabled() && isWindowedReadFile(attachment.name, attachment.mime);
    const windowPlaceholder = windowedRead ? makeWindowPlaceholder(attachment.storagePath) : void 0;
    const skapiWindow = windowedRead && windowPlaceholder ? {
      _skapi_window: [
        {
          path: attachment.storagePath,
          cursor: null,
          placeholder: windowPlaceholder,
          name: attachment.name,
          mime: attachment.mime,
          kind: "window",
          // Same per-image `detail` the render path sends. Without it the worker falls
          // back to its model-blind default of 'high', so a spreadsheet's embedded
          // photos were tiled at lower resolution than the SAME model gets for a PDF
          // page or a chat attachment. That is why a model could describe an attached
          // photo but reported the pictures inside a sheet as only partly legible.
          detail: renderDetail,
          auto_continue: true,
          continue_text: buildIndexingWindowMessage(attachment, windowPlaceholder, true)
        }
      ]
    } : {};
    const pagedRead = !visionFile && !windowedRead && (continuing || !parsedContent && isPagedReadFile(attachment.name, attachment.mime));
    const serverExtract = !visionFile && !windowedRead && !continuing && !parsedContent && !pagedRead && isServerExtractable(attachment.name, attachment.mime);
    const placeholder = serverExtract ? makeExtractPlaceholder(attachment.storagePath) : void 0;
    const extractContent = serverExtract && placeholder ? [{ path: attachment.storagePath, placeholder, name: attachment.name, mime: attachment.mime }] : void 0;
    const skapiExtract = extractContent && extractContent.length ? {
      _skapi_extract: extractContent.map((d) => ({
        ...d,
        // FIRST pass of an INDEXING run only: tells the worker to also pull the
        // file's embedded pictures into __MEDIA__ and register their records.
        // Chat-turn extraction (callClaudeWithMcp / callOpenAIWithPublicMcp)
        // never sets this, so merely ATTACHING a file to a chat message cannot
        // write media records; a CONTINUE pass skips it because the first pass
        // already saved (the save is whole-file, not windowed).
        save_media: !continuing
      }))
    } : {};
    const singlePass = !visionFile && !windowedRead && !pagedRead && !continuing;
    const imageFile = singlePass && !parsedContent && !serverExtract ? indexingImageFile(attachment) : void 0;
    const fileUrlDetail = imageFile && platform === "openai" ? getOpenAIImageDetail(info.model || DEFAULT_OPENAI_MODEL) : void 0;
    const shareIdentical = !continuing && info.shareIdentical !== false && (info.shareIdentical === true || projectShareIdenticalFiles(service));
    const skapiFileUrls = attachment.url && attachment.storagePath ? {
      _skapi_file_urls: [{
        path: attachment.storagePath,
        url: attachment.url,
        ...singlePass ? { index_end: true } : {},
        ...fileUrlDetail ? { detail: fileUrlDetail } : {},
        ...shareIdentical ? { share_identical: true } : {}
      }]
    } : {};
    const userMessage = visionFile && renderPlaceholder ? buildIndexingRenderMessage(attachment, renderPlaceholder, renderFrom) : windowedRead && windowPlaceholder ? buildIndexingWindowMessage(attachment, windowPlaceholder, false) : continuing ? buildIndexingContinueMessage(attachment) : buildIndexingUserMessage(
      attachment,
      parsedContent ? { inlineContent: parsedContent } : placeholder ? { inlineContentPlaceholder: placeholder } : pagedRead ? { pagedRead: true } : imageFile ? { imageFile } : void 0
    );
    const systemPrompt = buildIndexingSystemPrompt({
      // The model copies this id verbatim into project_id tool calls, so it must be
      // the PUBLIC token whenever the host supplied one; the raw code is rejected
      // by the tools' schema pattern.
      projectId: info.publicProjectId || service,
      serviceName: info.serviceName,
      serviceDescription: info.serviceDescription,
      // Per-FILE, not per-project: one project holds public and private files at
      // once, so this travels on the attachment rather than the identity.
      accessGroup: attachment.accessGroup
    });
    if (platform === "openai") {
      const resolvedModel2 = info.model || DEFAULT_OPENAI_MODEL;
      const imageDetail = getOpenAIImageDetail(resolvedModel2);
      return tapDispatchFailure(forwardRequest({
        secretName: "openai",
        queue: bgIndexingQueueName(info.userId, service),
        service,
        owner,
        ...pollOpt(),
        ...info.cref ? { cref: info.cref } : {},
        // Status push for this pass and the continuations the worker queues from it
        // (see ChatEngineConfig.statusPush). Absent unless the host turned it on.
        ...statusPushEnabled() ? { notify: true } : {},
        url: OPENAI_RESPONSES_API_URL,
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer $CLIENT_SECRET"
        },
        data: {
          model: resolvedModel2,
          max_output_tokens: getMaxOutputTokens("openai", resolvedModel2, "indexing"),
          // Nano-only transcription knobs. Indexing only; see variantIndexingOptions.
          ...variantIndexingOptions(resolvedModel2),
          ...skapiExtract,
          ...skapiRender,
          ...skapiWindow,
          ...skapiFileUrls,
          input: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: transformContentWithOpenAIImages(userMessage, imageDetail)
            }
          ],
          tools: [
            {
              type: "mcp",
              server_label: MCP_NAME,
              server_url: mcpIndexingUrl("openai", resolvedModel2),
              require_approval: "never",
              headers: { Authorization: "Bearer $ACCESS_TOKEN" }
            },
            // UNCONDITIONAL, unlike a chat turn: the project's web switch
            // governs answers, not indexing. Kept exactly as it was.
            ...[openaiWebSearchTool()] 
          ]
        }
      }));
    }
    const resolvedModel = info.model || DEFAULT_CLAUDE_MODEL;
    return tapDispatchFailure(forwardRequest({
      secretName: "claude",
      queue: bgIndexingQueueName(info.userId, service),
      service,
      owner,
      ...pollOpt(),
      ...info.cref ? { cref: info.cref } : {},
      // Status push for this pass and the continuations the worker queues from it
      // (see ChatEngineConfig.statusPush). Absent unless the host turned it on.
      ...statusPushEnabled() ? { notify: true } : {},
      url: ANTHROPIC_MESSAGES_API_URL,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "$CLIENT_SECRET",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA_HEADER
      },
      data: {
        model: resolvedModel,
        max_tokens: getMaxOutputTokens("claude", resolvedModel, "indexing"),
        ...skapiExtract,
        ...skapiRender,
        ...skapiWindow,
        ...skapiFileUrls,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" }
          }
        ],
        messages: [
          {
            role: "user",
            content: transformContentWithImages(userMessage)
          }
        ],
        mcp_servers: [
          {
            type: "url",
            name: MCP_NAME,
            url: mcpIndexingUrl("claude", resolvedModel),
            authorization_token: "$ACCESS_TOKEN"
          }
        ],
        tools: [
          {
            type: "mcp_toolset",
            mcp_server_name: MCP_NAME
          },
          // UNCONDITIONAL, unlike a chat turn: the project's web switch governs
          // answers, not indexing. Kept exactly as it was.
          claudeWebFetchTool()
        ]
      }
    }));
  }
  function providerDocument(response) {
    if (typeof response !== "string") return response;
    var t = response.trim();
    if (t.charAt(0) !== "{" || t.charAt(t.length - 1) !== "}") return response;
    try {
      var doc = JSON.parse(t);
      return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : response;
    } catch (e) {
      return response;
    }
  }
  function extractClaudeText(response) {
    response = providerDocument(response);
    if (!Array.isArray(response?.content)) {
      return "";
    }
    return response.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  }
  function extractOpenAIText(response) {
    response = providerDocument(response);
    if (typeof response?.output_text === "string" && response.output_text.length) {
      return response.output_text;
    }
    if (Array.isArray(response?.output)) {
      const text = response.output.flatMap((item) => item?.content || []).filter((part) => part?.type === "output_text").map((part) => part.text || "").join("\n").trim();
      if (text) {
        return text;
      }
    }
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part?.type === "text") {
          return part.text || "";
        }
        return "";
      }).join("\n");
    }
    return "";
  }
  var BG_INDEXING_QUEUE_SUFFIX = "-bg";
  async function resetFileIndexOnServer(args) {
    try {
      const base = String(mcpUrl() || "").replace(/\/+$/, "");
      if (!base || !args || !args.service || !args.storagePath) return null;
      const res = await forwardRequest({
        service: args.service,
        ...args.owner ? { owner: args.owner } : {},
        url: base + "/internal/index-reset",
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer $ACCESS_TOKEN" },
        data: { project_id: args.service, path: args.storagePath }
      });
      const body = typeof res === "string" ? JSON.parse(res) : res;
      if (body && typeof body === "object" && typeof body.removed === "number" && body.path === args.storagePath) {
        return body;
      }
      return null;
    } catch {
      return null;
    }
  }
  function indexDoneUniqueId(storagePath) {
    return "done::" + storagePath;
  }
  function runIndexUniqueId(storagePath) {
    return "run::" + storagePath;
  }
  function upsertIndexRunRecordSafe(service, storagePath, patch, opts) {
    const report = !!(opts && opts.report);
    if (!service || !storagePath) return Promise.resolve();
    let out;
    try {
      const hook = chatEngineConfig().upsertIndexRunRecord;
      if (typeof hook !== "function") return Promise.resolve();
      out = hook({ service, storagePath, patch });
    } catch (e) {
      return report ? Promise.reject(e) : Promise.resolve();
    }
    const p = Promise.resolve(out).then(function() {
      return void 0;
    });
    return report ? p : p.catch(function() {
      return void 0;
    });
  }
  function bgIndexingQueueName(userId, service) {
    return (userId || service || "") + BG_INDEXING_QUEUE_SUFFIX;
  }
  function isBgIndexingQueue(queueName) {
    if (typeof queueName !== "string" || !queueName) return false;
    const prefix = queueName.split("|")[0];
    const idx = prefix.lastIndexOf(":");
    const name = idx === -1 ? prefix : prefix.slice(idx + 1);
    return name.slice(-BG_INDEXING_QUEUE_SUFFIX.length) === BG_INDEXING_QUEUE_SUFFIX;
  }
  var INDEXING_COMPLETE_MARKER = "INDEXING_COMPLETE";
  var EMPTY_INDEXING_REPLY = "Finished reading this file.";
  var MAX_INDEXING_RESUME_PASSES = 6;
  var CHAT_HISTORY_PAGE_LIMIT = 500;
  async function getChatHistory(params, fetchOptions) {
    const url = params.platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
    const p = Object.assign(
      {
        url,
        method: "POST"
      },
      { service: params.service, owner: params.owner },
      params.queue ? { queue: params.queue } : {},
      params.status ? { status: params.status } : {},
      params.queue_exact ? { queue_exact: true } : {},
      params.compact ? { compact: true } : {},
      params.queue_exclude ? { queue_exclude: params.queue_exclude } : {},
      params.fields ? { fields: params.fields } : {},
      params.after ? { after: params.after } : {},
      params.deadline ? { deadline: params.deadline } : {},
      params.signal ? { signal: params.signal } : {},
      params.fresh ? { fresh: true } : {}
    );
    return resolveForwardRequestHistory()(
      p,
      Object.assign({ ascending: false, limit: CHAT_HISTORY_PAGE_LIMIT }, fetchOptions)
    );
  }
  function buildHistoryItemFullId(platform, service, itemId) {
    const url = platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
    return `[POST]${url.toLowerCase()}#${service}:${itemId}`;
  }

  // src/engine/time.ts
  function wallClockNow() {
    return Date.now();
  }
  function formatChatTimestamp(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
    try {
      return new Date(ms).toLocaleString(void 0, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      });
    } catch (e) {
      return "";
    }
  }
  function formatDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 1e3) return "";
    var total = Math.floor(ms / 1e3);
    var h = Math.floor(total / 3600);
    var m = Math.floor(total % 3600 / 60);
    var s = total % 60;
    var out = [];
    if (h) out.push(h + "h");
    if (m) out.push(m + "m");
    out.push(s + "s");
    return out.join(" ");
  }
  function formatIndexDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 1e3) return "";
    var total = Math.floor(ms / 1e3);
    var h = Math.floor(total / 3600);
    var m = Math.floor(total % 3600 / 60);
    var s = total % 60;
    if (h) return h + " h" + (m ? " " + m + " min" : "");
    if (m) return m + " min" + (s ? " " + s + " s" : "");
    return s + " s";
  }
  function requestIdTimeMs(rid) {
    if (typeof rid !== "string") return 0;
    var stamp = rid.split(":")[0] || "";
    if (stamp.length !== 13) return 0;
    var alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
    var v = 0;
    for (var i = 0; i < stamp.length; i++) {
      var d = alphabet.indexOf(stamp.charAt(i).toUpperCase());
      if (d < 0) return 0;
      v = v * 32 + d;
    }
    return Math.floor(v / 2 / 1e6);
  }
  function messageTimeMs(m) {
    if (!m) return 0;
    var r = typeof m._serverItemId === "string" ? requestIdTimeMs(m._serverItemId) : 0;
    if (r > 0) return r;
    return typeof m._ts === "number" && m._ts > 0 ? m._ts : 0;
  }

  // src/engine/identical.ts
  var LINKED_COPY_TAG = "bq_linked";
  function linkedMarkerOf(data) {
    if (!data || typeof data !== "object" || data.linked !== true) return null;
    var original = typeof data.alias_of === "string" ? data.alias_of : "";
    if (!original) return null;
    var at = Number(data.completed_at || data.finished || data.linked_at);
    return {
      original,
      claim: typeof data.alias_claim === "string" && data.alias_claim ? data.alias_claim : void 0,
      linkedAt: isFinite(at) && at > 0 ? at : void 0,
      group: data.copy_group !== void 0 ? data.copy_group : void 0,
      owner: typeof data.copy_owner === "string" ? data.copy_owner : void 0,
      contentKey: typeof data.content_key === "string" && data.content_key ? data.content_key : void 0
    };
  }
  function fileNameOf(path) {
    var s = String(path || "");
    var at = s.lastIndexOf("/");
    return at === -1 ? s : s.slice(at + 1);
  }
  function copiesByOriginal(linked) {
    var entries = linked instanceof Map ? Array.from(linked.entries()) : Object.keys(linked).map(function(k) {
      return [k, linked[k]];
    });
    entries.sort(function(a, b) {
      return (a[1].linkedAt || 0) - (b[1].linkedAt || 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    });
    var out = /* @__PURE__ */ new Map();
    for (var i = 0; i < entries.length; i++) {
      var o = entries[i][1].original;
      if (!out.has(o)) out.set(o, []);
      out.get(o).push(entries[i][0]);
    }
    return out;
  }
  function formatLinkDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
    if (ms < 1e4) return (Math.max(ms, 100) / 1e3).toFixed(1) + " s";
    return formatIndexDuration(ms);
  }
  function linkedRowLabel(original, ms) {
    var took = formatLinkDuration(ms);
    return "Same content as " + fileNameOf(original) + ": linked" + (took ? " in " + took : "") + ", no AI used";
  }
  function parseLinkedReply(text) {
    if (typeof text !== "string" || text.indexOf('[skapi] Same content as "') === -1) return null;
    var m = /\[skapi\] Same content as "([^"]+)": linked to its index(?: in ([0-9]+(?:\.[0-9]+)?) s)?/.exec(text);
    if (!m) return null;
    var secs = m[2] !== void 0 ? Number(m[2]) : NaN;
    return { original: m[1], ms: isFinite(secs) ? Math.round(secs * 1e3) : void 0 };
  }
  function promotableCopies(linked, actor) {
    var entries = linked instanceof Map ? Array.from(linked.entries()) : Object.keys(linked).map(function(k) {
      return [k, linked[k]];
    });
    var out = /* @__PURE__ */ new Map();
    for (var i = 0; i < entries.length; i++) {
      var m = entries[i][1];
      if (actor.isProjectOwner || !!actor.userId && !!m && m.owner === actor.userId) out.set(entries[i][0], m);
    }
    return out;
  }
  function copiesToPromote(linked, removed, removedFolders, actor) {
    if (actor) linked = promotableCopies(linked, actor);
    var gone = new Set(removed || []);
    var folders = (removedFolders || []).filter(Boolean).map(function(f) {
      return f.replace(/\/+$/, "") + "/";
    });
    var isGone = function(p) {
      if (gone.has(p)) return true;
      for (var i = 0; i < folders.length; i++) if (p.indexOf(folders[i]) === 0) return true;
      return false;
    };
    var out = [];
    copiesByOriginal(linked).forEach(function(copies, original) {
      if (!isGone(original)) return;
      var keep = copies.filter(function(c) {
        return !isGone(c);
      });
      if (keep.length) out.push({ original, copies: keep });
    });
    return out;
  }
  function listOf(res) {
    return res && Array.isArray(res.list) ? res.list : [];
  }
  async function listLinkedCopies(skapi, service, maxPages = 10) {
    if (!skapi || typeof skapi.getRecords !== "function" || !service) return null;
    var out = /* @__PURE__ */ new Map();
    try {
      var fetchMore = false;
      for (var page = 0; page < maxPages; page++) {
        var res = await skapi.getRecords(
          { service, table: { name: "__INDEXING__", access_group: "authorized" }, tag: LINKED_COPY_TAG },
          { limit: 1e3, fetchMore }
        );
        var list = listOf(res);
        for (var i = 0; i < list.length; i++) {
          var r = list[i] || {};
          var uid = String(r.unique_id || "");
          if (uid.indexOf("done::") !== 0) continue;
          var mk = linkedMarkerOf(r.data);
          if (mk) out.set(uid.slice(6), mk);
        }
        if (!res || res.endOfList !== false) return out;
        fetchMore = true;
      }
      return out;
    } catch (err) {
      var msg = String(err && (err.code || err.message) || err || "");
      if (/NOT_EXISTS|not exist/i.test(msg)) return out;
      return null;
    }
  }

  // src/engine/indexing_groups.ts
  function canonIndexKey(s) {
    return typeof s === "string" && s ? s.trim() : "";
  }
  var RUN_RECORD_WORKING_STALE_MS = 6 * 60 * 60 * 1e3;
  var INDEXING_LABEL_RE = /^(Re)?[Ii]ndexing(\s*\(continuing\))?\s*:?\s+(.+)$/;
  var LEADING_MD_LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)/;
  function parseIndexingLabel(content) {
    if (typeof content !== "string" || !content) return null;
    var firstLine = content.split("\n")[0].trim();
    var m = firstLine.match(INDEXING_LABEL_RE);
    if (!m) return null;
    var head = m[3].split(" \xB7 ")[0].trim();
    var link = head.match(LEADING_MD_LINK_RE);
    var name = link ? link[1].trim() : head;
    if (!name) return null;
    return {
      name,
      path: link ? link[2].trim() : void 0,
      continued: !!m[2],
      isReindex: !!m[1]
    };
  }
  function readFileRef(msg) {
    var ref = msg && msg._indexFile;
    if (ref && (ref.path || ref.name)) {
      return {
        name: ref.name || ref.path || "",
        path: ref.path,
        mime: ref.mime,
        size: ref.size,
        isReindex: ref.isReindex,
        continued: !!ref.continued
      };
    }
    var parsed = parseIndexingLabel(msg && msg.content);
    if (!parsed) return null;
    return {
      name: parsed.name,
      path: parsed.path,
      isReindex: parsed.isReindex,
      continued: parsed.continued
    };
  }
  function isPendingMsg(m) {
    return !!(m.isPending || m.isPendingInProcess || m.isPendingQueued || m.isSendingToServer);
  }
  function isHiddenPass(m) {
    if (m.role === "user") {
      if (m.isCancelled) return false;
      var ref = readFileRef(m);
      return !!(ref && ref.continued);
    }
    return !!m.isPending;
  }
  function overlayRunRecordVerdict(grp, rec, liveIndexKeys) {
    if (!grp.members.length || grp.status === "active" || grp.cancelling) return;
    if (rec.status === "working" || typeof rec.started !== "number") return;
    if (liveIndexKeys[grp.key] || liveIndexKeys[canonIndexKey(grp.key)]) return;
    var firstTs = grp.members[0].msg._ts;
    var lastTs = grp.members[grp.members.length - 1].msg._ts;
    if (typeof lastTs !== "number" || typeof firstTs !== "number") return;
    if (rec.started > lastTs) return;
    var when = typeof rec.finished === "number" ? rec.finished : void 0;
    if (when === void 0) return;
    if (when < firstTs) return;
    if (when < lastTs - 5e3) return;
    if (rec.status === "error" || rec.status === "cancelled") {
      grp.status = rec.status;
    } else if (rec.status === "done") {
      grp.status = "done";
    } else {
      return;
    }
    grp.finished = true;
    grp.resolving = false;
    grp.resolvingReason = void 0;
  }
  function runRecordDurationMs(rec) {
    if (!rec || rec.status !== "done") return void 0;
    var a = rec.started;
    var b = rec.finished;
    if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b) || b < a) return void 0;
    return b - a;
  }
  var RUN_DURATION_CLOCK_SLACK_MS = 6e4;
  var RUN_DURATION_SERVER_SLACK_MS = 5e3;
  function runRecordGroupDurationMs(grp, rec) {
    if (rec.status !== "done" || !grp.members.length) return void 0;
    var fin = rec.finished;
    if (typeof fin !== "number" || !isFinite(fin)) return void 0;
    var firstTs = messageTimeMs(grp.members[0].msg);
    var lastTs = messageTimeMs(grp.members[grp.members.length - 1].msg);
    if (!firstTs || !lastTs) return void 0;
    if (fin < firstTs || fin < lastTs - RUN_DURATION_SERVER_SLACK_MS) return void 0;
    var firstPassTs = 0;
    for (var i = 0; i < grp.members.length; i++) {
      var m = grp.members[i].msg;
      if (m.role !== "user") continue;
      var ref = readFileRef(m);
      if (ref && !ref.continued) firstPassTs = messageTimeMs(m);
      break;
    }
    var st = typeof rec.started === "number" && isFinite(rec.started) ? rec.started : void 0;
    var start;
    if (st !== void 0 && st > firstTs + RUN_DURATION_CLOCK_SLACK_MS) return void 0;
    if (firstPassTs) {
      start = st !== void 0 && st >= firstPassTs - RUN_DURATION_CLOCK_SLACK_MS ? st : firstPassTs;
    } else {
      if (st === void 0) return void 0;
      start = st;
    }
    return fin >= start ? fin - start : void 0;
  }
  function indexGroupDurationLabel(group) {
    if (!group || group.status !== "done" || !group.finished || group.resolving || group.queued) return "";
    return formatIndexDuration(group.durationMs);
  }
  function indexGroupLinkedLabel(group) {
    if (!group || !group.linked || group.status !== "done") return "";
    return linkedRowLabel(group.linked.original, group.linked.ms);
  }
  function buildChatDisplayList(messages, opts) {
    var list = Array.isArray(messages) ? messages : [];
    var liveIndexKeys = opts && opts.liveIndexKeys || {};
    var liveIndexChecked = !!(opts && opts.liveIndexChecked);
    var doneKeys = opts && opts.doneKeys || {};
    var stoppedIndexIds = opts && opts.stoppedIndexIds || {};
    var windowedIndexing = opts && opts.windowedIndexing !== void 0 ? !!opts.windowedIndexing : windowedIndexingEnabled();
    var hasMoreHistory = !!(opts && opts.hasMoreHistory);
    var loadingOlderHistory = !!(opts && opts.loadingOlderHistory);
    var stubPlatform = opts && opts.stubPlatform;
    var groups = {};
    var order = [];
    var runOfIndex = new Array(list.length);
    var runByItemId = {};
    var keyByName = {};
    var openRunOfKey = {};
    var runsOfKey = {};
    var keyOfRun = {};
    var newestTsOfRun = {};
    var runSeq = 0;
    for (var i = 0; i < list.length; i++) {
      var msg = list[i];
      if (!msg || !msg.isBackgroundTask) continue;
      var runId;
      var ref = msg.role === "user" ? readFileRef(msg) : null;
      if (msg._serverItemId && runByItemId[msg._serverItemId]) {
        runId = runByItemId[msg._serverItemId];
      } else if (ref) {
        var key = ref.path || keyByName[ref.name] || ref.name;
        var alreadySeen = !!(msg._serverItemId && runByItemId[msg._serverItemId]);
        var openId = openRunOfKey[key];
        var notLater = false;
        var msgTime = messageTimeMs(msg);
        if (openId && msgTime > 0 && typeof newestTsOfRun[openId] === "number") {
          notLater = msgTime <= newestTsOfRun[openId];
        }
        if (!ref.continued && !alreadySeen && !notLater && openRunOfKey[key]) delete openRunOfKey[key];
        runId = openRunOfKey[key];
        if (!runId) {
          runId = "run" + runSeq++;
          openRunOfKey[key] = runId;
          keyOfRun[runId] = key;
          (runsOfKey[key] || (runsOfKey[key] = [])).push(runId);
        }
      } else if (msg.role !== "user") {
        runId = runOfIndex[i - 1];
      }
      if (!runId) continue;
      var memberTime = messageTimeMs(msg);
      if (memberTime > 0) {
        var prevTs = newestTsOfRun[runId];
        if (typeof prevTs !== "number" || memberTime > prevTs) newestTsOfRun[runId] = memberTime;
      }
      var g = groups[runId];
      if (!g) {
        var fileKey = keyOfRun[runId];
        g = groups[runId] = {
          key: fileKey,
          runKey: runId,
          // provisional; renumbered newest-first below
          name: ref ? ref.name : fileKey,
          path: ref ? ref.path : void 0,
          mime: ref ? ref.mime : void 0,
          size: ref ? ref.size : void 0,
          isReindex: !!(ref && ref.isReindex),
          members: [],
          passCount: 0,
          status: "done",
          cancellableIds: [],
          cancelling: false,
          stopped: false,
          mayHaveOlder: false,
          // The run's first loaded pass, and never re-stamped: see the file
          // docstring. `anchorId` is filled in once every member is known.
          anchorIndex: i,
          anchorId: "",
          // All five are derived once every member is known, below.
          visibleMembers: [],
          driver: "single",
          finished: false,
          resolving: false
        };
        order.push(runId);
      }
      if (ref) {
        if (ref.name) g.name = ref.name;
        if (ref.path) g.path = ref.path;
        if (ref.mime) g.mime = ref.mime;
        if (typeof ref.size === "number") g.size = ref.size;
        if (ref.isReindex) g.isReindex = true;
        if (!ref.continued) g.mayHaveOlder = false;
        g.passCount++;
      }
      g.members.push({ msg, index: i });
      runOfIndex[i] = runId;
      if (msg._serverItemId) runByItemId[msg._serverItemId] = runId;
      if (ref && ref.name) keyByName[ref.name] = g.key;
    }
    var newestRunOfKey = {};
    for (var nk in runsOfKey) {
      var nrs = runsOfKey[nk];
      if (nrs.length) newestRunOfKey[nrs[nrs.length - 1]] = true;
    }
    for (var rk in runsOfKey) {
      var runIds = runsOfKey[rk];
      for (var ri = 0; ri < runIds.length; ri++) {
        var grpR = groups[runIds[ri]];
        if (!grpR) continue;
        var first = grpR.members[0];
        var firstId = first && first.msg && (first.msg._serverItemId || first.msg._localId);
        grpR.runKey = rk + "#" + (firstId || "n" + ri);
      }
    }
    for (var oi = 0; oi < order.length; oi++) {
      var grp = groups[order[oi]];
      var lastSettled = -1;
      for (var si = 0; si < grp.members.length; si++) {
        if (!isPendingMsg(grp.members[si].msg)) lastSettled = si;
      }
      var active = false;
      for (var mi = lastSettled + 1; mi < grp.members.length; mi++) {
        if (isPendingMsg(grp.members[mi].msg)) {
          active = true;
          break;
        }
      }
      var stopped = false;
      for (var ki = 0; ki < grp.members.length; ki++) {
        var km = grp.members[ki].msg;
        if (km.isCancelled) {
          stopped = true;
          break;
        }
        if (km._serverItemId && stoppedIndexIds[km._serverItemId]) {
          stopped = true;
          break;
        }
      }
      grp.stopped = stopped;
      for (var xi = 0; xi < grp.members.length; xi++) {
        if (grp.members[xi].msg._cancelling) {
          grp.cancelling = true;
          break;
        }
      }
      var seenIds = {};
      for (var ci = 0; ci < grp.members.length; ci++) {
        var cm = grp.members[ci].msg;
        if (cm._cancelError && !stopped && (active || grp.cancelling)) grp.cancelError = cm._cancelError;
        if (cm.role !== "user" || !cm._serverItemId || cm._cancelling || cm.isSendingToServer) continue;
        if (!(cm.isPendingQueued || cm.isPendingInProcess)) continue;
        if (ci < lastSettled) continue;
        if (seenIds[cm._serverItemId]) continue;
        seenIds[cm._serverItemId] = true;
        grp.cancellableIds.push(cm._serverItemId);
      }
      if (active) {
        grp.status = "active";
        if (stopped) grp.cancelling = true;
      } else if (stopped) {
        grp.status = "cancelled";
      } else {
        var retriedIds = {};
        for (var ri = 0; ri < grp.members.length; ri++) {
          var rm = grp.members[ri].msg;
          if (rm.isRetried && rm._serverItemId) retriedIds[rm._serverItemId] = true;
        }
        var li = grp.members.length - 1;
        while (li >= 0 && (grp.members[li].msg.isRetried || grp.members[li].msg._serverItemId && retriedIds[grp.members[li].msg._serverItemId])) li--;
        if (li < 0) {
          grp.status = "active";
        } else {
          var last = grp.members[li].msg;
          grp.status = last.isError ? "error" : "done";
        }
      }
      var sawFirstPass = false;
      for (var pi = 0; pi < grp.members.length; pi++) {
        var pm = grp.members[pi].msg;
        if (pm.role !== "user") continue;
        var pref = readFileRef(pm);
        if (pref && !pref.continued) {
          sawFirstPass = true;
          break;
        }
      }
      grp.mayHaveOlder = !sawFirstPass && hasMoreHistory;
      var anchor = grp.members[0];
      grp.anchorIndex = anchor.index;
      grp.anchorId = anchor.msg._serverItemId || anchor.msg._localId || "";
      var sawComplete = false;
      for (var vi = 0; vi < grp.members.length; vi++) {
        var vm = grp.members[vi];
        if (vm.msg._indexComplete) sawComplete = true;
        if (!isHiddenPass(vm.msg)) grp.visibleMembers.push(vm);
        if (vm.msg.role === "assistant" && !vm.msg.isError && !grp.linked) {
          var linkedReply = parseLinkedReply(vm.msg.content);
          if (linkedReply) grp.linked = linkedReply;
        }
      }
      if (grp.linked && grp.status !== "active" && grp.status !== "cancelled") {
        grp.status = "done";
        sawComplete = true;
      }
      grp.driver = !isPagedReadFile(grp.name, grp.mime) ? "single" : isImageVisionFile(grp.name, grp.mime) ? "worker" : windowedIndexing ? "worker" : "client";
      if (grp.status === "active") {
        grp.finished = false;
      } else if (grp.status === "cancelled") {
        grp.finished = true;
      } else if (grp.driver === "single") {
        grp.finished = true;
      } else if (grp.driver === "client") {
        grp.finished = sawComplete || grp.status === "error" || grp.passCount >= MAX_INDEXING_RESUME_PASSES;
      } else {
        grp.finished = !newestRunOfKey[order[oi]] || !!grp.linked || !!doneKeys[grp.key] && !liveIndexKeys[grp.key] || liveIndexChecked && !liveIndexKeys[grp.key];
      }
      if (grp.status !== "done") {
        grp.resolving = false;
      } else if (grp.mayHaveOlder && loadingOlderHistory && !liveIndexKeys[grp.key] && !doneKeys[grp.key] && newestRunOfKey[order[oi]]) {
        grp.resolving = true;
        grp.resolvingReason = "history";
      } else if (!grp.finished && grp.driver === "worker" && !liveIndexChecked && !liveIndexKeys[grp.key]) {
        grp.resolving = true;
        grp.resolvingReason = "status";
        var openRun = opts && opts.runStubs && (grp.path && opts.runStubs[grp.path] || opts.runStubs[grp.key]);
        var runNow = opts && opts.liveIndexRunningKeys;
        if (opts && opts.liveIndexRunningChecked && openRun && openRun.status === "working" && runNow && !runNow[grp.key] && !(grp.path && runNow[grp.path]) && !(grp.name && runNow[grp.name])) {
          grp.resolving = false;
          grp.resolvingReason = void 0;
          grp.queued = true;
        }
      } else {
        grp.resolving = false;
      }
      var runningNow = opts && opts.liveIndexRunningKeys;
      if (runningNow && !grp.finished && !grp.resolving && grp.status === "active" && !runningNow[grp.key] && !(grp.path && runningNow[grp.path]) && !(grp.name && runningNow[grp.name])) {
        var otherRunning = false;
        if (opts && opts.liveIndexRunningChecked) {
          for (var rk in runningNow) {
            if (runningNow[rk] && rk !== grp.key && rk !== grp.path && rk !== grp.name) {
              otherRunning = true;
              break;
            }
          }
        }
        var openRun2 = opts && opts.runStubs && (grp.path && opts.runStubs[grp.path] || opts.runStubs[grp.key]);
        var waitingOpenRun = !!(opts && opts.liveIndexRunningChecked && openRun2 && openRun2.status === "working");
        var startedRun = false;
        for (var mi = 0; mi < grp.members.length; mi++) {
          var mm = grp.members[mi].msg;
          if (mm && mm.role === "assistant" && !mm.isPending && !mm.isPendingInProcess && !mm.isPendingQueued) {
            startedRun = true;
            break;
          }
        }
        if (!startedRun && (liveIndexKeys[grp.key] || grp.path && liveIndexKeys[grp.path] || otherRunning || waitingOpenRun)) grp.queued = true;
      }
    }
    var superseded = {};
    for (var sk in runsOfKey) {
      var srs = runsOfKey[sk];
      for (var sri = 0; sri < srs.length - 1; sri++) {
        var sgp = groups[srs[sri]];
        if (!sgp || sgp.status === "active" || sgp.cancelling) continue;
        superseded[srs[sri]] = true;
      }
    }
    var stubList = [];
    var runStubs = opts && opts.runStubs;
    if (runStubs) {
      var coveredPaths = {};
      var coveredPathlessNames = {};
      for (var ci = 0; ci < order.length; ci++) {
        var cg = groups[order[ci]];
        if (cg.path) {
          coveredPaths[canonIndexKey(cg.path)] = true;
          if (cg.key) coveredPaths[canonIndexKey(cg.key)] = true;
        } else if (cg.name) coveredPathlessNames[canonIndexKey(cg.name)] = true;
        else if (cg.key) coveredPaths[canonIndexKey(cg.key)] = true;
      }
      var now = opts && typeof opts.now === "number" ? opts.now : Date.now();
      var runningKeys = opts && opts.liveIndexRunningKeys;
      var runningChecked = !!(opts && opts.liveIndexRunningChecked);
      var stubClearedAt = opts && typeof opts.stubClearedAt === "number" && opts.stubClearedAt > 0 ? opts.stubClearedAt : 0;
      for (var sp in runStubs) {
        var rec = runStubs[sp];
        if (!sp || !rec || !rec.status || coveredPaths[canonIndexKey(sp)]) continue;
        var fname = rec.filename || sp.split("/").pop() || sp;
        if (coveredPathlessNames[canonIndexKey(fname)]) continue;
        if (stubPlatform && rec.platform && rec.platform !== stubPlatform) continue;
        var live = !!liveIndexKeys[sp] || !!liveIndexKeys[canonIndexKey(sp)];
        if (!live && (liveIndexKeys[fname] || liveIndexKeys[canonIndexKey(fname)])) {
          var claimedByOther = false;
          for (var lk in liveIndexKeys) {
            if (!liveIndexKeys[lk]) continue;
            var lkc = canonIndexKey(lk);
            if (lkc === canonIndexKey(sp)) continue;
            if (lkc.length > fname.length && lkc.slice(-(fname.length + 1)) === "/" + fname) {
              claimedByOther = true;
              break;
            }
          }
          live = !claimedByOther;
        }
        var recWhen = typeof rec.finished === "number" ? rec.finished : typeof rec.started === "number" ? rec.started : void 0;
        if (stubClearedAt && !live && recWhen !== void 0 && recWhen <= stubClearedAt) continue;
        var st = "active";
        var fin = false;
        var res = false;
        var waitingStub = false;
        var reason;
        if (!live) {
          if (rec.status === "done" || doneKeys[sp] || doneKeys[canonIndexKey(sp)] || doneKeys[fname] || doneKeys[canonIndexKey(fname)]) {
            st = "done";
            fin = true;
          } else if (rec.status === "error") {
            st = "error";
            fin = true;
          } else if (rec.status === "cancelled") {
            st = "cancelled";
            fin = true;
          } else if (liveIndexChecked) {
            st = "done";
            fin = true;
          } else if (typeof rec.started === "number" && now - rec.started > RUN_RECORD_WORKING_STALE_MS) {
            st = "error";
            fin = true;
          } else if (runningChecked && rec.status === "working") {
            waitingStub = true;
          } else {
            res = true;
            reason = "status";
          }
        }
        var sg = {
          key: sp,
          // ONE identity for the run whether it renders from the record or
          // from its loaded passes: the views key the DOM off runKey, so a
          // 'stub:'-prefixed key meant every handoff was an unmount plus a
          // remount somewhere else. Named after the record's start, which
          // the real group below reuses when it has one.
          runKey: "run:" + sp + "#" + (typeof rec.started === "number" ? rec.started : "n"),
          name: fname,
          path: sp,
          mime: void 0,
          size: void 0,
          isReindex: false,
          members: [],
          passCount: 0,
          status: st,
          cancellableIds: [],
          cancelling: false,
          stopped: st === "cancelled",
          mayHaveOlder: hasMoreHistory,
          anchorIndex: -1,
          anchorId: "",
          visibleMembers: [],
          driver: !isPagedReadFile(fname, void 0) ? "single" : isImageVisionFile(fname, void 0) ? "worker" : windowedIndexing ? "worker" : "client",
          finished: fin,
          resolving: res,
          resolvingReason: reason,
          stub: true,
          queued: waitingStub || live && !!runningKeys && !runningKeys[sp] && !runningKeys[canonIndexKey(sp)] && !runningKeys[fname] ? true : void 0,
          stubError: rec.error || (st === "error" && !rec.error ? "Indexing did not finish." : void 0),
          // The stub IS the record, so a 'done' record's span is this run's.
          durationMs: st === "done" ? runRecordDurationMs(rec) : void 0,
          linked: st === "done" && rec.linked && rec.alias_of ? { original: rec.alias_of, ms: typeof rec.link_ms === "number" ? rec.link_ms : void 0 } : void 0
        };
        stubList.push({ started: typeof rec.started === "number" ? rec.started : Infinity, group: sg });
      }
    }
    var suppressAnchor = {};
    var stubByCanon = {};
    if (runStubs) for (var ck in runStubs) stubByCanon[canonIndexKey(ck)] = runStubs[ck];
    if (runStubs) {
      for (var ti2 = 0; ti2 < order.length; ti2++) {
        var tg = groups[order[ti2]];
        if (!newestRunOfKey[order[ti2]]) continue;
        var trec = tg.path && (runStubs[tg.path] || stubByCanon[canonIndexKey(tg.path)]) || runStubs[tg.key] || stubByCanon[canonIndexKey(tg.key)];
        if (!trec || typeof trec.started !== "number") continue;
        if (stubPlatform && trec.platform && trec.platform !== stubPlatform) continue;
        suppressAnchor[order[ti2]] = true;
        tg.runKey = "run:" + (tg.path || tg.key) + "#" + trec.started;
        stubList.push({ started: trec.started, group: tg });
        overlayRunRecordVerdict(tg, trec, liveIndexKeys);
        tg.durationMs = runRecordGroupDurationMs(tg, trec);
        if (trec.linked && trec.alias_of && trec.status === "done") {
          tg.linked = { original: trec.alias_of, ms: tg.linked && tg.linked.ms !== void 0 ? tg.linked.ms : typeof trec.link_ms === "number" ? trec.link_ms : void 0 };
        }
      }
    }
    stubList.sort(function(a, b) {
      return a.started - b.started;
    });
    var out = [];
    var si = 0;
    for (var j = 0; j < list.length; j++) {
      var mts = list[j] && typeof list[j]._ts === "number" ? list[j]._ts : void 0;
      if (mts !== void 0) {
        while (si < stubList.length && stubList[si].started <= mts) {
          out.push({ kind: "indexing", group: stubList[si].group, index: -1 - si });
          si++;
        }
      }
      var r = runOfIndex[j];
      if (r === void 0) {
        out.push({ kind: "message", msg: list[j], index: j });
        continue;
      }
      if (groups[r].anchorIndex === j && !suppressAnchor[r] && !superseded[r]) {
        out.push({ kind: "indexing", group: groups[r], index: j });
      }
    }
    while (si < stubList.length) {
      out.push({ kind: "indexing", group: stubList[si].group, index: -1 - si });
      si++;
    }
    return out;
  }

  // src/engine/duplicates.ts
  var DUPLICATE_LOOKUP_MAX_CANDIDATES = 25;
  var SRC_PREFIX2 = "src::";
  function isDuplicateCandidateId(uniqueId, name) {
    if (typeof uniqueId !== "string" || !name) return false;
    if (uniqueId.indexOf(SRC_PREFIX2) !== 0) return false;
    if (uniqueId === SRC_PREFIX2 + name) return true;
    const tail = "/" + name;
    return uniqueId.length > SRC_PREFIX2.length + tail.length && uniqueId.slice(-tail.length) === tail;
  }
  function listOf2(res) {
    if (!res) return [];
    if (Array.isArray(res)) return res;
    return Array.isArray(res.list) ? res.list : [];
  }
  var DUPLICATE_LOOKUP_TIMEOUT_MS = 15e3;
  var DUPLICATE_LOOKUP_LIMIT = 500;
  function nfc(text) {
    try {
      return String(text || "").normalize("NFC");
    } catch {
      return String(text || "");
    }
  }
  async function storedCopyIndexing(skapi, storagePath, service) {
    const doneId = "done::" + storagePath;
    try {
      const done = listOf2(await skapi.getUniqueId(Object.assign({ unique_id: doneId }, service), { fetchMore: false, limit: 1 }));
      if (done.some(function(it) {
        return (it && typeof it === "object" ? it.unique_id : it) === doneId;
      })) return "done";
    } catch {
    }
    try {
      const run = listOf2(await skapi.getRecords(Object.assign({ unique_id: "run::" + storagePath }, service)))[0];
      const data = run && run.data && typeof run.data === "object" ? run.data : null;
      if (data && data.status === "working" && typeof data.started === "number" && Date.now() - data.started < RUN_RECORD_WORKING_STALE_MS) return "running";
    } catch {
    }
    return "other";
  }
  async function findDuplicateUpload(skapi, file, userId, opts) {
    const timeoutMs = opts && typeof opts.timeoutMs === "number" && opts.timeoutMs >= 0 ? opts.timeoutMs : DUPLICATE_LOOKUP_TIMEOUT_MS;
    let timer;
    const deadline = new Promise(function(resolve) {
      timer = setTimeout(function() {
        resolve(null);
      }, timeoutMs);
    });
    try {
      return await Promise.race([lookupDuplicate(skapi, file, userId, opts), deadline]);
    } catch {
      return null;
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  async function lookupDuplicate(skapi, file, userId, opts) {
    if (!skapi || typeof skapi.getUniqueId !== "function" || typeof skapi.getRecords !== "function") return null;
    const name = nfc(file && typeof file.name === "string" ? file.name.split("/").pop() || "" : "");
    const size = file && typeof file.size === "number" ? file.size : NaN;
    if (!name || !(size >= 0) || !userId) return null;
    const service = opts && opts.service ? { service: opts.service } : {};
    const found = listOf2(await skapi.getUniqueId(
      Object.assign({ unique_id: name, condition: "<=" }, service),
      { fetchMore: false, limit: DUPLICATE_LOOKUP_LIMIT }
    ));
    const ids = [];
    for (const item of found) {
      const id = item && typeof item === "object" ? item.unique_id : item;
      if (isDuplicateCandidateId(id, name) && ids.indexOf(id) === -1) ids.push(id);
      if (ids.length >= DUPLICATE_LOOKUP_MAX_CANDIDATES) break;
    }
    for (const uniqueId of ids) {
      let record = null;
      try {
        record = listOf2(await skapi.getRecords(Object.assign({ unique_id: uniqueId }, service)))[0] || null;
      } catch {
        continue;
      }
      if (!record || typeof record !== "object") continue;
      const data = record.data && typeof record.data === "object" ? record.data : null;
      if (!data || data.size_bytes !== size) continue;
      if (record.user_id !== userId) continue;
      const storagePath = uniqueId.slice(SRC_PREFIX2.length);
      const indexing = await storedCopyIndexing(skapi, storagePath, service);
      if (indexing === "other") continue;
      return { storagePath, uniqueId, record, indexing };
    }
    return null;
  }

  // src/engine/attachments.ts
  function groupAttachmentFailures(attachments) {
    const groups = {};
    const order = [];
    (attachments || []).forEach(function(att) {
      if (!att || att.status !== "error" && att.status !== "indexError") return;
      const code = String(att.errorCode || "");
      const message = String(
        att.errorDetail || att.errorMessage || (att.status === "indexError" ? "File indexing failed" : "File upload has failed")
      );
      const key = code + "\0" + message;
      if (!groups[key]) {
        groups[key] = { code, message, files: [] };
        order.push(key);
      }
      groups[key].files.push(String(att.name || "(unnamed file)"));
    });
    return order.map(function(k) {
      return groups[k];
    });
  }

  // src/engine/greeting.ts
  function buildChatGreeting(params) {
    const custom = typeof params.custom === "string" ? params.custom.trim() : "";
    if (custom) return { lead: custom, name: "", tail: "", text: custom };
    const name = params.projectName ? '"' + params.projectName + '"' : "";
    const lead = params.canUpload === false ? "Hi! Ask me anything about the data in your project" : "Hi! Start by attaching the files related to your project";
    const tail = params.canUpload === false ? "." : ", or pasting plain text into the chat. Once they are indexed, ask me anything about that data.";
    return { lead, name, tail, text: lead + (name ? " " + name : "") + tail };
  }

  // src/engine/citations.ts
  var DATA_TOOL_NAMES = [
    "getRecords",
    "queryGrid",
    "readFileContent",
    "searchText",
    "getFileOutline",
    "getUniqueId",
    "getTables",
    "getTags",
    "getIndexes"
  ];
  var NO_DATA_TOOL_MARK = "No project data was read for this answer";
  function citationFileName(path) {
    var segs = String(path || "").split("/");
    for (var i = segs.length - 1; i >= 0; i--) {
      if (segs[i]) return segs[i];
    }
    return String(path || "");
  }
  function citationLabel(path, page) {
    return citationFileName(path) + (typeof page === "number" && page > 0 ? " p." + page : "");
  }
  function isMintablePath(path) {
    return !!path && !isHttpUrlLike(path);
  }
  function citationsFor(note) {
    if (!isRetrievalNote(note)) return [];
    var out = [];
    var hitPaths = [];
    var byPath = {};
    var sheetsByPath = {};
    var i;
    for (i = 0; i < note.hits.length; i++) {
      var h = note.hits[i];
      if (!h || typeof h.path !== "string" || !isMintablePath(h.path)) continue;
      if (typeof h.sheet === "string" && h.sheet) {
        if (!byPath[h.path]) {
          byPath[h.path] = [];
          hitPaths.push(h.path);
        }
        if (!sheetsByPath[h.path]) sheetsByPath[h.path] = [];
        if (sheetsByPath[h.path].indexOf(h.sheet) === -1) sheetsByPath[h.path].push(h.sheet);
        continue;
      }
      var page = typeof h.page === "number" ? h.page : Number(h.page);
      if (!isFinite(page) || page <= 0) continue;
      page = Math.floor(page);
      if (!byPath[h.path]) {
        byPath[h.path] = [];
        hitPaths.push(h.path);
      }
      if (byPath[h.path].indexOf(page) === -1) byPath[h.path].push(page);
    }
    for (i = 0; i < hitPaths.length; i++) {
      var p = hitPaths[i];
      var sheets = sheetsByPath[p] || [];
      for (var sj = 0; sj < sheets.length; sj++) {
        out.push({ path: p, label: citationFileName(p) + " \xB7 " + sheets[sj] });
      }
      var pages = byPath[p].slice().sort(function(a, b) {
        return a - b;
      });
      for (var j = 0; j < pages.length; j++) {
        out.push({ path: p, page: pages[j], label: citationLabel(p, pages[j]) });
      }
    }
    for (i = 0; i < note.files.length; i++) {
      var f = note.files[i];
      if (typeof f !== "string" || !isMintablePath(f)) continue;
      if (byPath[f]) continue;
      var dup = false;
      for (var k = 0; k < out.length; k++) {
        if (out[k].path === f && out[k].page === void 0) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      out.push({ path: f, label: citationLabel(f) });
    }
    return out;
  }
  function isDataToolName(name) {
    return DATA_TOOL_NAMES.indexOf(name) !== -1;
  }
  function answerUsedNoDataTool(note) {
    if (!isRetrievalNote(note)) return false;
    if (note.web) return false;
    for (var i = 0; i < note.tools.length; i++) {
      if (isDataToolName(note.tools[i])) return false;
    }
    return true;
  }
  function retrievalNoteOfAnswer(msg) {
    if (!msg || msg.role !== "assistant") return null;
    if (msg.isError || msg.isPending || msg.isBackgroundTask || msg._streamPending) return null;
    return isRetrievalNote(msg._retrieval) ? msg._retrieval : null;
  }
  function citationLinkPart(citation, resolveFreshHref) {
    var expiredHref = buildDisplayExpiredAttachmentHref(citation.path, citation.label);
    var cached = resolveFreshHref ? resolveFreshHref(expiredHref) : void 0;
    return {
      type: "link",
      label: truncateLabelForDisplay(citation.label),
      fullLabel: citation.label,
      href: cached || expiredHref,
      expired: !cached,
      expiredHref,
      remotePath: citation.path
    };
  }

  // src/engine/download_encoding.ts
  var BOM = "\uFEFF";
  var BOM_EXTS = /* @__PURE__ */ new Set(["csv", "tsv", "tab", "txt", "text", "log"]);
  var HTML_EXTS = /* @__PURE__ */ new Set(["html", "htm", "xhtml"]);
  var XML_EXTS = /* @__PURE__ */ new Set(["xml", "svg", "rss", "atom", "xsl", "xslt", "plist", "kml"]);
  var RTF_EXTS = /* @__PURE__ */ new Set(["rtf"]);
  var EXT_CONTENT_TYPES = {
    csv: "text/csv; charset=utf-8",
    tsv: "text/tab-separated-values; charset=utf-8",
    tab: "text/tab-separated-values; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    text: "text/plain; charset=utf-8",
    log: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    markdown: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    jsonl: "application/x-ndjson; charset=utf-8",
    ndjson: "application/x-ndjson; charset=utf-8",
    geojson: "application/geo+json; charset=utf-8",
    yaml: "text/yaml; charset=utf-8",
    yml: "text/yaml; charset=utf-8",
    toml: "text/plain; charset=utf-8",
    ini: "text/plain; charset=utf-8",
    sql: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    xhtml: "application/xhtml+xml; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    ts: "text/plain; charset=utf-8",
    py: "text/x-python; charset=utf-8",
    sh: "text/x-shellscript; charset=utf-8",
    srt: "application/x-subrip; charset=utf-8",
    vtt: "text/vtt; charset=utf-8",
    ics: "text/calendar; charset=utf-8",
    vcf: "text/vcard; charset=utf-8",
    // RTF is 7-bit ASCII by specification, so it takes no charset parameter.
    rtf: "application/rtf",
    // Binary types the model can only ever REFERENCE, never author in a fence, but
    // which keep the type sensible if one ever shows up.
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp"
  };
  function normalizeExt(ext) {
    return String(ext || "").trim().replace(/^\./, "").toLowerCase();
  }
  function extOf(filename) {
    const name = String(filename || "");
    const dot = name.lastIndexOf(".");
    return dot > 0 ? normalizeExt(name.slice(dot + 1)) : "";
  }
  function encodingClassForExt(ext) {
    const e = normalizeExt(ext);
    if (BOM_EXTS.has(e)) return "bom";
    if (HTML_EXTS.has(e)) return "html";
    if (XML_EXTS.has(e)) return "xml";
    if (RTF_EXTS.has(e)) return "rtf";
    return "none";
  }
  function contentTypeForExt(ext, fallback = "text/plain; charset=utf-8") {
    return EXT_CONTENT_TYPES[normalizeExt(ext)] || fallback;
  }
  function hasBom(text) {
    return typeof text === "string" && text.charCodeAt(0) === 65279;
  }
  var HTML_HEAD_WINDOW = 4096;
  var META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i;
  var META_HTTP_EQUIV_RE = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/i;
  function ensureHtmlCharset(text) {
    const src = String(text == null ? "" : text);
    const head = src.slice(0, HTML_HEAD_WINDOW);
    const declared = META_CHARSET_RE.exec(head);
    if (declared) {
      if (declared[1].toLowerCase().replace(/[^a-z0-9]/g, "") === "utf8") return src;
      const start = declared.index + declared[0].length - declared[1].length;
      return src.slice(0, start) + "utf-8" + src.slice(start + declared[1].length);
    }
    const httpEquiv = META_HTTP_EQUIV_RE.exec(head);
    if (httpEquiv) {
      return src.slice(0, httpEquiv.index) + '<meta charset="utf-8">' + src.slice(httpEquiv.index + httpEquiv[0].length);
    }
    const tag = '<meta charset="utf-8">';
    const headOpen = /<head[^>]*>/i.exec(head);
    if (headOpen) {
      const at = headOpen.index + headOpen[0].length;
      return src.slice(0, at) + "\n" + tag + src.slice(at);
    }
    const htmlOpen = /<html[^>]*>/i.exec(head);
    if (htmlOpen) {
      const at = htmlOpen.index + htmlOpen[0].length;
      return src.slice(0, at) + "\n<head>" + tag + "</head>" + src.slice(at);
    }
    const doctype = /<!doctype[^>]*>/i.exec(head);
    if (doctype) {
      const at = doctype.index + doctype[0].length;
      return src.slice(0, at) + "\n" + tag + src.slice(at);
    }
    return tag + "\n" + src;
  }
  var XML_DECL_RE = /^\s*<\?xml\s[^?]*\?>/i;
  function ensureXmlEncoding(text) {
    const src = String(text == null ? "" : text);
    const decl = XML_DECL_RE.exec(src);
    if (!decl) return src;
    const found = /encoding\s*=\s*["']([^"']*)["']/i.exec(decl[0]);
    if (!found) return src;
    if (found[1].toLowerCase().replace(/[^a-z0-9]/g, "") === "utf8") return src;
    const fixedDecl = decl[0].slice(0, found.index) + found[0].replace(found[1], "UTF-8") + decl[0].slice(found.index + found[0].length);
    return fixedDecl + src.slice(decl[0].length);
  }
  var RTF_SIGNATURE_RE = /^[\s﻿]*\{\\rtf/i;
  function looksLikeRtf(text) {
    return RTF_SIGNATURE_RE.test(String(text == null ? "" : text));
  }
  function escapeRtfNonAscii(text) {
    const src = String(text == null ? "" : text);
    let out = "";
    let plainFrom = 0;
    for (let i = 0; i < src.length; i++) {
      const code = src.charCodeAt(i);
      if (code < 128) continue;
      out += src.slice(plainFrom, i);
      out += `\\u${code > 32767 ? code - 65536 : code}?`;
      plainFrom = i + 1;
    }
    return plainFrom === 0 ? src : out + src.slice(plainFrom);
  }
  function applyEncodingDeclaration(text, ext) {
    const src = String(text == null ? "" : text);
    switch (encodingClassForExt(ext)) {
      case "bom":
        return hasBom(src) ? src : BOM + src;
      case "html":
        return ensureHtmlCharset(src);
      case "xml":
        return ensureXmlEncoding(src);
      case "rtf":
        return looksLikeRtf(src) ? escapeRtfNonAscii(src) : hasBom(src) ? src : BOM + src;
      default:
        return src;
    }
  }
  function prepareDownloadText(filename, body) {
    const ext = extOf(filename);
    return {
      ext,
      text: applyEncodingDeclaration(body, ext),
      contentType: contentTypeForExt(ext)
    };
  }

  // src/engine/link_markup.ts
  function escapeInlineHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function(ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  var IMAGE_PREVIEWS_PER_MESSAGE = 8;
  var INLINE_LINK_GLYPH = "\u2197";
  var INLINE_LINK_UNAVAILABLE_GLYPH = "\u2715";
  var INLINE_LINK_UNAVAILABLE_SUFFIX = " (unavailable)";
  var FIT_LABEL_TAIL_CHARS = 8;
  function splitLabelForFit(name) {
    var chars = Array.from(String(name == null ? "" : name));
    var dot = -1;
    for (var i = chars.length - 1; i > 0; i--) {
      if (chars[i] === ".") {
        dot = i;
        break;
      }
      if (chars[i] === " " || chars[i] === "/" || chars.length - i > 10) break;
    }
    var extStart = dot > 0 && dot < chars.length - 1 ? dot : chars.length;
    var tailStart = Math.max(0, extStart - FIT_LABEL_TAIL_CHARS);
    if (tailStart < 4) return { stem: chars.join(""), tail: "" };
    return { stem: chars.slice(0, tailStart).join(""), tail: chars.slice(tailStart).join("") };
  }
  function renderInlineLinkHtml(link, opts) {
    var o = opts || {};
    var unavailable = !!o.unavailable;
    var refreshing = !unavailable && !!o.refreshing;
    var full = link.fullLabel || link.label;
    var preview = !!link.image && !!link.remotePath && o.allowImagePreview !== false && !unavailable;
    var cls = ["bq-link-button"];
    if (link.expired) cls.push("is-expired");
    if (refreshing) cls.push("is-refreshing");
    if (unavailable) cls.push("is-unavailable");
    if (preview) cls.push("is-image-preview");
    var glyphHtml = '<span class="bq-link-glyph" translate="no">' + (unavailable ? INLINE_LINK_UNAVAILABLE_GLYPH : INLINE_LINK_GLYPH) + "</span>";
    var stateSuffix = unavailable ? INLINE_LINK_UNAVAILABLE_SUFFIX : refreshing ? " (fetching...)" : "";
    var fit = !!o.fitLabel && !preview;
    if (fit) cls.push("bq-link-fit");
    var labelHtml;
    if (fit) {
      var split = splitLabelForFit(full);
      labelHtml = glyphHtml + '<span class="bq-link-stem">' + escapeInlineHtml(split.stem) + "</span>" + (split.tail ? '<span class="bq-link-tail">' + escapeInlineHtml(split.tail) + "</span>" : "") + (stateSuffix ? '<span class="bq-link-tail">' + escapeInlineHtml(stateSuffix) + "</span>" : "");
    } else {
      labelHtml = glyphHtml + escapeInlineHtml(link.label + stateSuffix);
    }
    var attrs = ['class="' + cls.join(" ") + '"'];
    if (unavailable) attrs.push('aria-disabled="true"', 'data-bq-unavailable="1"');
    else attrs.push('href="' + escapeInlineHtml(link.href) + '"', 'target="_blank"', 'rel="noopener noreferrer"');
    attrs.push('title="' + escapeInlineHtml(unavailable ? full + INLINE_LINK_UNAVAILABLE_SUFFIX : full) + '"');
    if (!preview && !unavailable) attrs.push('download="' + escapeInlineHtml(full) + '"');
    attrs.push('data-bq-link="1"');
    if (link.expired && !unavailable) attrs.push('data-bq-expired="1"');
    if (link.expiredHref) attrs.push('data-bq-expired-href="' + escapeInlineHtml(link.expiredHref) + '"');
    if (link.remotePath) attrs.push('data-bq-remote-path="' + escapeInlineHtml(link.remotePath) + '"');
    if (link.fullLabel) attrs.push('data-bq-full-label="' + escapeInlineHtml(link.fullLabel) + '"');
    if (!preview) return "<a " + attrs.join(" ") + ">" + labelHtml + "</a>";
    return "<a " + attrs.join(" ") + '><img class="bq-img-preview" alt="' + escapeInlineHtml(full) + '" data-bq-img-path="' + escapeInlineHtml(link.remotePath || "") + '" data-bq-img-type="' + escapeInlineHtml(link.image ? link.image.contentType : "") + '" decoding="async"><span class="bq-loader" data-bq-img-loader="1"></span><span class="bq-img-preview-caption" translate="no">' + labelHtml + "</span></a>";
  }

  // src/engine/image_preview.ts
  var previewUrlCache = /* @__PURE__ */ Object.create(null);
  var previewInFlight = /* @__PURE__ */ Object.create(null);
  function cacheKey(scope, path) {
    return scope + "\0" + path;
  }
  function clearImagePreviewCache(scope) {
    var prefix = scope + "\0";
    for (var k in previewUrlCache) if (k.indexOf(prefix) === 0) delete previewUrlCache[k];
    for (var f in previewInFlight) if (f.indexOf(prefix) === 0) delete previewInFlight[f];
    for (var s in staleImagePreviews) if (s.indexOf(prefix) === 0) delete staleImagePreviews[s];
  }
  function peekImagePreviewUrl(ctx, remotePath) {
    var hit = previewUrlCache[cacheKey(ctx.scope, remotePath)];
    if (!hit) return null;
    if (Date.now() - hit.at >= LINK_REFRESH_WINDOW_MS) return null;
    var dies = presignExpiryEpochMs(hit.url);
    if (dies !== null && Date.now() >= dies - PRESIGN_SAFETY_MARGIN_MS) return null;
    return hit.url;
  }
  function resolveImagePreviewUrl(ctx, remotePath, contentType, refresh) {
    var key = cacheKey(ctx.scope, remotePath);
    if (staleImagePreviews[key]) {
      delete staleImagePreviews[key];
      refresh = true;
    }
    if (refresh) {
      delete previewUrlCache[key];
      delete previewInFlight[key];
    } else {
      var warm = peekImagePreviewUrl(ctx, remotePath);
      if (warm) return Promise.resolve(warm);
      var flight = previewInFlight[key];
      if (flight) return flight;
    }
    var run = ctx.mint(remotePath, contentType, refresh).then(function(url) {
      if (previewInFlight[key] === run) {
        previewUrlCache[key] = { url, at: Date.now() };
        delete previewInFlight[key];
      }
      return url;
    }, function(e) {
      if (previewInFlight[key] === run) delete previewInFlight[key];
      throw e;
    });
    previewInFlight[key] = run;
    return run;
  }
  function markImagePreviewStale(scope, remotePath) {
    if (!remotePath) return;
    staleImagePreviews[cacheKey(scope, remotePath)] = true;
    delete previewUrlCache[cacheKey(scope, remotePath)];
  }
  var staleImagePreviews = /* @__PURE__ */ Object.create(null);
  function hydrateImagePreviews(imgs, ctx) {
    for (var i = 0; i < imgs.length; i++) hydrateOne(imgs[i], ctx);
  }
  function hydrateOne(img, ctx) {
    if (img.getAttribute("data-bq-img-state")) return;
    var path = img.getAttribute("data-bq-img-path");
    var type = img.getAttribute("data-bq-img-type") || "";
    if (!path) {
      img.setAttribute("data-bq-img-state", "error");
      return;
    }
    img.setAttribute("data-bq-img-state", "loading");
    img.addEventListener("load", function() {
      img.setAttribute("data-bq-img-state", "ready");
      img.removeAttribute("data-bq-img-retry");
      if (ctx.onLoad) ctx.onLoad(path);
    });
    img.addEventListener("error", function() {
      onImageError(img, ctx, path, type);
    });
    var warm = peekImagePreviewUrl(ctx, path);
    if (warm) {
      img.setAttribute("src", warm);
      notifyLayoutChange(img, ctx, path);
      return;
    }
    resolveImagePreviewUrl(ctx, path, type).then(function(url) {
      if (img.getAttribute("data-bq-img-state") !== "loading") return;
      img.setAttribute("src", url);
      notifyLayoutChange(img, ctx, path);
    }, function(e) {
      img.setAttribute("data-bq-img-state", "error");
      notifyLayoutChange(img, ctx, path);
      if (ctx.onError) ctx.onError(path, e);
    });
  }
  function onImageError(img, ctx, path, type) {
    if (img.getAttribute("data-bq-img-retry") === "1") {
      img.setAttribute("data-bq-img-state", "error");
      notifyLayoutChange(img, ctx, path);
      if (ctx.onError) ctx.onError(path, new Error("image preview failed to load"));
      return;
    }
    img.setAttribute("data-bq-img-retry", "1");
    img.removeAttribute("src");
    notifyLayoutChange(img, ctx, path);
    resolveImagePreviewUrl(ctx, path, type, true).then(function(url) {
      img.setAttribute("src", url);
      notifyLayoutChange(img, ctx, path);
    }, function(e) {
      img.setAttribute("data-bq-img-state", "error");
      notifyLayoutChange(img, ctx, path);
      if (ctx.onError) ctx.onError(path, e);
    });
  }
  function notifyLayoutChange(img, ctx, path) {
    if (!ctx.onLayoutChange) return;
    ctx.onLayoutChange(previewLayoutBox(img), path);
  }
  var PREVIEW_LAYOUT_BOX_SELECTOR = "a.bq-link-button.is-image-preview";
  function previewLayoutBox(img) {
    var closest = img.closest;
    if (typeof closest !== "function") return img;
    return closest.call(img, PREVIEW_LAYOUT_BOX_SELECTOR) || img;
  }

  // src/engine/ai_agent.ts
  function normalizePlatform(raw) {
    var p = (raw || "").trim().toLowerCase();
    return p === "claude" || p === "openai" ? p : null;
  }
  function parseAiAgentValue(value) {
    var raw = (value || "").trim();
    if (!raw || raw.toLowerCase() === "none") {
      return { platform: null, model: "", contextWindow: null, hasPlatform: false };
    }
    var firstHash = raw.indexOf("#");
    if (firstHash === -1) {
      var only = normalizePlatform(raw);
      return { platform: only, model: "", contextWindow: null, hasPlatform: !!only };
    }
    var platform = normalizePlatform(raw.slice(0, firstHash));
    var rest = raw.slice(firstHash + 1);
    var secondHash = rest.indexOf("#");
    var model = (secondHash === -1 ? rest : rest.slice(0, secondHash)).trim();
    var windowRaw = secondHash === -1 ? "" : rest.slice(secondHash + 1).trim();
    var parsedWindow = windowRaw ? Number(windowRaw) : NaN;
    var contextWindow = Number.isFinite(parsedWindow) && parsedWindow > 0 ? Math.floor(parsedWindow) : null;
    return { platform, model, contextWindow, hasPlatform: !!platform };
  }

  // src/engine/sse.ts
  var CLAUDE_EVENTS = {
    message_start: true,
    message_delta: true,
    message_stop: true,
    content_block_start: true,
    content_block_delta: true,
    content_block_stop: true,
    ping: true
  };
  var CLAUDE_TOOL_BLOCKS = {
    tool_use: true,
    server_tool_use: true,
    mcp_tool_use: true,
    web_search_tool_use: true
  };
  var OPENAI_TOOL_ITEMS = {
    function_call: true,
    mcp_call: true,
    web_search_call: true,
    file_search_call: true,
    code_interpreter_call: true,
    computer_call: true,
    image_generation_call: true
  };
  function detectProvider(type) {
    if (!type) return null;
    if (type.indexOf("response.") === 0) return "openai";
    if (CLAUDE_EVENTS[type]) return "claude";
    return null;
  }
  function lineEnd(s, from) {
    for (var i = from; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 10) return { at: i, len: 1 };
      if (c === 13) {
        if (i + 1 >= s.length) return null;
        return { at: i, len: s.charCodeAt(i + 1) === 10 ? 2 : 1 };
      }
    }
    return null;
  }
  function readFrame(lines) {
    var event = "";
    var data = [];
    var framed = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.length) continue;
      if (line.charCodeAt(0) === 58) {
        framed = true;
        continue;
      }
      var colon = line.indexOf(":");
      var field = colon === -1 ? line : line.slice(0, colon);
      var value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
      if (field === "data") {
        framed = true;
        data.push(value);
      } else if (field === "event") {
        framed = true;
        event = value;
      } else if (field === "id" || field === "retry") {
        framed = true;
      }
    }
    return { event, data: data.join("\n"), framed };
  }
  function createSseParser() {
    var buf = "";
    var lines = [];
    var lastSeq = 0;
    var sawFraming = false;
    var raw = "";
    var rawHasContent = false;
    var ended = false;
    var rawParsed = false;
    var rawBody = null;
    var provider = null;
    var terminalEvent = null;
    var errored = false;
    var error = null;
    var stopReason = null;
    var toolCalls = [];
    var malformedFrames = 0;
    var malformedToolJson = 0;
    var message = null;
    var blocks = /* @__PURE__ */ new Map();
    var parts = /* @__PURE__ */ new Map();
    var reasoning = /* @__PURE__ */ new Map();
    var response = null;
    var textCache = null;
    var thinkingCache = null;
    function feed(text) {
      if (typeof text !== "string" || !text.length) return;
      if (!sawFraming) {
        raw += text;
        if (!rawHasContent) rawHasContent = /\S/.test(text);
        rawParsed = false;
        rawBody = null;
      }
      buf += text;
      var i = 0;
      for (; ; ) {
        var end2 = lineEnd(buf, i);
        if (!end2) break;
        var line = buf.slice(i, end2.at);
        i = end2.at + end2.len;
        if (line.length === 0) dispatch();
        else lines.push(line);
      }
      if (i > 0) buf = buf.slice(i);
    }
    function feedChunks(chunks) {
      if (!chunks || !chunks.length) return;
      for (var i = 0; i < chunks.length; i++) {
        var c = chunks[i];
        if (!c || typeof c !== "object") continue;
        var seq = typeof c.seq === "number" ? c.seq : 0;
        if (seq && seq <= lastSeq) continue;
        if (seq > lastSeq) lastSeq = seq;
        feed(typeof c.txt === "string" ? c.txt : "");
      }
    }
    function end() {
      if (buf.length) {
        var tail = buf.charCodeAt(buf.length - 1) === 13 ? buf.slice(0, -1) : buf;
        if (tail.length) lines.push(tail);
        buf = "";
      }
      if (lines.length) dispatch();
      ended = true;
    }
    function isUnframed() {
      return ended && !sawFraming && rawHasContent;
    }
    function dispatch() {
      var pending = lines;
      lines = [];
      if (!pending.length) return;
      try {
        var frame = readFrame(pending);
        if (frame.framed && !sawFraming) {
          sawFraming = true;
          raw = "";
          rawHasContent = false;
        }
        if (!frame.data.length) return;
        if (frame.data === "[DONE]") return;
        var ev = JSON.parse(frame.data);
        if (!ev || typeof ev !== "object") {
          malformedFrames++;
          return;
        }
        var type = typeof ev.type === "string" && ev.type ? ev.type : frame.event;
        if (!type) {
          malformedFrames++;
          return;
        }
        if (!provider) provider = detectProvider(type);
        if (provider === "openai") handleOpenAI(type, ev);
        else if (provider === "claude") handleClaude(type, ev);
        else handleUnattributed(type, ev);
      } catch (e) {
        malformedFrames++;
      }
    }
    function handleUnattributed(type, ev) {
      if (type === "error") {
        takeError(ev && ev.error ? ev : { type: "error", error: ev });
        return;
      }
      malformedFrames++;
    }
    function takeError(payload) {
      errored = true;
      terminalEvent = "error";
      error = payload;
    }
    function handleClaude(type, ev) {
      if (type === "ping") return;
      if (type === "error") {
        takeError({ type: "error", error: ev && ev.error ? ev.error : ev });
        return;
      }
      if (type === "message_start") {
        message = ev && ev.message ? shallowClone(ev.message) : { type: "message", role: "assistant" };
        if (typeof message.stop_reason === "string") stopReason = message.stop_reason;
        return;
      }
      if (type === "content_block_start") {
        var idx = numberOr(ev.index, -1);
        if (idx < 0) {
          malformedFrames++;
          return;
        }
        var block = ev.content_block ? shallowClone(ev.content_block) : {};
        blocks.set(idx, { block, json: "", sawJson: false });
        invalidate();
        if (block && typeof block.type === "string" && CLAUDE_TOOL_BLOCKS[block.type]) {
          var call = {
            index: idx,
            name: typeof block.name === "string" && block.name ? block.name : block.type,
            type: block.type
          };
          if (typeof block.server_name === "string") call.serverName = block.server_name;
          toolCalls.push(call);
        }
        return;
      }
      if (type === "content_block_delta") {
        var i = numberOr(ev.index, -1);
        var d = ev.delta;
        if (i < 0 || !d || typeof d !== "object") {
          malformedFrames++;
          return;
        }
        var st = blocks.get(i);
        if (!st) {
          st = { block: { type: deltaBlockType(d.type) }, json: "", sawJson: false };
          blocks.set(i, st);
        }
        applyClaudeDelta(st, d);
        invalidate();
        return;
      }
      if (type === "content_block_stop") {
        var j = numberOr(ev.index, -1);
        var s = j >= 0 ? blocks.get(j) : void 0;
        if (s && s.sawJson) finishToolJson(s);
        return;
      }
      if (type === "message_delta") {
        if (!message) message = { type: "message", role: "assistant" };
        var delta = ev.delta;
        if (delta && typeof delta === "object") {
          for (var k in delta) {
            if (Object.prototype.hasOwnProperty.call(delta, k)) message[k] = delta[k];
          }
          if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        }
        if (ev.usage && typeof ev.usage === "object") {
          message.usage = mergeInto(shallowClone(message.usage) || {}, ev.usage);
        }
        return;
      }
      if (type === "message_stop") {
        terminalEvent = "message_stop";
        return;
      }
      malformedFrames++;
    }
    function applyClaudeDelta(st, d) {
      var t = d.type;
      if (t === "text_delta") {
        st.block.text = (st.block.text || "") + str(d.text);
        return;
      }
      if (t === "thinking_delta") {
        st.block.thinking = (st.block.thinking || "") + str(d.thinking);
        return;
      }
      if (t === "signature_delta") {
        st.block.signature = (st.block.signature || "") + str(d.signature);
        return;
      }
      if (t === "input_json_delta") {
        st.json += str(d.partial_json);
        st.sawJson = true;
        return;
      }
      if (t === "citations_delta") {
        if (d.citation) {
          if (!Array.isArray(st.block.citations)) st.block.citations = [];
          st.block.citations.push(d.citation);
        }
        return;
      }
      malformedFrames++;
    }
    function finishToolJson(st) {
      if (!st.json.length) {
        return;
      }
      try {
        st.block.input = JSON.parse(st.json);
      } catch (e) {
        malformedToolJson++;
      }
    }
    function deltaBlockType(deltaType) {
      if (deltaType === "thinking_delta" || deltaType === "signature_delta") return "thinking";
      if (deltaType === "input_json_delta") return "tool_use";
      return "text";
    }
    function handleOpenAI(type, ev) {
      if (type === "response.output_text.delta") {
        putPart(ev, str(ev.delta), false);
        invalidate();
        return;
      }
      if (type === "response.output_text.done") {
        if (typeof ev.text === "string") {
          putPart(ev, ev.text, true);
          invalidate();
        }
        return;
      }
      if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
        putReasoning(type, ev, str(ev.delta), false);
        invalidate();
        return;
      }
      if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_text.done") {
        if (typeof ev.text === "string") {
          putReasoning(type, ev, ev.text, true);
          invalidate();
        }
        return;
      }
      if (type === "response.output_item.added") {
        var item = ev.item;
        if (item && typeof item.type === "string" && OPENAI_TOOL_ITEMS[item.type]) {
          toolCalls.push({
            index: numberOr(ev.output_index, toolCalls.length),
            // A built-in tool (web_search_call) has no name of its own, so the item
            // type is the only label there is and a row can still be drawn.
            name: typeof item.name === "string" && item.name ? item.name : item.type,
            type: item.type
          });
        }
        return;
      }
      if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
        terminalEvent = type;
        if (ev.response && typeof ev.response === "object") {
          response = ev.response;
          var st = response.status;
          if (st === "incomplete") {
            var reason = response.incomplete_details && response.incomplete_details.reason;
            stopReason = typeof reason === "string" && reason ? reason : "incomplete";
          } else if (typeof st === "string" && st) {
            stopReason = st;
          }
          if (response.error && (response.error.message || response.error.code)) {
            errored = true;
            error = response;
          }
        }
        if (type === "response.failed") errored = true;
        return;
      }
      if (type === "response.error" || type === "error") {
        takeError(ev && ev.error ? ev : { type: "error", error: ev });
        return;
      }
    }
    function putReasoning(type, ev, text, replace) {
      var summary = type.indexOf("response.reasoning_summary_text.") === 0;
      var oi = numberOr(ev.output_index, 0);
      var idx = numberOr(summary ? ev.summary_index : ev.content_index, 0);
      var key = oi + ":" + (summary ? "s" : "r") + ":" + idx;
      var r = reasoning.get(key);
      if (!r) {
        r = { oi, idx, kind: summary ? 0 : 1, text: "" };
        reasoning.set(key, r);
      }
      r.text = replace ? text : r.text + text;
    }
    function putPart(ev, text, replace) {
      var oi = numberOr(ev.output_index, 0);
      var ci = numberOr(ev.content_index, 0);
      var key = oi + ":" + ci;
      var p = parts.get(key);
      if (!p) {
        p = { oi, ci, text: "" };
        parts.set(key, p);
      }
      p.text = replace ? text : p.text + text;
    }
    function invalidate() {
      textCache = null;
      thinkingCache = null;
    }
    function claudeTextBlocks() {
      return orderedBlocks().filter(function(b) {
        return b && b.type === "text";
      });
    }
    function orderedBlocks() {
      var idx = [];
      blocks.forEach(function(_v, k) {
        idx.push(k);
      });
      idx.sort(function(a, b) {
        return a - b;
      });
      var out = [];
      for (var i = 0; i < idx.length; i++) out.push(blocks.get(idx[i]).block);
      return out;
    }
    function orderedParts() {
      var out = [];
      parts.forEach(function(p) {
        out.push(p);
      });
      out.sort(function(a, b) {
        return a.oi !== b.oi ? a.oi - b.oi : a.ci - b.ci;
      });
      return out;
    }
    function currentText() {
      if (textCache !== null) return textCache;
      var out;
      if (provider === "openai") {
        out = orderedParts().map(function(p) {
          return p.text;
        }).join("\n");
      } else {
        out = claudeTextBlocks().map(function(b) {
          return b.text || "";
        }).join("\n");
      }
      textCache = out;
      return out;
    }
    function currentThinking() {
      if (thinkingCache !== null) return thinkingCache;
      var out;
      if (provider === "openai") {
        var rs = [];
        reasoning.forEach(function(r) {
          rs.push(r);
        });
        rs.sort(function(a, b) {
          if (a.oi !== b.oi) return a.oi - b.oi;
          if (a.idx !== b.idx) return a.idx - b.idx;
          return a.kind - b.kind;
        });
        out = rs.map(function(r) {
          return r.text;
        }).join("\n");
      } else {
        out = orderedBlocks().filter(function(b) {
          return b && b.type === "thinking";
        }).map(function(b) {
          return b.thinking || "";
        }).join("\n");
      }
      thinkingCache = out;
      return out;
    }
    function buildBody() {
      if (provider === "openai") {
        if (response) return response;
      } else if (blocks.size || message) {
        var base = message ? shallowClone(message) : { type: "message", role: "assistant" };
        base.content = orderedBlocks();
        return base;
      }
      if (errored && error) return error;
      return unframedBody();
    }
    function unframedBody() {
      if (!isUnframed()) return null;
      if (rawParsed) return rawBody;
      rawParsed = true;
      try {
        var v = JSON.parse(raw);
        rawBody = v && typeof v === "object" ? v : null;
      } catch (e) {
        rawBody = null;
      }
      return rawBody;
    }
    function snapshot() {
      return {
        provider,
        text: currentText(),
        thinkingText: currentThinking(),
        toolCalls: toolCalls.slice(),
        toolNames: toolCalls.map(function(t) {
          return t.name;
        }),
        stopReason,
        complete: terminalEvent !== null,
        // A terminal event that ENDED the answer rather than KILLED it. The
        // `errored` term covers all three ways a stream dies with a terminal event
        // on it: an Anthropic or OpenAI `error` frame (takeError sets both), a
        // response.failed, and a response.completed/incomplete whose Response
        // object carries an error payload. See the field's own doc for the loss
        // this separation prevents.
        answerComplete: terminalEvent !== null && terminalEvent !== "error" && !errored,
        terminalEvent,
        errored,
        error,
        malformedFrames,
        malformedToolJson,
        unframed: isUnframed(),
        unframedText: isUnframed() ? raw : null,
        lastSeq
      };
    }
    return {
      feed,
      feedChunks,
      end,
      snapshot,
      finalBody: buildBody
    };
  }
  function str(v) {
    return typeof v === "string" ? v : "";
  }
  function numberOr(v, fallback) {
    return typeof v === "number" && isFinite(v) ? v : fallback;
  }
  function shallowClone(o) {
    if (!o || typeof o !== "object") return o;
    var out = Array.isArray(o) ? o.slice() : {};
    if (!Array.isArray(o)) {
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
      }
    }
    return out;
  }
  function mergeInto(target, src) {
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  // src/engine/history.ts
  function filterListByClearHorizon(list, clearedAt) {
    if (!clearedAt) return list;
    return list.filter(function(item) {
      var updated = Number(item && item.updated);
      return isFinite(updated) && updated > clearedAt;
    });
  }
  function normalizeTextContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(function(part) {
        if (typeof part === "string") return part;
        if (part && (part.type === "text" || part.type === "input_text" || part.type === "output_text")) return part.text || "";
        return "";
      }).join("\n").trim();
    }
    return "";
  }
  function extractLastUserTextFromRequest(requestBody) {
    var arr = requestBody && Array.isArray(requestBody.messages) ? requestBody.messages : requestBody && Array.isArray(requestBody.input) ? requestBody.input : [];
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].role === "user") {
        var t = normalizeTextContent(arr[i].content);
        if (t) return t;
      }
    }
    return "";
  }
  function listedRequestText(item) {
    if (item && typeof item.request_text === "string") return item.request_text;
    return extractLastUserTextFromRequest(item && item.request_body);
  }
  function isIndexingRequestText(userText) {
    if (typeof userText !== "string") return false;
    return userText.indexOf("A new file has just been uploaded") === 0 || userText.indexOf("CONTINUE indexing") === 0;
  }
  function parseIndexingRequestText(userText) {
    if (typeof userText !== "string" || !userText) return null;
    var nameMatch = userText.match(/^- name: (.+)$/m);
    if (!nameMatch) return null;
    var mimeMatch = userText.match(/^- mime type: (.+)$/m);
    var sizeMatch = userText.match(/^- size \(bytes\): (\d+)$/m);
    var pathMatch = userText.match(/^- storage path: (.+)$/m);
    return {
      name: nameMatch[1].trim(),
      path: pathMatch ? pathMatch[1].trim() : void 0,
      mime: mimeMatch ? mimeMatch[1].trim() : void 0,
      size: sizeMatch ? Number(sizeMatch[1]) : void 0,
      continued: userText.indexOf("CONTINUE indexing") === 0
    };
  }
  var LIVE_INDEX_PROBE_LIMIT = 20;
  var BG_PROBE_TTL_MS = 4e3;
  var bgProbeCache = {};
  var bgProbeInflight = {};
  function probeBgQueue(params, opts) {
    const key = [params.service, params.owner, params.platform, params.queue, params.status, params.limit].join("|");
    const maxAge = opts && typeof opts.maxAgeMs === "number" ? opts.maxAgeMs : 0;
    const cached = bgProbeCache[key];
    if (maxAge > 0 && cached && Date.now() - cached.at < maxAge) {
      return Promise.resolve(cached);
    }
    const inflight = bgProbeInflight[key];
    if (inflight) return inflight;
    const p = Promise.resolve(getChatHistory(
      { service: params.service, owner: params.owner, platform: params.platform, queue: params.queue, status: params.status, compact: true, queue_exact: true },
      { limit: params.limit, fetchMore: false }
    )).then(function(result) {
      const entry2 = { result, at: Date.now() };
      bgProbeCache[key] = entry2;
      return entry2;
    });
    bgProbeInflight[key] = p;
    p.then(function() {
      delete bgProbeInflight[key];
    }, function() {
      delete bgProbeInflight[key];
    });
    return p;
  }
  async function fetchLiveIndexingKeys(params, opts) {
    const queue = bgIndexingQueueName(params.userId, params.service);
    const base = { service: params.service, owner: params.owner, platform: params.platform, queue };
    const maxAgeMs = opts && typeof opts.maxAgeMs === "number" ? opts.maxAgeMs : BG_PROBE_TTL_MS;
    const [pending, running] = await Promise.all([
      probeBgQueue({ ...base, status: "pending", limit: LIVE_INDEX_PROBE_LIMIT }, { maxAgeMs }),
      probeBgQueue({ ...base, status: "running", limit: LIVE_INDEX_PROBE_LIMIT }, { maxAgeMs })
    ]);
    const keys = /* @__PURE__ */ new Set();
    let truncated = false;
    for (const entry2 of [pending, running]) {
      const res = entry2.result;
      const list = res && Array.isArray(res.list) ? res.list : [];
      if (list.length >= LIVE_INDEX_PROBE_LIMIT || res && res.endOfList === false) truncated = true;
      for (const item of list) {
        const text = listedRequestText(item);
        if (!text || !isIndexingRequestText(text)) continue;
        const ref = parseIndexingRequestText(text);
        if (!ref) continue;
        if (ref.path) keys.add(ref.path);
        if (ref.name) keys.add(ref.name);
      }
    }
    return { keys, checked: !truncated, at: Math.min(pending.at, running.at) };
  }
  var BG_COVERAGE_MAX_PAGES = 2;
  var splitHistoryStates = {};
  var splitHistoryLocks = {};
  function freshSplitState() {
    return { bgBuffer: [], bgEnd: false, bgStarted: false, surfaceEnd: false, pendingSurface: null, surfaceCarry: [], lastSurfaceKeys: [], newestBgId: "" };
  }
  function noteBgIds(state, list) {
    for (const it of list) {
      const id = it && typeof it.id === "string" ? it.id : "";
      if (id && id > state.newestBgId) state.newestBgId = id;
    }
  }
  var createdOf = (it) => {
    const c = Number(it && it.created);
    return isFinite(c) && c > 0 ? c : NaN;
  };
  var oldestCreated = (lst) => {
    let m = Infinity;
    for (const it of lst) {
      const c = createdOf(it);
      if (!isNaN(c) && c < m) m = c;
    }
    return m;
  };
  var SURFACE_EMPTY_MAX_PAGES = 10;
  async function getSplitChatHistory(params, fetchOptions, _fetchImpl) {
    const key = [params.service, params.owner, params.platform, params.userId || ""].join("|");
    const prev = splitHistoryLocks[key] || Promise.resolve();
    let releaseLock;
    const lockTail = new Promise((r) => {
      releaseLock = r;
    });
    const run = () => _getSplitChatHistoryLocked(key, params, fetchOptions, releaseLock);
    const p = prev.then(run, run);
    p.then((res) => {
      if (!res || !res.bgPending) releaseLock();
    }, () => releaseLock());
    splitHistoryLocks[key] = p.then(() => lockTail, () => lockTail);
    return p;
  }
  async function _getSplitChatHistoryLocked(key, params, fetchOptions, releaseLock, _fetchImpl) {
    const fetch2 = getChatHistory;
    const bgQueue = bgIndexingQueueName(params.userId, params.service);
    const base = { service: params.service, owner: params.owner, platform: params.platform };
    const surfaceScope = params.scopeSurfaceToQueue && params.userId ? { queue: params.userId, queue_exact: true } : { queue_exclude: bgQueue };
    const fetchMore = !!(fetchOptions && fetchOptions.fetchMore);
    const limit = fetchOptions && fetchOptions.limit;
    const firstLoad = !splitHistoryStates[key];
    let headRefresh = false;
    if (!splitHistoryStates[key]) {
      splitHistoryStates[key] = freshSplitState();
    } else if (!fetchMore) {
      const prev = splitHistoryStates[key];
      if (prev.surfaceEnd && prev.bgEnd) {
        headRefresh = true;
        prev.pendingSurface = null;
        prev.surfaceCarry = [];
        prev.bgBuffer = [];
      } else {
        splitHistoryStates[key] = freshSplitState();
      }
    }
    const state = splitHistoryStates[key];
    const skipBg = !!params.skipBg;
    if (skipBg) {
      state.bgEnd = true;
      state.bgBuffer = [];
    }
    if (state.pendingSurface && state.pendingSurface.forFetchMore !== fetchMore) {
      state.pendingSurface = null;
    }
    if (!state.pendingSurface) {
      if (state.surfaceEnd && !headRefresh) {
        state.pendingSurface = { list: [], endOfList: true, startKeyHistory: state.lastSurfaceKeys, forFetchMore: fetchMore };
      } else {
        const sOpts = { fetchMore };
        if (limit) sOpts.limit = limit;
        let s = await fetch2({ ...base, ...surfaceScope }, sOpts);
        let hops = 0;
        while (s && !s.endOfList && !(s.list || []).length && hops < SURFACE_EMPTY_MAX_PAGES) {
          hops++;
          const nOpts = { fetchMore: true };
          if (limit) nOpts.limit = limit;
          s = await fetch2({ ...base, ...surfaceScope }, nOpts);
        }
        state.pendingSurface = {
          list: s && Array.isArray(s.list) ? s.list : [],
          endOfList: !!(s && s.endOfList),
          startKeyHistory: s && Array.isArray(s.startKeyHistory) ? s.startKeyHistory : [],
          forFetchMore: fetchMore
        };
      }
    }
    const surface = state.pendingSurface;
    if (fetchOptions && fetchOptions.deferBg && !skipBg && (!state.bgEnd || headRefresh)) {
      const surfaceList0 = state.surfaceCarry.length ? state.surfaceCarry.concat(surface.list) : surface.list.slice();
      state.surfaceCarry = [];
      const emitNow = surfaceList0.concat(state.bgBuffer);
      state.bgBuffer = [];
      if (!headRefresh) state.surfaceEnd = surface.endOfList;
      state.lastSurfaceKeys = surface.startKeyHistory;
      state.pendingSurface = null;
      const bgPending = (async () => {
        try {
          const batch = [];
          if (headRefresh) {
            const bOpts = { fetchMore: false };
            if (limit) bOpts.limit = limit;
            const b = await fetch2({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
            const bList = b && Array.isArray(b.list) ? b.list : [];
            for (const it of bList) {
              if (it && typeof it === "object") it._fromBgChain = true;
              batch.push(it);
            }
            const prevNewest = state.newestBgId;
            noteBgIds(state, bList);
            if (prevNewest && !(b && b.endOfList) && !bList.some((it) => it && it.id === prevNewest)) {
              state.bgEnd = false;
              state.bgStarted = true;
            }
          } else {
            let hops = 0;
            while (!state.bgEnd && hops < BG_COVERAGE_MAX_PAGES) {
              hops++;
              const bOpts = { fetchMore: state.bgStarted };
              if (limit) bOpts.limit = limit;
              const b = await fetch2({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
              state.bgStarted = true;
              const bList = b && Array.isArray(b.list) ? b.list : [];
              for (const it of bList) {
                if (it && typeof it === "object") it._fromBgChain = true;
                batch.push(it);
              }
              noteBgIds(state, bList);
              state.bgEnd = !!(b && b.endOfList);
              if (!bList.length && !state.bgEnd) break;
              if (state.bgEnd) break;
            }
          }
          return { list: batch, endOfList: state.surfaceEnd && state.bgEnd };
        } finally {
          releaseLock();
        }
      })();
      return {
        list: emitNow,
        // A head-refreshed ended chain KNOWS it is still ended — reporting
        // the hardcoded false here was what un-gated the fill loop on every
        // tab return. Mid-walk it computes to false exactly as before (this
        // branch is only entered with bgEnd false then); the bg batch still
        // carries the final word for that case.
        endOfList: state.surfaceEnd && state.bgEnd,
        startKeyHistory: surface.startKeyHistory,
        firstLoad,
        bgPending
      };
    }
    const surfaceList = state.surfaceCarry.length ? state.surfaceCarry.concat(surface.list) : surface.list.slice();
    const boundary = surface.endOfList ? -Infinity : oldestCreated(surfaceList);
    if (skipBg) ; else if (headRefresh) {
      const hOpts = { fetchMore: false };
      if (limit) hOpts.limit = limit;
      const hb = await fetch2({ ...base, queue: bgQueue, queue_exact: true, compact: true }, hOpts);
      const hbList = hb && Array.isArray(hb.list) ? hb.list : [];
      for (const it of hbList) {
        if (it && typeof it === "object") it._fromBgChain = true;
        state.bgBuffer.push(it);
      }
      const prevNewestH = state.newestBgId;
      noteBgIds(state, hbList);
      if (prevNewestH && !(hb && hb.endOfList) && !hbList.some((it) => it && it.id === prevNewestH)) {
        state.bgEnd = false;
        state.bgStarted = true;
      }
    } else if (boundary !== Infinity || surface.endOfList) {
      let hops = 0;
      while (!state.bgEnd && hops < BG_COVERAGE_MAX_PAGES) {
        const bufOldest = state.bgBuffer.length ? oldestCreated(state.bgBuffer) : Infinity;
        if (state.bgBuffer.length && bufOldest <= boundary) break;
        hops++;
        const bOpts = { fetchMore: state.bgStarted };
        if (limit) bOpts.limit = limit;
        const b = await fetch2({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
        state.bgStarted = true;
        const bList = b && Array.isArray(b.list) ? b.list : [];
        for (const it of bList) {
          if (it && typeof it === "object") it._fromBgChain = true;
          state.bgBuffer.push(it);
        }
        noteBgIds(state, bList);
        state.bgEnd = !!(b && b.endOfList);
        if (!bList.length && !state.bgEnd) break;
        if (state.bgEnd) break;
      }
    }
    const emitSurface = surfaceList;
    state.surfaceCarry = [];
    const emitBg = state.bgBuffer;
    state.bgBuffer = [];
    const seen = {};
    for (const it of emitSurface) {
      if (it && typeof it.id === "string") seen[it.id] = true;
    }
    const merged = emitSurface.concat(emitBg.filter((it) => !(it && typeof it.id === "string" && seen[it.id])));
    if (!headRefresh) state.surfaceEnd = surface.endOfList;
    state.lastSurfaceKeys = surface.startKeyHistory;
    state.pendingSurface = null;
    return {
      list: merged,
      endOfList: state.surfaceEnd && state.bgEnd && state.bgBuffer.length === 0 && state.surfaceCarry.length === 0,
      // Bookkeeping only (both the consumers and the SDK treat it opaquely);
      // the real cursors are the SDK's internal ones plus this module's state.
      startKeyHistory: surface.startKeyHistory,
      firstLoad
    };
  }
  function chatCacheKey(projectId, platform, userId) {
    if (!projectId || platform === "none") return "";
    return projectId + "#" + platform + "#" + (userId || "");
  }
  function indexScopeKey(projectId, platform) {
    if (!projectId || platform === "none") return "";
    return projectId + "#" + platform;
  }
  function mapHistoryListToMessages(list, platform, opts) {
    var mapped = [], runningItemIds = [], streamPendingItemIds = [];
    var extractAssistantText = platform === "openai" ? extractOpenAIText : extractClaudeText;
    var canRecoverStreams = streamRecoveryEnabled();
    var filtered = filterListByClearHorizon(list, opts.clearedAt);
    filtered.slice().reverse().forEach(function(item) {
      var requestBody = item && item.request_body;
      var isInProcess = item && item.status === "running";
      var isQueued = item && item.status === "pending";
      var isCancelledItem = item && item.status === "cancelled";
      var isPending = isInProcess || isQueued;
      var isFailed = item && item.status === "failed";
      var response = isFailed ? item.error != null ? item.error : item.response_body : item && item.response_body != null ? item.response_body : item && item.error;
      var isCompact = !!(item && item.compact);
      var userText = isCompact ? typeof item.request_text === "string" ? item.request_text : "" : extractLastUserTextFromRequest(requestBody);
      var assistantText = isPending ? "" : isCompact ? (typeof item.response_text === "string" ? item.response_text : "").trim() : (extractAssistantText(response) || "").trim() || "";
      var isErrorResponse = !isPending && (isFailed || !isCompact && isErrorResponseBody(response));
      var isStreamPending = canRecoverStreams && !isCompact && !isPending && !isCancelledItem && !isErrorResponse && !item._isBgTask && !item._isOnBgQueue && item.status === "resolved" && item.response_body == null && item.error == null && !assistantText;
      var reportedComplete = !!(item && item._isBgTask) && !isErrorResponse && (isCompact ? item.response_complete_marker === true : !!assistantText && assistantText.indexOf(INDEXING_COMPLETE_MARKER) !== -1);
      if (reportedComplete) assistantText = assistantText.split(INDEXING_COMPLETE_MARKER).join("").trim();
      var serverItemId = item && typeof item.id === "string" && item.id ? item.id : void 0;
      var createdTs = Number(item && item.created);
      var updatedTs = Number(item && item.updated);
      var executedTs = Number(item && item.executed);
      var respondedTs = Number(item && item.responded);
      var userTs = isFinite(createdTs) && createdTs > 0 ? createdTs : isFinite(updatedTs) && updatedTs > 0 ? updatedTs : void 0;
      var replyTs = isFinite(respondedTs) && respondedTs > 0 ? respondedTs : isFinite(updatedTs) && updatedTs > 0 ? updatedTs : isFinite(createdTs) && createdTs > 0 ? createdTs : void 0;
      if (userText) {
        var displayContent;
        var indexFile = void 0;
        if (item._isBgTask) {
          var ref = parseIndexingRequestText(userText);
          if (ref) {
            displayContent = opts.formatIndexingLabel(
              ref.name,
              ref.mime || "",
              typeof ref.size === "number" ? ref.size : null,
              ref.path,
              false,
              ref.continued
            );
            indexFile = ref;
          } else {
            displayContent = userText;
          }
        } else {
          displayContent = sanitizeAttachmentLinksForHistory(userText, opts.projectId);
        }
        var userMsg = { role: "user", content: displayContent };
        if (item._fromBgChain) userMsg._fromBgChain = true;
        if (isInProcess) userMsg.isPendingInProcess = true;
        if (isQueued) userMsg.isPendingQueued = true;
        if (isCancelledItem) userMsg.isCancelled = true;
        if (isCompact) userMsg._compact = true;
        if (item._isBgTask) userMsg.isBackgroundTask = true;
        if (indexFile) userMsg._indexFile = indexFile;
        if (item._isOnBgQueue) userMsg._useBgQueue = true;
        if (serverItemId !== void 0) userMsg._serverItemId = serverItemId;
        if (userTs !== void 0) userMsg._ts = userTs;
        mapped.push(userMsg);
      }
      if (isCancelledItem) ; else if (isInProcess) {
        var ph = { role: "assistant", content: "", isPending: true, isPendingInProcess: true };
        if (userTs !== void 0) ph._ts = userTs;
        if (item._fromBgChain) ph._fromBgChain = true;
        if (item._isBgTask) ph.isBackgroundTask = true;
        if (serverItemId !== void 0) {
          ph._serverItemId = serverItemId;
          runningItemIds.push(serverItemId);
        }
        mapped.push(ph);
      } else if (isQueued) ; else if (isErrorResponse) {
        var em = { role: "assistant", content: getErrorMessage(response), isError: true };
        if (isRetriedFailure(response)) em.isRetried = true;
        if (item._fromBgChain) em._fromBgChain = true;
        if (item._isBgTask) em.isBackgroundTask = true;
        if (serverItemId !== void 0) em._serverItemId = serverItemId;
        if (replyTs !== void 0) em._ts = replyTs;
        if (indexFile && isFinite(executedTs) && executedTs > 0) em._tsStart = executedTs;
        mapped.push(em);
      } else if (isStreamPending) {
        var sp = { role: "assistant", content: "", _streamPending: true };
        if (serverItemId !== void 0) {
          sp._serverItemId = serverItemId;
          streamPendingItemIds.push(serverItemId);
        }
        if (replyTs !== void 0) sp._ts = replyTs;
        mapped.push(sp);
      } else if (assistantText || reportedComplete) {
        var okm = { role: "assistant", content: sanitizeAttachmentLinksForHistory(assistantText, opts.projectId, true) || EMPTY_INDEXING_REPLY };
        if (item._fromBgChain) okm._fromBgChain = true;
        if (item._isBgTask) okm.isBackgroundTask = true;
        if (isCompact) okm._compact = true;
        if (!item._isBgTask && !isCompact) {
          var note = extractRetrievalNote(response, assistantText);
          if (note) okm._retrieval = note;
        }
        if (serverItemId !== void 0) okm._serverItemId = serverItemId;
        if (replyTs !== void 0) okm._ts = replyTs;
        if (indexFile && isFinite(executedTs) && executedTs > 0) okm._tsStart = executedTs;
        if (reportedComplete) okm._indexComplete = true;
        mapped.push(okm);
      }
    });
    if (opts.projectId) {
      var ownerKey = chatCacheKey(opts.projectId, platform, opts.userId);
      for (var oi = 0; oi < mapped.length; oi++) mapped[oi]._ownerKey = ownerKey;
    }
    return { messages: mapped, runningItemIds, streamPendingItemIds };
  }
  function adoptLocalAnswerIntoPage(incoming, local) {
    if (!incoming || !local || !incoming._streamPending) return false;
    if (incoming.role !== "assistant" || local.role !== "assistant") return false;
    if (local.isError) return false;
    var hasText = typeof local.content === "string" && local.content.length > 0;
    var isLive = !!(local.isPending || local._streaming);
    if (!hasText && !isLive) return false;
    if (hasText) {
      incoming.content = local.content;
      incoming._streamPending = false;
    }
    if (local._localId !== void 0) incoming._localId = local._localId;
    if (local.isPending) incoming.isPending = true;
    if (local.isPendingInProcess) incoming.isPendingInProcess = true;
    if (local._streaming) incoming._streaming = true;
    return true;
  }
  function adoptLiveTextIntoRunningRow(incoming, local) {
    if (!incoming || !local) return false;
    if (incoming.role !== "assistant" || local.role !== "assistant") return false;
    if (!incoming.isPending || incoming.isBackgroundTask || incoming._streamPending) return false;
    if (local.isError || !(local.isPending || local._streaming)) return false;
    if (typeof local.content !== "string" || !local.content) return false;
    if (typeof incoming.content === "string" && incoming.content.length >= local.content.length) return false;
    incoming.content = local.content;
    if (local._localId !== void 0) incoming._localId = local._localId;
    if (local._streaming) incoming._streaming = true;
    return true;
  }
  function shouldRescueInFlightMessage(m, ctx) {
    if (!m) return false;
    if (m.isBackgroundTask) return false;
    if (m._ownerKey !== void 0 && ctx.loadKey !== void 0 && m._ownerKey !== ctx.loadKey) return false;
    if (m._serverItemId && ctx.hasServerId(m._serverItemId)) return false;
    if (m._stageId) return true;
    if (m._streaming && !m._serverItemId) return true;
    if (!m._serverItemId && (m._unconfirmed || m._notSent)) return true;
    if (!m._serverItemId && ctx.pageHasPendingAssistant) return false;
    if (m.isSendingToServer || m.isPendingQueued || m.isPendingInProcess || m.isPending) return true;
    if (m.role === "user") {
      var next = ctx.next;
      if (!next || next.isBackgroundTask || !next.isPending || next.role !== "assistant") return false;
      if (ctx.sending && (next._serverItemId === void 0 || next._serverItemId === m._serverItemId)) return true;
      return !!m._serverItemId && next._serverItemId === m._serverItemId;
    }
    return false;
  }

  // src/engine/scroll_anchor.ts
  var ROW_KEY_ATTR = "data-row-key";
  var ROW_POS_ATTR = "data-row-pos";
  var MAX_ALTS = 2;
  var ALT_SCAN_LIMIT = 64;
  var UNKNOWN_ROW_POS = "\0?";
  function createScrollAnchor(options) {
    var held = null;
    var seen = typeof WeakMap === "function" ? /* @__PURE__ */ new WeakMap() : null;
    function capture() {
      var box = options.getBox();
      if (!box || options.isStuck()) return null;
      var boxTop = box.getBoundingClientRect().top;
      var kids = box.children;
      var fallback = null;
      var fallbackAt = -1;
      var behind = [];
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (!el || typeof el.getAttribute !== "function") continue;
        var key = el.getAttribute(ROW_KEY_ATTR);
        if (!key) continue;
        var top = el.getBoundingClientRect().top - boxTop;
        if (top + el.offsetHeight <= 0) {
          var bpos = el.getAttribute(ROW_POS_ATTR);
          behind.push({
            key,
            top,
            pos: bpos === null ? null : bpos || UNKNOWN_ROW_POS,
            el
          });
          if (behind.length > MAX_ALTS) behind.shift();
          continue;
        }
        if (top >= box.clientHeight) break;
        var rawPos = el.getAttribute(ROW_POS_ATTR);
        var pos = rawPos === null ? null : rawPos || UNKNOWN_ROW_POS;
        var cand = {
          key,
          top,
          pos,
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          el
        };
        if (rawPos === null) {
          cand.alts = withBehind(collectAlts(box, boxTop, i + 1), behind);
          return cand;
        }
        if (!fallback) {
          fallback = cand;
          fallbackAt = i;
        }
      }
      if (fallback) {
        fallback.alts = withBehind(
          collectAlts(box, boxTop, fallbackAt + 1, true) || collectAlts(box, boxTop, fallbackAt + 1),
          behind
        );
        return fallback;
      }
      return {
        key: null,
        top: 0,
        pos: null,
        scrollTop: box.scrollTop,
        scrollHeight: box.scrollHeight,
        el: null
      };
    }
    function collectAlts(box, boxTop, from, ordinaryOnly) {
      var out = [];
      var kids = box.children;
      var stop = Math.min(kids.length, from + ALT_SCAN_LIMIT);
      for (var i = from; i < stop && out.length < MAX_ALTS; i++) {
        var el = kids[i];
        if (!el || typeof el.getAttribute !== "function") continue;
        var key = el.getAttribute(ROW_KEY_ATTR);
        if (!key) continue;
        var rawPos = el.getAttribute(ROW_POS_ATTR);
        if (ordinaryOnly && rawPos !== null) continue;
        out.push({
          key,
          top: el.getBoundingClientRect().top - boxTop,
          pos: rawPos === null ? null : rawPos || UNKNOWN_ROW_POS,
          el
        });
      }
      return out.length ? out : void 0;
    }
    function withBehind(forward, behind) {
      var out = (forward || []).concat(behind.slice().reverse());
      return out.length ? out : void 0;
    }
    function findRow(box, anchor) {
      var el = anchor.el;
      if (el && el.parentNode === box) return el;
      if (!anchor.key) return null;
      var kids = box.children;
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (!kid || typeof kid.getAttribute !== "function") continue;
        if (kid.getAttribute(ROW_KEY_ATTR) === anchor.key) return kid;
      }
      return null;
    }
    function restore(anchor) {
      var box = options.getBox();
      if (!box || !anchor || options.isStuck()) return;
      var el = findRow(box, anchor);
      if (el) {
        var livePos = el.getAttribute(ROW_POS_ATTR) || UNKNOWN_ROW_POS;
        if (anchor.pos !== null && anchor.pos !== UNKNOWN_ROW_POS && livePos !== UNKNOWN_ROW_POS && livePos !== anchor.pos) el = null;
      }
      if (el) {
        var boxTop = box.getBoundingClientRect().top;
        var delta = el.getBoundingClientRect().top - boxTop - anchor.top;
        var slack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
        var moved = delta - (anchor.scrollTop - box.scrollTop);
        if (moved > slack || moved < -slack) {
          el = null;
        } else {
          if (delta >= 1 || delta <= -1) box.scrollTop += delta;
          held = {
            key: anchor.key,
            top: anchor.top,
            pos: anchor.pos,
            scrollTop: box.scrollTop,
            scrollHeight: box.scrollHeight,
            el,
            // Carried, not dropped: one successful restore used to disarm the
            // standbys for every later hold.
            alts: anchor.alts
          };
          return;
        }
      }
      var alts = anchor.alts;
      for (var ai = 0; alts && ai < alts.length; ai++) {
        var alt = alts[ai];
        var ael = findRow(box, {
          key: alt.key,
          top: alt.top,
          pos: alt.pos,
          scrollTop: anchor.scrollTop,
          scrollHeight: anchor.scrollHeight,
          el: alt.el
        });
        if (!ael) continue;
        if (alt.pos !== null && alt.pos !== UNKNOWN_ROW_POS) {
          var altLive = ael.getAttribute(ROW_POS_ATTR) || UNKNOWN_ROW_POS;
          if (altLive !== UNKNOWN_ROW_POS && altLive !== alt.pos) continue;
        }
        var aboxTop = box.getBoundingClientRect().top;
        var adelta = ael.getBoundingClientRect().top - aboxTop - alt.top;
        var aslack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
        var amoved = adelta - (anchor.scrollTop - box.scrollTop);
        if (amoved > aslack || amoved < -aslack) continue;
        if (adelta >= 1 || adelta <= -1) box.scrollTop += adelta;
        held = {
          key: alt.key,
          top: alt.top,
          pos: alt.pos,
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          el: ael,
          alts: alts.slice(ai + 1)
        };
        return;
      }
      lost(box, anchor);
    }
    function lost(box, anchor) {
      held = null;
      var grew = box.scrollHeight - anchor.scrollHeight;
      if (grew > 0) {
        box.scrollTop = anchor.scrollTop + grew;
        return;
      }
      if (options.rawFallback) box.scrollTop = anchor.scrollTop;
    }
    function preserve(mutate) {
      var anchor = capture();
      var result = mutate();
      restore(anchor);
      return result;
    }
    function remember() {
      held = capture();
    }
    function hold() {
      var box = options.getBox();
      if (!box || options.isStuck()) {
        held = null;
        return;
      }
      if (!held) {
        held = capture();
        return;
      }
      if (box.scrollTop !== held.scrollTop) {
        held = capture();
        return;
      }
      restore(held);
    }
    function absorb(el) {
      if (!el) return;
      var box = options.getBox();
      if (!box) return;
      var h = el.offsetHeight;
      var prev = seen ? seen.get(el) : void 0;
      if (seen) seen.set(el, h);
      if (options.isStuck()) return;
      if (prev === void 0) prev = 0;
      var delta = h - prev;
      if (delta === 0) return;
      if (el.getBoundingClientRect().top >= box.getBoundingClientRect().top) return;
      box.scrollTop += delta;
      if (held) held = capture();
    }
    function pinBottom() {
      var box = options.getBox();
      if (!box) return;
      box.scrollTop = box.scrollHeight;
    }
    function forget() {
      held = null;
    }
    return {
      capture,
      restore,
      preserve,
      remember,
      hold,
      pinBottom,
      absorb,
      forget
    };
  }

  // src/engine/viewport_fill.ts
  var HISTORY_FILL_SLACK_PX = 64;
  var MAX_HISTORY_FILL_PAGES = 24;
  var IDLE_WAIT_STEP_MS = 120;
  var IDLE_WAIT_MAX_MS = 15e3;
  async function waitForIdle(opts, stale) {
    var waited = 0;
    while (opts.isLoading()) {
      if (stale() || waited >= IDLE_WAIT_MAX_MS) return false;
      await new Promise(function(r) {
        setTimeout(r, IDLE_WAIT_STEP_MS);
      });
      waited += IDLE_WAIT_STEP_MS;
    }
    return !stale();
  }
  async function fillHistoryViewport(opts) {
    var maxPages = typeof opts.maxPages === "number" ? opts.maxPages : MAX_HISTORY_FILL_PAGES;
    var stale = function() {
      return !!(opts.isStale && opts.isStale());
    };
    var swallowed = 0;
    for (var page = 0; page < maxPages; page++) {
      if (stale() || opts.isEndOfList()) return;
      if (!await waitForIdle(opts, stale)) return;
      var satisfied = false;
      try {
        satisfied = !!await opts.isSatisfied();
      } catch {
        return;
      }
      if (satisfied || stale()) return;
      if (!await waitForIdle(opts, stale)) return;
      var before = opts.messageCount();
      var attempted;
      try {
        attempted = await opts.fetchOlder();
      } catch {
        return;
      }
      if (stale()) return;
      if (attempted === false) {
        if (++swallowed > 3) return;
        page--;
        continue;
      }
      if (opts.messageCount() <= before) return;
    }
  }
  function createHistoryFiller(base) {
    var pending = [];
    var running = false;
    var fetching = false;
    function announce(next) {
      if (fetching === next) return;
      fetching = next;
      if (!base.onRunningChange) return;
      try {
        base.onRunningChange(next);
      } catch (e) {
      }
    }
    async function allSatisfied() {
      var next = [];
      for (var i = 0; i < pending.length; i++) {
        if (!await pending[i]()) next.push(pending[i]);
      }
      pending = next;
      return pending.length === 0;
    }
    return {
      // The published fact, so a view and `isRunning()` can never disagree about
      // what they are showing. A fill that never fetches is not something anyone
      // outside this module has any use for knowing about.
      isRunning: function() {
        return fetching;
      },
      fill: function(isSatisfied) {
        pending.push(isSatisfied);
        if (running) return Promise.resolve();
        running = true;
        var done = function() {
          pending = [];
          running = false;
          announce(false);
        };
        return fillHistoryViewport({
          isSatisfied: allSatisfied,
          isEndOfList: base.isEndOfList,
          isLoading: base.isLoading,
          messageCount: base.messageCount,
          // The span opens HERE, at the first real page request: past
          // isEndOfList, past isStale, past isSatisfied. Everything before this
          // point is a fill that concluded there was nothing to do.
          fetchOlder: function() {
            announce(true);
            return base.fetchOlder();
          },
          isStale: base.isStale,
          maxPages: base.maxPages
        }).then(done, done);
      }
    };
  }

  // src/engine/session.ts
  var WORKER_PASS_ADOPT_LIMIT = 20;
  var LIVE_INDEX_SNAPSHOT_MAX_AGE_MS = 5e3;
  var INDEX_DISPATCH_CLAIM_MS = 2 * 60 * 1e3;
  var WORKER_PASS_ADOPT_ATTEMPTS = [0, 2e3, 6e3];
  var RECENT_INDEX_PASS_EVIDENCE_MS = 10 * 60 * 1e3;
  var ADOPT_TICK_MS = 10 * 1e3;
  var STATUS_PUSH_ADOPT_TICK_MS = 60 * 1e3;
  var CATCH_UP_MIN_GAP_MS = 2e3;
  var EARLY_PROBE_SCHEDULE_MS = [400, 900, 1700];
  var INDEXING_DRAIN_BUSY_POLL_MS = 8e3;
  var INDEXING_DRAIN_CONFIRM_POLL_MS = 3e3;
  var INDEXING_DRAIN_IDLE_LOOKS = 2;
  var INDEXING_DRAIN_MIN_MS = 8e3;
  var _bgHistoryBatchSeq = 0;
  var INDEXING_DRAIN_TIMEOUT_MS = 15 * 60 * 1e3;
  var INDEXING_DRAIN_LOOK_TIMEOUT_MS = 45e3;
  var INDEXING_DRAIN_NUDGE_MIN_GAP_MS = 1500;
  var _g2 = typeof globalThis !== "undefined" ? globalThis : {};
  function nowMs() {
    return _g2.performance && typeof _g2.performance.now === "function" ? _g2.performance.now() : Date.now();
  }
  function nextFrame(cb) {
    if (typeof _g2.requestAnimationFrame === "function") {
      _g2.requestAnimationFrame(cb);
      return;
    }
    setTimeout(function() {
      cb(nowMs());
    }, 16);
  }
  function isPollStopped(res) {
    return !!res && typeof res === "object" && res.status === "stopped";
  }
  var OPEN_STATE_RANK = { queued: 0, running: 1, terminal: 2 };
  var IQ_LIVE_MS = 8 * 1e3;
  var IQ_PUSH_LIVE_MS = 60 * 1e3;
  var IQ_CONFIRM_MS = 2500;
  var IQ_FRAME_GAP_MS = 2e3;
  var NOT_SENT_TEXT = "Not sent. Retry?";
  var REQUEST_GONE_TEXT = "This request is no longer available.";
  var REQUEST_UNREACHABLE_TEXT = "This answer is no longer reachable from this network.";
  var ANSWER_UNLOADABLE_TEXT = "The answer is stored but could not be loaded right now. Reload to try again.";
  var BODY_UNAVAILABLE_BACKOFF_AFTER = 3;
  var BODY_UNAVAILABLE_GIVE_UP = 5;
  var UNLOADABLE_RETRIES = 10;
  var FAILED_PASS_RECHECK_MIN_MS = 3 * 1e3;
  var FAILED_PASS_RECHECK_MAX_MS = 30 * 1e3;
  var CHAIN_STORE_PREFIX = "bq-chain:";
  var CHAIN_STORE_TTL_MS = 24 * 60 * 60 * 1e3;
  var CHAIN_LOST_TEXT = "Indexing stopped before the file finished (the page was closed). Index it again.";
  var NEXT_PASS_NOT_SENT_TEXT = "Could not send the next indexing pass.";
  var NOT_SENT_MIN_AGE_MS = 15 * 1e3;
  var LOOK_READ_CAP = 300;
  var RETURN_COVER_MS = 15 * 1e3;
  var LOOK_HEAD_OF_LINE = 5;
  var LOOK_READ_CONCURRENCY = 4;
  var FILE_RUN_RECHECK_MS = 30 * 1e3;
  function cancelledEnvelope(id) {
    return { id, status: "cancelled", in_queue: false };
  }
  function pollErrorBody(err) {
    return { type: "error", error: { type: "request_error", message: getErrorMessage(err) } };
  }
  var NO_TEXT_RESPONSE = "No text response received from AI provider.";
  var EMPTY_PROVIDER_BODY = { content: [], output: [] };
  var LIVE_PENDING_LINK_WINDOW = 512;
  var STREAM_RECOVERY_PER_LOAD = 2;
  function liveSafePrefix(text) {
    if (!text) return "";
    var cut = text.length;
    var fenceAt = -1, fences = 0, from = 0, hit;
    for (; ; ) {
      hit = text.indexOf("```", from);
      if (hit === -1) break;
      fences++;
      fenceAt = hit;
      from = hit + 3;
    }
    if (fences % 2 === 1 && fenceAt !== -1) cut = fenceAt;
    var head = text.slice(0, cut);
    var lineStart = head.lastIndexOf("\n") + 1;
    var line = head.slice(lineStart);
    var open = line.lastIndexOf("[");
    if (open !== -1 && line.length - open <= LIVE_PENDING_LINK_WINDOW) {
      var rest = line.slice(open);
      var close = rest.indexOf("]");
      if (close === -1) {
        cut = lineStart + open;
      } else if (rest.charAt(close + 1) === "(" && rest.indexOf(")", close + 1) === -1) {
        cut = lineStart + open;
      }
    }
    var tokStart = line.length;
    while (tokStart > 0 && !/\s/.test(line.charAt(tokStart - 1))) tokStart--;
    var tok = line.slice(tokStart);
    if (tok && /^(?:https?:\/\/|src::)/i.test(tok)) {
      var tokCut = lineStart + tokStart;
      if (tokCut < cut) cut = tokCut;
    }
    if (line.indexOf("```") === -1) {
      var ticks = 0, lastTick = -1;
      for (var i = 0; i < line.length; i++) {
        if (line.charAt(i) === "`") {
          ticks++;
          lastTick = i;
        }
      }
      if (ticks % 2 === 1 && lastTick !== -1) {
        var tickCut = lineStart + lastTick;
        if (tickCut < cut) cut = tickCut;
      }
    }
    if (cut >= text.length) return text;
    if (cut < 0) cut = 0;
    return text.slice(0, cut);
  }
  function commonPrefixLength(a, b) {
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    if (i > 0) {
      var prev = a.charCodeAt(i - 1);
      if (prev >= 55296 && prev <= 56319) i--;
    }
    return i;
  }
  function typewriterResumeIndex(painted, fullText, regions) {
    if (!painted || !fullText) return 0;
    if (/^\s/.test(painted) && !/^\s/.test(fullText)) {
      painted = painted.replace(/^\s+/, "");
      if (!painted) return 0;
    }
    var i = commonPrefixLength(painted, fullText);
    if (i <= 0) return 0;
    if (i >= fullText.length) return fullText.length;
    for (var changed = true; changed; ) {
      changed = false;
      for (var k = 0; k < regions.length; k++) {
        var r = regions[k];
        if (i > r.start && i < r.end) {
          i = r.end;
          changed = true;
        }
      }
    }
    return i > fullText.length ? fullText.length : i;
  }
  function mayKeepStreamedAnswer(snap, rowStatus) {
    if (rowStatus !== void 0 && rowStatus !== null && rowStatus !== "" && rowStatus !== "resolved") return false;
    if (!snap || typeof snap !== "object") return false;
    if (snap.errored) return false;
    if (snap.answerComplete) return true;
    if (snap.unframed) return true;
    return false;
  }
  function streamRecoveryPhase(msg) {
    if (!msg || !msg._streamPending || msg.content || !msg._serverItemId) return "";
    if (msg._streamRecovery === "active") return "active";
    if (msg._streamRecovery === "failed") return "failed";
    return "idle";
  }
  function streamRecoveryLabels(phase) {
    if (phase === "failed") {
      return { note: "Could not load this answer.", action: "Try again" };
    }
    return { note: "This answer was not saved with the conversation.", action: "Load answer" };
  }
  var LIVE_PAINT_MIN_MS = 250;
  var LIVE_TYPE_MAX_STEP = 1200;
  var WRONG_ANSWER_MESSAGE = "This answer seems wrong. Please check it again against the documents.";
  var WRONG_ANSWER_LABEL = "Wrong answer?";
  function canReportWrongAnswer(msg) {
    var note = retrievalNoteOfAnswer(msg);
    return !!note && !answerUsedNoDataTool(note) && !msg.isCancelled;
  }
  var UPLOAD_CANCELLED_MESSAGE = "Upload cancelled";
  function isUploadCancelledError(err) {
    return !!err && (err.code === "CANCELLED" || err.message === UPLOAD_CANCELLED_MESSAGE);
  }
  var _ChatSession = class _ChatSession {
    constructor(host) {
      // --- live streaming ----------------------------------------------------
      //
      // A streamed turn's answer NEVER reaches the polling row: the relay appends the
      // destination's raw bytes to a chunk table and the row settles with a status and
      // nothing else. So for a streamed turn this parser is not a nicety that makes the
      // wait prettier, it is the only place the answer exists until csr-finalize stores
      // one. Three things follow, and all three are load-bearing:
      //
      //   1. EVERY foreground poll gets a sink while streaming is on, not just the one
      //      the dispatch attaches. A tab return, a reload, a resumePolling all
      //      re-attach a poll to a still-running item, and skapi's reader sends
      //      `since: 0` on its first tick, so a fresh sink REPLAYS the whole stream from
      //      the beginning. Attaching without one settles that turn on an envelope and
      //      the user's answer is gone.
      //   2. The parser is keyed by SERVER ITEM ID, and so is the bubble it paints into.
      //      A history refetch replaces the local pending bubble with the server's copy
      //      of the same turn; that copy carries the same _serverItemId, so the next
      //      paint finds it and carries on. Nothing has to be rescued and nothing can be
      //      painted twice.
      //   3. The stream is never the source of truth. At settle the parser's ASSEMBLED
      //      body (byte equivalent to what a buffered call returns) goes through the
      //      same extractClaudeText / extractOpenAIText the buffered path uses, and a
      //      row that does hold a stored body wins outright.
      //
      // Background polls never get a sink, and that is safe because nothing on the bg
      // queue ever streams: an indexing pass must not (the worker READS its reply), and
      // a chat turn sent with attachments is deliberately left buffered for exactly the
      // reason point 1 gives, since the re-attach loop would poll it as a background
      // item and hand it no reader. See chatStreamWiring. A sink there would also spend
      // the request budget MAX_CONCURRENT_BG_POLLS exists to protect.
      /** Live streams by server item id. One per in-flight streamed turn. */
      this.liveStreams = {};
      /** When skapi recorded a turn's response as having finished arriving, by server
       *  item id. Read off the terminal envelope of a STREAMED turn (the only settle
       *  that carries it, see _settleLiveStream) and used as the answer bubble's time
       *  in place of this browser's clock. Entries are never removed: a settle reaches
       *  here twice (the poll's onResponse, then the promise), and the value for an id
       *  cannot change. */
      this._respondedAt = {};
      // ─── compact-stub hydration ─────────────────────────────────────────────
      // Split-fetch bg pages arrive as label stubs (no bodies). When the user
      // expands a row, the real reply text is fetched per item (csr-poll point
      // lookup) and MEMOIZED per chat: every later remap (first-page refresh,
      // queue-detect tick, cache restore) re-applies the memo, so a hydrated
      // bubble can never silently revert to its 200-char head.
      this._hydratedBodies = {};
      this._hydratingItems = {};
      /** The button's label and the message it sends, read off the session so the
       *  clients need no extra import. */
      this.wrongAnswerLabel = WRONG_ANSWER_LABEL;
      this.wrongAnswerMessage = WRONG_ANSWER_MESSAGE;
      this.typewriterQueue = Promise.resolve();
      /** performance.now() of the last look that read every open item's status. */
      this._recFullReadAt = 0;
      /** performance.now() of the last return look's start (see resumePolling). */
      this._recReturnAt = 0;
      /** Looks that still read statuses after a counter moved: a queued turn starts a moment
       *  after the one ahead of it finishes, and starting moves no counter. */
      this._recFollowUps = 0;
      /** The backend refused the counters read (too old): statuses are read every look. */
      this._recCountersOff = false;
      /** The backend refused the batch status read (too old): today's polls instead. */
      this._recReadsOff = false;
      /** A first-page read a look could not run yet (a load in flight, polling paused). */
      this._recFirstPageOwed = false;
      /** performance.now() of the last first-page read a look started. */
      this._recFirstPageAt = 0;
      /** gateRefreshToken of the last first-page load started (see loadHistory). */
      this._recFirstPageToken = void 0;
      /** performance.now() when the last first-page load landed (see loadHistory). */
      this._recFirstPageDoneAt = 0;
      /** performance.now() of the last indexing queue check a look ran. */
      this._recAdoptAt = 0;
      this._fileRunCheckAt = 0;
      this._recSyncing = false;
      /** Pages watching a project's background indexing queue (watchIndexQueue). */
      this._iqWatches = [];
      this._chainsRestored = false;
      /**
       * A run closed idle (a complete queue look found no pass of it) whose record still says
       * 'working': when it is THIS user's run of a client-driven file and no browser tab here
       * keeps its chain (a reload, a discarded tab, or a browser without localStorage lost
       * it), nothing will ever send its next pass, so run:: says CHAIN_LOST_TEXT. Never for a
       * worker-driven file (the worker writes its endings), another user's run (their chain is
       * in their browser), or a run whose next pass is being looked for.
       */
      /** Files the last queue look listed pending or running, settled bubbles included. */
      this._rawListedIndexKeys = {};
      /** Runs found idle on one complete look, waiting for a second before "lost" (see below). */
      this._lostLooks = {};
      /**
       * Pick up indexing passes the WORKER minted, which no client ever dispatched.
       *
       * For a PDF (and for text/grid when windowed indexing is on) the worker writes
       * pass N+1's row itself, inside pass N's invocation, right after saving pass
       * N's result. That row reaches this client through nothing at all: it is not in
       * bgTaskQueue (the client never asked for it) and it is not in state.messages
       * (only a first-page history load maps it in, which happens on mount, project
       * switch or tab return). So between two worker passes every pass the client
       * knows about is settled, and the collapsed row renders "Indexed  N passes"
       * with no spinner and no Stop, for a file that is still being read. A user who
       * believes that then asks questions against a half-indexed file — which is what
       * this exists to prevent.
       *
       * So when a background indexing pass settles, ask the bg queue what is still
       * unresolved on it and adopt anything unknown as an ordinary BgTaskEntry.
       * drainBgTaskQueue then treats it exactly like a pass this client dispatched:
       * same bubble, same `_indexFile` (so it joins the file's collapsed row), same
       * poll — and that poll settling runs this again, so the chain is followed to
       * its end. `status`-scoped so the reply carries the live items only, never a
       * page of finished ones with their bodies.
       *
       * Termination: the only trigger is a pass SETTLING, which happens once per
       * pass. An adopted item that is still running is not re-adopted (its id is
       * already polled), and when the queue holds nothing unknown the chain stops on
       * its own. Nothing here is periodic — a timer that re-reads history is the
       * shape that previously looped fetchHistoryPage after an already-DONE index.
       */
      this._adoptingWorkerPasses = false;
      /** Per project: when a look last CONFIRMED the bg queue held nothing pending or running
       *  (2026-11-20). A recent pass older than this is a finished run, not evidence of live
       *  work, so a tab return no longer re-asks for ten minutes after every run. Memory only:
       *  a reload starts without it and asks once, as before. */
      this._idleVerdictAt = {};
      // ── RETURN CATCH-UP + REQUEST STATUS PUSH (owner, 2026-11-23) ──────────────
      // The rule: when the user comes back to the chat (the tab shown again, the computer
      // awake again, the network or the websocket back), the chat is re-read from the
      // server, so nothing that happened while they were away is missing. Since the
      // reconciler (2026-11-24) that is its return look: the live readers restart, the
      // discovery listing finds sends whose ack was lost, the first page is merged (keeps
      // older pages, a send in flight, never lets an empty answer replace a known one), and
      // every open item is read. Status frames (statusPush) only make looks sooner; they
      // never decide anything on screen. The methods below keep their names as wrappers.
      this._statusUnsub = null;
      this._statusSeenConnect = false;
      /** The last COMPLETE running+pending look at this user's bg queue: which pass ids were
       *  live. Complete means both lists came back shorter than their limit, so a tracked pass
       *  missing from it really has left the queue. */
      this._lastLiveLook = null;
      /** By-listing passes whose by-id lookup is in flight, so one tick never reads a pass twice. */
      this._listingSettling = {};
      this._listingLookInflight = false;
      this._progressInflight = false;
      this.host = host;
      this.state = {
        messages: [],
        attachments: [],
        uploadingAttachments: false,
        sending: false,
        typing: false,
        typingAbort: false,
        loadingHistory: false,
        loadingOlderHistory: false,
        // A deferred bg stub batch (first-paint split) is still in flight; the
        // views show a small 'loading indexing history' hint while true.
        bgHistoryLoading: false,
        historyEndOfList: false,
        historyStartKeyHistory: [],
        historyRequestToken: 0,
        gateRefreshToken: 0,
        liveIndexKeys: {},
        indexPageProgress: {},
        passPaging: {},
        liveIndexChecked: false,
        liveIndexRunning: {},
        liveIndexRunningChecked: false,
        liveIndexSettled: {},
        stoppedIndexIds: {},
        reconnecting: false,
        signInNeeded: false,
        indexQueues: {}
      };
      this.bgTaskQueue = [];
      this.cancelledServerIds = /* @__PURE__ */ new Set();
      this.cancelledIndexKeys = /* @__PURE__ */ new Set();
      this.pendingAgentRequests = {};
      this.aiChatHistoryCache = {};
      this.historyItemPolls = /* @__PURE__ */ new Map();
      this._pauseReasons = /* @__PURE__ */ new Set();
      this._resuming = false;
      this._wrongReported = {};
      this._lidSeq = 0;
      this._stageSeq = 0;
      this._uploadBatches = 0;
      this._indexDispatchesInFlight = 0;
      this._drainNudges = [];
      this._liveStages = {};
      this._liveIndexKey = "";
      this._liveIndexAt = 0;
      this._indexClaims = {};
      this._bgQueueByFile = null;
      this._bgQueueStamp = { arr: null, length: 0, first: void 0, last: void 0 };
      this._bgQueueIndexRebuilds = 0;
      this._watchVisibility();
    }
    /** What the display layer needs to decide whether a run is finished. `keys` holds
     *  every file the server still has indexing work for; `checked` is false until the
     *  first answer for this chat, and false means "we do not know yet". */
    getLiveIndexState() {
      return { keys: this.state.liveIndexKeys, checked: this.state.liveIndexChecked, running: this.state.liveIndexRunning || {}, runningChecked: !!this.state.liveIndexRunningChecked, settled: this.state.liveIndexSettled || {} };
    }
    /** Passes that were on a row when the user stopped it, so the display layer can
     *  still tell that this run was stopped once the stop has left no other trace.
     *  See cancelIndexingGroup, which fills it, and buildChatDisplayList, which is
     *  the only reader. */
    getStoppedIndexIds() {
      return this.state.stoppedIndexIds;
    }
    /**
     * Is this file ALREADY being indexed by this client?
     *
     * One live run per file, and the reason is what a second one looks like: the
     * conversation grows a SECOND collapsed row for the same file (a run is opened
     * by every FIRST pass, so two of them are two rows), the same document is read
     * twice at full provider cost, and the two chains fight over the same records —
     * the delete-then-repost that starts run 2 wipes what run 1 has saved so far.
     *
     * Asked of this client's own live work, so it cannot be wrong in the dangerous
     * direction: a queued/running pass keeps its bgTaskQueue entry until its bubble
     * settles, and a settled run answers false, which is what a genuine later
     * re-index needs.
     *
     * The retry that made this necessary: a chip whose INDEX request failed is
     * handed back to the composer to be retried on the next send, and an index
     * request can fail from the client's side (a lost ack, an expired token on the
     * response) while the server has already queued the pass. The retry then indexes
     * a file that was never not being indexed.
     */
    hasLiveIndexRun(storagePath) {
      if (!storagePath) return false;
      var scoped = this._indexClaimKey(storagePath);
      var claimed = this._indexClaims[scoped];
      if (claimed && nowMs() - claimed < INDEX_DISPATCH_CLAIM_MS) return true;
      if (this._bgQueueIndex()[scoped] > 0) return true;
      return this.state.messages.some(function(m) {
        if (!m.isBackgroundTask || m.role !== "user" || m.isCancelled) return false;
        if (!(m.isPendingQueued || m.isPendingInProcess || m.isSendingToServer)) return false;
        return !!m._indexFile && m._indexFile.path === storagePath;
      });
    }
    /** Storage paths are project-relative, and one ChatSession serves every
     *  project, so a claim has to be scoped the way a stop is (_indexKeyOf). */
    _indexClaimKey(storagePath) {
      var id = this.host.getIdentity();
      return indexScopeKey(id.projectId, id.platform) + "|" + storagePath;
    }
    /**
     * bgTaskQueue as a map: scoped path (indexScopeKey(projectId, platform) +
     * '|' + storagePath, the key the claims and the stops use) -> entries.
     *
     * The array stays the source of truth because the engine does not own every
     * write to it: both hosts hand in their own array (the dashboard a Vue
     * reactive one it pushes to from the Files page and splices from its
     * fallback poller), and tests push to it directly. So the map is DERIVED, and
     * rebuilt when a cheap stamp says the array changed: its identity, its length,
     * its first and its last entry.
     *
     * Why that stamp is exact for this array: every write to bgTaskQueue is either
     * a push of a NEW entry object or a splice that removes one (nothing inserts
     * in the middle, replaces in place or re-pushes a removed entry). Under those
     * two operations, same length plus same last entry means the same contents:
     * a push changes the last entry unless that same push is removed again, and a
     * removal changes the length unless a push restores it, which changes the
     * last entry. The first entry is in the stamp as margin. A rebuild is one
     * pass over the array, paid once per change instead of once per claim.
     */
    _bgQueueIndex() {
      var q = this.bgTaskQueue;
      var n = q ? q.length : 0;
      var first = n ? q[0] : void 0;
      var last = n ? q[n - 1] : void 0;
      var st = this._bgQueueStamp;
      if (this._bgQueueByFile && st.arr === q && st.length === n && st.first === first && st.last === last) {
        return this._bgQueueByFile;
      }
      var idx = {};
      for (var i = 0; i < n; i++) {
        var e = q[i];
        if (!e || !e.storagePath) continue;
        var k = indexScopeKey(e.projectId, e.platform) + "|" + e.storagePath;
        idx[k] = (idx[k] || 0) + 1;
      }
      this._bgQueueByFile = idx;
      this._bgQueueStamp = { arr: q, length: n, first, last };
      this._bgQueueIndexRebuilds++;
      return idx;
    }
    /**
     * Take this file's indexing slot, or report that someone already has it.
     *
     * The check-and-CLAIM is what makes it safe against a second caller arriving
     * mid-flight: the claim is written SYNCHRONOUSLY, before the first await, so a
     * concurrent caller sees it even though no request has completed and no queue
     * has admitted anything. Ask-then-dispatch could not do that — every source it
     * consults only learns about a dispatch after the ack.
     *
     * Returns true when the caller owns the slot and should dispatch. A caller that
     * then fails to dispatch MUST releaseIndexRun, or the file waits out the claim
     * (a few minutes) before it can be retried.
     */
    claimIndexRun(storagePath) {
      var self = this;
      if (!storagePath) return Promise.resolve(true);
      if (this.hasLiveIndexRun(storagePath)) return Promise.resolve(false);
      this._indexClaims[this._indexClaimKey(storagePath)] = nowMs();
      return this._refreshLiveIndexKeys(LIVE_INDEX_SNAPSHOT_MAX_AGE_MS).then(function() {
        if (!self.state.liveIndexKeys[storagePath]) return true;
        self.releaseIndexRun(storagePath);
        return false;
      }).catch(function() {
        return true;
      });
    }
    /** Give the slot back — the dispatch failed, or was abandoned. */
    releaseIndexRun(storagePath) {
      if (storagePath) delete this._indexClaims[this._indexClaimKey(storagePath)];
    }
    /**
     * Index files that are ALREADY STORED again, without uploading anything: the
     * Reindex answer of the "already uploaded" report, offered for the members a send
     * skipped as duplicates (att.duplicates, see uploadSingleAttachment). The same
     * steps the Files page's Reindex takes: claim the file (one already being indexed
     * is left alone), keep its access group (host.readFileAccessGroup, read before the
     * delete), clear the old index, re-create the file record, queue the first pass.
     * Each file appears in the chat as a "Reindexing" row. Never rejects; resolves to
     * the number of files queued.
     */
    reindexStoredFiles(list) {
      var self = this;
      var id = this.host.getIdentity();
      var queued = 0;
      if (!id.projectId || id.platform !== "claude" && id.platform !== "openai") return Promise.resolve(0);
      var chain = Promise.resolve();
      (list || []).forEach(function(d) {
        if (!d || !d.storagePath) return;
        var storagePath = d.storagePath;
        var name = d.name || storagePath.split("/").filter(Boolean).pop() || storagePath;
        var mime = d.mime || self.host.getMimeType(name) || void 0;
        chain = chain.then(function() {
          var claimed = false;
          var url = "";
          var group;
          return self.claimIndexRun(storagePath).then(function(ok) {
            claimed = ok;
            if (!ok) return;
            return Promise.resolve(self.host.getTemporaryUrl(storagePath)).then(function(u) {
              url = typeof u === "string" ? u : u && u.url || "";
              if (!url) return;
              return typeof self.host.readFileAccessGroup === "function" ? Promise.resolve(self.host.readFileAccessGroup(storagePath)).then(function(g) {
                group = g || void 0;
              }) : void 0;
            }).then(function() {
              if (!url) return;
              if (typeof self.host.deleteExistingFileRecord === "function") {
                return Promise.resolve(self.host.deleteExistingFileRecord(storagePath)).catch(function() {
                });
              }
            }).then(function() {
              if (!url) return;
              if (typeof self.host.ensureFileIndexRecord === "function") {
                return Promise.resolve(self.host.ensureFileIndexRecord(storagePath, { name, mime, size: d.size }, group)).catch(function() {
                });
              }
            }).then(function() {
              if (!url || group || typeof self.host.uploadAccessGroup !== "function") return;
              return Promise.resolve(self.host.uploadAccessGroup(storagePath)).then(function(g) {
                group = g || void 0;
              }).catch(function() {
              });
            }).then(function() {
              if (!url) {
                self.releaseIndexRun(storagePath);
                return;
              }
              return self.trackIndexDispatch(notifyAgentSaveAttachment({
                platform: id.platform,
                model: id.model,
                service: id.projectId,
                publicProjectId: id.publicProjectId,
                owner: id.owner,
                userId: id.userId || id.projectId,
                serviceName: id.serviceName,
                serviceDescription: id.serviceDescription,
                attachment: { name, storagePath, mime, size: d.size, url, accessGroup: group }
              })).then(function(ack) {
                if (ack && typeof ack.id === "string") {
                  queued += 1;
                  self.bgTaskQueue.push({
                    projectId: id.projectId,
                    platform: id.platform,
                    id: ack.id,
                    identity: Object.assign({}, id),
                    owner: id.owner,
                    filename: name,
                    storagePath,
                    isReindex: true,
                    mime,
                    size: d.size,
                    status: ack.status === "running" ? "running" : "pending",
                    poll: ack.poll
                  });
                  self.noteBgQueueChanged();
                  self.drainBgTaskQueue();
                } else {
                  self.releaseIndexRun(storagePath);
                }
              });
            });
          }).catch(function(err) {
            console.error("[chat-engine] reindex of a stored file failed", storagePath, err);
            if (claimed) self.releaseIndexRun(storagePath);
          });
        });
      });
      return chain.then(function() {
        self.drainBgTaskQueue();
        return queued;
      });
    }
    /**
     * ONE SHARED INDEX FOR IDENTICAL FILES: the linked copies that lose their original when
     * `removed` files (or every file under `folders`) go away, per original, oldest first
     * (identical.ts copiesToPromote). Read through host.findLinkedCopies, fresh, and it has
     * to be read BEFORE the delete or reset: those remove nothing from the copies' markers,
     * but a later sweep could no longer tell whose copies they were once a new original
     * exists. Never rejects; [] without the hook or on any failure.
     */
    collectLinkedCopies(removed, folders) {
      if (typeof this.host.findLinkedCopies !== "function") return Promise.resolve([]);
      var id = this.host.getIdentity();
      var actor = { userId: id && !id.anonymous ? id.userId : null, isProjectOwner: !!(id && !id.anonymous && id.owner && id.userId === id.owner) };
      return Promise.resolve(this.host.findLinkedCopies()).then(function(map) {
        return map ? copiesToPromote(map, removed || [], folders, actor) : [];
      }).catch(function() {
        return [];
      });
    }
    /**
     * Send the copies of a removed or overwritten original again (owner decision
     * 2026-11-26): each list's oldest copy first, so its first pass claims the content and
     * is indexed for real (one AI run), then the others, which link to it with no AI call.
     * The share flag rides on every first pass while the project's switch is on (requests.ts
     * notifyAgentSaveAttachment). Through reindexStoredFiles, so each copy keeps its access
     * group and shows as a "Reindexing" row. Resolves to the number of files queued.
     */
    promoteLinkedCopies(plan) {
      var list = [];
      (plan || []).forEach(function(g) {
        (g && g.copies || []).forEach(function(c) {
          if (c) list.push({ storagePath: c });
        });
      });
      if (!list.length) return Promise.resolve(0);
      console.log("[chat-engine] identical files: sending " + list.length + " linked cop" + (list.length === 1 ? "y" : "ies") + " again, their original is gone:", plan);
      return this.reindexStoredFiles(list);
    }
    /**
     * The same question, asked of the SERVER when this page cannot answer it.
     *
     * hasLiveIndexRun only knows what this page did. That is not enough for the
     * case duplicates actually come from: the first run was started before a
     * reload, or in another tab, or its bubble has since been paged out of the
     * loaded window — and then the retry finds nothing locally and starts a second
     * run of a file that is still being indexed. The queue is the one place that
     * knows, and it is already asked for exactly this list.
     *
     * Only a POSITIVE answer is used. Absence proves nothing here (the query is
     * capped, and `liveIndexChecked` records that), so an unanswerable question
     * falls back to dispatching — the cost of a wrong "no" is the duplicate this
     * exists to prevent, and the cost of a wrong "yes" is a file that never gets
     * indexed at all. Only one of those is recoverable by the user.
     */
    isIndexRunLive(storagePath) {
      var self = this;
      if (!storagePath) return Promise.resolve(false);
      if (this.hasLiveIndexRun(storagePath)) return Promise.resolve(true);
      return this._refreshLiveIndexKeys(LIVE_INDEX_SNAPSHOT_MAX_AGE_MS).then(function() {
        return !!self.state.liveIndexKeys[storagePath];
      }).catch(function() {
        return false;
      });
    }
    /** Re-ask the queue which files are still being indexed, unless the answer we
     *  have is younger than `maxAgeMs`. Shared by every caller that needs a current
     *  one; the display layer's own refresh path is the adopt ladder. */
    _refreshLiveIndexKeys(maxAgeMs) {
      var self = this;
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!id.projectId || platform !== "claude" && platform !== "openai") return Promise.resolve();
      var askedKey = this.getHistoryCacheKey();
      if (this._liveIndexKey === askedKey && nowMs() - this._liveIndexAt < maxAgeMs) {
        return Promise.resolve();
      }
      var queue = bgIndexingQueueName(id.userId, id.projectId);
      var ask = function(status) {
        return Promise.resolve(probeBgQueue(
          { service: id.projectId, owner: id.owner, platform, queue, status, limit: WORKER_PASS_ADOPT_LIMIT },
          { maxAgeMs: BG_PROBE_TTL_MS }
        )).then(function(entry2) {
          return entry2.result;
        }).catch(function() {
          return null;
        });
      };
      return Promise.all([ask("pending"), ask("running")]).then(function(results) {
        if (results[0] === null || results[1] === null) return;
        if (self.getHistoryCacheKey() !== askedKey) return;
        self._liveIndexKey = askedKey;
        self._recordLiveIndexKeys(results);
      });
    }
    /**
     * Replace the live-index snapshot from a queue query's raw items.
     *
     * Whole-snapshot, never incremental: the query returns everything unresolved on
     * the queue, so a file MISSING from it is precisely the fact we are after. Merging
     * would make a finished file impossible to observe.
     */
    _recordLiveIndexKeys(lists) {
      var next = {};
      var running = {};
      var rawListed = {};
      var truncated = false;
      var runningTruncated = false;
      var settledIds = {};
      this.state.messages.forEach(function(m) {
        if (!m._serverItemId) return;
        if (m.isPending || m.isPendingInProcess || m.isPendingQueued) return;
        settledIds[m._serverItemId] = true;
      });
      for (var li = 0; li < lists.length; li++) {
        var list = lists[li] && Array.isArray(lists[li].list) ? lists[li].list : [];
        if (list.length >= WORKER_PASS_ADOPT_LIMIT || lists[li] && lists[li].endOfList === false) {
          truncated = true;
          for (var si = 0; si < list.length; si++) {
            if (list[si] && list[si].status === "running") {
              runningTruncated = true;
              break;
            }
          }
        }
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (!item || item.status !== "pending" && item.status !== "running") continue;
          var rawRef = parseIndexingRequestText(listedRequestText(item));
          if (rawRef) {
            if (rawRef.path) rawListed[rawRef.path] = true;
            if (rawRef.name) rawListed[rawRef.name] = true;
          }
          if (item.id && settledIds[item.id]) continue;
          var text = listedRequestText(item);
          if (!isIndexingRequestText(text)) continue;
          var ref = parseIndexingRequestText(text);
          if (!ref) continue;
          if (ref.path) next[ref.path] = true;
          if (ref.name) next[ref.name] = true;
          if (item.status === "running") {
            if (ref.path) running[ref.path] = true;
            if (ref.name) running[ref.name] = true;
          }
        }
      }
      var nowChecked = !truncated;
      var was = this.state.liveIndexKeys, changed = this.state.liveIndexChecked !== nowChecked;
      if (!changed) {
        for (var k in next) if (!was[k]) {
          changed = true;
          break;
        }
        if (!changed) {
          for (var k2 in was) if (!next[k2]) {
            changed = true;
            break;
          }
        }
      }
      if (!changed) {
        var wasRun = this.state.liveIndexRunning || {};
        for (var r1 in running) if (!wasRun[r1]) {
          changed = true;
          break;
        }
        if (!changed) {
          for (var r2 in wasRun) if (!running[r2]) {
            changed = true;
            break;
          }
        }
      }
      this.state.liveIndexKeys = next;
      this._rawListedIndexKeys = rawListed;
      if (this.state.liveIndexRunningChecked !== !runningTruncated) changed = true;
      var settledNow = this.state.liveIndexSettled || {};
      var settledNext = {};
      for (var sk in settledNow) if (settledNow[sk] && !next[sk]) settledNext[sk] = true;
      if (nowChecked) {
        for (var wk in was) if (was[wk] && !next[wk]) {
          if (!settledNext[wk]) changed = true;
          settledNext[wk] = true;
        }
      }
      this.state.liveIndexSettled = settledNext;
      this.state.liveIndexRunning = running;
      this.state.liveIndexRunningChecked = !runningTruncated;
      this.state.liveIndexChecked = nowChecked;
      this._liveIndexAt = nowMs();
      this._liveIndexKey = this.getHistoryCacheKey();
      if (changed) this.host.notify();
    }
    /** Forget the snapshot: it describes ONE chat's queue, and the answer for the
     *  project the user just switched to is unknown until it is asked for again. */
    _resetLiveIndexKeys() {
      this.state.liveIndexKeys = {};
      this.state.liveIndexRunning = {};
      this.state.liveIndexRunningChecked = false;
      this.state.liveIndexSettled = {};
      this.state.liveIndexChecked = false;
      this._liveIndexAt = 0;
      this.state.passPaging = {};
    }
    /**
     * Ask the queue what is still indexing, once, for the chat that is on screen.
     *
     * Seeds the snapshot on a history load. Without it a reloaded chat has no way to
     * learn that a run it can see is over: the adopt ladder that normally answers this
     * only fires when a pass SETTLES, and after a reload there is no pass left to
     * settle — so every finished worker-driven row would spin forever.
     *
     * Best-effort: a failure leaves `checked` false, which reads as "still working"
     * rather than as a false all-clear.
     *
     * Delegates to the adopt ladder rather than asking once. A single empty look is
     * exactly what that ladder exists to distrust — the worker writes pass N+1 a few
     * milliseconds AFTER flipping pass N to resolved, so a query landing in that gap
     * sees an empty queue for a chain that is very much alive. One look would turn
     * that into a confident "Indexed" with a green check, on the one scenario this
     * whole feature is for, and nothing would ever re-ask: the ladder is normally
     * triggered by a pass SETTLING, and after a reload there is no pass left to
     * settle. The ladder re-asks at 0/2s/6s, records each answer, and as a bonus
     * adopts and polls any live pass it finds, which makes the row genuinely active
     * instead of merely unconfirmed.
     */
    refreshLiveIndexState() {
      var sid = this.host.getIdentity().projectId;
      var idleAt = sid ? this._idleVerdictAt[sid] : 0;
      if (sid && idleAt && !this._hasLocalLiveIndexWork(sid) && this._newestIndexPassTs() <= idleAt) {
        this._recordLiveIndexKeys([{ list: [] }, { list: [] }]);
        return;
      }
      this._adoptWorkerIndexingPasses(0, true);
      this._ensureAdoptTick();
    }
    /** Forget what we know about which files are indexing — but ONLY when the
     *  snapshot was taken for a different chat than the one on screen now. For a
     *  consumer whose history loading is its own fork and so never reaches
     *  loadHistory's reset — a snapshot describes ONE chat's queue, and carrying it
     *  into another project would let a row there claim to be finished on someone
     *  else's evidence.
     *
     *  Conditional for the same reason loadHistory's own reset is (the
     *  `loadKey !== _liveIndexKey` gate): the view calls this on every mount, and
     *  an unconditional wipe turned every re-entry to the chat into a grey
     *  "Checking status:" sweep across rows whose state was already known. A
     *  RE-entry keeps showing the last answer (green/yellow) while the first-page
     *  refresh re-asks quietly; only a genuine project/platform switch starts from
     *  "not known yet". Claiming `_liveIndexKey` here (before any answer) is the
     *  same fudge loadHistory makes: it marks WHOSE chat the empty snapshot is
     *  for, so repeated calls do not re-wipe, and _recordLiveIndexKeys re-claims
     *  it when the real answer lands. */
    resetLiveIndexState() {
      var key = this.getHistoryCacheKey();
      if (key === this._liveIndexKey) return;
      this._liveIndexKey = key;
      this._resetLiveIndexKeys();
    }
    /** Wrap an indexing-request dispatch so awaitIndexingDrained counts it as
     *  live work from the moment it is sent, not from the moment it is acked. */
    trackIndexDispatch(p) {
      var self = this;
      this._indexDispatchesInFlight += 1;
      var release = function() {
        self._indexDispatchesInFlight = Math.max(0, self._indexDispatchesInFlight - 1);
      };
      return p.then(function(v) {
        release();
        return v;
      }, function(e) {
        release();
        throw e;
      });
    }
    /**
     * Something just happened that plausibly ENDED indexing work, so let any waiting
     * turn look now instead of sitting out the rest of its busy interval.
     *
     * A nudge changes only WHEN a look happens, never what it concludes: the two
     * agreeing idle looks, the confirm gap between them, "a failed look counts as
     * busy" and the minimum wait are all untouched. That is why it is safe to fire
     * from places that are merely good guesses.
     *
     * Fired from end-of-chain points ONLY: the adopt ladder giving up, a resume
     * declining to continue, a pass failing. Not from every settling pass (one nudge
     * per pass per file for the whole run), and not from an indexing request being
     * accepted — see the note in trackIndexDispatch for why that one is actively
     * harmful rather than merely wasteful.
     */
    _nudgeIndexingDrain() {
      if (!this._drainNudges.length) return;
      var list = this._drainNudges.slice();
      for (var i = 0; i < list.length; i++) {
        try {
          list[i]();
        } catch (e) {
        }
      }
    }
    /**
     * Register a live poll so (a) a remount dedupes against it instead of stacking a
     * SECOND poll on the same item, and (b) pausePolling can stop it.
     *
     * `stop` comes from the SDK and may be absent on an older skapi-js, in which case the
     * poll simply cannot be stopped and is left running — see pausePolling.
     *
     * (This block documents _trackPoll, further down. The two methods below sit between it
     * and its subject.)
     */
    /**
     * Foreground poll with an early-probe race.
     *
     * skapi's poll() is a bare setInterval(fn, latency) with NO check at t=0, so the earliest a
     * reply can be observed is one full POLL_INTERVAL (3s) after dispatch. For a long generation
     * that granularity is free. For a SHORT one it is nearly pure dead time: a greeting that the
     * provider finishes in 1s still waits until the 3s tick, which measured as a large share of a
     * 5s "yo" round trip.
     *
     * So keep the 3s interval as the steady state, and additionally point-look-up the item a few
     * times early, on a widening schedule. Whichever answers first wins and the other is stopped.
     * The probe uses the csrHistoryItemLookup hook both clients already implement; without it this
     * degrades to exactly the old behaviour.
     *
     * FOREGROUND ONLY. Background indexing polls keep the flat cadence: nobody is watching them,
     * and they are the ones bounded by MAX_CONCURRENT_BG_POLLS, so adding probes there would spend
     * the request budget the cap exists to protect.
     */
    attachForegroundPoll(source, itemId, opts, ctx) {
      return this._fgPollWithEarlyProbe(source, itemId, opts, ctx);
    }
    _fgPollWithEarlyProbe(source, itemId, opts, ctx) {
      var self = this;
      var live = this._beginLiveStream(itemId, ctx);
      if (live) {
        var inner = opts || {};
        var callerResponse = typeof inner.onResponse === "function" ? inner.onResponse : null;
        var callerError = typeof inner.onError === "function" ? inner.onError : null;
        var streamOpts = Object.assign({}, inner, {
          onStream: function(chunk, _seq, via) {
            self._feedLiveStream(live, chunk, via);
          },
          onResponse: function(res) {
            var effective = res;
            if (isPollStopped(res)) self._closeLiveStream(live, false);
            else effective = self._settleLiveStream(live, res);
            if (callerResponse) callerResponse(effective);
          },
          onError: function(err) {
            self._closeLiveStream(live, false);
            if (callerError) callerError(err);
          }
        });
        var lp = source.poll(Object.assign({ latency: STREAM_POLL_INTERVAL }, streamOpts));
        var stopLp = lp && typeof lp.stop === "function" ? lp.stop.bind(lp) : null;
        var wrapped = Promise.resolve(lp).then(function(res) {
          if (isPollStopped(res)) {
            self._closeLiveStream(live, false);
            return res;
          }
          return self._settleLiveStream(live, res);
        }, function(err) {
          self._closeLiveStream(live, false);
          throw err;
        });
        wrapped.stop = function() {
          self._closeLiveStream(live, false);
          if (stopLp) stopLp();
        };
        return wrapped;
      }
      var base = source.poll(Object.assign({ latency: POLL_INTERVAL }, opts || {}));
      var lookup = chatEngineConfig().csrHistoryItemLookup;
      var liveIdent = this.host.getIdentity();
      var ident = {
        projectId: ctx && ctx.projectId !== void 0 ? ctx.projectId : liveIdent && liveIdent.projectId,
        owner: ctx && ctx.owner !== void 0 ? ctx.owner : liveIdent && liveIdent.owner
      };
      var platform = ctx && (ctx.platform === "claude" || ctx.platform === "openai") ? ctx.platform : liveIdent && liveIdent.platform;
      if (!lookup || !itemId || !ident.projectId || platform !== "claude" && platform !== "openai") {
        return base;
      }
      var settled = false;
      var timers = [];
      var clearProbes = function() {
        for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
        timers = [];
      };
      var stopBase = base && typeof base.stop === "function" ? base.stop.bind(base) : null;
      var resolveRaced = null;
      var raced = new Promise(function(resolve, reject) {
        resolveRaced = resolve;
        base.then(function(res) {
          if (settled) return;
          settled = true;
          clearProbes();
          resolve(res);
        }, function(err) {
          if (settled) return;
          settled = true;
          clearProbes();
          reject(err);
        });
        var fullId = buildHistoryItemFullId(platform, ident.projectId, itemId);
        EARLY_PROBE_SCHEDULE_MS.forEach(function(delay) {
          timers.push(setTimeout(function() {
            if (settled) return;
            Promise.resolve(lookup(fullId, ident.projectId, ident.owner)).then(function(body) {
              if (settled || !body || typeof body !== "object") return;
              if (body.status === "pending" || body.status === "running") return;
              if (isPollStopped(body)) return;
              settled = true;
              clearProbes();
              if (stopBase) {
                try {
                  stopBase();
                } catch (e) {
                }
              }
              if (opts && typeof opts.onResponse === "function") {
                try {
                  opts.onResponse(body);
                } catch (e) {
                }
              }
              resolve(body);
            }, function() {
            });
          }, delay));
        });
      });
      raced.stop = function() {
        if (settled) return;
        settled = true;
        clearProbes();
        if (stopBase) {
          try {
            stopBase();
          } catch (e) {
          }
        }
        if (resolveRaced) resolveRaced({ id: itemId, status: "stopped" });
      };
      return raced;
    }
    _trackPoll(id, kind, p) {
      var stop = p && typeof p.stop === "function" ? p.stop.bind(p) : void 0;
      if (!stop) {
        console.debug("[chat-engine] poll has no stop handle", { id, kind });
      }
      this.historyItemPolls.set(id, { kind, stop });
      return p;
    }
    /** Background polls currently attached, for the MAX_CONCURRENT_BG_POLLS budget.
     *  Counts the registry rather than a separate tally so it cannot drift: every
     *  attach goes through _trackPoll and every detach deletes the entry. Note an
     *  entry left behind by pausePolling on an older skapi-js (no stop handle)
     *  still counts, which is correct — that poll really is still running. */
    _countBgPolls() {
      var n = 0;
      this.historyItemPolls.forEach(function(handle) {
        if (handle && handle.kind === "bg") n++;
      });
      return n;
    }
    _noteRespondedAt(itemId, response) {
      if (!itemId || !isCsrStatusEnvelope(response)) return;
      var at = Number(response.responded);
      if (!isFinite(at) || at <= 0) return;
      if (!this._respondedAt) this._respondedAt = {};
      this._respondedAt[itemId] = at;
    }
    /** The time a live answer bubble is stamped with: when skapi received the
     *  response, if the settle told us, else now. "Now" is what every bubble got
     *  before, and it is still right for a buffered turn, whose settle hands back the
     *  destination's body and nothing of skapi's; a history load then replaces it
     *  with the server's value. */
    _replyStampFor(msg) {
      var id = msg ? msg._serverItemId : void 0;
      var at = typeof id === "string" && id && this._respondedAt ? this._respondedAt[id] : void 0;
      return typeof at === "number" ? at : wallClockNow();
    }
    /**
     * Open (or re-open) the live stream for `itemId`, or null when this poll must
     * not carry one.
     *
     * Re-entrant on purpose: an auth-refresh retry re-dispatches the SAME turn under
     * a NEW id, and a re-attach after a tab return replays an existing id from seq 0.
     * Either way the bytes about to arrive are a whole stream, so an existing entry
     * is discarded and a fresh parser takes its place - feeding a replay into the old
     * parser would concatenate the answer with itself.
     *
     * `ctx` IS THE TURN'S OWN IDENTITY, and every caller that has one passes it.
     * This used to read the LIVE getIdentity(), which is a bug of exactly the kind
     * _callProviderFor documents and threads its own parameters to avoid: the user
     * hits Send, then switches project or platform inside the ack round trip, and the
     * stream that opens for the OLD turn is stamped with the NEW identity. What that
     * costs is not cosmetic - `platform` picks which url csr-finalize is addressed
     * with and which extractor reads the assembled body, `projectId`/`owner` scope
     * the finalize itself, and `ownerKey` decides which chat the answer is painted
     * into. Get them from the live read at the wrong moment and the turn is finalized
     * against the wrong service (so its answer is never stored), parsed with the
     * wrong provider's extractor, or painted into a conversation it does not belong
     * to. The live read stays only as the fallback for a caller with nothing pinned.
     */
    _beginLiveStream(itemId, ctx) {
      if (!liveStreamingEnabled()) return null;
      if (!itemId) {
        console.warn("[chat-engine] live streaming is on but the dispatch reported no item id");
        return null;
      }
      var pinnedPlatform = ctx && (ctx.platform === "claude" || ctx.platform === "openai") ? ctx.platform : void 0;
      var ident = pinnedPlatform && ctx && ctx.projectId !== void 0 && ctx.owner !== void 0 && ctx.ownerKey !== void 0 ? null : this.host.getIdentity();
      var platform = pinnedPlatform || (ident ? ident.platform : void 0);
      if (platform !== "claude" && platform !== "openai") return null;
      var projectId = ctx && ctx.projectId !== void 0 ? ctx.projectId : ident ? ident.projectId : "";
      var owner = ctx && ctx.owner !== void 0 ? ctx.owner : ident ? ident.owner : "";
      var ownerKey = ctx && ctx.ownerKey !== void 0 ? ctx.ownerKey : this.getHistoryCacheKey();
      var prev = this.liveStreams[itemId];
      if (prev) this._closeLiveStream(prev, false);
      var st = {
        id: itemId,
        ownerKey,
        platform,
        projectId,
        owner,
        parser: createSseParser(),
        painted: "",
        started: false,
        fed: false,
        ended: false,
        timer: null,
        lastPaintAt: 0,
        finalBody: null,
        transport: { socket: 0, poll: 0 }
      };
      this.liveStreams[itemId] = st;
      return st;
    }
    /** The chunk sink handed to skapi's poll. Raw relayed text, in order, never parsed
     *  here: the parser owns the grammar and this owns the pacing. */
    _feedLiveStream(st, chunk, via) {
      if (st.ended || typeof chunk !== "string" || !chunk) return;
      st.fed = true;
      if (via === "socket") st.transport.socket++;
      else if (via === "poll") st.transport.poll++;
      st.parser.feed(chunk);
      if (st.timer) return;
      var self = this;
      var wait = st.lastPaintAt ? Math.max(0, LIVE_PAINT_MIN_MS - (nowMs() - st.lastPaintAt)) : 0;
      st.timer = setTimeout(function() {
        st.timer = null;
        self._paintLiveStream(st);
      }, wait);
    }
    /**
     * Write the safe prefix of the answer so far into the turn's bubble.
     *
     * notify() is spent EXACTLY ONCE per turn, on the first paint, because that is a
     * state change the per-bubble refresh cannot express: the bubble stops being a
     * "Thinking..." spinner and becomes text. Every paint after it goes through
     * refreshMessageBubble, which is what keeps a growing answer from rebuilding the
     * whole display list once a second.
     */
    _paintLiveStream(st) {
      if (st.ended) return;
      st.lastPaintAt = nowMs();
      if (this.getHistoryCacheKey() !== st.ownerKey) return;
      var idx = this._liveTargetIndex(st.id);
      if (idx === -1) {
        this._noteServerState(st.id, "running", st.ownerKey);
        idx = this._liveTargetIndex(st.id);
      }
      if (idx === -1) return;
      var msg = this.state.messages[idx];
      if (!msg) return;
      var snap = st.parser.snapshot();
      var next = liveSafePrefix(snap.text);
      if (next.length <= st.painted.length) return;
      var prev = st.painted;
      st.painted = next;
      var grew = next.length - prev.length;
      var animate = grew > 0 && grew <= LIVE_TYPE_MAX_STEP;
      if (animate) {
        if (!msg._localId) msg._localId = this._newLocalId();
        if (!msg._streaming) {
          msg._streaming = true;
          this.host.notify();
        }
        this.enqueueTypewrite(idx, next, msg._localId, prev);
      } else {
        msg.content = next;
        if (!msg._streaming) {
          msg._streaming = true;
          this.host.notify();
        } else this.host.refreshMessageBubble(idx);
      }
      this.host.scrollToBottomIfSticky();
      this._reportLiveStream(st, st.started ? "update" : "start", snap, next);
      st.started = true;
    }
    /** The bubble a live stream paints into: the turn's pending assistant placeholder,
     *  found by server item id. Not by _localId, deliberately - a history refetch
     *  replaces the local copy with the server's, and only the id survives that. */
    _liveTargetIndex(itemId) {
      return this.state.messages.findIndex(function(m) {
        return !!m && m.role === "assistant" && !m.isBackgroundTask && m._serverItemId === itemId && (!!m.isPending || !!m._streaming);
      });
    }
    /** Hand the host its optional observation update. Guarded: this runs on the paint
     *  path, and a throwing hook must not cost the user the rest of their answer. */
    _reportLiveStream(st, phase, snap, text) {
      var hook = chatEngineConfig().onLiveStreamUpdate;
      if (!hook) return;
      try {
        hook({
          serverItemId: st.id,
          ownerKey: st.ownerKey,
          phase,
          text,
          thinkingText: snap && snap.thinkingText || "",
          toolNames: snap && snap.toolNames ? snap.toolNames.slice() : [],
          complete: !!(snap && snap.complete),
          // Reported alongside `complete`, never instead of it: a host drawing
          // "still arriving" wants complete, a host drawing "this answer is
          // partial" wants this one, and an `error` frame is the case where the
          // two disagree. See sse.ts answerComplete.
          answerComplete: !!(snap && snap.answerComplete),
          errored: !!(snap && snap.errored),
          transport: { socket: st.transport.socket, poll: st.transport.poll }
        });
      } catch (e) {
        console.warn("[chat-engine] onLiveStreamUpdate threw", e);
      }
    }
    /** Stop painting and (when the turn really ended) assemble the body. `finished`
     *  is false for a stream being discarded rather than settled: a retry replacing
     *  it, or a stop, neither of which has an answer to assemble. */
    _closeLiveStream(st, finished) {
      var first = !st.ended;
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      if (first) {
        st.ended = true;
        if (finished && st.fed) {
          st.parser.end();
          st.finalBody = st.parser.finalBody();
        }
      }
      if (this.liveStreams[st.id] === st) delete this.liveStreams[st.id];
      if (first && st.started) this._reportLiveStream(st, "end", st.parser.snapshot(), "");
      if (this.getHistoryCacheKey() !== st.ownerKey) return;
      var idx = this._liveTargetIndex(st.id);
      if (idx !== -1 && this.state.messages[idx] && this.state.messages[idx]._streaming) {
        this.state.messages[idx]._streaming = false;
      }
    }
    /**
     * Settle a streamed turn: end the parse, decide the body the rest of the session
     * will read, and release the chunks.
     *
     * The substitution is one-directional and never a merge. A response that is a
     * real stored body (a buffered turn, or a streamed one somebody already
     * finalized) is returned untouched, because that is the destination's own answer
     * and the stream is not entitled to overwrite it. Only a STATUS ENVELOPE - the
     * shape a streamed row settles as, having stored nothing - is replaced, and then
     * by the assembled body, which every caller downstream reads with the same
     * extractor it uses for a buffered reply. Idempotent, because it is reached both
     * through the poll's onResponse and through the promise it resolves.
     */
    _settleLiveStream(st, response) {
      this._closeLiveStream(st, true);
      if (!isCsrStatusEnvelope(response)) return response;
      this._noteRespondedAt(st.id, response);
      if (response.status !== "resolved") return response;
      if (!this._mayFinalize(st)) this._rec().incomplete[st.id] = true;
      if (st.finalBody == null) return response;
      this._finalizeStreamedTurn(st);
      return st.finalBody;
    }
    /**
     * May this parse be STORED as the turn's permanent answer?
     *
     * THE FAILURE THIS PREVENTS. Finalizing does two things at once: it stores what
     * you give it as the row's result, and it DELETES the chunks it was assembled
     * from. So finalizing a truncated parse is not a cosmetic loss, it is the
     * permanent one: the truncation becomes the stored answer and the only copy of
     * the missing part is deleted in the same call. And a truncated parse is a shape
     * this repo has already paid for - a degraded chunk read (the poller degrades to
     * "no chunks this tick, more=true" on any transient chunk-table error, and caps
     * a long answer at 500k characters per response) can hand the settle a stream
     * that stopped mid-answer. The row can settle 'resolved' on top of that, because
     * the ROW's status describes the destination's request, not the client's read of
     * it.
     *
     * THE POLICY ITSELF IS mayKeepStreamedAnswer (top of this file), shared with the
     * recovery path so the two cannot drift apart again - they did, and the drift was
     * silent: the live settle refused a failed turn while the recovery finalized one.
     * What is local to this method is only the two things the free function cannot
     * know: that there is an assembled body at all, and that this call site is
     * reached only on a row that settled 'resolved' (the caller returns before it
     * otherwise), which is the status it therefore states.
     *
     * The test the policy applies is deliberately NOT `complete`: a terminal event
     * arrived and the answer finished are two claims, and an `error` frame satisfies
     * the first while truncating the second. See sse.ts's answerComplete.
     */
    _mayFinalize(st) {
      if (st.finalBody == null) return false;
      return mayKeepStreamedAnswer(st.parser.snapshot(), "resolved");
    }
    /**
     * Store the assembled body as the version history keeps, which is also what
     * releases this request's chunks.
     *
     * The ASSEMBLED BODY and not the extracted text, because the row is read back by
     * mapHistoryListToMessages through extractClaudeText / extractOpenAIText: storing
     * the provider's own document is what makes a streamed turn indistinguishable
     * from a buffered one on the next load, with no branch anywhere in the mapper.
     *
     * BEST EFFORT, and loudly so: the answer is already on screen and already in the
     * history cache by the time this fires. A failure costs the chunks (they stay,
     * and the turn stays re-readable) and a row that reads back empty, never the
     * user's answer in front of them.
     *
     * WHAT IS DELIBERATELY NEVER FINALIZED, because finalize is also the only way to
     * release chunks and it is tempting to reach for it as a cleanup:
     *
     *   - an INCOMPLETE parse (see _mayFinalize). Storing a truncation makes it
     *     permanent AND deletes the part that was missing from it. A stream killed by
     *     an `error` frame is one of these however terminal it looks: the frame ends
     *     the stream, so `complete` is true, while the text is only what arrived
     *     before the error. That is why the gate reads answerComplete.
     *   - a FAILED turn. Its chunks hold the part of the answer that did arrive,
     *     which is the only copy of that text there is, and the two ways to release
     *     them both cost something real: storing the partial makes a truncated answer
     *     the turn's permanent history AND masks the failure on read (csr-poll hands
     *     back a finalized body before it ever looks at the row's error, so the turn
     *     would read back as a clean short answer), while storing the error throws
     *     the partial away outright. Keeping them costs storage on rows that produced
     *     bytes and then failed, which is rare - a failure before the first byte (a
     *     wrong API key, the common case) has no chunks to keep - and the poller
     *     hands those chunks back alongside the error on every later read, so nothing
     *     is stranded, only retained. Retention is the honest trade here; deletion is
     *     not reversible.
     *   - a CANCELLED turn, for the same reason plus one: the user's Stop means the
     *     half answer is to be discarded, so writing it into history as the kept
     *     version would resurrect exactly what the stop was for.
     */
    _finalizeStreamedTurn(st) {
      if (st.finalized) return;
      if (!this._mayFinalize(st)) return;
      var fin = resolveForwardRequestFinalize();
      if (!fin || st.finalBody == null) return;
      st.finalized = true;
      var item = this._openMap()[st.id];
      this._finalizeAnswer(st.id, st.finalBody, {
        ownerKey: st.ownerKey,
        platform: st.platform,
        projectId: st.projectId,
        owner: st.owner,
        queue: item ? item.queue : void 0
      });
    }
    /** Painted-but-unsettled live text on a bubble, for the typewriter to resume from.
     *  A pending assistant placeholder is created with content '' by every path that
     *  makes one, so non-empty content on one can only have been painted here. */
    _paintedTextAt(idx) {
      var m = idx >= 0 ? this.state.messages[idx] : void 0;
      if (!m || m.role !== "assistant" || typeof m.content !== "string") return "";
      return m.content;
    }
    /** The recovery bookkeeping, created on first touch.
     *
     *  LAZY, not constructor-initialised, and for a concrete reason: ChatSession is
     *  also built with Object.create(ChatSession.prototype) by the engine's own test
     *  harnesses, which drive one method against a hand-built state rather than a
     *  whole session. A field only the constructor creates is undefined there, and
     *  the method that reaches for it throws, turning a test of the settle into a
     *  crash about bookkeeping. */
    _rec() {
      if (!this._streamRecovery) this._streamRecovery = { incomplete: {}, attempted: {}, inflight: {}, failed: {}, queue: [], running: false };
      return this._streamRecovery;
    }
    /**
     * Put this session's fetching state onto the turn's bubble, so a view can tell a
     * loader that means something from one that means nothing.
     *
     * ONLY EVER ONTO A STILL-MARKED BUBBLE. Once `_streamPending` is off the turn has
     * an answer (or was proven to have none) and this says nothing about it; writing
     * it there would leave a stale 'active' on a settled bubble forever.
     *
     * host.notify() is what redraws the widget, whose renderer is imperative. It is a
     * no-op in agent.vue, whose state is a Vue reactive() - the property write above
     * is what redraws there. Both are covered by doing both, and neither is a
     * substitute for the other.
     */
    _markRecoveryPhase(itemId, phase) {
      var changed = false;
      for (var i = 0; i < this.state.messages.length; i++) {
        var m = this.state.messages[i];
        if (!m || m.role !== "assistant" || m._serverItemId !== itemId || !m._streamPending) continue;
        var next = phase === null ? void 0 : phase;
        if (m._streamRecovery === next) continue;
        if (next === void 0) delete m._streamRecovery;
        else m._streamRecovery = next;
        changed = true;
      }
      if (changed) this.host.notify();
    }
    /**
     * Let LOCAL answers survive a freshly-mapped page whose copies of them are
     * authoritative-but-empty. Call with the page BEFORE it replaces or merges into
     * state.messages; mutates the page's bubbles in place.
     *
     * The adoption itself is history.ts's adoptLocalAnswerIntoPage (shared, so the
     * clients' own mappers cannot fork it). What lives here is the one thing the
     * pure function cannot know: whether the local text is the WHOLE answer. Text
     * left by a stream that ended without a terminal event is not, so that bubble
     * keeps its marker and gets read back even though it has content - otherwise a
     * truncated answer would adopt itself over the row and never be corrected.
     */
    _adoptLocalAnswers(mapped, loadKey) {
      if (!mapped || !mapped.length) return;
      var tomb = this._tomb();
      var needsLocals = false;
      for (var i = 0; i < mapped.length; i++) {
        var mi = mapped[i];
        if (!mi) continue;
        if (mi._streamPending || mi.isPending && mi.role === "assistant" && !mi.isBackgroundTask || mi._serverItemId && tomb[mi._serverItemId] && (mi.isPending || mi.isPendingQueued || mi.isPendingInProcess)) {
          needsLocals = true;
          break;
        }
      }
      if (!needsLocals) return;
      var locals = {};
      var localUsers = {};
      for (var j = 0; j < this.state.messages.length; j++) {
        var lm = this.state.messages[j];
        if (!lm || !lm._serverItemId) continue;
        if (lm._ownerKey !== void 0 && loadKey !== void 0 && lm._ownerKey !== loadKey) continue;
        if (lm.role === "assistant") {
          if (locals[lm._serverItemId] === void 0) locals[lm._serverItemId] = lm;
        } else if (lm.role === "user") {
          if (localUsers[lm._serverItemId] === void 0) localUsers[lm._serverItemId] = lm;
        }
      }
      var pendingIncoming = [];
      for (var k = 0; k < mapped.length; k++) {
        var inc = mapped[k];
        if (!inc) continue;
        var id = inc._serverItemId;
        if (inc._streamPending) pendingIncoming.push(inc);
        if (!id) continue;
        var local = locals[id];
        if (inc._streamPending) {
          if (!local) continue;
          if (!adoptLocalAnswerIntoPage(inc, local)) continue;
          if (this._rec().incomplete[id]) inc._streamPending = true;
          continue;
        }
        if (local && inc.role === "assistant" && inc.isPending && !tomb[id]) adoptLiveTextIntoRunningRow(inc, local);
      }
      for (var t = mapped.length - 1; t >= 0; t--) {
        var tm = mapped[t];
        var tid = tm ? tm._serverItemId : void 0;
        if (!tid || !tomb[tid]) continue;
        if (tm.role === "assistant" && tm.isPending) {
          var la = locals[tid];
          if (la && !la.isPending && !la._streamPending) mapped[t] = Object.assign({}, la);
          continue;
        }
        if (tm.role === "user" && (tm.isPendingQueued || tm.isPendingInProcess)) {
          var lu = localUsers[tid];
          if (!lu || lu.isPendingQueued || lu.isPendingInProcess || lu.isSendingToServer) continue;
          mapped[t] = lu.isCancelled ? Object.assign({}, lu) : this._settledUserCopy(tm, tid);
          var hasAnswer = false;
          for (var q = 0; q < mapped.length; q++) {
            var qm = mapped[q];
            if (qm && qm.role === "assistant" && qm._serverItemId === tid) {
              hasAnswer = true;
              break;
            }
          }
          var lans = locals[tid];
          if (!hasAnswer && !lu.isCancelled && lans && !lans.isPending && !lans._streamPending) mapped.splice(t + 1, 0, Object.assign({}, lans));
        }
      }
      for (var p = 0; p < pendingIncoming.length; p++) {
        var pi = pendingIncoming[p];
        if (!pi._streamPending || !pi._serverItemId) continue;
        var phase = this._recoveryPhaseFor(pi._serverItemId);
        if (phase === null) delete pi._streamRecovery;
        else pi._streamRecovery = phase;
      }
    }
    /**
     * This session's fetching state for one turn, from the bookkeeping rather than
     * from any bubble. A queued entry counts as 'active': it is committed to be read,
     * serially, and the reader has no way to tell "being read" from "next in line"
     * apart from the wait.
     */
    _recoveryPhaseFor(itemId) {
      var rec = this._rec();
      if (rec.inflight[itemId]) return "active";
      for (var i = 0; i < rec.queue.length; i++) if (rec.queue[i].id === itemId) return "active";
      if (rec.failed[itemId]) return "failed";
      return null;
    }
    /**
     * PUBLIC DELEGATE, for a client that maps and merges its own history page.
     *
     * agent.vue keeps a forked mapper and a forked first-page merge (its mount path
     * runs them, while resumePolling routes through loadHistory below), so both
     * paths are live for the SAME row inside one component. Adoption is part of the
     * merge contract, not an optional extra: without it that fork erases a streamed
     * answer off the screen on every turn, which is the whole of MAJOR 3.
     *
     * Exposed rather than reimplemented because the rule needs the session's own
     * `incomplete` set, which the pure helper (history.ts adoptLocalAnswerIntoPage)
     * cannot see. A client that reached for the helper alone would adopt a TRUNCATED
     * answer over the row and clear the marker that would have gone back for the
     * rest - a fork that reads as correct and loses text.
     *
     * Call it exactly where loadHistory does: on the freshly mapped page, after
     * applyHydratedBodies and BEFORE the page replaces or merges into state.messages.
     */
    adoptLocalAnswers(mapped, loadKey) {
      this._adoptLocalAnswers(mapped, loadKey);
    }
    /**
     * Queue the on-screen turns whose answer is only in the chunk store, newest
     * first, and start draining. Never blocks and never throws.
     *
     * `ownerKey` is the chat the queue entries belong to, snapshotted by the caller:
     * a recovery that lands after the user has moved on writes into that chat's
     * cache, never into whatever list is on screen by then.
     */
    _scheduleStreamRecovery(ownerKey, platform, projectId, owner) {
      if (!streamRecoveryEnabled()) return;
      var rec = this._rec();
      var wanted = [];
      for (var i = this.state.messages.length - 1; i >= 0; i--) {
        var m = this.state.messages[i];
        if (!m || m.role !== "assistant" || !m._streamPending || !m._serverItemId) continue;
        var id = m._serverItemId;
        if (rec.attempted[id]) continue;
        if (this.liveStreams[id]) continue;
        if (rec.queue.some(function(e) {
          return e.id === id;
        })) continue;
        wanted.push(id);
        if (wanted.length >= STREAM_RECOVERY_PER_LOAD) break;
      }
      if (!wanted.length) return;
      for (var w = 0; w < wanted.length; w++) {
        rec.queue.push({ id: wanted[w], ownerKey, platform, projectId, owner });
        this._markRecoveryPhase(wanted[w], "active");
      }
      this._drainStreamRecovery();
    }
    /**
     * PUBLIC DELEGATE, the other half of what a forked history path needs.
     *
     * Same reason as adoptLocalAnswers: agent.vue's mount path never calls
     * loadHistory, so without this its pages would MARK unfinalized streamed turns
     * and then never read them back - CRITICAL 1 left unfixed on the client's
     * primary path, with the marker making it look handled.
     *
     * Takes the load's SNAPSHOTTED identity rather than reading it live, and that is
     * the reason this exists instead of the caller looping over recoverStreamedAnswer:
     * that one reads getIdentity() at call time (right, for an on-demand affordance
     * the user just clicked), which after a project switch racing the load would
     * finalize the turn against the project they switched TO. Call it AFTER the page
     * is rendered and the loading flags are cleared - it must never hold up the
     * conversation it belongs to.
     */
    scheduleStreamRecovery(ownerKey, platform, projectId, owner) {
      this._scheduleStreamRecovery(ownerKey, platform, projectId, owner);
    }
    /** Serial drain of the recovery queue. Each entry is one full chunk read. */
    _drainStreamRecovery() {
      var rec = this._rec();
      if (rec.running) return;
      var next = rec.queue.shift();
      if (!next) return;
      rec.running = true;
      var self = this;
      this._readBackStreamedTurn(next.id, next.ownerKey, next.platform, next.projectId, next.owner).catch(function() {
      }).then(function() {
        self._rec().running = false;
        self._drainStreamRecovery();
      });
    }
    /**
     * Read one unfinalized streamed turn back out of the chunk store and put its
     * answer where the turn's answer belongs.
     *
     * Public because the cap above is deliberately small: a host that wants to offer
     * "load the rest" on an older recoverable turn calls this with its
     * `_serverItemId`, and gets the same path the automatic recovery uses. Safe to
     * call for an id that turns out not to be recoverable, and safe to call twice -
     * a second call while the first is still in flight is a no-op.
     *
     * THIS IS THE USER ASKING, and that is why it passes `manual`. The automatic
     * recovery refuses a row it has already tried, so that a re-render, or the
     * history load that every visibilitychange fires, cannot loop on the same
     * chunks. A click is neither of those: it is one bounded request that a person
     * asked for, and applying the loop guard to it made the affordance a button that
     * silently did nothing for exactly the rows most likely to have it - every row
     * an earlier read touched and could not settle.
     */
    recoverStreamedAnswer(itemId) {
      if (!itemId) return Promise.resolve();
      var id = this.host.getIdentity();
      var platform = id && id.platform === "openai" ? "openai" : "claude";
      return this._readBackStreamedTurn(itemId, this.getHistoryCacheKey(), platform, id ? id.projectId : "", id ? id.owner : "", true);
    }
    _readBackStreamedTurn(itemId, ownerKey, platform, projectId, owner, manual) {
      var read = resolveForwardRequestStream();
      if (!read || !itemId) return Promise.resolve();
      if (this._rec().inflight[itemId]) return Promise.resolve();
      if (!manual && this._rec().attempted[itemId]) {
        this._markRecoveryPhase(itemId, null);
        return Promise.resolve();
      }
      this._rec().attempted[itemId] = true;
      this._rec().inflight[itemId] = true;
      delete this._rec().failed[itemId];
      this._markRecoveryPhase(itemId, "active");
      var self = this;
      var url = platform === "openai" ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
      var parser = createSseParser();
      var fed = false;
      return Promise.resolve(read(itemId, {
        url,
        method: "POST",
        service: projectId,
        owner,
        since: 0,
        onStream: function(chunk) {
          if (typeof chunk !== "string" || !chunk) return;
          fed = true;
          parser.feed(chunk);
        }
      })).then(function(res) {
        if (isPollStopped(res)) {
          delete self._rec().attempted[itemId];
          delete self._rec().inflight[itemId];
          self._markRecoveryPhase(itemId, null);
          return;
        }
        var envelope = isCsrStatusEnvelope(res);
        var body = null;
        if (res && !envelope) {
          body = res;
        } else if (fed) {
          parser.end();
          body = parser.finalBody();
        }
        var snap = parser.snapshot();
        var fromRow = !!(res && !envelope);
        var rowStatus = envelope && typeof res.status === "string" ? res.status : void 0;
        var degraded = !!(envelope && res && res.more === true);
        var store = !fromRow && !degraded && body != null && mayKeepStreamedAnswer(snap, rowStatus);
        delete self._rec().inflight[itemId];
        delete self._rec().failed[itemId];
        self._markRecoveryPhase(itemId, null);
        if (degraded) {
          delete self._rec().attempted[itemId];
        }
        self._applyRecoveredAnswer(itemId, ownerKey, platform, projectId, owner, body, store, degraded);
      }, function(err) {
        console.warn("[chat-engine] could not read back a streamed turn", itemId, err);
        delete self._rec().attempted[itemId];
        delete self._rec().inflight[itemId];
        self._rec().failed[itemId] = true;
        self._markRecoveryPhase(itemId, "failed");
      });
    }
    /**
     * Write a recovered answer into the turn's bubble (or into the owning chat's
     * cache when the reader has moved on), then store it as the version history
     * keeps.
     *
     * FINALIZING IS WHAT MAKES THIS RUN ONCE. It copies the answer onto the row and
     * releases the chunks, so the next load reads an ordinary turn and no recovery is
     * scheduled for it ever again, by anyone, in any tab. `store` is the caller's
     * decision and carries two gates at once: mayKeepStreamedAnswer, the SAME keep
     * policy the live settle applies (an incomplete, errored or failed read is shown
     * but never stored, because storing it would make the truncation permanent and
     * delete the part that was missing), and whether the body is new at all (one
     * that came off the row is already stored).
     */
    _applyRecoveredAnswer(itemId, ownerKey, platform, projectId, owner, body, store, degraded) {
      var text = "";
      var isErr = isErrorResponseBody(body);
      if (body != null && !isErr) {
        text = ((platform === "openai" ? extractOpenAIText(body) : extractClaudeText(body)) || "").trim();
      }
      if (!text && !isErr) {
        if (degraded) {
          return;
        }
        this._clearStreamPendingMark(itemId, ownerKey, true);
        if (this._hasWaitingBubble(itemId, ownerKey)) {
          this.applyTerminal(itemId, EMPTY_PROVIDER_BODY, { ownerKey, platform, projectId, owner, instant: true });
        }
        return;
      }
      this.applyTerminal(itemId, body, { ownerKey, platform, projectId, owner, instant: true, correction: true });
      if (!degraded) delete this._rec().incomplete[itemId];
      if (!store || body == null || isErr) return;
      this._finalizeAnswer(itemId, body, { ownerKey, platform, projectId, owner });
    }
    /**
     * Take the "answer is elsewhere" marker off a turn once it is settled one way or
     * the other. `drop` removes an assistant bubble that turned out to have no answer
     * at all, which restores exactly the list the mapper used to produce for such a
     * row (none), rather than leaving a permanently empty bubble behind.
     *
     * ONLY EVER CALLED FOR A TURN THAT WAS ACTUALLY READ. The marker is the one thing
     * that keeps an unrecovered answer reachable, so it comes off only on the strength
     * of an answer (the recovery wrote one) or of a read that came back empty. A read
     * that FAILED, or one that was STOPPED, knows neither, and taking the marker off
     * on either of those is how a bubble ends up empty forever with its answer still
     * in the chunk table. `drop` is likewise never passed for a bubble that HAS
     * content: an empty row is an empty turn, a failed read is not.
     */
    _clearStreamPendingMark(itemId, ownerKey, drop) {
      if (ownerKey && this.getHistoryCacheKey() !== ownerKey) return;
      var changed = false;
      for (var i = this.state.messages.length - 1; i >= 0; i--) {
        var m = this.state.messages[i];
        if (!m || m.role !== "assistant" || m._serverItemId !== itemId) continue;
        if (!m._streamPending) continue;
        if (drop && !m.content) {
          this.state.messages.splice(i, 1);
          changed = true;
          continue;
        }
        m._streamPending = false;
        changed = true;
      }
      if (changed) {
        this.updateHistoryCache();
        this.host.notify();
      }
    }
    /**
     * Stop and forget one item's poll. Used after a cancel: the row is either gone
     * (cancelled while queued) or flagged cancelled (cancelled while running), so
     * asking about it again only burns requests. Safe when no poll is attached, and
     * safe on an older skapi-js with no stop handle (the entry is then LEFT in the
     * map so a later drain cannot stack a second, unstoppable poll on the id).
     */
    _stopPoll(id) {
      var handle = this.historyItemPolls.get(id);
      if (!handle) return;
      if (typeof handle.stop !== "function") return;
      try {
        handle.stop();
      } catch (e) {
      }
      this.historyItemPolls.delete(id);
    }
    /** True while any pause reason is active. */
    isPollingPaused() {
      return this._pauseReasons.size > 0;
    }
    /**
     * Stop BACKGROUND polling until resumePolling. Foreground polls (a reply the user is
     * waiting on) keep running deliberately: their results must still land in the history
     * cache so resumePendingRequest can render them on return, otherwise a user who sends
     * a message then navigates away comes back to a permanently stuck "Thinking...".
     *
     * Server-side work is untouched; this only stops asking about it. That is safe for
     * document indexing because the worker drives that loop itself.
     */
    pausePolling(reason) {
      this._pauseReasons.add(reason || "paused");
      var self = this;
      var stopped = [];
      this.historyItemPolls.forEach(function(handle, id) {
        if (!handle || handle.kind !== "bg") return;
        if (typeof handle.stop !== "function") return;
        try {
          handle.stop();
        } catch (e) {
        }
        stopped.push(id);
      });
      stopped.forEach(function(id) {
        self.historyItemPolls.delete(id);
      });
    }
    /**
     * Lift a pause reason WITHOUT running the reconcile. For a caller that is about to
     * reload history anyway (a view remounting), letting resumePolling also reconcile
     * would race that load and can double-attach.
     */
    clearPauseReason(reason) {
      this._pauseReasons.delete(reason || "paused");
    }
    /**
     * Clear a pause reason and, once none remain, re-attach polling and reconcile.
     * Deliberately does NOT touch gateRefreshToken: bumping it would silently discard
     * the results of anything still in flight across the pause.
     */
    resumePolling(reason) {
      this._pauseReasons.delete(reason || "paused");
      if (this._pauseReasons.size > 0 || this._resuming) return Promise.resolve();
      var self = this;
      this._resuming = true;
      return Promise.resolve().then(function() {
        if (self._viewMounted()) self.drainBgTaskQueue();
        if (self._recReturnAt && nowMs() - self._recReturnAt < RETURN_COVER_MS) {
          self._recEnsure();
          return;
        }
        return self.catchUpHistory();
      }).catch(function(e) {
        console.error("[chat-engine] resume polling failed", e);
      }).then(function() {
        self._resuming = false;
      });
    }
    /**
     * Does the chat on screen need its first history page fetched again to stay right?
     * Only when a waiting bubble of THIS chat has nothing that will settle it: no live poll
     * and no entry in bgTaskQueue (whose passes the drain and the queue check follow). Then
     * the page is the only place its poll handle or its answer can come from (a turn on the
     * background queue whose poll paused while the tab was hidden, for instance). A bubble
     * with no server id yet is a send still in flight, which resolves on its own.
     */
    needsHistoryRefetch() {
      var key = this.getHistoryCacheKey();
      var tracked = {};
      for (var q = 0; q < this.bgTaskQueue.length; q++) if (this.bgTaskQueue[q]) tracked[this.bgTaskQueue[q].id] = true;
      for (var i = 0; i < this.state.messages.length; i++) {
        var m = this.state.messages[i];
        if (!m || !(m.isPending || m.isPendingQueued || m.isPendingInProcess)) continue;
        if (m._ownerKey !== void 0 && m._ownerKey !== key) continue;
        var sid = m._serverItemId;
        if (!sid) continue;
        if (this.historyItemPolls.has(sid) || tracked[sid]) continue;
        if (this._recNewMode() && this._openMap()[sid]) continue;
        return true;
      }
      return false;
    }
    _newLocalId() {
      this._lidSeq += 1;
      return "lid_" + this._lidSeq;
    }
    /**
     * The key every per-chat cache hangs off: the restored message cache, the
     * hydrated-body memo, the live-index key and the per-file storage-path key.
     *
     * It carries the IDENTITY as well as the project and platform. A single
     * browser can hold more than one conversation on one project without a
     * reload — an anonymous visitor who signs in, or a dashboard user who logs
     * out and back in as someone else — and with an identity-free key the
     * previous conversation stayed in the cache and was re-rendered, and written
     * back, as the new one's. `userId` is the same value the request queue is
     * named after, so two identities that share a queue share a cache, which is
     * exactly right.
     */
    getHistoryCacheKey() {
      var id = this.host.getIdentity();
      return chatCacheKey(id.projectId, id.platform, id.userId);
    }
    /** Re-apply memoized hydrated texts onto freshly-mapped messages. Both
     *  clients call this right after their mapper runs (loadHistory does it
     *  internally); it mutates the given array's items in place. */
    applyHydratedBodies(messages) {
      var key = this.getHistoryCacheKey();
      var memo = key ? this._hydratedBodies[key] : null;
      if (!memo) return;
      var id = this.host.getIdentity();
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (!m || !m._compact || m.role !== "assistant" || !m._serverItemId) continue;
        var text = memo[m._serverItemId];
        if (typeof text !== "string") continue;
        m.content = sanitizeAttachmentLinksForHistory(text, id.projectId, true) || EMPTY_INDEXING_REPLY;
        delete m._compact;
      }
    }
    /** Fetch the real response bodies for compact history stubs (one csr-poll
     *  point lookup per item id), memoize, and swap them into the live list.
     *  Best-effort: a failed lookup leaves the stub (its head + fallback line
     *  still render) and a later expand retries. */
    hydrateCompactItems(itemIds) {
      var self = this;
      var lookup = chatEngineConfig().csrHistoryItemLookup;
      if (!lookup || !itemIds || !itemIds.length) return Promise.resolve();
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!id.projectId || platform !== "claude" && platform !== "openai") return Promise.resolve();
      var chatKey = this.getHistoryCacheKey();
      if (!chatKey) return Promise.resolve();
      var jobs = itemIds.map(function(itemId) {
        if (!itemId) return Promise.resolve();
        var already = self._hydratedBodies[chatKey] && self._hydratedBodies[chatKey][itemId] !== void 0;
        var inflightKey = chatKey + "|" + itemId;
        if (already || self._hydratingItems[inflightKey]) return Promise.resolve();
        self._hydratingItems[inflightKey] = true;
        return Promise.resolve(lookup(buildHistoryItemFullId(platform, id.projectId, itemId), id.projectId, id.owner)).then(function(body) {
          var text = ((platform === "openai" ? extractOpenAIText(body) : extractClaudeText(body)) || "").trim();
          if (text.indexOf(INDEXING_COMPLETE_MARKER) !== -1) text = text.split(INDEXING_COMPLETE_MARKER).join("").trim();
          if (!self._hydratedBodies[chatKey]) self._hydratedBodies[chatKey] = {};
          self._hydratedBodies[chatKey][itemId] = text;
          if (self.getHistoryCacheKey() !== chatKey) return;
          for (var i = 0; i < self.state.messages.length; i++) {
            var m = self.state.messages[i];
            if (m && m._compact && m.role === "assistant" && m._serverItemId === itemId) {
              m.content = sanitizeAttachmentLinksForHistory(text, id.projectId, true) || EMPTY_INDEXING_REPLY;
              delete m._compact;
            }
          }
        }).catch(function() {
        }).then(function() {
          delete self._hydratingItems[inflightKey];
        });
      });
      return Promise.all(jobs).then(function() {
        if (self.getHistoryCacheKey() !== chatKey) return;
        self.host.notify();
        self.updateHistoryCache();
      });
    }
    updateHistoryCache() {
      var key = this.getHistoryCacheKey();
      if (!key) return;
      this.aiChatHistoryCache[key] = {
        messages: this.state.messages.filter(function(m) {
          return m._ownerKey === void 0 || m._ownerKey === key;
        }),
        endOfList: this.state.historyEndOfList,
        startKeyHistory: this.state.historyStartKeyHistory.slice()
      };
    }
    /**
     * Give the immediate-send pair the server's id for their turn, the moment the
     * dispatch learns it.
     *
     * WHY THIS EXISTS. An immediate send pushes its user bubble and its
     * "Thinking..." placeholder locally, and until now neither ever carried a
     * _serverItemId — only the QUEUED path stamped one, off its ack. So for the
     * whole life of the turn there was no way to tell the local copy and the
     * server's copy of the SAME turn apart, and the history merge fell back to a
     * heuristic: rescue the local pair unless the freshly-fetched page happens to
     * contain a pending assistant.
     *
     * That heuristic has a hole exactly one poll interval wide. The server settles
     * the request; for up to POLL_INTERVAL the client has not noticed, so
     * `state.sending` is still true and the local pair is still on screen — while a
     * history fetch issued in that window returns the turn ALREADY SETTLED, with no
     * pending assistant in it. The rescue then re-appends the local pair below the
     * server's copy (the question, twice), and when the poll finally resolves,
     * the old positional settle wrote the answer into the rescued placeholder because
     * it was the only pending assistant left (the answer, twice). updateHistoryCache
     * persists the result, so it survives every later visit.
     *
     * Navigating away while waiting and coming back is what lands a fetch in that
     * window: a remount runs refreshGate -> a fresh first page, at an arbitrary
     * moment relative to the 3s poll.
     *
     * With the id on the bubbles, both clients' rescue loops skip them through the
     * dedup they already have (`_serverItemId is in this page`), the reply the
     * dispatch caches inherits the id too, and nothing needs a new special case.
     *
     * Matched by _localId, never by index: a file's indexing rows are spliced in
     * above these bubbles while the request is in flight.
     */
    _stampTurnWithItemId(key, userLid, placeholderLid, itemId) {
      if (!itemId) return;
      var changed = false;
      var stamp = function(list) {
        var hit = false;
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (!m || !m._localId) continue;
          if (m._localId !== userLid && m._localId !== placeholderLid) continue;
          var ackFlags = m._localId === userLid && m.role === "user" && (!!m.isSendingToServer || !!m._dimSending) && !m._stageId;
          if (m._serverItemId === itemId && !ackFlags) continue;
          var patch = { _serverItemId: itemId };
          if (ackFlags) {
            patch.isSendingToServer = false;
            patch._dimSending = false;
          }
          list[i] = Object.assign({}, m, patch);
          hit = true;
        }
        return hit;
      };
      changed = stamp(this.state.messages);
      var cached = key ? this.aiChatHistoryCache[key] : void 0;
      if (cached) {
        var msgs = cached.messages.slice();
        if (stamp(msgs)) {
          this.aiChatHistoryCache[key] = {
            messages: msgs,
            endOfList: cached.endOfList,
            startKeyHistory: cached.startKeyHistory
          };
        }
      }
      if (changed) this.host.notify();
    }
    _openMap() {
      if (!this._openItems) this._openItems = {};
      return this._openItems;
    }
    _tomb() {
      if (!this._terminalIds) this._terminalIds = {};
      return this._terminalIds;
    }
    /** Remember when the tab was last hidden, for the "watched live" test. */
    _watchVisibility() {
      if (this._visibilityWatched) return;
      this._visibilityWatched = true;
      var doc = _g2.document;
      if (!doc || typeof doc.addEventListener !== "function") return;
      var self = this;
      if (doc.visibilityState === "hidden") this._hiddenAt = Date.now();
      doc.addEventListener("visibilitychange", function() {
        if (doc.visibilityState === "hidden") self._hiddenAt = Date.now();
      });
    }
    /**
     * Follow an item, with its identity pinned NOW (the ack, a page showing it running
     * or waiting, a background entry being adopted). Adding an id already followed
     * changes nothing but its state, and only forward; a terminal id is never reopened.
     */
    trackOpenItem(itemId, init) {
      if (!itemId || !init) return;
      this._watchVisibility();
      if (this._tomb()[itemId]) return;
      var map = this._openMap();
      var state = init.state === "running" ? "running" : "queued";
      var cur = map[itemId];
      if (!cur) {
        var plat = init.platform === "openai" ? "openai" : "claude";
        if (init.platform !== "claude" && init.platform !== "openai") {
          var live = this.host.getIdentity();
          plat = live && live.platform === "openai" ? "openai" : "claude";
        }
        map[itemId] = {
          ownerKey: init.ownerKey || "",
          projectId: init.projectId || "",
          owner: init.owner || "",
          platform: plat,
          queue: init.queue,
          kind: init.kind === "indexing" ? "indexing" : "chat",
          state,
          addedAt: Date.now(),
          lastConfirmed: 0
        };
        if (init.cref) map[itemId].cref = init.cref;
        var who = null;
        if (init.anonymous === void 0 || init.uid === void 0) {
          try {
            who = this.host.getIdentity();
          } catch (e) {
            who = null;
          }
        }
        if (init.anonymous) map[itemId].anonymous = true;
        else if (init.anonymous === void 0 && who && who.anonymous) map[itemId].anonymous = true;
        var uid = init.uid !== void 0 ? init.uid : who ? who.userId : "";
        if (uid) map[itemId].uid = uid;
        this._recEnsure();
        return;
      }
      if (OPEN_STATE_RANK[state] > OPEN_STATE_RANK[cur.state]) cur.state = state;
      if (!cur.queue && init.queue) cur.queue = init.queue;
      if (!cur.cref && init.cref) cur.cref = init.cref;
    }
    /** The pinned identity of an item this page follows, or null. */
    getOpenItem(itemId) {
      return itemId && this._openMap()[itemId] || null;
    }
    /** True once an item's result was applied (or it was cancelled) in this page. */
    isItemSettled(itemId) {
      return !!itemId && !!this._tomb()[itemId];
    }
    _closeItem(itemId) {
      this._tomb()[itemId] = true;
      delete this._openMap()[itemId];
      if (this._recChunks) delete this._recChunks[itemId];
    }
    /** Did the reader watch this turn arrive? Live text was painted into it, or the tab
     *  has stayed visible (with this chat on screen) since the page started following it. */
    _watchedLive(itemId, painted, ownerKey) {
      if (painted) return true;
      var doc = _g2.document;
      if (doc && doc.visibilityState === "hidden") return false;
      if (!this.host.isViewMounted || !this.host.isViewMounted()) return false;
      if (ownerKey && ownerKey !== this.getHistoryCacheKey()) return false;
      var item = this._openMap()[itemId];
      if (!item) return false;
      return !(this._hiddenAt && this._hiddenAt >= item.addedAt);
    }
    /** The identity a settle uses: the caller's, then the pinned one, then the live one. */
    _settleIdentity(itemId, ctx) {
      var c = ctx || {};
      var pin = this._openMap()[itemId];
      var live = null;
      var liveId = function() {
        if (!live) live = this.host.getIdentity() || {};
        return live;
      };
      var ownerKey = c.ownerKey !== void 0 && c.ownerKey !== "" ? c.ownerKey : pin && pin.ownerKey ? pin.ownerKey : this.getHistoryCacheKey();
      var platform = c.platform === "claude" || c.platform === "openai" ? c.platform : pin ? pin.platform : liveId.call(this).platform;
      var projectId = c.projectId !== void 0 ? c.projectId : pin && pin.projectId ? pin.projectId : liveId.call(this).projectId;
      var owner = c.owner !== void 0 ? c.owner : pin && pin.owner ? pin.owner : liveId.call(this).owner;
      return { ownerKey: ownerKey || "", platform: platform === "openai" ? "openai" : "claude", projectId: projectId || "", owner: owner || "" };
    }
    /**
     * Apply how an item ended. The ONLY writer of a settled result; see the section note.
     * `result` is what the server gave back: a provider body, an error body, a cancelled
     * envelope, or a status envelope (which is not a result and is routed instead).
     * True when a bubble was written.
     */
    applyTerminal(itemId, result, ctx) {
      if (!itemId || isPollStopped(result)) return false;
      var c = ctx || {};
      var who = this._settleIdentity(itemId, c);
      if (this._isCancelledPollResult(result)) {
        if (this._tomb()[itemId] && !this._hasWaitingBubble(itemId, who.ownerKey)) return false;
        this._closeItem(itemId);
        this._settleCancelledTurn(itemId, who.ownerKey);
        return true;
      }
      if (isCsrStatusEnvelope(result) && !isErrorResponseBody(result)) {
        if (result.status === "running" || result.status === "pending") {
          this._noteServerState(itemId, result.status, who.ownerKey);
        } else if (result.status === "resolved") {
          this._readBackSettledStream(itemId, who);
        }
        return false;
      }
      if (this._tomb()[itemId] && !c.correction && !this._hasWaitingBubble(itemId, who.ownerKey)) return false;
      var onScreen = !who.ownerKey || who.ownerKey === this.getHistoryCacheKey();
      var outcome = onScreen ? this._applyTerminalOnScreen(itemId, result, who, c) : "missing";
      if (outcome === "missing") outcome = this._applyTerminalToCache(itemId, result, who, c);
      if (outcome === "missing") return false;
      this._closeItem(itemId);
      if (!c.correction) this._noteProviderAnswer(who, result);
      return outcome === "applied";
    }
    /** Hand a settled provider answer to the host (ChatHost.onProviderAnswer), whichever
     *  path read it. Optional, and never in the way of the settle. */
    _noteProviderAnswer(who, result) {
      if (!who || !who.projectId || who.platform !== "claude" && who.platform !== "openai") return;
      var hook;
      try {
        hook = this.host && this.host.onProviderAnswer;
      } catch (e) {
        hook = void 0;
      }
      if (typeof hook !== "function") return;
      try {
        hook(who.projectId, who.platform, result);
      } catch (e) {
      }
    }
    /** A bubble of this item that still reads as waiting (a stale page can put one back). */
    _hasWaitingBubble(itemId, ownerKey) {
      var test = function(m) {
        return !!m && m._serverItemId === itemId && (!!m.isPending || !!m.isPendingQueued || !!m.isPendingInProcess || !!m._streamPending);
      };
      if (!ownerKey || ownerKey === this.getHistoryCacheKey()) {
        if (this.state.messages.some(test)) return true;
      }
      var cached = ownerKey ? this.aiChatHistoryCache[ownerKey] : void 0;
      return !!cached && cached.messages.some(test);
    }
    /** The settled copy of a request bubble: its pending and sending flags come off,
     *  everything that places it (file row, queue, chat, time, render key) stays. */
    _settledUserCopy(u, itemId) {
      var out = { role: "user", content: u.content };
      var sid = itemId || u._serverItemId;
      if (sid) out._serverItemId = sid;
      if (u.isBackgroundTask) out.isBackgroundTask = true;
      if (u._indexFile) out._indexFile = u._indexFile;
      if (u._useBgQueue) out._useBgQueue = true;
      if (u._ownerKey !== void 0) out._ownerKey = u._ownerKey;
      if (u._ts !== void 0) out._ts = u._ts;
      if (u._localId !== void 0) out._localId = u._localId;
      if (u._fromBgChain) out._fromBgChain = true;
      return out;
    }
    /**
     * The shared core: settle the item with id `itemId` inside `list`, by id only.
     * Returns what happened and, for a reply to type out, where and from what.
     */
    _settleInList(list, itemId, result, who, c, mayType) {
      var none = { outcome: "missing", idx: -1, isBg: false, typed: false, text: "", painted: "" };
      var aIdx = -1, settledIdx = -1, uIdx = -1;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m || m._serverItemId !== itemId) continue;
        if (who.ownerKey && m._ownerKey !== void 0 && m._ownerKey !== who.ownerKey) continue;
        if (m.role === "assistant") {
          if (m.isPending || m._streamPending) {
            if (aIdx === -1) aIdx = i;
          } else if (settledIdx === -1) settledIdx = i;
        } else if (m.role === "user" && uIdx === -1) uIdx = i;
      }
      if (aIdx === -1 && c.correction && settledIdx !== -1) aIdx = settledIdx;
      if (aIdx === -1 && uIdx === -1 && settledIdx === -1) return none;
      var u = uIdx !== -1 ? list[uIdx] : null;
      if (aIdx === -1 && settledIdx !== -1) {
        none.outcome = "settled";
        return none;
      }
      if (aIdx === -1 && u && u.isCancelled) {
        none.outcome = "settled";
        return none;
      }
      if (aIdx === -1 && u && !(u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer || u.isPendingOlder)) {
        none.outcome = "settled";
        return none;
      }
      var a = aIdx !== -1 ? list[aIdx] : null;
      var isBg = !!(a && a.isBackgroundTask || u && u.isBackgroundTask);
      var isErr = isErrorResponseBody(result);
      var platform = who.platform;
      var answer = isErr ? getErrorMessage(result) : ((platform === "openai" ? extractOpenAIText(result) : extractClaudeText(result)) || "").trim();
      var reportedComplete = isBg && !isErr && !!answer && answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1;
      var keyOf = a && a._ownerKey !== void 0 ? a._ownerKey : u && u._ownerKey !== void 0 ? u._ownerKey : void 0;
      var reply;
      var typed = false, text = "", painted = "", lid;
      if (isErr) {
        reply = { role: "assistant", content: answer, isError: true, _serverItemId: itemId };
        if (isBg && isRetriedFailure(result)) reply.isRetried = true;
        if (isBg) reply.isBackgroundTask = true;
        else reply._ts = this._replyStampFor(reply);
      } else if (isBg) {
        var bgText = answer || NO_TEXT_RESPONSE;
        if (reportedComplete) bgText = bgText.split(INDEXING_COMPLETE_MARKER).join("").trim();
        reply = { role: "assistant", content: bgText || EMPTY_INDEXING_REPLY, isBackgroundTask: true, _serverItemId: itemId };
        if (reportedComplete) reply._indexComplete = true;
      } else {
        text = answer || NO_TEXT_RESPONSE;
        painted = a && (a.isPending || a._streaming) && typeof a.content === "string" ? a.content : "";
        typed = mayType && !c.instant && this._watchedLive(itemId, painted, who.ownerKey);
        lid = this._newLocalId();
        reply = { role: "assistant", content: typed ? painted : text, _serverItemId: itemId, _localId: lid };
        var note = extractRetrievalNote(result, answer);
        if (note) reply._retrieval = note;
        if (!typed) reply._ts = this._replyStampFor(reply);
      }
      if (keyOf !== void 0) reply._ownerKey = keyOf;
      if (u && (u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer || u.isPendingOlder)) list[uIdx] = this._settledUserCopy(u, itemId);
      var idx;
      if (aIdx !== -1) {
        list[aIdx] = reply;
        idx = aIdx;
      } else {
        idx = uIdx + 1;
        list.splice(idx, 0, reply);
      }
      for (var k = list.length - 1; k >= 0; k--) {
        if (k === idx) continue;
        var d = list[k];
        if (!d || d.role !== "assistant" || d._serverItemId !== itemId || !(d.isPending || d._streamPending)) continue;
        list.splice(k, 1);
        if (k < idx) idx--;
      }
      return { outcome: "applied", idx, isBg, typed, text, lid, painted };
    }
    _applyTerminalOnScreen(itemId, result, who, c) {
      var self = this;
      var r = this._settleInList(this.state.messages, itemId, result, who, c, true);
      if (r.outcome !== "applied") return r.outcome;
      this.host.notify();
      var cacheKey2 = this.getHistoryCacheKey();
      if (r.typed) {
        var lid = r.lid, full = r.text;
        Promise.resolve(this.enqueueTypewrite(r.idx, full, lid, r.painted)).then(function() {
          self._patchCachedText(cacheKey2, lid, full);
        });
      }
      this.updateHistoryCache();
      if (r.typed) this._patchCachedText(cacheKey2, r.lid, r.text);
      if (!r.isBg) {
        this.host.scrollToBottomIfSticky(true);
        this._checkQueuedRunning(who.ownerKey);
      }
      return "applied";
    }
    /** Put the whole text of a reply (found by local id) into a chat's cache copy. */
    _patchCachedText(key, lid, text) {
      var entry2 = key ? this.aiChatHistoryCache[key] : void 0;
      if (!entry2 || !lid) return;
      var msgs = entry2.messages;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m || m._localId !== lid || m.role !== "assistant") continue;
        if (m.content === text) return;
        var next = msgs.slice();
        next[i] = Object.assign({}, m, { content: text });
        this.aiChatHistoryCache[key] = { messages: next, endOfList: entry2.endOfList, startKeyHistory: entry2.startKeyHistory };
        return;
      }
    }
    /** The same settle for a chat that is not on screen: made in its history cache,
     *  which is what the next visit renders. Never typed. */
    _applyTerminalToCache(itemId, result, who, c) {
      var key = who.ownerKey;
      var existing = key ? this.aiChatHistoryCache[key] : void 0;
      if (!existing) return "missing";
      var msgs = existing.messages.slice();
      var r = this._settleInList(msgs, itemId, result, who, c, false);
      if (r.outcome !== "applied") return r.outcome;
      this.aiChatHistoryCache[key] = { messages: msgs, endOfList: existing.endOfList, startKeyHistory: existing.startKeyHistory };
      return "applied";
    }
    /**
     * A read of an item failed (its poll, or a by-id read). Only the server's own answer
     * changes the screen: NOT_EXISTS settles the item as cancelled; a failure on the way
     * (network, timeout, 429, 5xx) or of the sign-in leaves everything as it is, and the
     * next look settles it; any other refusal is shown on the item, by id.
     */
    onPollFailure(itemId, err, ctx) {
      if (!itemId) return "kept";
      this.historyItemPolls.delete(itemId);
      if (isNotExistsError(err)) {
        this.applyTerminal(itemId, cancelledEnvelope(itemId), ctx);
        return "cancelled";
      }
      if (isTransportFailure(err) || isAuthExpiredError(err)) {
        console.warn("[chat-engine] a read of " + itemId + " failed on the way; the item is left as it is", err);
        return "kept";
      }
      this.applyTerminal(itemId, pollErrorBody(err), ctx);
      return "failed";
    }
    /**
     * A streamed turn's row settled 'resolved' with no body: its answer is in the chunk
     * store. A live stream that is still being fed settles it itself; otherwise the
     * chunks are read back by id, and the read's apply goes through the funnel.
     */
    _readBackSettledStream(itemId, who) {
      var st = this.liveStreams[itemId];
      if (st && st.fed && !st.ended) return;
      if (st) this._closeLiveStream(st, false);
      if (!streamRecoveryEnabled() || !resolveForwardRequestStream()) {
        this.applyTerminal(itemId, EMPTY_PROVIDER_BODY, { ownerKey: who.ownerKey, platform: who.platform, projectId: who.projectId, owner: who.owner, instant: true });
        return;
      }
      void this._readBackStreamedTurn(itemId, who.ownerKey, who.platform, who.projectId, who.owner, true);
    }
    /** The server says the item is running (or waiting): move it forward, never back. */
    _noteServerState(itemId, status, ownerKey) {
      if (!itemId || this._tomb()[itemId]) return;
      if (this.cancelledServerIds.has(itemId)) return;
      var item = this._openMap()[itemId];
      if (status === "running") {
        if (item && OPEN_STATE_RANK[item.state] < OPEN_STATE_RANK.running) item.state = "running";
        this._promoteChatItemToRunning(itemId, ownerKey !== void 0 ? ownerKey : item ? item.ownerKey : void 0);
      }
    }
    /**
     * Show a queued chat turn as RUNNING, found by its server id, because the server said
     * so. This replaces the guess that "the next waiting bubble on screen" was the one
     * the server took next. False when that turn is not waiting on screen.
     */
    _promoteChatItemToRunning(itemId, ownerKey) {
      if (ownerKey && ownerKey !== this.getHistoryCacheKey()) return false;
      var msgs = this.state.messages;
      var idx = -1;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m && m.role === "user" && m._serverItemId === itemId && m.isPendingQueued && !m.isBackgroundTask && !m._stageId && !m.isCancelled && !m._cancelling) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return false;
      var ex = msgs[idx];
      var promoted = Object.assign({}, ex, { isPendingInProcess: true });
      delete promoted.isPendingQueued;
      msgs[idx] = promoted;
      var hasPlaceholder = msgs.some(function(m2) {
        return !!m2 && m2.role === "assistant" && m2._serverItemId === itemId && !!m2.isPending;
      });
      if (!hasPlaceholder) {
        var placeholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, _serverItemId: itemId };
        if (ex._ownerKey !== void 0) placeholder._ownerKey = ex._ownerKey;
        if (ex._useBgQueue) placeholder._useBgQueue = true;
        msgs.splice(idx + 1, 0, placeholder);
      }
      this.host.notify();
      this.updateHistoryCache();
      return true;
    }
    /**
     * After a chat turn ends, ask the SERVER whether the next queued turn of this chat
     * runs now, by id: the oldest waiting main-queue turn with a server id is read once
     * (csrHistoryItemLookup) a few times over a few seconds, and promoted when the row
     * says running. Bounded and single: a new call restarts the ladder. A host without
     * the by-id read gets no promotion; the turn shows as answered when its poll settles.
     */
    /** The chat `key` is on screen and none of its main-queue turns shows as running
     *  (no "Thinking..." of an ordinary turn): the next settle will not come to ask. */
    _noRunningChatTurnOnScreen(key) {
      if (!key || key !== this.getHistoryCacheKey()) return false;
      return !this.state.messages.some(function(m) {
        return !!m && !m.isBackgroundTask && !m._useBgQueue && (m.role === "assistant" && !!m.isPending || m.role === "user" && !!m.isPendingInProcess);
      });
    }
    _checkQueuedRunning(ownerKey) {
      var self = this;
      if (this._recNewMode()) {
        void this._recSched().trigger("promote");
        return;
      }
      var lookup = chatEngineConfig().csrHistoryItemLookup;
      if (typeof lookup !== "function") return;
      if (this._queuedCheckTimer) {
        clearTimeout(this._queuedCheckTimer);
        this._queuedCheckTimer = null;
      }
      var delays = [600, 2500, 6e3];
      var step = 0;
      var look = function() {
        self._queuedCheckTimer = null;
        if (ownerKey && ownerKey !== self.getHistoryCacheKey()) return;
        var target;
        var msgs = self.state.messages;
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          if (!m || m.role !== "user" || !m.isPendingQueued || m.isBackgroundTask || m._useBgQueue || m._stageId || m._cancelling) continue;
          var sid = m._serverItemId;
          if (!sid || self._tomb()[sid]) continue;
          if (target === void 0 || sid < target) target = sid;
        }
        if (!target) return;
        var who = self._settleIdentity(target, ownerKey ? { ownerKey } : void 0);
        if (!who.projectId) return;
        var id = target;
        Promise.resolve(lookup(buildHistoryItemFullId(who.platform, who.projectId, id), who.projectId, who.owner)).then(function(body) {
          if (!body || typeof body !== "object" || !isCsrStatusEnvelope(body)) return;
          if (body.status === "running") {
            self._noteServerState(id, "running", ownerKey);
            return;
          }
          if (body.status === "pending") next();
        }, function() {
          next();
        });
      };
      var next = function() {
        step++;
        if (step >= delays.length || self._queuedCheckTimer) return;
        self._queuedCheckTimer = setTimeout(look, delays[step]);
      };
      this._queuedCheckTimer = setTimeout(look, delays[0]);
    }
    /**
     * Settle a send that has NO server id: its POST failed, or the POST answered with a
     * body directly. Found by the bubbles' own local ids, never by position.
     */
    _settleLocalTurn(key, userLid, placeholderLid, reply) {
      if (!userLid && !placeholderLid) return;
      var self = this;
      var apply = function(list) {
        var uIdx = -1, pIdx = -1;
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (!m || !m._localId) continue;
          if (userLid && m._localId === userLid && m.role === "user") uIdx = i;
          else if (placeholderLid && m._localId === placeholderLid && m.role === "assistant") pIdx = i;
        }
        if (uIdx === -1 && pIdx === -1) return false;
        if (pIdx !== -1 && !list[pIdx].isPending) return false;
        if (uIdx !== -1) {
          var u = list[uIdx];
          if (u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer || u._dimSending) list[uIdx] = self._settledUserCopy(u);
        }
        var out = Object.assign({}, reply);
        var host = pIdx !== -1 ? list[pIdx] : uIdx !== -1 ? list[uIdx] : null;
        if (host && host._ownerKey !== void 0) out._ownerKey = host._ownerKey;
        if (out._ts === void 0) out._ts = self._replyStampFor(out);
        if (pIdx !== -1) list[pIdx] = out;
        else list.splice(uIdx + 1, 0, out);
        return true;
      };
      if (!key || key === this.getHistoryCacheKey()) {
        if (apply(this.state.messages)) {
          this.host.notify();
          this.updateHistoryCache();
          this.host.scrollToBottomIfSticky(true);
          return;
        }
      }
      var existing = key ? this.aiChatHistoryCache[key] : void 0;
      if (!existing) return;
      var msgs = existing.messages.slice();
      if (apply(msgs)) this.aiChatHistoryCache[key] = { messages: msgs, endOfList: existing.endOfList, startKeyHistory: existing.startKeyHistory };
    }
    /** A provider body (or error) read as the reply it renders as. */
    _replyFromBody(body, platform) {
      if (isErrorResponseBody(body)) return { role: "assistant", content: getErrorMessage(body), isError: true };
      var text = ((platform === "openai" ? extractOpenAIText(body) : extractClaudeText(body)) || "").trim();
      var reply = { role: "assistant", content: text || NO_TEXT_RESPONSE };
      var note = extractRetrievalNote(body, text);
      if (note) reply._retrieval = note;
      return reply;
    }
    /**
     * projectId/owner are passed explicitly by every caller: a request can be
     * dispatched after the user moved to another project, and re-reading the live
     * identity here would silently send the turn to THAT project instead of the
     * one it was composed for. Falls back to the live read only when a caller
     * omits them.
     */
    _callProviderFor(platform, prompt, messages, system, model, userId, extractContent, fileUrls, projectId, owner, turn) {
      if (projectId === void 0 || owner === void 0) {
        var id = this.host.getIdentity();
        if (projectId === void 0) projectId = id.projectId;
        if (owner === void 0) owner = id.owner;
      }
      var liveId = this.host.getIdentity();
      var mcpScope = { anonymous: liveId.anonymous, publicProjectId: liveId.publicProjectId };
      if (turn) turn.userId = liveId.anonymous ? "" : liveId.userId || "";
      return platform === "openai" ? callOpenAIWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls, void 0, void 0, mcpScope, turn) : callClaudeWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls, void 0, void 0, mcpScope, turn);
    }
    /**
     * A fresh per-send record for the request builder (see requests.ts ChatTurnContext).
     * Chat turns only, and only OpenAI reuses a tool listing: Claude's MCP connector has no
     * equivalent item, and indexing passes never come through here. Off unless the host
     * set `reuseMcpToolList: true` in configureChatEngine.
     */
    _newChatTurn(platform) {
      var on = false;
      try {
        on = chatEngineConfig().reuseMcpToolList === true;
      } catch (_) {
        on = false;
      }
      return { reuseMcpToolList: platform === "openai" && on };
    }
    /**
     * What a settled chat turn means for the stored MCP tool listing: a failure drops it
     * when the turn carried it (forgetMcpListToolsOnFailure decides whether reuse also
     * stops); a good OpenAI body refreshes it. A stopped poll or a cancelled row says
     * nothing either way. Applied once per turn: an exception thrown later by a UI
     * handler on the same chain is not a provider failure.
     */
    _settleChatTurnTools(turn, response, failed) {
      if (!turn || turn.settled) return;
      turn.settled = true;
      if (failed || isErrorResponseBody(response)) {
        forgetMcpListToolsOnFailure(turn, response);
        return;
      }
      if (isPollStopped(response) || this._isCancelledPollResult(response)) return;
      rememberMcpListTools(turn, response);
    }
    /**
     * Send one chat turn and follow it to its end. Two phases (reconciler plan, section 3
     * item 6):
     *
     * ACK. The POST that puts the turn on the server's queue. Only a 401 on THIS request
     * may refresh the session and send again, once. When it comes back with the server
     * id the turn is stamped (params.onItemId, matched by local id), pinned as an open
     * item, and the sending state clears: pendingAgentRequests[key] (an immediate send's
     * marker) is the ack and nothing longer.
     *
     * FOLLOW. The poll on that id. Whatever it ends with goes through applyTerminal or
     * onPollFailure. A failed READ never sends the turn again: a 401 on a poll tick used
     * to resend the whole prompt as a new request while the first one kept running.
     * The one resend left is the server's own FINAL answer saying the turn's
     * credentials expired (the MCP bearer the turn carried went stale): that turn is
     * over and failed, so one fresh turn is sent in its place.
     *
     * params: key, projectId, owner, aiPlatform, aiModel, systemPrompt, text,
     * boundedMessages, userId (the queue), extractContent, fileUrls, plus
     *   userLid / placeholderLid  the local ids of the turn's bubbles (a send with no
     *                             server id is settled through these);
     *   onItemId(itemId)          the ack, every time an id is learned;
     *   onAck(itemId?)            once, when the POST is over either way;
     *   immediate                 an immediate send: marks pendingAgentRequests[key].
     */
    dispatchAgentRequest(params) {
      var self = this;
      var turn;
      var ident = {
        ownerKey: params.key,
        projectId: params.projectId,
        owner: params.owner,
        platform: params.aiPlatform,
        queue: params.userId
      };
      var streamCtx = {
        platform: params.aiPlatform,
        projectId: params.projectId,
        owner: params.owner,
        ownerKey: params.key
      };
      var watermark = self._recNewestKnownId(params.key);
      var post = function() {
        turn = self._newChatTurn(params.aiPlatform);
        if (crefSupported()) {
          turn.cref = newClientRef();
          self._stampCref(params.key, params.userLid, params.placeholderLid, turn.cref);
        }
        return Promise.resolve(
          self._callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId, params.extractContent, params.fileUrls, params.projectId, params.owner, turn)
        );
      };
      var postOnce = function() {
        return post().catch(function(err) {
          if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(post);
          throw err;
        });
      };
      var acked = false;
      var ackResolve = null;
      var ackPromise = new Promise(function(r) {
        ackResolve = r;
      });
      var markAck = function(itemId) {
        if (acked) return;
        acked = true;
        if (self.pendingAgentRequests[params.key] === ackPromise) delete self.pendingAgentRequests[params.key];
        if (ackResolve) ackResolve();
        if (typeof params.onAck === "function") {
          try {
            params.onAck(itemId);
          } catch (e) {
            console.warn("[chat-engine] onAck threw", e);
          }
        }
      };
      var mayResendFor = function(body) {
        return isErrorResponseBody(body) && isAuthExpiredError(body) && !isNonRetryableRequestError(body);
      };
      var resend = function(failed, oldItemId) {
        return self.host.refreshSession().then(postOnce).then(function(next) {
          return follow(next, false);
        }, function(err) {
          self._settleChatTurnTools(turn, err, true);
          if (oldItemId) self.applyTerminal(oldItemId, failed, ident);
          else self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, self._replyFromBody(failed, params.aiPlatform));
          return { itemId: oldItemId, error: err };
        });
      };
      var follow = function(initial, mayResend) {
        var queued = !!initial && !!initial.poll && (initial.status === "pending" || initial.status === "running");
        if (queued && typeof initial.id === "string" && initial.id) {
          var itemId = initial.id;
          self.trackOpenItem(itemId, {
            ownerKey: params.key,
            projectId: params.projectId,
            owner: params.owner,
            platform: params.aiPlatform,
            queue: params.userId,
            kind: "chat",
            state: initial.status === "running" ? "running" : "queued",
            cref: turn && turn.cref || (typeof initial.cref === "string" ? initial.cref : void 0)
          });
          if (typeof params.onItemId === "function") params.onItemId(itemId);
          markAck(itemId);
          var resent = false;
          var resendOnce = function(body) {
            if (resent) return null;
            resent = true;
            return resend(body, itemId);
          };
          var oi = self._openMap()[itemId];
          if (oi) {
            oi.turn = turn;
            if (mayResend) oi.resend = function(body) {
              void resendOnce(body);
            };
          }
          if (initial.status === "running") self._noteServerState(itemId, "running", params.key);
          else if (!params.immediate && self._noRunningChatTurnOnScreen(params.key)) {
            self._checkQueuedRunning(params.key);
          }
          var dp = self._fgPollWithEarlyProbe(initial, itemId, void 0, streamCtx);
          self._trackPoll(itemId, "fg", dp);
          var myHandle = self.historyItemPolls.get(itemId);
          return Promise.resolve(dp).then(function(res) {
            if (self.historyItemPolls.get(itemId) === myHandle) self.historyItemPolls.delete(itemId);
            if (isPollStopped(res)) return { itemId, stopped: true };
            if (mayResend && mayResendFor(res)) {
              self._closeItem(itemId);
              var again = resendOnce(res);
              return again || { itemId, stopped: true };
            }
            self._settleChatTurnTools(turn, res);
            self.applyTerminal(itemId, res, ident);
            return { itemId, response: res };
          }, function(err) {
            self._settleChatTurnTools(turn, err, true);
            if (self.historyItemPolls.get(itemId) !== myHandle) return { itemId, error: err };
            self.onPollFailure(itemId, err, ident);
            return { itemId, error: err };
          });
        }
        markAck(void 0);
        if (queued) {
          return Promise.resolve(initial.poll({ latency: POLL_INTERVAL })).then(function(res) {
            if (isPollStopped(res)) return { stopped: true };
            self._settleChatTurnTools(turn, res);
            self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, self._replyFromBody(res, params.aiPlatform));
            return { response: res };
          }, function(err) {
            self._settleChatTurnTools(turn, err, true);
            self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, { role: "assistant", content: getErrorMessage(err), isError: true });
            return { error: err };
          });
        }
        if (mayResend && mayResendFor(initial)) {
          return resend(initial);
        }
        self._settleChatTurnTools(turn, initial);
        self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, self._replyFromBody(initial, params.aiPlatform));
        return Promise.resolve({ response: initial });
      };
      if (params.immediate) this.pendingAgentRequests[params.key] = ackPromise;
      var posted;
      try {
        posted = postOnce();
      } catch (syncErr) {
        posted = Promise.reject(syncErr);
      }
      var run = posted.then(function(initial) {
        return follow(initial, true);
      }, function(err) {
        markAck(void 0);
        if (turn && turn.cref && isTransportFailure(err) && !isNotExistsError(err) && reconcilerReadsEnabled()) {
          self._recAddPendingSend({
            cref: turn.cref,
            key: params.key,
            userLid: params.userLid,
            placeholderLid: params.placeholderLid,
            projectId: params.projectId,
            owner: params.owner,
            platform: params.aiPlatform === "openai" ? "openai" : "claude",
            queue: params.userId || params.projectId,
            watermark,
            params
          });
          return { error: err, cref: turn.cref, pending: true };
        }
        self._settleChatTurnTools(turn, err, true);
        self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, { role: "assistant", content: getErrorMessage(err), isError: true });
        return { error: err };
      });
      return run;
    }
    /**
     * Put a turn on screen the INSTANT the user hits Send, before its attachments
     * have finished uploading. Uploads run in the background now (the composer is
     * cleared and stays usable), so without a staged bubble the message would
     * appear only once its files were up — below anything the user sent in the
     * meantime, in an order that never matches what they typed.
     *
     * Staged bubbles carry _useBgQueue because that is where a turn with
     * attachments ultimately dispatches (behind its own indexing tasks). That flag
     * is also what keeps the queued-turn promotion (_checkQueuedRunning) off them:
     * it follows the SERVER queue, and a staged turn has no server request behind
     * it yet.
     *
     * Returns the id to hand back as PinnedDispatchContext.stageId at dispatch.
     */
    stageOutgoingMessage(displayText) {
      this._stageSeq += 1;
      var stageId = "stg_" + this._stageSeq;
      var key = this.getHistoryCacheKey();
      var staged = {
        role: "user",
        content: displayText,
        isPendingQueued: true,
        isUploadingAttachments: true,
        isSendingToServer: true,
        _dimSending: true,
        // A staged bubble has no server id for minutes, and its indexing rows are
        // now inserted ABOVE it — so its array index moves. Both views fall back to
        // the index when a bubble has no id, which would re-key (and in Vue, remount)
        // this bubble on every file, restarting its transition and losing it as a
        // scroll anchor. A local id it keeps for its whole life fixes both.
        _localId: this._newLocalId(),
        _useBgQueue: true,
        _stageId: stageId,
        _ts: wallClockNow()
      };
      if (key) staged._ownerKey = key;
      this._liveStages[stageId] = true;
      this.state.messages.push(staged);
      this.host.notify();
      this.host.scrollToBottom(true);
      return stageId;
    }
    /** Is anything in this page still uploading/dispatching for this stage? */
    isLiveStage(stageId) {
      return !!stageId && !!this._liveStages[stageId];
    }
    /**
     * Settle any staged bubble in `list` whose chain no longer exists, and return the
     * list (a new array only if something changed).
     *
     * The caller is a cache restore. A staged bubble is the one kind of message whose
     * resolution lives entirely in page memory — no server request stands behind it
     * yet — so a copy that outlives its upload would render "(Uploading files...)"
     * forever with nothing left to finish it. Today nothing can: this cache dies with
     * the page, so every restored stage is still live and this is a no-op. It exists
     * so that stops being a silent assumption.
     */
    settleDeadStagedMessages(list) {
      if (!Array.isArray(list)) return list;
      var self = this;
      var dead = false;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m && m._stageId && !self._liveStages[m._stageId]) {
          dead = true;
          break;
        }
      }
      if (!dead) return list;
      return list.map(function(m2) {
        if (!m2 || !m2._stageId || self._liveStages[m2._stageId]) return m2;
        var settled = { role: "user", content: m2.content };
        if (m2._ownerKey !== void 0) settled._ownerKey = m2._ownerKey;
        if (m2._ts !== void 0) settled._ts = m2._ts;
        if (m2._localId !== void 0) settled._localId = m2._localId;
        return settled;
      });
    }
    _stageIndex(list, stageId) {
      if (!stageId) return -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i]._stageId === stageId) return i;
      }
      return -1;
    }
    /**
     * Staged turn, phase 2: its files are up and it is now waiting for the whole
     * indexing chain behind them. Swaps "(Uploading files...)" for
     * "(Indexing files...)"; the bubble stays dimmed, because from the user's side
     * nothing has been handed over yet.
     *
     * It deliberately does NOT say "(In queue)" here. The turn is not queued behind
     * anything the server knows about yet — it is waiting on work that can run for
     * minutes — and claiming otherwise is what made the wait look like a stall.
     */
    markStagedMessageIndexing(stageId) {
      var idx = this._stageIndex(this.state.messages, stageId);
      if (idx === -1) return;
      var ex = this.state.messages[idx];
      if (!ex.isUploadingAttachments) return;
      this.state.messages[idx] = Object.assign({}, ex, {
        isUploadingAttachments: false,
        isAwaitingIndexing: true
      });
      this.host.notify();
    }
    /**
     * Staged turn, phase 3: the last of its files has finished indexing, so the turn
     * is genuinely just queued now. Full opacity + "(In queue)".
     *
     * Clears the PRESENTATIONAL _dimSending only; isSendingToServer stays set until
     * the server actually acks (it is the token that ack matches on). Called by the
     * clients the instant awaitIndexingDrained resolves, i.e. immediately before the
     * dispatch that replaces this bubble — dispatchComposedMessage carries the
     * cleared flag onto the replacement so the turn does not blink back to dimmed.
     */
    markStagedMessageReady(stageId) {
      var idx = this._stageIndex(this.state.messages, stageId);
      if (idx === -1) return;
      var ex = this.state.messages[idx];
      if (!ex.isAwaitingIndexing && !ex._dimSending && !ex.isUploadingAttachments) return;
      this.state.messages[idx] = Object.assign({}, ex, {
        isUploadingAttachments: false,
        isAwaitingIndexing: false,
        _dimSending: false
      });
      this.host.notify();
    }
    /**
     * Resolves once this project's background-indexing queue has nothing left to
     * run, so a chat enqueued right after it is genuinely last.
     *
     * Sending the chat as soon as the uploads finish is not enough, which is the
     * whole reason this exists: indexing a file is a CHAIN, and each pass is only
     * enqueued once the previous one lands (the client mints CONTINUE passes for
     * text/grid files, the worker mints them for PDFs and windowed reads). Every
     * one of those passes therefore queues up BEHIND a chat sent at upload time,
     * and the model answers from a file it has only partly read.
     *
     * The queue is read from the server's status index rather than from
     * bgTaskQueue: that mirror holds only what this client dispatched or adopted,
     * and it stops being maintained once the view unmounts. An empty answer has to
     * repeat before it is believed — see INDEXING_DRAIN_IDLE_LOOKS — and a look
     * that fails counts as busy, so a dropped request delays the turn instead of
     * releasing it early.
     *
     * Reads the identity PINNED at Send time, never a live one: the user may be in
     * another project by now, and this must keep asking about the one they sent
     * from.
     */
    awaitIndexingDrained(identity) {
      var self = this;
      var svcId = identity && identity.projectId;
      var platform = identity && identity.platform;
      if (!svcId || platform !== "claude" && platform !== "openai") return Promise.resolve("skipped");
      var ident = { projectId: svcId, owner: identity.owner, platform, userId: identity.userId };
      var startedAt = nowMs();
      var deadline = startedAt + INDEXING_DRAIN_TIMEOUT_MS;
      var idleLooks = 0;
      var lastIdleAt = 0;
      var lastLookAt = -Infinity;
      var askToken = 0, asked = 0, askedAt = 0;
      var nudged = false;
      return new Promise(function(resolve) {
        var done = false;
        var w;
        var capTimer = null;
        var finish = function(v) {
          if (done) return;
          done = true;
          if (capTimer !== null) {
            clearTimeout(capTimer);
            capTimer = null;
          }
          var i = self._iqWatches.indexOf(w);
          if (i !== -1) self._iqWatches.splice(i, 1);
          var ni = self._drainNudges.indexOf(nudge);
          if (ni !== -1) self._drainNudges.splice(ni, 1);
          resolve(v);
        };
        var nudge = function() {
          if (done || idleLooks > 0 || asked) return;
          if (self._indexDispatchesInFlight > 0) return;
          nudged = true;
          var doc = _g2.document;
          if (doc && doc.visibilityState === "hidden") {
            self._recEnsure();
            return;
          }
          void self._recSched().trigger("frame");
        };
        w = {
          opts: { identity: function() {
            return ident;
          } },
          force: false,
          frame: false,
          runsCheckAt: 0,
          lastTryAt: 0,
          drain: {
            due: function() {
              if (done) return false;
              if (nowMs() >= deadline) {
                finish("timedout");
                return false;
              }
              if (asked) {
                if (nowMs() - askedAt < INDEXING_DRAIN_LOOK_TIMEOUT_MS) return false;
                asked = 0;
                idleLooks = 0;
              }
              var since = nowMs() - lastLookAt;
              if (self._indexDispatchesInFlight > 0) {
                if (since >= INDEXING_DRAIN_BUSY_POLL_MS) {
                  idleLooks = 0;
                  lastLookAt = nowMs();
                }
                return false;
              }
              if (nudged && since >= INDEXING_DRAIN_NUDGE_MIN_GAP_MS) return true;
              return since >= (idleLooks > 0 ? INDEXING_DRAIN_CONFIRM_POLL_MS : INDEXING_DRAIN_BUSY_POLL_MS);
            },
            onAsk: function() {
              askToken += 1;
              asked = askToken;
              askedAt = nowMs();
              lastLookAt = askedAt;
              nudged = false;
              return askToken;
            },
            onSnapshot: function(snap, failed, token) {
              if (done || token !== asked) return;
              asked = 0;
              if (failed || !snap || !snap.checked || Object.keys(snap.keys).length > 0) idleLooks = 0;
              else if (snap.at !== lastIdleAt) {
                idleLooks += 1;
                lastIdleAt = snap.at;
              }
              if (idleLooks >= INDEXING_DRAIN_IDLE_LOOKS && nowMs() - startedAt >= INDEXING_DRAIN_MIN_MS) finish("drained");
            }
          }
        };
        self._iqWatches.push(w);
        self._drainNudges.push(nudge);
        capTimer = setTimeout(function() {
          capTimer = null;
          finish("timedout");
        }, INDEXING_DRAIN_TIMEOUT_MS);
        if (capTimer && typeof capTimer.unref === "function") capTimer.unref();
        void self._recSched().trigger("add");
      });
    }
    /**
     * Abandon a staged turn — its uploads failed outright, so nothing will be
     * dispatched. The bubble stays (the user's text is not silently thrown away)
     * but settles into a plain, non-pending message; the caller reports the
     * failure separately.
     */
    settleStagedMessage(stageId) {
      delete this._liveStages[stageId];
      var idx = this._stageIndex(this.state.messages, stageId);
      if (idx === -1) return;
      var ex = this.state.messages[idx];
      var settled = { role: "user", content: ex.content };
      if (ex._ownerKey !== void 0) settled._ownerKey = ex._ownerKey;
      if (ex._ts !== void 0) settled._ts = ex._ts;
      if (ex._localId !== void 0) settled._localId = ex._localId;
      this.state.messages[idx] = settled;
      this.host.notify();
      this.updateHistoryCache();
    }
    // composed = clean display text; composedForLlm carries office-extraction
    // placeholders for the provider only. useBgQueue routes a post-attachment turn
    // onto the "-bg" queue so it runs after indexing.
    dispatchComposedMessage(composed, useBgQueue, composedForLlm, extractContent, fileUrls, pinned) {
      var self = this;
      var stageId = pinned ? pinned.stageId : void 0;
      if (!composed) {
        if (stageId) this.settleStagedMessage(stageId);
        return;
      }
      var id = pinned ? pinned.identity : this.host.getIdentity();
      if (id.platform === "none") {
        if (stageId) this.settleStagedMessage(stageId);
        return;
      }
      if (stageId) delete this._liveStages[stageId];
      var llmComposed = composedForLlm || composed;
      var key = chatCacheKey(id.projectId, id.platform, id.userId);
      var offChat = !!key && key !== this.getHistoryCacheKey();
      var isQueuedSend = !offChat && (useBgQueue || this.state.sending || this.state.messages.some(function(m) {
        return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue;
      }));
      var aiPlatform = id.platform;
      var aiModel = id.model || void 0;
      var systemPrompt = pinned ? pinned.systemPrompt : this.host.buildSystemPrompt();
      var userId = id.userId || id.projectId;
      var chatQueue = useBgQueue ? bgIndexingQueueName(userId) : userId;
      if (offChat) {
        var offHistory = (this.aiChatHistoryCache[key] ? this.aiChatHistoryCache[key].messages : []).filter(function(m) {
          return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder && !m.isCancelled && !m.isBackgroundTask && !m.isError;
        });
        var offBounded = buildBoundedChatMessages({
          platform: aiPlatform,
          model: aiModel,
          systemPrompt,
          projectId: id.projectId,
          history: offHistory.concat([{ role: "user", content: llmComposed }])
        });
        var offExisting = this.aiChatHistoryCache[key] || { messages: [], endOfList: false, startKeyHistory: [] };
        var offUser = { role: "user", content: composed, _ownerKey: key, _ts: wallClockNow(), _localId: this._newLocalId() };
        var offPlaceholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, _ownerKey: key, _localId: this._newLocalId() };
        var offStage = this._stageIndex(this.state.messages, stageId);
        if (offStage !== -1) {
          if (this.state.messages[offStage]._ts !== void 0) offUser._ts = this.state.messages[offStage]._ts;
          this.state.messages.splice(offStage, 1);
          this.host.notify();
        }
        var offCached = offExisting.messages;
        if (stageId) {
          offCached = offCached.filter(function(m) {
            if (m._stageId !== stageId) return true;
            if (offStage === -1 && m._ts !== void 0) offUser._ts = m._ts;
            return false;
          });
        }
        this.aiChatHistoryCache[key] = {
          messages: offCached.concat([offUser, offPlaceholder]),
          endOfList: offExisting.endOfList,
          startKeyHistory: offExisting.startKeyHistory
        };
        var offUserLid = offUser._localId, offPlaceholderLid = offPlaceholder._localId;
        this.dispatchAgentRequest({
          key,
          projectId: id.projectId,
          owner: id.owner,
          aiPlatform,
          aiModel,
          systemPrompt,
          text: composed,
          boundedMessages: offBounded.messages,
          userId: chatQueue,
          extractContent,
          fileUrls,
          userLid: offUserLid,
          placeholderLid: offPlaceholderLid,
          onItemId: function(itemId) {
            self._stampTurnWithItemId(key, offUserLid, offPlaceholderLid, itemId);
          }
        });
        return;
      }
      if (isQueuedSend) {
        var resolvedHistory = this.state.messages.filter(function(m) {
          return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder && !m.isCancelled && !m.isBackgroundTask && !m.isError;
        });
        var boundedQ = buildBoundedChatMessages({
          platform: aiPlatform,
          model: aiModel,
          systemPrompt,
          projectId: id.projectId,
          history: resolvedHistory.concat([{ role: "user", content: llmComposed }])
        });
        var queuedBubble = { role: "user", content: composed, isPendingQueued: true, isSendingToServer: true, _dimSending: true, _localId: this._newLocalId(), _ts: wallClockNow() };
        if (key) queuedBubble._ownerKey = key;
        if (useBgQueue) queuedBubble._useBgQueue = true;
        var qStage = this._stageIndex(this.state.messages, stageId);
        if (qStage !== -1) {
          var qEx = this.state.messages[qStage];
          if (qEx._ts !== void 0) queuedBubble._ts = qEx._ts;
          if (qEx._dimSending === false) queuedBubble._dimSending = false;
          if (qEx._localId) queuedBubble._localId = qEx._localId;
          this.state.messages.splice(qStage, 1, queuedBubble);
        } else {
          this.state.messages.push(queuedBubble);
        }
        this.host.notify();
        this.updateHistoryCache();
        this.scrollForDispatch(stageId);
        var capturedKey = key;
        var capturedQueuedLid = queuedBubble._localId;
        this.dispatchAgentRequest({
          key,
          projectId: id.projectId,
          owner: id.owner,
          aiPlatform,
          aiModel,
          systemPrompt,
          text: composed,
          boundedMessages: boundedQ.messages,
          userId: chatQueue,
          extractContent,
          fileUrls,
          userLid: capturedQueuedLid,
          onItemId: function(itemId) {
            self._stampTurnWithItemId(capturedKey, capturedQueuedLid, void 0, itemId);
          }
        });
        return;
      }
      var immediateUser = { role: "user", content: composed, _localId: this._newLocalId(), _ts: wallClockNow(), ...key ? { _ownerKey: key } : {} };
      var immediatePlaceholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, _localId: this._newLocalId(), ...key ? { _ownerKey: key } : {} };
      var iStage = this._stageIndex(this.state.messages, stageId);
      if (iStage !== -1) {
        var iEx = this.state.messages[iStage];
        if (iEx._ts !== void 0) immediateUser._ts = iEx._ts;
        if (iEx._localId) immediateUser._localId = iEx._localId;
        this.state.messages.splice(iStage, 1, immediateUser, immediatePlaceholder);
      } else {
        this.state.messages.push(immediateUser);
        this.state.messages.push(immediatePlaceholder);
      }
      this.host.notify();
      this.updateHistoryCache();
      this.state.sending = true;
      this.scrollForDispatch(stageId);
      var immediateUserLid = immediateUser._localId;
      var historyForLlm = this.state.messages.filter(function(m) {
        if (m === immediateUser || immediateUserLid && m && m._localId === immediateUserLid) return false;
        return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder && !m.isCancelled && !m.isBackgroundTask && !m.isError;
      });
      historyForLlm.push({ role: "user", content: llmComposed });
      var bounded = buildBoundedChatMessages({
        platform: aiPlatform,
        model: aiModel,
        systemPrompt,
        projectId: id.projectId,
        history: historyForLlm
      });
      var immediatePlaceholderLid = immediatePlaceholder._localId;
      this.dispatchAgentRequest({
        key,
        projectId: id.projectId,
        owner: id.owner,
        aiPlatform,
        aiModel,
        systemPrompt,
        text: composed,
        boundedMessages: bounded.messages,
        userId: chatQueue,
        extractContent,
        fileUrls,
        immediate: true,
        userLid: immediateUserLid,
        placeholderLid: immediatePlaceholderLid,
        // THE fix for a turn rendering twice after navigate-away-and-back. Until
        // this existed the immediate-send pair carried no server id for its whole
        // life (only the QUEUED path stamped one, off its ack), so nothing could
        // tell the local copy and the server's copy of the same turn apart. See
        // _stampTurnWithItemId.
        onItemId: function(itemId) {
          self._stampTurnWithItemId(key, immediateUserLid, immediatePlaceholderLid, itemId);
        },
        // `sending` clears at the ACK, not when the answer lands (reconciler plan,
        // section 3 item 6). It is session-global (it routes the next send onto the
        // queued path and locks the pickers), and holding it for the whole turn meant
        // a poll that hung wedged every later send in every project. Once acked, the
        // turn's own "Thinking..." bubble is what routes the next send to the queue.
        onAck: function() {
          self.state.sending = false;
          self.host.notify();
        }
      });
    }
    /**
     * Scroll for a dispatch that is going out NOW, but never for one arriving late.
     *
     * A turn with attachments does not dispatch when the user hits Send: it waits out
     * its uploads and then its whole indexing chain, which is minutes
     * (awaitIndexingDrained). By then the reader has very often scrolled up into
     * history to pass the time, and the forcing scrollToBottom yanked them out of it
     * — and worse, force-pinned stickToBottom, which no-ops every method on the
     * scroll anchor and re-arms the queue-detect poll whose only bail is
     * !stickToBottom.
     *
     * `stageId` is the exact marker for that case: only the attachment path ever
     * produces one. The gesture itself was already paid for at stage time, where
     * stageOutgoingMessage forces the scroll while the user is still looking at the
     * composer. Deliberately NOT gated on "did we find the staged bubble" — a remount
     * rebuilds from the cache and the turn is appended rather than replaced, which is
     * just as late and just as unrequested.
     */
    scrollForDispatch(stageId) {
      if (stageId) this.host.scrollToBottomIfSticky(true);
      else this.host.scrollToBottom(true);
    }
    promoteNextBgQueuedToRunning() {
      if (this._recNewMode()) return;
      var listed = {};
      for (var q = 0; q < this.bgTaskQueue.length; q++) {
        var qe = this.bgTaskQueue[q];
        if (qe && qe.byListing) listed[qe.id] = true;
      }
      var guessed = function(m) {
        return !(m._serverItemId && listed[m._serverItemId]);
      };
      if (this.state.messages.some(function(m) {
        return m.isPending && m.role === "assistant" && m.isBackgroundTask && guessed(m);
      })) return;
      var nextIdx = this.state.messages.findIndex(function(m) {
        return m.isPendingQueued && m.role === "user" && m.isBackgroundTask && guessed(m);
      });
      if (nextIdx === -1) return;
      var existing = this.state.messages[nextIdx];
      var promoted = { role: "user", content: existing.content, isPendingInProcess: true, isBackgroundTask: true };
      if (existing._indexFile) promoted._indexFile = existing._indexFile;
      if (existing._ts !== void 0) promoted._ts = existing._ts;
      if (existing._serverItemId !== void 0) promoted._serverItemId = existing._serverItemId;
      if (existing._ownerKey !== void 0) promoted._ownerKey = existing._ownerKey;
      this.state.messages[nextIdx] = promoted;
      var placeholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true };
      if (existing._serverItemId !== void 0) placeholder._serverItemId = existing._serverItemId;
      if (existing._ownerKey !== void 0) placeholder._ownerKey = existing._ownerKey;
      this.state.messages.splice(nextIdx + 1, 0, placeholder);
      this.host.notify();
    }
    /**
     * The next queued chat turn shows "Thinking..." once the SERVER says it runs.
     *
     * This used to promote "the first waiting bubble on screen" the moment any turn
     * ended, which was a guess about the server's queue, and wrong whenever the screen
     * and the queue disagreed: a turn still running on the server after a failed read,
     * a cancel in flight, a send whose ack had not come back. Now it asks: the oldest
     * waiting turn is read by id and promoted when its row says running (see
     * _checkQueuedRunning). Kept public under its old name for hosts that call it.
     */
    promoteNextQueuedToRunning() {
      this._checkQueuedRunning(this.getHistoryCacheKey());
    }
    /**
     * A queued send's answer, routed through the funnel by its server id. Kept for hosts
     * that call it; the engine's own queued path settles through dispatchAgentRequest.
     * Without a server id there is nothing to settle by, and nothing is written.
     */
    onQueuedSendResponse(_composed, response, platform, serverId, ownerKey) {
      if (!serverId) return;
      this.historyItemPolls.delete(serverId);
      this.applyTerminal(serverId, response, { platform, ownerKey });
    }
    /** A queued send's failed read, routed through onPollFailure by its server id. */
    onQueuedSendError(_composed, err, serverId, ownerKey) {
      if (!serverId) return;
      this.onPollFailure(serverId, err, { ownerKey });
    }
    cancelQueuedMessage(msg, idx) {
      var self = this;
      var id = this.host.getIdentity();
      var serverId = msg._serverItemId;
      if (!serverId || msg._cancelling) return;
      var platform = id.platform;
      if (platform !== "claude" && platform !== "openai") return;
      var url = platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
      var queueBase = id.userId || id.projectId;
      var queue = msg.isBackgroundTask || msg._useBgQueue ? bgIndexingQueueName(queueBase) : queueBase;
      var at = this.state.messages[idx] && this.state.messages[idx]._serverItemId === serverId && this.state.messages[idx].role === msg.role ? idx : this.state.messages.findIndex(function(m) {
        return m._serverItemId === serverId && m.role === msg.role;
      });
      if (at !== -1) {
        this.state.messages[at] = Object.assign({}, this.state.messages[at], { _cancelling: true, _cancelError: void 0 });
      }
      this.host.notify();
      Promise.resolve(this.host.cancelRequest({
        url,
        method: "POST",
        id: serverId,
        queue,
        service: id.projectId,
        owner: id.owner
      })).then(function(result) {
        if (result && result.removed) {
          self.cancelledServerIds.add(serverId);
          self._stopPoll(serverId);
          self._closeItem(serverId);
          var qi = self.bgTaskQueue.findIndex(function(e) {
            return e.id === serverId;
          });
          if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
          var removeIdx = self.state.messages.findIndex(function(m) {
            return m._serverItemId === serverId && (m.isPendingQueued || m.isPendingInProcess) && m.role === "user";
          });
          if (removeIdx !== -1) {
            var wasMsg = self.state.messages[removeIdx];
            var cancelledMsg = { role: "user", content: wasMsg.content, isCancelled: true, _serverItemId: serverId };
            if (wasMsg.isBackgroundTask) cancelledMsg.isBackgroundTask = true;
            if (wasMsg._indexFile) cancelledMsg._indexFile = wasMsg._indexFile;
            if (wasMsg._useBgQueue) cancelledMsg._useBgQueue = true;
            if (wasMsg._ownerKey !== void 0) cancelledMsg._ownerKey = wasMsg._ownerKey;
            self.state.messages[removeIdx] = cancelledMsg;
            var thById = self.state.messages.findIndex(function(m) {
              return m._serverItemId === serverId && m.isPending && m.role === "assistant";
            });
            if (thById !== -1) self.state.messages.splice(thById, 1);
            if (msg.isBackgroundTask) self.promoteNextBgQueuedToRunning();
            else self.promoteNextQueuedToRunning();
            self.updateHistoryCache();
          }
          self.host.notify();
        } else {
          var errMsg = result && typeof result.message === "string" && result.message ? result.message : "Could not remove from queue.";
          var ci = self.state.messages.findIndex(function(m) {
            return m._serverItemId === serverId && m.role === "user";
          });
          if (ci !== -1) {
            self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg });
            self.host.notify();
          }
        }
      }).catch(function(err) {
        var errMsg = err && typeof err.message === "string" && err.message ? err.message : "Could not remove from queue.";
        var ci = self.state.messages.findIndex(function(m) {
          return m._serverItemId === serverId && m.role === "user";
        });
        if (ci !== -1) {
          self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg });
          self.host.notify();
        }
      });
    }
    /**
     * Does this bubble get the "Wrong answer?" button: the free function's gate,
     * and only on the latest answer, because the message it sends names no answer
     * and the model reads it right after the last one. An answer already reported
     * keeps its (disabled) button after the complaint turn lands below it.
     */
    canReportWrongAnswer(msg) {
      if (!canReportWrongAnswer(msg)) return false;
      return this.wrongAnswerReported(msg) || this._isLatestAnswer(msg);
    }
    /** True when no chat turn follows `msg` in state.messages. Indexing rows and
     *  cancelled turns do not count (neither reaches the model's history). Matched
     *  by identity or by item id, since agent.vue hands in reactive proxies. */
    _isLatestAnswer(msg) {
      var list = this.state.messages || [];
      var sid = msg._serverItemId, lid = msg._localId;
      for (var i = list.length - 1; i >= 0; i--) {
        var m = list[i];
        if (!m) continue;
        if (m === msg || m.role === "assistant" && (sid && m._serverItemId === sid || lid && m._localId === lid)) return true;
        if (m.isBackgroundTask || m.isCancelled) continue;
        return false;
      }
      return false;
    }
    /** True once this answer's "Wrong answer?" was sent (one click per answer). */
    wrongAnswerReported(msg) {
      if (!msg) return false;
      if (msg._wrongReported) return true;
      var key = msg._serverItemId || msg._localId;
      return !!key && !!this._wrongReported[key];
    }
    /**
     * The "Wrong answer?" button: sends WRONG_ANSWER_MESSAGE as an ordinary visible
     * user turn through dispatchComposedMessage, so it reads the same after a reload
     * and both clients behave alike. The answer is marked first, so the button goes
     * disabled at once. False when the bubble does not qualify or was already used.
     * `pinned` is the caller's usual pinned identity and prompt (agent.vue pins them).
     */
    reportWrongAnswer(msg, pinned) {
      if (this.wrongAnswerReported(msg) || !this.canReportWrongAnswer(msg)) return false;
      msg._wrongReported = true;
      var key = msg._serverItemId || msg._localId;
      if (key) this._wrongReported[key] = true;
      this.host.notify();
      this.dispatchComposedMessage(WRONG_ANSWER_MESSAGE, false, void 0, void 0, void 0, pinned);
      return true;
    }
    /**
     * Stop waiting for the reply to the chat turn that is running now, and move on.
     *
     * `msg` is the turn's pending ASSISTANT bubble (the dot-trail "Thinking"
     * placeholder), which is where both views draw the control. A turn's two bubbles
     * carry the same _serverItemId, so it is also how the request is found.
     * cancelQueuedMessage is the sibling for a turn still waiting in the queue and
     * takes the USER bubble; the two differ in what they are handed and in what has
     * to be unwound afterwards, not in what the server is asked.
     *
     * What ends the wait:
     *   1. csr-cancel marks the running row cancelled. The worker stops relaying and
     *      never stores an answer for it, so the reply cannot turn up later on this
     *      device or another, and history replays the turn as cancelled;
     *   2. the poll on it is stopped, which settles whichever chain was awaiting it
     *      with a stopped result: dispatchAgentRequest's for an immediate send, the
     *      queued chain for a promoted turn, the history poll after a reload. Each
     *      reads a stopped result as "no reply" and releases its poll registration
     *      (state.sending and pendingAgentRequests were already released at the ack);
     *   3. the bubbles settle at once, without waiting for that chain: the user
     *      bubble takes its cancelled form, the placeholder goes, the id is
     *      tombstoned, and the server is asked whether the next queued turn runs now,
     *      so its own "Thinking" appears when it does.
     *
     * What it does NOT do: the provider call already in flight on the worker runs
     * to its end (a streamed one stops within about a second). A message sent
     * behind it on the same queue starts once the worker acks the cancelled row.
     *
     * Refused without a server id (the ack has not come back yet; the views disable
     * the control until it has) and while a cancel is already out. Indexing passes
     * are not this method's business: their Stop is cancelIndexingGroup, which ends
     * the file's whole chain.
     */
    cancelPendingReply(msg, idx) {
      var self = this;
      var id = this.host.getIdentity();
      var serverId = msg._serverItemId;
      if (!serverId || msg._cancelling) return;
      if (msg.role !== "assistant" || !msg.isPending || msg.isBackgroundTask) return;
      var platform = id.platform;
      if (platform !== "claude" && platform !== "openai") return;
      var url = platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
      var queueBase = id.userId || id.projectId;
      var queue = msg._useBgQueue ? bgIndexingQueueName(queueBase) : queueBase;
      var findPlaceholder = function() {
        return self.state.messages.findIndex(function(m) {
          return m._serverItemId === serverId && m.role === "assistant" && !!m.isPending;
        });
      };
      var at = this.state.messages[idx] && this.state.messages[idx]._serverItemId === serverId && this.state.messages[idx].role === "assistant" ? idx : findPlaceholder();
      if (at !== -1) {
        this.state.messages[at] = Object.assign({}, this.state.messages[at], { _cancelling: true, _cancelError: void 0 });
      }
      this.host.notify();
      var unmark = function(errMsg) {
        var ci = findPlaceholder();
        if (ci === -1) return;
        self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg });
        self.host.notify();
      };
      Promise.resolve(this.host.cancelRequest({
        url,
        method: "POST",
        id: serverId,
        queue,
        service: id.projectId,
        owner: id.owner
      })).then(function(result) {
        if (result && result.removed) {
          self._stopPoll(serverId);
          self._closeItem(serverId);
          self._settleCancelledTurn(serverId);
          return;
        }
        unmark(void 0);
      }).catch(function(err) {
        unmark(err && typeof err.message === "string" && err.message ? err.message : "Could not stop this request.");
      });
    }
    /** The cancelled form of a request bubble, with everything that keeps it in
     *  place carried over: the file markers that hold an indexing pass in its
     *  collapsed row, the chat it belongs to, its send time and its render key. */
    _cancelledCopyOf(m, itemId) {
      var cancelled = { role: "user", content: m.content, isCancelled: true };
      if (itemId !== void 0) cancelled._serverItemId = itemId;
      else if (m._serverItemId !== void 0) cancelled._serverItemId = m._serverItemId;
      if (m.isBackgroundTask) cancelled.isBackgroundTask = true;
      if (m._indexFile) cancelled._indexFile = m._indexFile;
      if (m._useBgQueue) cancelled._useBgQueue = true;
      if (m._ownerKey !== void 0) cancelled._ownerKey = m._ownerKey;
      if (m._ts !== void 0) cancelled._ts = m._ts;
      if (m._localId !== void 0) cancelled._localId = m._localId;
      return cancelled;
    }
    /**
     * Settle a turn as cancelled wherever it lives, and let the queue move on.
     *
     * On the chat on screen: every pending placeholder carrying the id goes (a
     * history refetch can have re-mapped the running turn into a second one), the
     * request bubble takes its cancelled form, and the next queued turn is promoted
     * so the conversation does not sit on an "(In queue)" bubble with nothing
     * running. For a chat that is NOT on screen (the user moved on while the turn
     * ran, and it was cancelled from elsewhere) the same edit is made in that chat's
     * history cache, which is what the next visit renders.
     *
     * Idempotent on purpose: a cancel this client made settles the bubbles at once,
     * and the chain that was awaiting the poll settles again a moment later when the
     * stop resolves it. The second pass finds nothing to do.
     */
    _settleCancelledTurn(itemId, ownerKey) {
      if (!itemId) return;
      if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
        this._applyCancelToCache(ownerKey, itemId);
        return;
      }
      var changed = false, wasBg = false;
      for (var i = this.state.messages.length - 1; i >= 0; i--) {
        var m = this.state.messages[i];
        if (!m || m._serverItemId !== itemId) continue;
        if (m.role === "assistant" && m.isPending) {
          this.state.messages.splice(i, 1);
          changed = true;
          continue;
        }
        if (m.role === "user" && !m.isCancelled) {
          if (m.isBackgroundTask) wasBg = true;
          this.state.messages[i] = this._cancelledCopyOf(m, itemId);
          changed = true;
        }
      }
      this.cancelledServerIds.delete(itemId);
      if (!changed) return;
      if (wasBg) this.promoteNextBgQueuedToRunning();
      else this.promoteNextQueuedToRunning();
      this.updateHistoryCache();
      this.host.notify();
    }
    /**
     * _settleCancelledTurn for a chat that is not on screen: the same edit, made in
     * its history cache, by id only. Every bubble of a turn that can be cancelled
     * carries its id: an off-chat send's pair is stamped at the ack like any other
     * (dispatchComposedMessage), and a cancel needs the id to be sent at all. (The
     * positional fallback this had, "the trailing pending placeholder", could take
     * another turn's.)
     */
    _applyCancelToCache(key, itemId) {
      var existing = key ? this.aiChatHistoryCache[key] : void 0;
      if (!existing) return;
      var msgs = existing.messages.slice();
      var changed = false;
      var uIdx = -1;
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (!m || m._serverItemId !== itemId) continue;
        if (m.role === "assistant" && m.isPending) {
          msgs.splice(i, 1);
          changed = true;
        } else if (m.role === "user" && !m.isCancelled && uIdx === -1) uIdx = i;
      }
      if (uIdx !== -1) {
        msgs[uIdx] = this._cancelledCopyOf(msgs[uIdx], itemId);
        changed = true;
      }
      if (!changed) return;
      this.aiChatHistoryCache[key] = { messages: msgs, endOfList: existing.endOfList, startKeyHistory: existing.startKeyHistory };
    }
    /**
     * Stop indexing a file, from its collapsed row — every pass at once, not just
     * the bubble the user happens to see.
     *
     * A big file is indexed as a CHAIN of passes, so cancelling only the live one
     * accomplishes nothing: the next pass is dispatched as soon as it settles.
     * Three things end the chain:
     *   1. every queued/running pass of this file is cancelled server-side
     *      (csr-cancel deletes a queued row and flags a running one "cancelled",
     *      which is also the worker's gate for NOT enqueueing the next window);
     *   2. the file is remembered in cancelledIndexKeys, so the client-driven
     *      resume (maybeResumeIndexing) stops dispatching CONTINUE passes; and
     *   3. any of its passes still sitting in bgTaskQueue is dropped by the next
     *      drain rather than surfacing a fresh "Indexing…" bubble; and
     *   4. the RUN is remembered (state.stoppedIndexIds), because none of the above
     *      necessarily leaves a mark on the conversation — see below — and without
     *      it the collapsed row reported the stopped file as finished.
     *
     * Records already written by the passes that DID run are kept — this stops the
     * work, it does not undo it.
     */
    cancelIndexingGroup(group) {
      var self = this;
      if (!group || !group.key) return;
      var idn = this.host.getIdentity();
      var scoped = indexScopeKey(idn.projectId, idn.platform) + "|" + group.key;
      this.cancelledIndexKeys.add(scoped);
      if (!group.finished) {
        var stoppedIds = {};
        for (var sk in this.state.stoppedIndexIds) stoppedIds[sk] = true;
        (group.members || []).forEach(function(m) {
          var sid = m && m.msg && m.msg._serverItemId;
          if (sid) stoppedIds[sid] = true;
        });
        this.bgTaskQueue.forEach(function(e) {
          if (e && e.id && self._indexKeyOf(e) === scoped) stoppedIds[e.id] = true;
        });
        this.state.stoppedIndexIds = stoppedIds;
        var runPath = group.path || "";
        if (!runPath) {
          (group.members || []).some(function(m) {
            var p = m && m.msg && m.msg._indexFile && m.msg._indexFile.path;
            if (p) {
              runPath = p;
              return true;
            }
            return false;
          });
        }
        if (!runPath) {
          this.bgTaskQueue.some(function(e) {
            if (e && e.storagePath && self._indexKeyOf(e) === scoped) {
              runPath = e.storagePath;
              return true;
            }
            return false;
          });
        }
        if (runPath) {
          var ident = this.host.getIdentity();
          if (ident && ident.projectId) {
            upsertIndexRunRecordSafe(ident.projectId, runPath, { status: "cancelled", finished: Date.now() });
            this._forgetChain(ident.projectId, runPath);
          }
        }
      }
      this._adoptWorkerIndexingPasses(0);
      this._sweepCancelledIndexing();
      var ids = group.cancellableIds || [];
      if (!ids.length) {
        this.host.notify();
        return;
      }
      ids.forEach(function(serverId) {
        var idx = self.state.messages.findIndex(function(m) {
          return m._serverItemId === serverId && m.role === "user" && (m.isPendingQueued || m.isPendingInProcess);
        });
        if (idx === -1) return;
        self.cancelQueuedMessage(self.state.messages[idx], idx);
      });
    }
    // --- typewriter -------------------------------------------------------
    // Reveal `fullText` into a message bubble at a constant wall-clock RATE
    // (chars/second) driven by requestAnimationFrame, rather than a fixed number
    // of characters per fixed-delay tick. This is what keeps typing smooth and
    // cheap on slow machines:
    //
    //   * Each frame reveals `elapsed_ms * CHARS_PER_SEC` characters, so the
    //     visual speed is the same regardless of how long a frame actually took.
    //   * As the bubble's markdown grows, each re-render gets more expensive, so
    //     frames get longer — which makes each frame reveal MORE characters and
    //     therefore do FEWER, larger renders. That converts the old O(n^2)
    //     "re-render the whole growing string once per 3 characters" (which got
    //     slower and slower and pegged the CPU) into roughly O(n): the number of
    //     renders self-throttles to what the machine can actually paint.
    //   * rAF paces us to the browser's paint cycle and pauses in background
    //     tabs, so we never queue work faster than it can be drawn.
    //
    // `paintedText` is what a LIVE STREAM already put in this bubble. The reveal
    // starts from the point the two texts stop agreeing rather than from zero: the
    // authoritative answer still replaces the live one character for character (it is
    // the only source of truth, and this method writes fullText and nothing else), but
    // retyping a paragraph the reader has just watched arrive is the one thing that
    // would make a streamed turn look worse than an unstreamed one.
    typewriteIntoIndex(idx, fullText, localId, paintedText) {
      var self = this;
      if (!fullText) return Promise.resolve();
      var CHARS_PER_SEC = 300;
      var MIN_STEP = 1;
      var MAX_FRAME_MS = 1e3;
      var regions = [], m;
      var fenceRegex = /```[^\n`]+?\.[^\s.`]+\n[\s\S]*?```/g;
      while ((m = fenceRegex.exec(fullText)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
      var linkRegex = createInlineLinkRegex();
      while ((m = linkRegex.exec(fullText)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
      regions.sort(function(a, b) {
        return a.start - b.start;
      });
      this.state.typing = true;
      this.state.typingAbort = false;
      var i = paintedText ? typewriterResumeIndex(paintedText, fullText, regions) : 0;
      var last = nowMs();
      return new Promise(function(resolve) {
        var done = false;
        var doc = _g2.document;
        function isHidden() {
          return !!(doc && doc.hidden);
        }
        function cleanup() {
          if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVisibility);
        }
        function finish() {
          if (done) return;
          done = true;
          cleanup();
          var fi = localId ? self.state.messages.findIndex(function(mm) {
            return mm._localId === localId;
          }) : idx;
          if (fi !== -1) {
            var t = self.state.messages[fi];
            if (t) {
              t.content = fullText;
              self.host.refreshMessageBubble(fi);
            }
          }
          self.state.typing = false;
          resolve();
        }
        function onVisibility() {
          if (isHidden()) finish();
        }
        if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVisibility);
        function frame(t) {
          if (done) return;
          if (self.state.typingAbort || i >= fullText.length || isHidden()) {
            finish();
            return;
          }
          var dt = t - last;
          last = t;
          if (!(dt > 0)) dt = 16;
          if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;
          var step = Math.round(dt * CHARS_PER_SEC / 1e3);
          if (step < MIN_STEP) step = MIN_STEP;
          var next = Math.min(fullText.length, i + step);
          for (var changed = true; changed; ) {
            changed = false;
            for (var k = 0; k < regions.length; k++) {
              var r = regions[k];
              if (next > r.start && i < r.end && r.end > next) {
                next = r.end;
                changed = true;
              }
            }
          }
          if (next > fullText.length) next = fullText.length;
          i = next;
          var currentIdx = localId ? self.state.messages.findIndex(function(mm) {
            return mm._localId === localId;
          }) : idx;
          if (currentIdx === -1) {
            finish();
            return;
          }
          var target = self.state.messages[currentIdx];
          if (!target) {
            finish();
            return;
          }
          target.content = fullText.slice(0, i);
          self.host.refreshMessageBubble(currentIdx);
          self.host.scrollToBottomIfSticky();
          nextFrame(frame);
        }
        if (isHidden()) {
          finish();
          return;
        }
        nextFrame(frame);
      });
    }
    enqueueTypewrite(idx, fullText, localId, paintedText) {
      var self = this;
      var target = this.state.messages[idx];
      if (target && target._ts === void 0) target._ts = this._replyStampFor(target);
      if (!this.typewriterQueue) this.typewriterQueue = Promise.resolve();
      this.typewriterQueue = this.typewriterQueue.then(function() {
        return self.typewriteIntoIndex(idx, fullText, localId, paintedText);
      });
      return this.typewriterQueue;
    }
    // (_removeStrayPendingAssistants, the "Thinking..." sweep that guessed which
    // pending bubble was a stray from the user bubble above it, is gone with the
    // positional writers it cleaned up after. A settle now removes every other waiting
    // copy of ITS OWN request, by id: see _settleInList.)
    // Drop the pending flags on the resolved turn's USER bubble (preserving its
    // content + background-task marker). Needed because a bg "Indexing:" turn's user
    // bubble carries isPendingInProcess; leaving it set keeps the bubble visually
    // stuck and keeps its bgTaskQueue entry alive forever.
    _clearPendingUserBubble(itemId) {
      var uIdx = this.state.messages.findIndex(function(m) {
        return m.role === "user" && m._serverItemId === itemId && (m.isPendingInProcess || m.isPendingQueued || m.isSendingToServer);
      });
      if (uIdx === -1) return;
      var u = this.state.messages[uIdx];
      var cleaned = { role: "user", content: u.content, _serverItemId: itemId };
      if (u.isBackgroundTask) cleaned.isBackgroundTask = true;
      if (u._ts !== void 0) cleaned._ts = u._ts;
      if (u._indexFile) cleaned._indexFile = u._indexFile;
      this.state.messages[uIdx] = cleaned;
    }
    // An immediate send for the chat on screen whose POST has not been acked yet (the
    // view unmounted and remounted mid-request): show the sending state until the ack.
    // Nothing is rendered from here any more. Once acked, the turn is an ordinary open
    // item, and applyTerminal settles it by its id wherever its bubble lives (on screen
    // or in its chat's cache), so a remount needs no replay of the reply.
    resumePendingRequest(_token) {
      var self = this;
      var key = this.getHistoryCacheKey();
      var pending = key ? this.pendingAgentRequests[key] : void 0;
      if (!pending) return Promise.resolve();
      this.state.sending = true;
      this.host.notify();
      return Promise.resolve(pending).catch(function() {
      }).then(function() {
        if (key && self.pendingAgentRequests[key]) return;
        self.state.sending = false;
        self.host.notify();
      });
    }
    _recNewMode() {
      return !this._recReadsOff && reconcilerReadsEnabled();
    }
    _recSched() {
      if (!this._sched) {
        var self = this;
        this._sched = new LookScheduler({
          runLook: function(req) {
            return self._reconcileLook(req);
          },
          work: function() {
            return self._recWork();
          },
          pushLive: function() {
            return statusPushLive();
          },
          onFlags: function(f) {
            if (!!self.state.reconnecting === f.reconnecting && !!self.state.signInNeeded === f.signInNeeded) return;
            self.state.reconnecting = f.reconnecting;
            self.state.signInNeeded = f.signInNeeded;
            self._viewNotify();
          }
        });
      }
      return this._sched;
    }
    /** Keep the chain running at its cadence while there is anything to follow. */
    _recEnsure() {
      if (this._recSyncing) return;
      try {
        this._recSched().ensure();
      } catch (e) {
      }
    }
    /** A view host may be absent (the dashboard's files page): nothing here may throw then. */
    _viewMounted() {
      try {
        return !!(this.host && this.host.isViewMounted && this.host.isViewMounted());
      } catch (e) {
        return false;
      }
    }
    _viewNotify() {
      if (!this._viewMounted()) return;
      try {
        this.host.notify();
      } catch (e) {
      }
    }
    /**
     * Look at the server now. `trigger` says why (default 'return': the user is back, so
     * readers restart and the first page is read). Resolves when that look ends. Any
     * number of calls at once run one look, plus exactly one more for calls that arrive
     * while it runs.
     */
    reconcileNow(trigger) {
      return this._recSched().trigger(trigger || "return");
    }
    /** The sign-in is back: looks resume at once (state.signInNeeded clears on success). */
    noteSignedIn() {
      this._recSched().signedIn();
    }
    /** A chat view was (re)opened: a return look (readers, discovery, first page). */
    noteViewOpened() {
      void this._recSched().trigger("view");
    }
    /** The host changed bgTaskQueue (the files page pushes passes with no chat view):
     *  the new entries join the open set and the chain runs. */
    noteBgQueueChanged() {
      this._syncOpenFromBgQueue();
      this._recEnsure();
    }
    /**
     * True when this page's reconciler follows every bgTaskQueue entry itself, with or
     * without a chat view (the host's skapi-js has the batch reads). A host's own poller of
     * that queue (web-bunnyquery main.vue's fallback poller) then stands down: two
     * followers of one pass race to settle it, and the poller's settle skips the next pass
     * of a file this client drives and its run:: record.
     */
    followsBackgroundQueue() {
      return this._recNewMode();
    }
    /** Stop the reconciler's timer (tests, teardown). Any trigger starts it again. */
    stopReconciler() {
      if (this._sched) this._sched.stop();
    }
    /** Diagnostics: the open set's size, looks run, timers armed, pending sends. */
    reconcilerStats() {
      var sc = this._sched;
      return {
        open: Object.keys(this._openMap()).length,
        looks: sc ? sc.looks : 0,
        timers: sc ? sc.timersArmed : 0,
        generation: sc ? sc.gen : 0,
        pendingSends: Object.keys(this._recPending || {}).length,
        fileRuns: Object.keys(this._fileRuns || {}).length,
        reconnecting: !!this.state.reconnecting,
        signInNeeded: !!this.state.signInNeeded,
        running: !!sc && sc.isRunning()
      };
    }
    /** The bg entry of a pass, by id. */
    _bgEntry(itemId) {
      var q = this.bgTaskQueue || [];
      for (var i = 0; i < q.length; i++) if (q[i] && q[i].id === itemId) return q[i];
      return null;
    }
    /** The queue an indexing pass runs on. */
    _bgQueueOf(entry2) {
      var uid = entry2.identity ? entry2.identity.userId : "";
      return bgIndexingQueueName(uid, entry2.projectId);
    }
    /**
     * Every bgTaskQueue entry is an open item, whoever pushed it (the engine, the files
     * page with no chat view, a host's own code). Its identity is pinned here when the
     * host pushed it without one, from the identity live now when that is the entry's
     * project.
     */
    _syncOpenFromBgQueue() {
      var q = this.bgTaskQueue;
      if (!q || !q.length) return;
      var map = this._openMap(), tomb = this._tomb();
      var live = null;
      this._recSyncing = true;
      try {
        for (var i = 0; i < q.length; i++) {
          var e = q[i];
          if (!e || !e.id || !e.projectId || map[e.id] || tomb[e.id]) continue;
          if (!e.identity) {
            if (!live) {
              try {
                live = this.host.getIdentity();
              } catch (err) {
                live = null;
              }
            }
            if (live && live.projectId === e.projectId) e.identity = Object.assign({}, live, { platform: e.platform });
          }
          if (e.owner === void 0 && e.identity) e.owner = e.identity.owner;
          var uid = e.identity ? e.identity.userId : "";
          if (e.ownerKey === void 0 && e.identity) e.ownerKey = chatCacheKey(e.projectId, e.platform, uid);
          this.trackOpenItem(e.id, {
            ownerKey: e.ownerKey || chatCacheKey(e.projectId, e.platform, uid),
            projectId: e.projectId,
            owner: e.owner || "",
            platform: e.platform,
            queue: bgIndexingQueueName(uid, e.projectId),
            kind: "indexing",
            state: e.status === "running" ? "running" : "queued",
            anonymous: !!(e.identity && e.identity.anonymous),
            uid: e.identity ? e.identity.userId : void 0
          });
        }
      } finally {
        this._recSyncing = false;
      }
      this._persistChains();
    }
    _chainStorage() {
      try {
        var ls = _g2.localStorage;
        return ls && typeof ls.getItem === "function" ? ls : null;
      } catch (e) {
        return null;
      }
    }
    _chainKey(projectId, storagePath) {
      return projectId + "|" + storagePath;
    }
    /** Keep every client-driven pass in bgTaskQueue (the newest pass per file wins). */
    _persistChains() {
      var q = this.bgTaskQueue;
      if (!q || !q.length) return;
      if (!this._chains) this._chains = {};
      var ls = this._chainStorage();
      for (var i = 0; i < q.length; i++) {
        var e = q[i];
        if (!e || !e.id || !e.storagePath || !e.projectId || !e.identity) continue;
        if (e.platform !== "claude" && e.platform !== "openai") continue;
        if (this._chainEnded && this._chainEnded[e.id]) continue;
        if (this._isWorkerDrivenIndexing(e.filename, e.mime)) continue;
        var k = this._chainKey(e.projectId, e.storagePath);
        var cur = this._chains[k];
        if (cur && cur.id >= e.id) continue;
        var rec = {
          projectId: e.projectId,
          platform: e.platform,
          owner: e.owner !== void 0 ? e.owner : e.identity.owner,
          ownerKey: e.ownerKey,
          identity: Object.assign({}, e.identity),
          storagePath: e.storagePath,
          filename: e.filename,
          mime: e.mime,
          size: e.size,
          isReindex: e.isReindex,
          resumePass: e.resumePass || 0,
          id: e.id,
          at: Date.now()
        };
        this._chains[k] = rec;
        if (!ls) continue;
        try {
          var had = ls.getItem(CHAIN_STORE_PREFIX + k);
          var prev = had ? JSON.parse(had) : null;
          if (prev && typeof prev.id === "string" && prev.id > e.id) continue;
          ls.setItem(CHAIN_STORE_PREFIX + k, JSON.stringify(rec));
        } catch (err) {
        }
      }
    }
    /** The chain of this file ended: forget it (only when the kept pass is not newer than
     *  `upToId`, a later run of the same file being newer; without it, whatever is kept). */
    _forgetChain(projectId, storagePath, upToId) {
      if (!projectId || !storagePath) return;
      if (upToId) {
        if (!this._chainEnded) this._chainEnded = {};
        this._chainEnded[upToId] = true;
      }
      var k = this._chainKey(projectId, storagePath);
      if (this._chains && this._chains[k] && (!upToId || this._chains[k].id <= upToId)) delete this._chains[k];
      var ls = this._chainStorage();
      if (!ls) return;
      try {
        var had = ls.getItem(CHAIN_STORE_PREFIX + k);
        if (!had) return;
        var prev = JSON.parse(had);
        if (upToId && prev && typeof prev.id === "string" && prev.id > upToId) return;
        ls.removeItem(CHAIN_STORE_PREFIX + k);
      } catch (err) {
      }
    }
    /** Is a chain of this file kept (this page or another tab of this browser)? */
    _chainKept(projectId, storagePath) {
      var k = this._chainKey(projectId, storagePath);
      if (this._chains && this._chains[k]) return true;
      var ls = this._chainStorage();
      if (!ls) return false;
      try {
        return !!ls.getItem(CHAIN_STORE_PREFIX + k);
      } catch (e) {
        return false;
      }
    }
    /** Once per page, at its first look: the kept chains go back into bgTaskQueue. */
    _restoreChains() {
      if (this._chainsRestored) return;
      this._chainsRestored = true;
      var ls = this._chainStorage();
      if (!ls) return;
      if (!this._recNewMode() && typeof chatEngineConfig().csrHistoryItemLookup !== "function") return;
      var keys = [];
      try {
        for (var i = 0; i < ls.length; i++) {
          var lk = ls.key(i);
          if (lk && lk.indexOf(CHAIN_STORE_PREFIX) === 0) keys.push(lk);
        }
      } catch (e) {
        return;
      }
      if (!this._chains) this._chains = {};
      var tomb = this._tomb();
      var added = false;
      for (var j = 0; j < keys.length; j++) {
        var rec = null;
        try {
          rec = JSON.parse(ls.getItem(keys[j]) || "null");
        } catch (e) {
          rec = null;
        }
        var ok = !!rec && typeof rec.id === "string" && !!rec.projectId && !!rec.storagePath && !!rec.identity && (rec.platform === "claude" || rec.platform === "openai") && typeof rec.at === "number";
        if (!ok || Date.now() - rec.at > CHAIN_STORE_TTL_MS) {
          try {
            ls.removeItem(keys[j]);
          } catch (e) {
          }
          continue;
        }
        var r = rec;
        this._chains[this._chainKey(r.projectId, r.storagePath)] = r;
        if (tomb[r.id] || this.bgTaskQueue.some(function(e) {
          return !!e && e.id === r.id;
        })) continue;
        this.bgTaskQueue.push({
          projectId: r.projectId,
          platform: r.platform,
          id: r.id,
          identity: Object.assign({}, r.identity),
          owner: r.owner,
          ownerKey: r.ownerKey,
          filename: r.filename,
          storagePath: r.storagePath,
          isReindex: r.isReindex,
          mime: r.mime,
          size: r.size,
          status: "pending",
          poll: void 0,
          resumePass: r.resumePass
        });
        added = true;
      }
      if (added && this._viewMounted()) {
        try {
          this.drainBgTaskQueue();
        } catch (e) {
        }
      }
    }
    /** An open indexing pass whose file this client drives (it sends the next pass). */
    _isClientDrivenOpen(itemId) {
      var e = this._bgEntry(itemId);
      return !!e && !!e.storagePath && !this._isWorkerDrivenIndexing(e.filename, e.mime);
    }
    /** What the chain has to follow: anything at all (visible cadence), and what is worth
     *  a look once a minute while the tab is hidden (a client-driven chain: without the
     *  browser its next pass is never sent). Never reads the network. */
    _recWork() {
      var open = this._openMap();
      var any = false, hidden = false;
      var live = this._recLiveUid();
      for (var id in open) {
        if (!this._recReadable(open[id].uid, open[id].projectId, live)) continue;
        any = true;
        if (open[id].kind === "indexing" && this._isClientDrivenOpen(id)) {
          hidden = true;
          break;
        }
      }
      if (this._recPending) {
        for (var c in this._recPending) {
          if (!this._recReadable(this._recPending[c].uid, this._recPending[c].projectId, live)) continue;
          any = true;
          if (this._recPending[c].kind === "indexing") hidden = true;
        }
      }
      if (!any && this._recFirstPageOwed && this._viewMounted()) any = true;
      if (!any && this._fileRuns && Object.keys(this._fileRuns).length && this._viewMounted()) any = true;
      if (!any && this._viewMounted()) {
        try {
          var ident = this.host.getIdentity();
          if (ident && ident.projectId && this._hasLocalLiveIndexWork(ident.projectId)) any = true;
        } catch (e) {
        }
      }
      var iq = this._iqWork();
      return { visible: any || iq.visible, hidden: hidden || iq.hidden };
    }
    /** How a failed read is taken: 'auth' (the sign-in is gone), 'transient' (on the way),
     *  'refused' (the server's own no). */
    _recErrKind(err) {
      var msg = err && typeof err === "object" && typeof err.message === "string" ? err.message.toLowerCase() : typeof err === "string" ? err.toLowerCase() : "";
      if (isAuthExpiredError(err) || msg.indexOf("login is required") !== -1 || msg.indexOf("user login") !== -1) return "auth";
      if (isTransportFailure(err)) return "transient";
      return "refused";
    }
    /** The user id signed in now (ChatIdentity.userId), or null when the host cannot say. */
    _recLiveUid() {
      try {
        var id = this.host.getIdentity();
        return id ? { uid: id.userId || "", projectId: id.projectId || "" } : null;
      } catch (e) {
        return null;
      }
    }
    /**
     * Can the caller signed in now read an item sent under `uid`? A row answers only the
     * identity that made it: after a sign-out (or with another account) every read of it
     * would come back "missing" and settle a turn that is fine as "no longer available".
     * Such an item is left exactly as it is (not read, not counted as work) until its user
     * is back. An item pinned before the user was known (uid = the project id, the hosts'
     * fallback) is always read.
     */
    _recReadable(uid, projectId, live) {
      if (!uid || uid === projectId) return true;
      if (!live) return false;
      var now = live.uid || live.projectId;
      return !!now && uid === now;
    }
    /** The newest server id of a chat known here (on screen, in its cache, or open). */
    _recNewestKnownId(key) {
      var best = "";
      var scan = function(list) {
        if (!list) return;
        for (var i = 0; i < list.length; i++) {
          var sid = list[i] && list[i]._serverItemId;
          if (typeof sid === "string" && sid > best && !list[i].isBackgroundTask) best = sid;
        }
      };
      if (!key || key === this.getHistoryCacheKey()) scan(this.state.messages);
      var cached = key ? this.aiChatHistoryCache[key] : void 0;
      if (cached) scan(cached.messages);
      var open = this._openMap();
      for (var id in open) if (open[id].ownerKey === key && open[id].kind === "chat" && id > best) best = id;
      return best;
    }
    /** Put a send's cref on its bubbles (on screen and in the chat's cache). */
    _stampCref(key, userLid, placeholderLid, cref) {
      if (!userLid && !placeholderLid || !cref) return;
      var stamp = function(list) {
        if (!list) return;
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (!m || !m._localId) continue;
          if (m.role === "user" && m._localId === userLid || m.role === "assistant" && m._localId === placeholderLid) m._cref = cref;
        }
      };
      stamp(this.state.messages);
      var cached = key ? this.aiChatHistoryCache[key] : void 0;
      if (cached) stamp(cached.messages);
    }
    /** A send whose POST got no answer: its row is looked for by cref (see dispatchAgentRequest). */
    _recAddPendingSend(p) {
      if (!this._recPending) this._recPending = {};
      p.sentAt = Date.now();
      p.looks = 0;
      if (p.uid === void 0) {
        var live = this._recLiveUid();
        p.uid = live ? live.uid : "";
      }
      this._recPending[p.cref] = p;
      if (p.kind !== "indexing") this._markLocalTurn(p.key, p.userLid, p.placeholderLid, { _unconfirmed: true });
      void this._recSched().trigger("send");
    }
    /** Patch the bubbles of a local turn (by local id), on screen and in its chat's cache. */
    _markLocalTurn(key, userLid, placeholderLid, patch) {
      var hit = function(m) {
        return !!m && !!m._localId && (m.role === "user" && m._localId === userLid || m.role === "assistant" && m._localId === placeholderLid);
      };
      var apply = function(list) {
        var any = false;
        for (var i = 0; i < list.length; i++) {
          if (!hit(list[i])) continue;
          var next = Object.assign({}, list[i], patch);
          for (var k in patch) if (patch[k] === void 0) delete next[k];
          list[i] = next;
          any = true;
        }
        return any;
      };
      if (!key || key === this.getHistoryCacheKey()) {
        if (apply(this.state.messages)) this._viewNotify();
      }
      var cached = key ? this.aiChatHistoryCache[key] : void 0;
      if (cached) {
        var msgs = cached.messages.slice();
        if (apply(msgs)) this.aiChatHistoryCache[key] = { messages: msgs, endOfList: cached.endOfList, startKeyHistory: cached.startKeyHistory };
      }
    }
    /**
     * Send again a turn that said "Not sent. Retry?". Only ever on the user's click: the
     * reply bubble goes back to waiting and the same send goes out with a new cref. False
     * when `msg` is not such a reply (or was retried already).
     */
    retryNotSent(msg) {
      if (!msg || !msg._notSent || !msg._localId) return false;
      var map = this._notSent || {};
      var rec = map[msg._localId];
      if (!rec) return false;
      delete map[msg._localId];
      var lid = msg._localId;
      var onScreen = !rec.key || rec.key === this.getHistoryCacheKey();
      var params = rec.params;
      if (params.immediate && this._chatBusy(rec.key, onScreen)) {
        params = Object.assign({}, params, { immediate: false, placeholderLid: void 0 });
        rec.params = params;
      }
      var asQueued = !params.immediate;
      var restore = function(list) {
        var hit = false;
        for (var i = list.length - 1; i >= 0; i--) {
          var m = list[i];
          if (!m) continue;
          if (m.role === "assistant" && m._localId === lid && m._notSent) {
            if (rec.placeholderLid && !asQueued) {
              var ph = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, _localId: rec.placeholderLid };
              if (m._ownerKey !== void 0) ph._ownerKey = m._ownerKey;
              list[i] = ph;
            } else {
              list.splice(i, 1);
            }
            hit = true;
          } else if (m.role === "user" && rec.userLid && m._localId === rec.userLid) {
            var back = Object.assign({}, m, asQueued ? { isPendingQueued: true, isSendingToServer: true, _dimSending: true } : {});
            delete back._notSent;
            list[i] = back;
            hit = true;
          }
        }
        return hit;
      };
      if (onScreen && restore(this.state.messages)) {
        this._viewNotify();
        this.updateHistoryCache();
      } else {
        var cached = rec.key ? this.aiChatHistoryCache[rec.key] : void 0;
        if (cached) {
          var msgs = cached.messages.slice();
          if (restore(msgs)) this.aiChatHistoryCache[rec.key] = { messages: msgs, endOfList: cached.endOfList, startKeyHistory: cached.startKeyHistory };
        }
      }
      if (params.immediate && onScreen) {
        this.state.sending = true;
        this._viewNotify();
      }
      this.dispatchAgentRequest(params);
      return true;
    }
    /** Is a send of this chat in flight right now (see retryNotSent)? */
    _chatBusy(key, onScreen) {
      if (key && this.pendingAgentRequests[key]) return true;
      if (!onScreen) return false;
      return !!this.state.sending || !this._noRunningChatTurnOnScreen(this.getHistoryCacheKey());
    }
    /** True for a "Not sent. Retry?" reply that retryNotSent can still send. */
    canRetryNotSent(msg) {
      return !!msg && !!msg._notSent && !!msg._localId && !!(this._notSent && this._notSent[msg._localId]);
    }
    /**
     * Follow an indexing run from its run:: 'working' record (reconciler plan, section 3
     * item 1): the host passes the project's paths whose record says working, after every
     * read of those records. A run stays open until its record says done/error/cancelled
     * (it leaves the list), or a complete look at the queue finds no pass of it. While one
     * is open and not seen live, a look asks the host to read the records again
     * (host.recheckFileRuns) every FILE_RUN_RECHECK_MS: no fixed number of rounds.
     */
    syncFileRuns(projectId, workingPaths, info) {
      if (!projectId) return;
      if (!this._fileRuns) this._fileRuns = {};
      if (!this._fileRunsIdle) this._fileRunsIdle = {};
      var want = {};
      for (var i = 0; i < (workingPaths || []).length; i++) {
        var p = workingPaths[i];
        if (typeof p === "string" && p) want[projectId + "|" + p] = true;
      }
      for (var k in this._fileRuns) {
        if (this._fileRuns[k].projectId === projectId && !want[k]) delete this._fileRuns[k];
      }
      for (var k2 in this._fileRunsIdle) {
        if (k2.indexOf(projectId + "|") === 0 && !want[k2]) delete this._fileRunsIdle[k2];
      }
      var added = false;
      for (var w in want) {
        var path = w.slice(projectId.length + 1);
        var hint = info && info[path];
        if (this._fileRuns[w]) {
          if (hint) {
            this._fileRuns[w].owner = hint.owner;
            this._fileRuns[w].filename = hint.filename;
          }
          continue;
        }
        if (this._fileRunsIdle[w]) continue;
        this._fileRuns[w] = { projectId, storagePath: path, since: Date.now() };
        if (hint) {
          this._fileRuns[w].owner = hint.owner;
          this._fileRuns[w].filename = hint.filename;
        }
        added = true;
      }
      if (added) this._recEnsure();
    }
    /** The runs of a project this page follows, by storage path. */
    openFileRuns(projectId) {
      var out = [];
      var runs = this._fileRuns || {};
      for (var k in runs) if (runs[k].projectId === projectId) out.push(runs[k].storagePath);
      return out;
    }
    /**
     * Watch a project's background indexing queue, with or without a chat view (the
     * dashboard's files page draws its "Indexing" and "Indexed" badges from it). The
     * reconciler's one timer chain reads it (no timer or poll of the page's own):
     *  - at once when the watch starts, on every return (tab shown, wake, online,
     *    reconnect) and when a status frame names the indexing queue;
     *  - every 8 s while the queue holds work or the last read came back cut off (once a
     *    minute while status frames arrive);
     *  - every 2.5 s while the page waits for a second, independent look (wantsConfirm);
     *  - never while the tab is hidden (a refresh() still reads).
     * The answer lands in state.indexQueues[projectId] (IndexQueueSnapshot). Runs the page
     * follows itself (runsOpen) get recheckRuns every FILE_RUN_RECHECK_MS from the same
     * chain. A failed read keeps the last snapshot.
     */
    watchIndexQueue(opts) {
      var self = this;
      var w = { opts, force: true, frame: false, runsCheckAt: 0, lastTryAt: 0 };
      this._iqWatches.push(w);
      this._startStatusPush();
      void this._recSched().trigger("add");
      return {
        stop: function() {
          var i = self._iqWatches.indexOf(w);
          if (i !== -1) self._iqWatches.splice(i, 1);
          if (!self._iqWatches.length && !Object.keys(self._openMap()).length && !self._viewMounted()) self._stopStatusPush();
        },
        refresh: function(maxAgeMs) {
          if (self._iqWatches.indexOf(w) === -1) return Promise.resolve();
          var ident = self._iqIdentity(w);
          if (!ident) return Promise.resolve();
          var snap = self.indexQueueSnapshot(ident.projectId);
          if (snap && maxAgeMs && Date.now() - snap.at < maxAgeMs) return Promise.resolve();
          w.force = true;
          return self._recSched().trigger("add");
        },
        ensure: function() {
          self._recEnsure();
        }
      };
    }
    /** The last read of a project's indexing queue (see watchIndexQueue), or null. */
    indexQueueSnapshot(projectId) {
      var all = this.state.indexQueues;
      return projectId && all && all[projectId] || null;
    }
    _iqIdentity(w) {
      var ident = null;
      try {
        ident = w.opts.identity();
      } catch (e) {
        ident = null;
      }
      if (!ident || !ident.projectId || ident.platform !== "claude" && ident.platform !== "openai") return null;
      return ident;
    }
    /** What the watches give the chain to do (see _recWork). */
    _iqWork() {
      var visible = false, hidden = false;
      for (var i = 0; i < this._iqWatches.length; i++) {
        var w = this._iqWatches[i];
        if (w.drain) {
          visible = true;
          hidden = true;
          continue;
        }
        var ident = this._iqIdentity(w);
        if (!ident) continue;
        var snap = this.indexQueueSnapshot(ident.projectId);
        if (w.force || w.frame || !snap || !snap.checked || Object.keys(snap.keys).length) {
          visible = true;
          continue;
        }
        try {
          if (w.opts.wantsConfirm && w.opts.wantsConfirm()) {
            visible = true;
            continue;
          }
          if (w.opts.runsOpen && w.opts.runsOpen()) visible = true;
        } catch (e) {
        }
      }
      return { visible, hidden };
    }
    /** The watched queues' part of a look: read the ones that are due (see watchIndexQueue). */
    _iqLook(req) {
      var self = this;
      if (!this._iqWatches.length) return Promise.resolve();
      var doc = _g2.document;
      var hidden = !!doc && doc.visibilityState === "hidden";
      var push = statusPushLive();
      var groups = {};
      var list = this._iqWatches.slice();
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        var ident = this._iqIdentity(w);
        if (!ident) continue;
        var now = Date.now();
        if (!w.drain) {
          var runs = false;
          try {
            runs = !!(w.opts.runsOpen && w.opts.recheckRuns && w.opts.runsOpen());
          } catch (e) {
            runs = false;
          }
          if (!runs) w.runsCheckAt = 0;
          else if (!w.runsCheckAt) w.runsCheckAt = now;
          else if (!hidden && now - w.runsCheckAt >= FILE_RUN_RECHECK_MS) {
            w.runsCheckAt = now;
            try {
              w.opts.recheckRuns();
            } catch (e) {
            }
          }
        }
        var due = false;
        var token = 0;
        var confirm = false;
        if (w.drain) {
          due = w.drain.due();
          if (due) token = w.drain.onAsk();
        } else if (w.force) {
          due = true;
        } else if (!hidden) {
          var snap = this.indexQueueSnapshot(ident.projectId);
          var age = now - Math.max(snap ? snap.at : 0, w.lastTryAt);
          var busy = !snap || !snap.checked || Object.keys(snap.keys).length > 0;
          try {
            confirm = !!(w.opts.wantsConfirm && w.opts.wantsConfirm());
          } catch (e) {
            confirm = false;
          }
          due = req.isReturn || !snap && age >= IQ_LIVE_MS || w.frame && age >= IQ_FRAME_GAP_MS || busy && age >= (push ? IQ_PUSH_LIVE_MS : IQ_LIVE_MS) || confirm && age >= IQ_CONFIRM_MS;
        }
        if (!due) continue;
        w.force = false;
        w.frame = false;
        w.lastTryAt = now;
        var fresh = !!w.drain || confirm;
        var key = [ident.projectId, ident.owner, ident.platform, ident.userId || "", fresh ? "f" : ""].join("|");
        if (!groups[key]) groups[key] = { ident, fresh, watches: [], tokens: [] };
        groups[key].watches.push(w);
        groups[key].tokens.push(token);
      }
      return Promise.all(Object.keys(groups).map(function(k) {
        var g = groups[k];
        var tell = function(snap2, failed) {
          for (var j = 0; j < g.watches.length; j++) {
            var d = g.watches[j].drain;
            if (d) {
              try {
                d.onSnapshot(snap2, failed, g.tokens[j]);
              } catch (e) {
              }
            }
          }
        };
        return fetchLiveIndexingKeys({
          service: g.ident.projectId,
          owner: g.ident.owner,
          platform: g.ident.platform,
          userId: g.ident.userId
        }, g.fresh ? { maxAgeMs: 0 } : void 0).then(function(res) {
          if (!req.alive()) {
            tell(null, true);
            return;
          }
          var snap2 = { keys: {}, checked: !!res.checked, at: res.at };
          res.keys.forEach(function(fk) {
            snap2.keys[fk] = true;
          });
          var cur = self.indexQueueSnapshot(g.ident.projectId);
          if (!cur || cur.at <= snap2.at) {
            var next = Object.assign({}, self.state.indexQueues || {});
            next[g.ident.projectId] = snap2;
            self.state.indexQueues = next;
          }
          tell(snap2, false);
        }, function() {
          tell(null, true);
        });
      })).then(function() {
        if (self._iqWork().visible) self._startStatusPush();
        else if (!Object.keys(self._openMap()).length && !self._viewMounted()) self._stopStatusPush();
      });
    }
    _lostKey(run) {
      return run.projectId + "\0" + run.storagePath + "\0" + run.since;
    }
    _flipIfChainLost(run) {
      var self = this;
      if (!run.owner) return false;
      var raw = this._rawListedIndexKeys || {};
      if (raw[run.storagePath] || run.filename && raw[run.filename]) {
        delete this._lostLooks[this._lostKey(run)];
        return true;
      }
      var lk = this._lostKey(run);
      if (!this._lostLooks[lk]) {
        this._lostLooks[lk] = 1;
        return true;
      }
      delete this._lostLooks[lk];
      var live = null;
      try {
        live = this.host.getIdentity();
      } catch (e2) {
        live = null;
      }
      if (!live || !live.userId || live.userId !== run.owner || live.projectId !== run.projectId) return false;
      var name = run.filename || run.storagePath.split("/").pop() || run.storagePath;
      if (this._isWorkerDrivenIndexing(name, void 0)) return false;
      if (workerIndexEndingsEnabled() && !isPagedReadFile(name, void 0)) return false;
      if (this._chainKept(run.projectId, run.storagePath)) return false;
      for (var q = 0; q < this.bgTaskQueue.length; q++) {
        var e = this.bgTaskQueue[q];
        if (e && e.projectId === run.projectId && e.storagePath === run.storagePath) return false;
      }
      if (this._recPending) for (var c in this._recPending) {
        if (this._recPending[c].kind === "indexing" && this._recPending[c].projectId === run.projectId) return false;
      }
      var projectId = run.projectId, path = run.storagePath;
      runSettleSideEffect(projectId, bgIndexingQueueName(live.userId, projectId), "lost:" + projectId + ":" + path + ":" + run.since, function() {
        return upsertIndexRunRecordSafe(projectId, path, { status: "error", finished: Date.now(), error: CHAIN_LOST_TEXT }, { report: true }).then(function() {
          if (typeof self.host.recheckFileRuns === "function") {
            try {
              self.host.recheckFileRuns(projectId, [path]);
            } catch (e2) {
            }
          }
        });
      });
      return false;
    }
    /** A file run the queue says is live, or that this page has a pass queued for. */
    _fileRunLive(run) {
      var keys = this.state.liveIndexKeys || {};
      if (keys[run.storagePath]) return true;
      var q = this.bgTaskQueue || [];
      for (var i = 0; i < q.length; i++) {
        if (q[i] && q[i].projectId === run.projectId && q[i].storagePath === run.storagePath) return true;
      }
      return false;
    }
    /** Ask the host to read the records of open runs that are not seen live. */
    _recCheckFileRuns(projectId) {
      var runs = this._fileRuns || {};
      var paths = [];
      for (var k in runs) if (runs[k].projectId === projectId && !this._fileRunLive(runs[k])) paths.push(runs[k].storagePath);
      if (!paths.length || typeof this.host.recheckFileRuns !== "function") return;
      if (nowMs() - this._fileRunCheckAt < FILE_RUN_RECHECK_MS) return;
      this._fileRunCheckAt = nowMs();
      try {
        this.host.recheckFileRuns(projectId, paths);
      } catch (e) {
      }
    }
    /** A COMPLETE look at the queue (both listings shorter than their limit) found no pass
     *  for these runs: they are over. The host reads their records one last time. */
    _closeIdleFileRuns(projectId) {
      var runs = this._fileRuns || {};
      var closed = [];
      for (var k in runs) {
        if (runs[k].projectId !== projectId || this._fileRunLive(runs[k])) continue;
        if (this._flipIfChainLost(runs[k])) continue;
        closed.push(runs[k].storagePath);
        delete runs[k];
        if (!this._fileRunsIdle) this._fileRunsIdle = {};
        this._fileRunsIdle[k] = true;
      }
      if (closed.length && typeof this.host.recheckFileRuns === "function") {
        try {
          this.host.recheckFileRuns(projectId, closed);
        } catch (e) {
        }
      }
    }
    /**
     * Rule 3 of 4b: on every return each live stream reader is stopped (and its in-flight
     * read aborted) before the look decides anything; a fresh one starts after the look if
     * the turn still streams. A reader whose poll cannot be stopped (an older skapi-js) is
     * left alone, and none is added beside it.
     */
    _recStopLiveReaders() {
      var ids = Object.keys(this.liveStreams || {});
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var h = this.historyItemPolls.get(id);
        if (!h || typeof h.stop !== "function") continue;
        this._stopPoll(id);
        var st = this.liveStreams[id];
        if (st) this._closeLiveStream(st, false);
      }
    }
    /** Start the one reader of a running streamed turn on screen that has none. */
    _recStartReaders() {
      if (!liveStreamingEnabled() || !this._viewMounted()) return;
      var doc = _g2.document;
      if (doc && doc.visibilityState === "hidden") return;
      var key = this.getHistoryCacheKey();
      var open = this._openMap();
      for (var id in open) {
        var it = open[id];
        if (it.kind !== "chat" || it.lastStatus !== "running" || !it.stream || it.ownerKey !== key) continue;
        if (this.historyItemPolls.has(id) || this.liveStreams[id]) continue;
        this._recAttachReader(id, it);
      }
    }
    _recAttachReader(itemId, item) {
      var read = resolveForwardRequestStream();
      if (!read) return;
      var self = this;
      var url = item.platform === "openai" ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
      var source = {
        poll: function(o) {
          return read(itemId, {
            url,
            method: "POST",
            service: item.projectId,
            owner: item.owner,
            since: 0,
            poll: Math.max(1e3, o && o.latency || 1e3),
            onStream: o && o.onStream,
            onResponse: o && o.onResponse,
            onError: o && o.onError
          });
        }
      };
      var ctx = { ownerKey: item.ownerKey, projectId: item.projectId, owner: item.owner, platform: item.platform };
      var dp;
      try {
        dp = this._fgPollWithEarlyProbe(source, itemId, void 0, { platform: item.platform, projectId: item.projectId, owner: item.owner, ownerKey: item.ownerKey });
      } catch (e) {
        return;
      }
      if (!dp) return;
      this._trackPoll(itemId, "fg", dp);
      var handle = this.historyItemPolls.get(itemId);
      Promise.resolve(dp).then(function(res) {
        if (self.historyItemPolls.get(itemId) === handle) self.historyItemPolls.delete(itemId);
        if (isPollStopped(res)) return;
        self.applyTerminal(itemId, res, ctx);
      }, function(err) {
        if (self.historyItemPolls.get(itemId) === handle) self.historyItemPolls.delete(itemId);
        self.onPollFailure(itemId, err, ctx);
      });
    }
    /** One look. See the section note. Never throws; never changes the screen on a failure. */
    _reconcileLook(req) {
      var iq = this._iqLook(req).catch(function(e) {
        console.warn("[chat-engine] index queue read failed", e);
      });
      return Promise.all([this._reconcileChatLook(req), iq]).then(function(r) {
        return r[0];
      });
    }
    _reconcileChatLook(req) {
      var self = this;
      this._restoreChains();
      this._syncOpenFromBgQueue();
      if (req.isReturn) this._recReturnAt = nowMs();
      if (!this._recNewMode()) return this._reconcileLookLegacy(req);
      var outcome = "ok";
      var fail = function(err) {
        var k = self._recErrKind(err);
        if (k === "auth") outcome = "auth";
        else if (k === "transient" && outcome !== "auth") outcome = "transient";
        return k;
      };
      if (req.isReturn) this._recStopLiveReaders();
      return Promise.resolve().then(function() {
        return self._recDiscover(req, fail);
      }).then(function() {
        if (req.alive()) self._recFirstPage(req);
      }).then(function() {
        return req.alive() ? self._recReadStatuses(req, fail) : void 0;
      }).then(function() {
        return req.alive() ? self._recRetryUnloadable(req) : void 0;
      }).then(function() {
        if (!req.alive()) return outcome;
        if (self._recFollowUps > 0) self._recFollowUps--;
        self._recStartReaders();
        self._recIndexingCheck(req);
        if (!Object.keys(self._openMap()).length && !self._viewMounted() && !self._iqWatches.length) self._stopStatusPush();
        return outcome;
      });
    }
    /**
     * The look of a host whose skapi-js has no batch reads: today's polls stay, and the
     * look re-attaches what a failed poll let go of (onPollFailure 'kept', a bg entry whose
     * read failed): one by-id read each through csrHistoryItemLookup, a few per look.
     */
    _reconcileLookLegacy(req) {
      var self = this;
      var outcome = "ok";
      var open = this._openMap();
      var live = this._recLiveUid();
      var unpolledBg = false;
      if (this._countBgPolls() < MAX_CONCURRENT_BG_POLLS) for (var oid in open) {
        if (open[oid].kind !== "indexing" || this.historyItemPolls.has(oid)) continue;
        var oe = this._bgEntry(oid);
        if (oe && !oe.byListing) {
          unpolledBg = true;
          break;
        }
      }
      if ((req.isReturn || unpolledBg) && this._viewMounted() && !this.isPollingPaused()) this.drainBgTaskQueue();
      this._recFirstPage(req);
      this._recIndexingCheck(req);
      var lookup = chatEngineConfig().csrHistoryItemLookup;
      if (typeof lookup !== "function") return Promise.resolve(outcome);
      var headless = !this._viewMounted();
      var rank = function(id) {
        var e = self._bgEntry(id);
        return e && e.status !== "running" ? 1 : 0;
      };
      var ids = Object.keys(open).filter(function(id) {
        if (self.historyItemPolls.has(id) || self.liveStreams[id]) return false;
        if (!self._recReadable(open[id].uid, open[id].projectId, live)) return false;
        var e = self._bgEntry(id);
        if (e && e.byListing && !headless) return false;
        if (e && e.status !== "running" && !headless) return false;
        return true;
      }).sort(function(a, b) {
        return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
      }).slice(0, MAX_CONCURRENT_BG_POLLS);
      return Promise.all(ids.map(function(id) {
        var item = open[id];
        if (!item || !item.projectId) return Promise.resolve();
        var who = { ownerKey: item.ownerKey, projectId: item.projectId, owner: item.owner, platform: item.platform };
        return Promise.resolve(lookup(buildHistoryItemFullId(item.platform, item.projectId, id), item.projectId, item.owner)).then(function(body) {
          if (!req.alive() || !self._openMap()[id]) return;
          item.lastConfirmed = nowMs();
          if (isCsrStatusEnvelope(body) && (body.status === "running" || body.status === "pending")) {
            item.lastStatus = body.status;
            if (typeof body.executed === "number" && body.executed > 0) item.executedAt = body.executed;
            if (body.status === "running") {
              if (item.kind === "chat") self._noteServerState(id, "running", item.ownerKey);
              else self._recPromoteBg(id);
            }
            return;
          }
          var entry2 = item.kind === "indexing" ? self._bgEntry(id) : null;
          var started = item.executedAt;
          if (started === void 0 && isCsrStatusEnvelope(body) && typeof body.executed === "number" && body.executed > 0) started = body.executed;
          if (entry2) return self._settleBgOutcome(entry2, entry2.platform, Promise.resolve(body), function() {
            return started;
          }).then(function() {
            self._recAfterApply(id, item);
          });
          if (item.kind === "indexing") self.handleHistoryItemResolution(id, body, item.platform, started, who);
          else self.applyTerminal(id, body, who);
          self._recAfterApply(id, item);
        }, function(err) {
          if (!req.alive()) return;
          if (isNotExistsError(err)) {
            var entry2 = item.kind === "indexing" ? self._bgEntry(id) : null;
            if (entry2) return self._settleBgOutcome(entry2, entry2.platform, Promise.reject(err), function() {
              return void 0;
            });
            self.onPollFailure(id, err, who);
            return;
          }
          var k = self._recErrKind(err);
          if (k === "auth") outcome = "auth";
          else if (k === "transient" && outcome !== "auth") outcome = "transient";
        });
      })).then(function() {
        return outcome;
      });
    }
    /**
     * The discovery listing: rows of a chat's queue newer than what the page knows, ids and
     * status only. On a return (the chat on screen), and while a send waits for its row
     * (its chat). A row carrying a waiting send's cref IS that send: its bubbles get the id
     * and it is followed like any acked turn. A waiting send no complete listing has shown
     * twice says "Not sent. Retry?". A live row nothing here knows makes the look read the
     * first page.
     */
    _recDiscover(req, fail) {
      var self = this;
      var pend = this._recPending || {};
      var live = this._recLiveUid();
      var pendList = Object.keys(pend).map(function(k) {
        return pend[k];
      }).filter(function(p) {
        return self._recReadable(p.uid, p.projectId, live);
      });
      if (!req.isReturn && !pendList.length) return Promise.resolve();
      var chats = {};
      var chatId = function(key2, queue) {
        return key2 + "\0" + queue;
      };
      if (req.isReturn && this._viewMounted()) {
        var id = null;
        try {
          id = this.host.getIdentity();
        } catch (e) {
          id = null;
        }
        if (id && id.projectId && (id.platform === "claude" || id.platform === "openai")) {
          var key = this.getHistoryCacheKey();
          var q0 = id.userId || id.projectId;
          chats[chatId(key, q0)] = { key, projectId: id.projectId, owner: id.owner, platform: id.platform, queue: q0 };
        }
      }
      pendList.forEach(function(p) {
        var ck = chatId(p.key, p.queue);
        if (!chats[ck]) chats[ck] = { key: p.key, projectId: p.projectId, owner: p.owner, platform: p.platform, queue: p.queue };
      });
      return Promise.all(Object.keys(chats).map(function(k) {
        var c = chats[k];
        var known = self._recNewestKnownId(c.key);
        var after = known;
        var mine = pendList.filter(function(p) {
          return p.key === c.key && p.queue === c.queue;
        });
        for (var i = 0; i < mine.length; i++) {
          if (!mine[i].watermark) after = "";
          else if (after && mine[i].watermark < after) after = mine[i].watermark;
        }
        return Promise.resolve(getChatHistory({
          service: c.projectId,
          owner: c.owner,
          platform: c.platform,
          queue: c.queue,
          queue_exact: true,
          fields: "ids",
          after: after || void 0,
          deadline: req.remaining(),
          signal: req.signal,
          fresh: true
        }, { limit: 100, fetchMore: false })).then(function(res) {
          if (!req.alive()) return;
          self._recApplyDiscovery(c, res, mine, known);
        }, function(err) {
          if (fail(err) === "refused" && req.alive()) self._recApplyDiscovery(c, { list: [], endOfList: true }, mine, known);
        });
      })).then(function() {
      });
    }
    _recApplyDiscovery(c, res, mine, known) {
      var list = res && Array.isArray(res.list) ? res.list : [];
      var complete = !res || res.endOfList !== false;
      var pend = this._recPending || {};
      var open = this._openMap(), tomb = this._tomb();
      var unknown = false;
      var oldest = "";
      var onScreen = c.key === this.getHistoryCacheKey();
      var msgs = this.state.messages;
      var shown = function(rid) {
        return msgs.some(function(m) {
          return !!m && m._serverItemId === rid;
        });
      };
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        if (!row || typeof row.id !== "string") continue;
        if (!oldest || row.id < oldest) oldest = row.id;
        var p = typeof row.cref === "string" ? pend[row.cref] : void 0;
        if (p && p.key === c.key && p.queue === c.queue) {
          if (p.kind === "indexing") {
            delete pend[p.cref];
            if (p.onFound) {
              try {
                p.onFound(row);
              } catch (e) {
                console.warn("[chat-engine] a found pass threw", e);
              }
            }
          } else {
            this._recMatchPending(p, row);
          }
          continue;
        }
        if (open[row.id] || tomb[row.id] || !onScreen) continue;
        if (row.status === "pending" || row.status === "running" || !!known && row.id > known && !isBgIndexingQueue(c.queue)) {
          if (!shown(row.id)) unknown = true;
        }
      }
      for (var j = 0; j < mine.length; j++) {
        var ps = mine[j];
        if (!pend[ps.cref]) continue;
        var covers = complete || !!oldest && requestIdTimeMs(oldest) > 0 && requestIdTimeMs(oldest) < (ps.sentAt || 0) - 2 * 60 * 1e3;
        if (!covers) continue;
        ps.looks = (ps.looks || 0) + 1;
        if (ps.looks >= 2 && Date.now() - (ps.sentAt || 0) >= NOT_SENT_MIN_AGE_MS) {
          if (ps.kind === "indexing") {
            delete pend[ps.cref];
            if (ps.onMissing) {
              try {
                ps.onMissing();
              } catch (e) {
                console.warn("[chat-engine] a missing pass threw", e);
              }
            }
          } else {
            this._recNotSent(ps);
          }
        }
      }
      if (unknown) this._recFirstPageOwed = true;
    }
    /** A waiting send's row was found by its cref: the send was received after all. */
    _recMatchPending(p, row) {
      if (this._recPending) delete this._recPending[p.cref];
      var id = row.id;
      this._markLocalTurn(p.key, p.userLid, p.placeholderLid, { _unconfirmed: void 0 });
      if (p.params && typeof p.params.onItemId === "function") {
        try {
          p.params.onItemId(id);
        } catch (e) {
          console.warn("[chat-engine] onItemId threw", e);
        }
      } else {
        this._stampTurnWithItemId(p.key, p.userLid, p.placeholderLid, id);
      }
      this.trackOpenItem(id, {
        ownerKey: p.key,
        projectId: p.projectId,
        owner: p.owner,
        platform: p.platform,
        queue: p.queue,
        kind: "chat",
        state: row.status === "running" ? "running" : "queued",
        cref: p.cref,
        uid: p.uid
      });
      if (row.status === "running") this._noteServerState(id, "running", p.key);
    }
    /** Two complete listings never showed the send: it did not reach the server. Shown as
     *  "Not sent. Retry?" and never sent again unless the user asks (retryNotSent). */
    _recNotSent(p) {
      if (this._recPending) delete this._recPending[p.cref];
      var lid = p.placeholderLid || this._newLocalId();
      if (!this._notSent) this._notSent = {};
      this._notSent[lid] = p;
      this._settleLocalTurn(p.key, p.userLid, p.placeholderLid, { role: "assistant", content: NOT_SENT_TEXT, isError: true, _notSent: true, _localId: lid });
      this._markLocalTurn(p.key, p.userLid, void 0, { _notSent: true, _unconfirmed: void 0 });
    }
    /** The first history page, merged (loadHistory's own merge), on a return or when a live
     *  row nothing here knows was seen. Not awaited: the look's own reads decide its outcome,
     *  and the merge applies itself. Owed (run by a later look) while a load is in flight or
     *  polling is paused. */
    _recFirstPage(req) {
      var wants = false;
      for (var t in req.triggers) if (t !== "tick" && t !== "add" && t !== "promote" && t !== "send" && t !== "frame") wants = true;
      if (!wants && !this._recFirstPageOwed) return;
      if (!this._viewMounted()) {
        this._recFirstPageOwed = false;
        return;
      }
      var id = null;
      try {
        id = this.host.getIdentity();
      } catch (e) {
        id = null;
      }
      if (!id || !id.projectId || id.platform === "none") {
        this._recFirstPageOwed = false;
        return;
      }
      if (nowMs() - this._recFirstPageAt < CATCH_UP_MIN_GAP_MS) return;
      if (this.isPollingPaused() || this.state.loadingHistory) {
        this._recFirstPageOwed = true;
        return;
      }
      this._recFirstPageOwed = false;
      this._recFirstPageAt = nowMs();
      void this.loadHistory(false, this.state.gateRefreshToken).catch(function(e) {
        console.warn("[chat-engine] first-page read failed", e);
      });
    }
    /** The indexing queue check (adoption, page progress, file runs), at its own cadence
     *  inside the one chain. Needs the chat view: what it adopts are rows of that chat. */
    _recIndexingCheck(req) {
      if (!this._viewMounted() || this.isPollingPaused()) return;
      var id = null;
      try {
        id = this.host.getIdentity();
      } catch (e) {
        id = null;
      }
      if (!id || !id.projectId || id.platform !== "claude" && id.platform !== "openai") return;
      var gap = statusPushLive() ? STATUS_PUSH_ADOPT_TICK_MS : ADOPT_TICK_MS;
      var due = req.isReturn || !!req.triggers.frame || nowMs() - this._recAdoptAt >= gap;
      var runs = this.openFileRuns(id.projectId).length > 0;
      if (due && (this._hasLocalLiveIndexWork(id.projectId) || runs)) {
        this._recAdoptAt = nowMs();
        this._adoptWorkerIndexingPasses(0, false, true);
        if (!this._recNewMode()) this._settleByListing();
        this._refreshPageProgress();
      }
      if (runs) this._recCheckFileRuns(id.projectId);
    }
    /**
     * Read the queue counters and, when needed, the status of the open items.
     *
     * WHICH ITEMS. A row read costs as much as the conversation it carries, so a look reads
     * every open item only on a return and at the stale watch (once a minute). Otherwise it
     * reads only the items whose status can have changed: the ones never confirmed or seen
     * terminal, the ones a status frame named, and, when a counter moved or something
     * nudged the look (a settle asking for the next turn, a send), the running items plus
     * the head of each queue's line (a queue runs its requests in order, so only the first
     * few waiting ones can have started). A bulk upload's hundreds of waiting passes are
     * then read once a minute, not on every finish.
     */
    _recReadStatuses(req, fail) {
      var self = this;
      var open = this._openMap();
      var live = this._recLiveUid();
      var groups = {};
      for (var id in open) {
        var it = open[id];
        if (!it.projectId) continue;
        if (!this._recReadable(it.uid, it.projectId, live)) continue;
        var g = it.projectId + "\0" + (it.owner || "");
        if (!groups[g]) groups[g] = { projectId: it.projectId, owner: it.owner || "", ids: [], queues: {} };
        groups[g].ids.push(id);
        var qn = queueNameOf(it.queue);
        if (qn) groups[g].queues[qn] = true;
      }
      var frames = this._recFrameIds || {};
      this._recFrameIds = {};
      var keys = Object.keys(groups);
      if (!keys.length) return Promise.resolve();
      var full = req.isReturn || nowMs() - this._recFullReadAt >= LOOK_STALE_MS;
      var nudged = this._recFollowUps > 0;
      for (var t in req.triggers) if (t !== "tick" && t !== "add" && t !== "frame") nudged = true;
      if (full) this._recFullReadAt = nowMs();
      return Promise.all(keys.map(function(k) {
        return self._recReadGroup(req, groups[k], full, nudged, frames, fail);
      })).then(function() {
      });
    }
    _recReadGroup(req, g, full, nudged, frames, fail) {
      var self = this;
      var open = this._openMap();
      var must = {}, moving = {};
      var mustRead = full;
      var waitingQ = {}, runningQ = {};
      for (var i = 0; i < g.ids.length; i++) {
        var iid = g.ids[i];
        var it = open[iid];
        if (!it) continue;
        if (it.failedPending && !it.failedRecheck && nowMs() - it.failedPending >= FAILED_PASS_RECHECK_MAX_MS) {
          it.failedRecheck = true;
          it.terminalSeen = true;
        }
        if (it.lastConfirmed === 0 || it.terminalSeen || frames[iid]) {
          must[iid] = true;
          mustRead = true;
        }
        var iq = queueNameOf(it.queue);
        if (it.state === "running" || it.lastStatus === "running") {
          runningQ[iq] = true;
          moving[iid] = true;
        } else (waitingQ[iq] = waitingQ[iq] || []).push(iid);
      }
      for (var wq in waitingQ) {
        var line = waitingQ[wq].sort().slice(0, LOOK_HEAD_OF_LINE);
        for (var h = 0; h < line.length; h++) moving[line[h]] = true;
        if (!runningQ[wq]) {
          for (var h2 = 0; h2 < line.length; h2++) must[line[h2]] = true;
          mustRead = true;
        }
      }
      var counters = resolveForwardRequestQueueCounters();
      var queues = Object.keys(g.queues).slice(0, 20);
      var step;
      if (counters && !this._recCountersOff && queues.length) {
        step = Promise.resolve(counters(queues, { service: g.projectId, owner: g.owner, deadline: req.remaining(), signal: req.signal, fresh: true })).then(function(res) {
          var moved = false;
          var got = res && res.queues && typeof res.queues === "object" ? res.queues : {};
          if (!self._recCounters) self._recCounters = {};
          for (var q = 0; q < queues.length; q++) {
            var c = got[queues[q]];
            if (!c) continue;
            var key = g.projectId + "|" + queues[q];
            var prev = self._recCounters[key];
            var rct = Number(c.rct) || 0, seq = Number(c.seq) || 0;
            if (prev && (prev.rct !== rct || prev.seq !== seq)) moved = true;
            self._recCounters[key] = { rct, seq };
          }
          if (moved) self._recFollowUps = 2;
          return mustRead || moved || nudged;
        }, function(err) {
          var k = fail(err);
          if (k === "refused") {
            self._recCountersOff = true;
            return true;
          }
          return false;
        });
      } else {
        step = Promise.resolve(true);
        nudged = true;
      }
      return step.then(function(read) {
        if (!read || !req.alive()) {
          if (full) self._recFullReadAt = 0;
          return;
        }
        var status = resolveForwardRequestStatus();
        if (!status) return;
        var wide = full || nudged || self._recFollowUps > 0;
        var rank = function(id) {
          var it2 = self._openMap()[id];
          if (!it2) return 9;
          if (it2.state === "running" || it2.terminalSeen) return 0;
          return it2.kind === "chat" ? 1 : 2;
        };
        var ids = g.ids.filter(function(id) {
          if (!self._openMap()[id]) return false;
          return full || must[id] || wide && moving[id];
        }).sort(function(a, b) {
          return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
        }).slice(0, LOOK_READ_CAP);
        if (!ids.length) return;
        var reqs = ids.map(function(id) {
          var it2 = open[id];
          return buildHistoryItemFullId(it2.platform, it2.projectId, id);
        });
        return Promise.resolve(status(reqs, { service: g.projectId, owner: g.owner, deadline: req.remaining(), signal: req.signal, fresh: true })).then(function(res) {
          if (!req.alive()) return;
          var rows = res && Array.isArray(res.list) ? res.list : [];
          return self._recApplyStatuses(req, rows, fail);
        }, function(err) {
          var k = fail(err);
          if (k === "refused") {
            self._recReadsOff = true;
            console.warn("[chat-engine] the batch status read is not available; following requests with polls", err);
          }
          if (full) self._recFullReadAt = 0;
        });
      });
    }
    _recApplyStatuses(req, rows, fail) {
      var self = this;
      var open = this._openMap();
      var terminal = [];
      var changedBg = false;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || typeof row.id !== "string") continue;
        var item = open[row.id];
        if (!item) continue;
        item.lastConfirmed = nowMs();
        item.lastStatus = row.status;
        if (row.stream !== void 0) item.stream = !!row.stream;
        if (!item.cref && typeof row.cref === "string") item.cref = row.cref;
        if (row.status === "pending" || row.status === "running") {
          item.terminalSeen = false;
          if (row.status === "running") {
            if (OPEN_STATE_RANK[item.state] < OPEN_STATE_RANK.running) item.state = "running";
            if (item.kind === "chat") self._noteServerState(row.id, "running", item.ownerKey);
            else if (self._recPromoteBg(row.id, true)) changedBg = true;
          }
          continue;
        }
        if (row.status === "missing") {
          self._recApplyMissing(row.id, item);
          continue;
        }
        terminal.push({ id: row.id, item, row });
      }
      if (changedBg) {
        this._viewNotify();
        this.updateHistoryCache();
      }
      terminal.sort(function(a, b) {
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      var next = 0;
      var worker = function() {
        if (next >= terminal.length || !req.alive()) return Promise.resolve();
        var t = terminal[next++];
        return Promise.resolve(self._recSettleTerminal(req, t.id, t.item, t.row, fail)).catch(function(e) {
          console.warn("[chat-engine] settling " + t.id + " threw", e);
        }).then(worker);
      };
      var lanes = [];
      for (var l = 0; l < LOOK_READ_CONCURRENCY && l < terminal.length; l++) lanes.push(worker());
      return Promise.all(lanes).then(function() {
      });
    }
    /** A pass the server says runs now: its waiting bubble becomes the running one, by id
     *  (replaces promoteNextBgQueuedToRunning's guess). True when a bubble changed. */
    _recPromoteBg(itemId, quiet) {
      var e = this._bgEntry(itemId);
      if (e && e.status === "pending") e.status = "running";
      var changed = this._promoteBgItemToRunning(itemId);
      if (changed && !quiet) {
        this._viewNotify();
        this.updateHistoryCache();
      }
      return changed;
    }
    /** One item the batch read says is over: let a live reader settle it if it is still
     *  being fed (one look's grace), else read it once and apply it. */
    _recSettleTerminal(req, id, item, row, fail) {
      var hasPoll = this.historyItemPolls.has(id);
      var st = this.liveStreams[id];
      var fed = !!st && st.fed && !st.ended;
      if ((hasPoll || fed) && !req.isReturn && !item.terminalSeen) {
        item.terminalSeen = true;
        return;
      }
      if ((item.unavail || 0) >= BODY_UNAVAILABLE_BACKOFF_AFTER && !req.isReturn && nowMs() - (item.unavailAt || 0) < LOOK_STALE_MS) return;
      if (item.failedPending && !item.failedRecheck) {
        if (nowMs() - item.failedPending < FAILED_PASS_RECHECK_MAX_MS) return;
        item.failedRecheck = true;
      }
      if (hasPoll) this._stopPoll(id);
      st = this.liveStreams[id];
      if (st) this._closeLiveStream(st, false);
      if (row.status === "cancelled") {
        this._recApplyValue(id, item, cancelledEnvelope(id), row);
        return;
      }
      var needChunks = row.status === "resolved" && !!row.stream && !row.has_body;
      return this._recReadEnvelope(req, id, item, needChunks, row, fail);
    }
    _recChunkState(id) {
      if (!this._recChunks) this._recChunks = {};
      if (!this._recChunks[id]) this._recChunks[id] = { parser: createSseParser(), cursor: 0, stalls: 0 };
      return this._recChunks[id];
    }
    /**
     * The envelope read of one terminal item. A streamed turn with no stored answer is read
     * from its cursor (`since`), as many reads as it takes within the look, and is final
     * only when the cursor reaches `final_seq` (without one, when `more` is false); what is
     * read so far is kept for the next look when the deadline comes first.
     */
    _recReadEnvelope(req, id, item, needChunks, row, fail) {
      var self = this;
      var read = resolveForwardRequestRead();
      if (!read) return Promise.resolve();
      var fullId = buildHistoryItemFullId(item.platform, item.projectId, id);
      var ch = needChunks ? this._recChunkState(id) : null;
      var finalSeq = typeof row.final_seq === "number" ? row.final_seq : void 0;
      var loop = function() {
        var params = { id: fullId, service: item.projectId, owner: item.owner, deadline: req.remaining(), signal: req.signal, fresh: true };
        if (ch) params.since = ch.cursor;
        return Promise.resolve(read(params)).then(function(env) {
          if (!req.alive() || !self._openMap()[id]) return;
          if (!env || typeof env !== "object") {
            item.terminalSeen = true;
            return;
          }
          if (env.status === "missing") {
            self._recApplyMissing(id, item);
            return;
          }
          if (env.status === "pending" || env.status === "running") {
            item.terminalSeen = false;
            return;
          }
          if (env.body_unavailable) {
            self._recBodyUnavailable(id, item);
            return;
          }
          if (env.status === "cancelled") {
            self._recApplyValue(id, item, cancelledEnvelope(id), env);
            return;
          }
          if (env.body !== void 0 && env.body !== null) {
            self._recApplyValue(id, item, env.body, env);
            return;
          }
          if (env.status === "failed") {
            self._recApplyValue(id, item, { id, status: "failed", in_queue: false, error: env.error != null ? env.error : { message: "The request failed." } }, env);
            return;
          }
          if (!ch) {
            if (env.stream) {
              ch = self._recChunkState(id);
              return loop();
            }
            self._recApplyValue(id, item, EMPTY_PROVIDER_BODY, env);
            return;
          }
          if (typeof env.final_seq === "number") finalSeq = env.final_seq;
          var before = ch.cursor;
          var chunks = Array.isArray(env.chunks) ? env.chunks.slice() : [];
          chunks.sort(function(a, b) {
            return a && b ? a.seq - b.seq : 0;
          });
          for (var i = 0; i < chunks.length; i++) {
            var c = chunks[i];
            if (!c || typeof c.seq !== "number" || c.seq <= ch.cursor) continue;
            if (typeof c.txt === "string" && c.txt) ch.parser.feed(c.txt);
            ch.cursor = c.seq;
          }
          if (typeof env.last_seq === "number" && env.last_seq > ch.cursor) ch.cursor = env.last_seq;
          var complete = finalSeq !== void 0 ? ch.cursor >= finalSeq : env.more === false;
          if (!complete) {
            if (ch.cursor === before) {
              ch.stalls++;
              if (env.more === false && ch.stalls >= 3) {
                self._recApplyStreamed(id, item, ch, env, false);
                return;
              }
              item.terminalSeen = true;
              return;
            }
            if (req.remaining() < 1500) {
              item.terminalSeen = true;
              return;
            }
            return loop();
          }
          self._recApplyStreamed(id, item, ch, env, true);
        }, function(err) {
          fail(err);
          item.terminalSeen = true;
        });
      };
      return loop();
    }
    /**
     * An envelope read answered body_unavailable: the answer is stored but could not be
     * loaded now (an S3 read that failed on the server). Read again at every look for the
     * first BODY_UNAVAILABLE_BACKOFF_AFTER tries, then only at the stale watch or a return
     * (_recSettleTerminal). After BODY_UNAVAILABLE_GIVE_UP the turn stops saying
     * "Thinking..." and shows ANSWER_UNLOADABLE_TEXT; a later read that loads the answer
     * replaces that text (_recRetryUnloadable). An indexing pass ends with that error.
     */
    _recBodyUnavailable(id, item) {
      item.unavail = (item.unavail || 0) + 1;
      item.unavailAt = nowMs();
      if (item.unavail < BODY_UNAVAILABLE_BACKOFF_AFTER) {
        item.terminalSeen = true;
        return;
      }
      item.terminalSeen = false;
      if (item.unavail < BODY_UNAVAILABLE_GIVE_UP) return;
      var err = { type: "error", error: { type: "request_error", message: ANSWER_UNLOADABLE_TEXT } };
      if (item.kind === "chat") {
        if (!this._recUnloadable) this._recUnloadable = {};
        this._recUnloadable[id] = { item, tries: 0, at: nowMs() };
      }
      this._recApplyValue(id, item, err, null);
    }
    /**
     * Chat turns shown as ANSWER_UNLOADABLE_TEXT: one envelope read each at a return or
     * the stale watch, at most UNLOADABLE_RETRIES times. An answer that loads replaces the
     * text (a correction); a row that is gone or failed leaves the text as it is.
     */
    _recRetryUnloadable(req) {
      var self = this;
      var list = this._recUnloadable;
      var read = resolveForwardRequestRead();
      if (!list || !read) return Promise.resolve();
      var live = this._recLiveUid();
      var due = Object.keys(list).filter(function(id) {
        var u = list[id];
        if (!self._recReadable(u.item.uid, u.item.projectId, live)) return false;
        return req.isReturn || nowMs() - u.at >= LOOK_STALE_MS;
      }).slice(0, LOOK_READ_CONCURRENCY);
      return Promise.all(due.map(function(id) {
        var u = list[id];
        u.at = nowMs();
        u.tries++;
        var it = u.item;
        return Promise.resolve(read({ id: buildHistoryItemFullId(it.platform, it.projectId, id), service: it.projectId, owner: it.owner, deadline: req.remaining(), signal: req.signal, fresh: true })).then(function(env) {
          if (!env || typeof env !== "object" || env.body_unavailable) {
            if (u.tries >= UNLOADABLE_RETRIES) delete list[id];
            return;
          }
          delete list[id];
          if (env.body === void 0 || env.body === null || env.status !== "resolved") return;
          self.applyTerminal(id, env.body, { ownerKey: it.ownerKey, platform: it.platform, projectId: it.projectId, owner: it.owner, instant: true, correction: true });
        }, function() {
          if (u.tries >= UNLOADABLE_RETRIES) delete list[id];
        });
      })).then(function() {
      });
    }
    /** A streamed turn read whole (or given up on): shown at once, finalized only when
     *  whole and keepable, with if_absent so a complete answer another tab stored wins. */
    _recApplyStreamed(id, item, ch, env, whole) {
      ch.parser.end();
      var body = ch.parser.finalBody();
      var snap = ch.parser.snapshot();
      if (this._recChunks) delete this._recChunks[id];
      this._noteRespondedAt(id, { id, status: "resolved", in_queue: false, responded: env && env.responded });
      var keep = whole && body != null && mayKeepStreamedAnswer(snap, "resolved");
      this._applyRecoveredAnswer(id, item.ownerKey, item.platform, item.projectId, item.owner, body, false, false);
      if (keep) this._finalizeAnswer(id, body, { ownerKey: item.ownerKey, platform: item.platform, projectId: item.projectId, owner: item.owner, queue: item.queue });
      this._recAfterApply(id, item);
    }
    /** Apply one terminal value (a provider body, a failed or cancelled envelope). */
    _recApplyValue(id, item, value, env) {
      var self = this;
      if (env && typeof env.responded === "number") this._noteRespondedAt(id, { id, status: env.status, in_queue: false, responded: env.responded });
      var who = { ownerKey: item.ownerKey, projectId: item.projectId, owner: item.owner, platform: item.platform, queue: item.queue };
      var executed = env && typeof env.executed === "number" ? env.executed : void 0;
      if (item.kind === "indexing") {
        var entry2 = this._bgEntry(id);
        if (entry2 && !item.failedRecheck && isErrorResponseBody(value) && !isRetriedFailure(value) && this._isWorkerDrivenIndexing(entry2.filename, entry2.mime)) {
          if (!item.failedPending) item.failedPending = nowMs();
          item.terminalSeen = false;
          return;
        }
        if (entry2) {
          void this._settleBgOutcome(entry2, entry2.platform, Promise.resolve(value), function() {
            return executed;
          }).then(function() {
            self._recAfterApply(id, item);
          });
          return;
        }
        this.handleHistoryItemResolution(id, value, item.platform, executed, who);
      } else {
        var failed = isErrorResponseBody(value);
        if (item.resend && failed && isAuthExpiredError(value) && !isNonRetryableRequestError(value)) {
          var again = item.resend;
          delete item.resend;
          this._stopPoll(id);
          this._closeItem(id);
          again(value);
          return;
        }
        delete item.resend;
        if (item.turn) this._settleChatTurnTools(item.turn, value, failed);
        this.applyTerminal(id, value, who);
      }
      this._recAfterApply(id, item);
    }
    /** An item the server no longer has ("missing" on a strongly consistent read). */
    _recApplyMissing(id, item) {
      var self = this;
      var who = { ownerKey: item.ownerKey, projectId: item.projectId, owner: item.owner, platform: item.platform, queue: item.queue };
      if (item.kind === "indexing") {
        var entry2 = this._bgEntry(id);
        var gone = { code: "NOT_EXISTS", message: "Request not found." };
        if (entry2) {
          void this._settleBgOutcome(entry2, entry2.platform, Promise.reject(gone), function() {
            return void 0;
          }).then(function() {
            self._recAfterApply(id, item);
          });
          return;
        }
        this.applyTerminal(id, cancelledEnvelope(id), who);
      } else {
        var text = item.anonymous ? REQUEST_UNREACHABLE_TEXT : REQUEST_GONE_TEXT;
        this.applyTerminal(id, { type: "error", error: { type: "request_error", message: text } }, who);
      }
      this._recAfterApply(id, item);
    }
    /** After a terminal apply: an item whose bubble is nowhere (no chat view, no cache of
     *  its chat) is closed all the same; the next history load shows the server's state. */
    _recAfterApply(id, item) {
      if (!this._openMap()[id]) return;
      if (this._hasWaitingBubble(id, item.ownerKey)) return;
      this._closeItem(id);
    }
    /**
     * Store a streamed answer as the version history keeps (csr-finalize) with if_absent,
     * in the tab that holds the settle lock. When another tab stored one first ("exists"),
     * the stored one is read back and shown instead.
     */
    _finalizeAnswer(itemId, body, who) {
      var fin = resolveForwardRequestFinalize();
      if (!fin || body == null) return;
      var self = this;
      var url = who.platform === "openai" ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
      runSettleSideEffect(who.projectId, queueNameOf(who.queue), "fin:" + who.projectId + ":" + itemId, function() {
        return Promise.resolve(fin(itemId, body, { url, method: "POST", service: who.projectId, owner: who.owner, ifAbsent: true })).then(function(res) {
          if (res && res.finalized === false && res.reason === "exists") self._readStoredAnswer(itemId, who);
        }, function(err) {
          console.warn("[chat-engine] forwardRequestFinalize failed", err);
          if (isTransportFailure(err)) throw err;
        });
      });
    }
    /** Another tab stored this turn's answer first: show the stored one. */
    _readStoredAnswer(itemId, who) {
      var read = resolveForwardRequestRead();
      if (!read) return;
      var self = this;
      Promise.resolve(read({ id: buildHistoryItemFullId(who.platform, who.projectId, itemId), service: who.projectId, owner: who.owner, fresh: true })).then(function(env) {
        if (!env || env.body === void 0 || env.body === null) return;
        self.applyTerminal(itemId, env.body, { ownerKey: who.ownerKey, platform: who.platform, projectId: who.projectId, owner: who.owner, instant: true, correction: true });
      }, function() {
      });
    }
    // --- background-task resolution + drain -------------------------------
    /** Record how long a background indexing pass took, on the bubble that just
     *  settled, so the duration shows immediately instead of waiting for whatever
     *  next refetches history.
     *
     *  `_tsStart` is otherwise written only by the history mapper, which reads the
     *  row's `executed`; a live settle never sees the row at all (the poll resolves
     *  with the destination's body). This is the same value by the other route.
     *
     *  `_ts` is stamped too when the branch that built the bubble left it without
     *  one: it is the END of the pass, and the pass ended now. A later history load
     *  replaces both with the server's own numbers.
     *
     *  Indexing passes only: an ordinary turn has no duration to show, and
     *  `_tsStart`'s presence is what both views read to decide. */
    _stampPassDuration(itemId, executedAt) {
      if (!itemId) return;
      if (!this._indexRefOfItem(itemId)) return;
      var hasStart = typeof executedAt === "number" && executedAt > 0;
      for (var i = this.state.messages.length - 1; i >= 0; i--) {
        var m = this.state.messages[i];
        if (!m || m.role !== "assistant" || m._serverItemId !== itemId) continue;
        if (m.isPending) continue;
        if (typeof m._ts !== "number") m._ts = Date.now();
        if (hasStart) m._tsStart = executedAt;
        this.host.notify();
        this.updateHistoryCache();
        break;
      }
    }
    handleHistoryItemResolution(itemId, response, platform, executedAt, ctx) {
      var indexRef = this._indexRefOfItem(itemId);
      this.applyHistoryItemResolution(itemId, response, platform, ctx);
      this._stampPassDuration(itemId, executedAt);
      this.promoteNextBgQueuedToRunning();
      this.drainBgTaskQueue();
      if (indexRef) this._followWorkerIndexingChain(indexRef.name, indexRef.mime);
    }
    /** The file an already-rendered background pass is about, off its request
     *  bubble. Null for an ordinary turn, which is most of them. */
    _indexRefOfItem(itemId) {
      if (!itemId) return null;
      for (var i = 0; i < this.state.messages.length; i++) {
        var m = this.state.messages[i];
        if (m._serverItemId !== itemId || m.role !== "user" || !m.isBackgroundTask) continue;
        return m._indexFile || null;
      }
      return null;
    }
    /**
     * A poll that came back saying the request was CANCELLED, rather than with an
     * answer.
     *
     * The server keeps a cancelled request as a terminal row instead of deleting it
     * (that row is the durable record of the stop, and the chat history it belongs
     * to), so a poll still running when the cancel lands now RESOLVES on it. It used
     * to reject with NOT_EXISTS, and the resolution path below reads a status object
     * as an answer with no text — which would stamp "No text response received from
     * AI provider" over a turn the user had just stopped.
     *
     * Reachable whenever the poll was not stopped by whoever cancelled: another tab,
     * another device, or the row being cancelled server-side by the file's own stop.
     */
    _isCancelledPollResult(response) {
      if (!response || typeof response !== "object" || response.status !== "cancelled") return false;
      if (response.content !== void 0 || response.output !== void 0) return false;
      return response.queue_name !== void 0 || response.in_queue !== void 0;
    }
    /**
     * A history-attached poll (the engine's, agent.vue's, the files page's) settled.
     * Routed through the one funnel, by id: see applyTerminal. `ctx` is the identity the
     * caller pinned when it attached the poll; the open item's pinned identity fills
     * whatever it leaves out.
     */
    applyHistoryItemResolution(itemId, response, platform, ctx) {
      this.historyItemPolls.delete(itemId);
      var c = Object.assign({}, ctx || {});
      if (c.platform !== "claude" && c.platform !== "openai") c.platform = platform;
      this.applyTerminal(itemId, response, c);
    }
    /** How a bg task maps onto a collapsed row: the row's own key (storage path
     *  when known, else the filename), scoped to the chat it belongs to. A storage
     *  path is project-relative ("report.xlsx"), and ONE ChatSession serves every
     *  project — unscoped, stopping a file in one project would silently suppress
     *  the same filename's continuations in another. */
    _indexKeyOf(entry2) {
      if (!entry2) return "";
      var file = entry2.storagePath || entry2.filename;
      if (!file) return "";
      return indexScopeKey(entry2.projectId, entry2.platform) + "|" + file;
    }
    /**
     * Reconcile the bg queue with the files the user has stopped.
     *
     * A FIRST pass (no resumePass) is a fresh indexing request — a re-upload, or a
     * Reindex from the file manager — so it LIFTS the stop: the key is a storage
     * path, and without this an earlier cancel would silently kill every future
     * index of the same path. A continuation of a stopped file is dropped instead,
     * covering the pass that was dispatched in the moment before the cancel landed.
     *
     * "Fresh" is the load-bearing word, and it used to be missing. A run's OWN first
     * pass sits in this queue for as long as it runs (entries are only dropped once
     * their bubble settles), so stopping a file during its first pass — which is
     * exactly when a user who has just uploaded it does — met that first-pass entry
     * on the very next drain and lifted the stop the user had just asked for. The
     * chain then carried on, one worker-minted window after another, with nothing
     * client-side left to suppress it. The ids recorded at stop time are what tells
     * the two apart: a pass that was already there when the user hit Stop cannot be
     * the new request that lifts it.
     */
    _applyIndexCancellations() {
      if (!this.cancelledIndexKeys.size) return;
      var surfaced = {};
      this.state.messages.forEach(function(m) {
        if (!m._serverItemId) return;
        if (m.isPending || m.isPendingQueued || m.isPendingInProcess) surfaced[m._serverItemId] = true;
      });
      for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
        var entry2 = this.bgTaskQueue[i];
        var key = this._indexKeyOf(entry2);
        if (!key || !this.cancelledIndexKeys.has(key)) continue;
        if (!entry2.resumePass && !this.state.stoppedIndexIds[entry2.id]) {
          this.cancelledIndexKeys.delete(key);
          continue;
        }
        if (surfaced[entry2.id]) continue;
        this.bgTaskQueue.splice(i, 1);
        this._stopPoll(entry2.id);
        this._cancelServerItem(entry2.id);
      }
    }
    /**
     * Cancel any live pass of a stopped file that turned up on its own.
     *
     * The client is not the only thing that continues a file: for PDFs and (when
     * windowed indexing is on) text/grid files the WORKER enqueues the next window
     * itself, and that pass reaches the chat through the history poll, never
     * through bgTaskQueue. The worker's own gate stops the chain when the running
     * row is cancelled — but if the row had already finished when the user hit
     * stop, the next window was queued a moment earlier and still arrives. Stop it
     * here rather than making the user hit stop again.
     *
     * Runs from drainBgTaskQueue, which both clients call after a history load.
     */
    _sweepCancelledIndexing() {
      if (!this.cancelledIndexKeys.size) return;
      var self = this;
      var chatKey = this.getHistoryCacheKey();
      var targets = [];
      this.state.messages.forEach(function(m, i) {
        if (!m.isBackgroundTask || m.role !== "user" || !m._serverItemId) return;
        if (m._cancelling || m.isSendingToServer) return;
        if (!(m.isPendingQueued || m.isPendingInProcess)) return;
        var ref = m._indexFile;
        var file = ref && (ref.path || ref.name);
        if (!file || !self.cancelledIndexKeys.has(chatKey + "|" + file)) return;
        targets.push({ msg: m, idx: i });
      });
      targets.forEach(function(t) {
        var idx = self.state.messages.indexOf(t.msg);
        self.cancelQueuedMessage(t.msg, idx === -1 ? t.idx : idx);
      });
    }
    /**
     * True when the WORKER, not this client, drives the rest of this file's chain.
     * The mirror image of the early returns in maybeResumeIndexing: whatever that
     * refuses to continue is exactly what nothing client-side is tracking.
     */
    _isWorkerDrivenIndexing(filename, mime) {
      if (!isPagedReadFile(filename, mime)) return false;
      if (isImageVisionFile(filename, mime)) return true;
      return windowedIndexingEnabled() && isWindowedReadFile(filename, mime);
    }
    /** Newest wall-clock `_ts` of any indexing pass on screen, or 0. */
    _newestIndexPassTs() {
      var newest = 0;
      var msgs = this.state.messages;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m && m._indexFile && typeof m._ts === "number" && m._ts > newest) newest = m._ts;
      }
      return newest;
    }
    /** Live indexing work THIS page is tracking for the project: a queued or adopted pass,
     *  an attached bg poll, or a live key a look recorded. No recency guess. */
    _hasLocalLiveIndexWork(svcId) {
      for (var i = 0; i < this.bgTaskQueue.length; i++) {
        var e = this.bgTaskQueue[i];
        if (e && e.projectId === svcId) return true;
      }
      var keys = this.state.liveIndexKeys || {};
      for (var k in keys) {
        if (keys[k]) return true;
      }
      var found = false;
      this.historyItemPolls.forEach(function(h) {
        if (h && h.kind === "bg") found = true;
      });
      return found;
    }
    /**
     * Re-read the chat from the server now (see the rule above). A thin wrapper over the
     * reconciler's return look: safe to call from any number of triggers at once, runs
     * with no chat view too (the first page is read only when one is mounted, and owed
     * while polling is paused), and resolves when that look ends.
     */
    catchUpHistory() {
      return this._recSched().trigger("return");
    }
    /**
     * Watch for the moments the user comes back without the tab being hidden first: the
     * computer waking from sleep (the reconciler's timer finds a gap far longer than asked),
     * the network coming back, a page restored from the back-forward cache. Also starts
     * the status push listener. Runs while a chat view is mounted and stops itself when
     * none is.
     */
    _ensureReturnWatch() {
      this._recEnsure();
      this._startStatusPush();
    }
    /** Listen to request status frames while a chat view is mounted (statusPush on). */
    _startStatusPush() {
      if (this._statusUnsub || !statusPushEnabled()) return;
      var self = this;
      this._statusSeenConnect = false;
      try {
        var unsub = chatEngineConfig().onRequestStatus(function(ev) {
          self._onRequestStatus(ev);
        });
        this._statusUnsub = typeof unsub === "function" ? unsub : function() {
        };
      } catch (e) {
        this._statusUnsub = null;
      }
    }
    _stopStatusPush() {
      var unsub = this._statusUnsub;
      this._statusUnsub = null;
      if (unsub) {
        try {
          unsub();
        } catch (e) {
        }
      }
    }
    /**
     * One status frame event. 'connected' (first connection, and every reconnect after a
     * drop, a sleep or the planned renewal) catches up, because frames sent while the
     * socket was down are lost. A status change of an indexing pass this page does not
     * poll runs the queue check now instead of at its next heartbeat; a pass that IS polled
     * was already woken by skapi-js itself. Chat turns are left to their own polls.
     */
    _onRequestStatus(ev) {
      if (!ev) return;
      var hiddenTab = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (ev.type === "connected") {
        if (!this._statusSeenConnect) {
          this._statusSeenConnect = true;
          return;
        }
        if (hiddenTab) {
          this._recEnsure();
          return;
        }
        void this._recSched().trigger("reconnect");
        return;
      }
      if (ev.type !== "status" || typeof ev.id !== "string") return;
      var bgFrame = !!ev.queue && isBgIndexingQueue(ev.queue);
      if (bgFrame) for (var wi = 0; wi < this._iqWatches.length; wi++) this._iqWatches[wi].frame = true;
      if (ev.status === "running" && (!ev.queue || !isBgIndexingQueue(ev.queue))) this._noteServerState(ev.id, "running");
      if (this._recNewMode()) {
        if (this._tomb()[ev.id]) return;
        if (hiddenTab) {
          this._recEnsure();
          return;
        }
        var known = !!this._openMap()[ev.id];
        if (known) {
          if (!this._recFrameIds) this._recFrameIds = {};
          this._recFrameIds[ev.id] = true;
        }
        var bg = !!ev.queue && isBgIndexingQueue(ev.queue);
        void this._recSched().trigger(known || bg ? "frame" : "unknown");
        return;
      }
      if (!this._viewMounted()) {
        if (bgFrame && this._iqWatches.length) {
          if (hiddenTab) this._recEnsure();
          else void this._recSched().trigger("frame");
        }
        return;
      }
      if (!ev.queue || !isBgIndexingQueue(ev.queue)) return;
      if (this.historyItemPolls.has(ev.id)) return;
      var tracked = false;
      for (var i = 0; i < this.bgTaskQueue.length; i++) {
        var e = this.bgTaskQueue[i];
        if (e && e.id === ev.id) {
          tracked = !e.byListing;
          break;
        }
      }
      if (tracked) return;
      this._nudgeQueueCheck();
    }
    /** Run the queue check (adopt, settle by listing, page progress) now, through the
     *  reconciler's one chain. */
    _nudgeQueueCheck() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this._recEnsure();
        return;
      }
      void this._recSched().trigger("frame");
    }
    _ensureAdoptTick() {
      this._recEnsure();
    }
    /**
     * Follow an indexing pass found in a loaded history page through the queue check
     * instead of polling it (owner, 2026-11-20): polls on one queue run one at a time in
     * skapi-js, so after a reload mid-run every lane waited behind the first. Only for a
     * pass the worker drives (a client-driven chain is resumed off its dispatching entry,
     * whose pass count caps it) and only when the host can read a row by id. True when the
     * pass is now tracked (the caller then attaches no poll).
     */
    trackHistoryIndexPass(item) {
      if (typeof chatEngineConfig().csrHistoryItemLookup !== "function") return false;
      if (!item || typeof item.id !== "string" || !item.id) return false;
      if (item.status !== "pending" && item.status !== "running") return false;
      for (var q = 0; q < this.bgTaskQueue.length; q++) {
        if (this.bgTaskQueue[q] && this.bgTaskQueue[q].id === item.id) return !!this.bgTaskQueue[q].byListing;
      }
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!id.projectId || platform !== "claude" && platform !== "openai") return false;
      var text = typeof item.request_text === "string" && item.request_text ? item.request_text : extractLastUserTextFromRequest(item.request_body);
      var ref = parseIndexingRequestText(text);
      if (!ref || !ref.name) return false;
      if (!this._isWorkerDrivenIndexing(ref.name, ref.mime)) return false;
      this.bgTaskQueue.push({
        projectId: id.projectId,
        platform,
        id: item.id,
        identity: Object.assign({}, id),
        owner: id.owner,
        filename: ref.name,
        storagePath: ref.path,
        mime: ref.mime,
        size: ref.size,
        status: item.status === "running" ? "running" : "pending",
        poll: typeof item.poll === "function" ? item.poll : void 0,
        resumePass: ref.continued ? 1 : 0,
        byListing: true,
        adoptedAt: Date.now()
      });
      return true;
    }
    /**
     * Show a pass as RUNNING once the queue says it is. A pass this client sent starts out
     * waiting (the server queues it), and its own poll's running tick used to be what
     * moved it on. Settled from the listing, it has no poll, so the running listing the
     * 10-second check already takes does it instead (owner, 2026-11-20).
     */
    _promoteListedRunning(runningRes) {
      var list = runningRes && Array.isArray(runningRes.list) ? runningRes.list : [];
      if (!list.length) return;
      var running = {};
      for (var i = 0; i < list.length; i++) if (list[i] && typeof list[i].id === "string") running[list[i].id] = true;
      var changed = false;
      for (var q = 0; q < this.bgTaskQueue.length; q++) {
        var e = this.bgTaskQueue[q];
        if (!e || e.status !== "pending" || !running[e.id]) continue;
        e.status = "running";
        if (this._promoteBgItemToRunning(e.id)) changed = true;
      }
      if (changed) {
        this.host.notify();
        this.updateHistoryCache();
      }
    }
    /** promoteNextBgQueuedToRunning for one named pass: its waiting request bubble becomes
     *  the running one, with a "Thinking..." placeholder under it. False when that pass has
     *  no waiting bubble (already running, settled, or not on screen). */
    _promoteBgItemToRunning(itemId) {
      var idx = this.state.messages.findIndex(function(m) {
        return m.role === "user" && m.isBackgroundTask && m.isPendingQueued && m._serverItemId === itemId;
      });
      if (idx === -1) return false;
      var existing = this.state.messages[idx];
      if (existing._cancelling) return false;
      var promoted = { role: "user", content: existing.content, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: itemId };
      if (existing._indexFile) promoted._indexFile = existing._indexFile;
      if (existing._ts !== void 0) promoted._ts = existing._ts;
      if (existing._ownerKey !== void 0) promoted._ownerKey = existing._ownerKey;
      this.state.messages[idx] = promoted;
      var placeholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: itemId };
      if (existing._ownerKey !== void 0) placeholder._ownerKey = existing._ownerKey;
      this.state.messages.splice(idx + 1, 0, placeholder);
      return true;
    }
    /**
     * Chats-only history (owner, 2026-11-21): on when the host can list a file's passes
     * (listIndexPasses) and read one by id (csrHistoryItemLookup). The history fetch then
     * skips the indexing queue, a file's row comes from its run:: record, and opening the
     * row loads its passes (loadRunPasses), a page at a time.
     */
    lazyIndexRowsEnabled() {
      var cfg = chatEngineConfig();
      return typeof cfg.listIndexPasses === "function" && typeof cfg.csrHistoryItemLookup === "function";
    }
    /** The paging state of a file's passes, or null before its row was first opened. */
    runPassPaging(storagePath) {
      if (!storagePath || !this.state.passPaging) return null;
      return this.state.passPaging[storagePath] || null;
    }
    /**
     * Load the next page of a file's indexing passes into the chat, newest first (owner,
     * 2026-11-21). The ids come from the file's pass records (listIndexPasses, once), each
     * pass is read by id (csrHistoryItemLookup) and lands as the same request + reply bubbles
     * a live pass produces, so its file's row groups it like any other. A pass still running
     * or waiting is left to the live queue check, which shows it as it settles; one already
     * in the chat is not read again. Never throws.
     */
    loadRunPasses(storagePath, fileName) {
      var self = this;
      var cfg = chatEngineConfig();
      var list = cfg.listIndexPasses, lookup = cfg.csrHistoryItemLookup;
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!storagePath || typeof list !== "function" || typeof lookup !== "function") return Promise.resolve();
      if (!id.projectId || platform !== "claude" && platform !== "openai") return Promise.resolve();
      if (!this.state.passPaging) this.state.passPaging = {};
      var paging = this.state.passPaging[storagePath];
      if (paging && (paging.loading || paging.done)) return Promise.resolve();
      if (!paging) {
        this.state.passPaging[storagePath] = { ids: [], loaded: 0, loading: false, done: false };
      }
      var p = this.state.passPaging[storagePath];
      p.loading = true;
      p.error = void 0;
      this.host.notify();
      var svcId = id.projectId, owner = id.owner;
      var name = fileName || storagePath.split("/").pop() || storagePath;
      var idsReady = p.ids.length ? Promise.resolve(p.ids) : Promise.resolve(list(svcId, storagePath)).then(function(ids) {
        var clean = (Array.isArray(ids) ? ids : []).filter(function(x) {
          return typeof x === "string" && !!x;
        });
        clean.sort(function(a, b) {
          return a < b ? 1 : a > b ? -1 : 0;
        });
        p.ids = clean;
        return clean;
      });
      return idsReady.then(function(ids) {
        var oldest = ids.length ? ids[ids.length - 1] : "";
        var present = {};
        for (var i = 0; i < self.state.messages.length; i++) {
          var m = self.state.messages[i];
          if (m && m._serverItemId) present[m._serverItemId] = true;
        }
        var page = [];
        var pagePos = [];
        var next = p.loaded;
        while (next < ids.length && page.length < _ChatSession.RUN_PASS_PAGE) {
          if (!present[ids[next]]) {
            page.push(ids[next]);
            pagePos.push(next);
          }
          next++;
        }
        return Promise.all(page.map(function(rid) {
          return Promise.resolve(lookup(buildHistoryItemFullId(platform, svcId, rid), svcId, owner)).then(
            function(body) {
              return { rid, body, err: null };
            },
            function(err) {
              return { rid, body: null, err };
            }
          );
        })).then(function(got) {
          if (self.host.getIdentity().projectId !== svcId) return;
          var add = [];
          var retryFrom = -1;
          for (var g = 0; g < got.length; g++) {
            var r = got[g];
            if (!r) continue;
            var body = r.body;
            if (isCsrStatusEnvelope(body) && (body.status === "running" || body.status === "pending")) continue;
            var notExists = isNotExistsError(r.err);
            if (notExists) continue;
            if (r.err && (isTransportFailure(r.err) || isAuthExpiredError(r.err))) {
              if (retryFrom === -1 || pagePos[g] < retryFrom) retryFrom = pagePos[g];
              continue;
            }
            var continued = r.rid !== oldest;
            var when = requestIdTimeMs(r.rid);
            var user = {
              role: "user",
              content: self.host.formatIndexingLabel(name, void 0, null, storagePath, false, continued),
              isBackgroundTask: true,
              _serverItemId: r.rid,
              _indexFile: { name, path: storagePath, isReindex: false, continued }
            };
            if (when) user._ts = when;
            var reply;
            if (r.err) {
              reply = { role: "assistant", content: getErrorMessage(r.err), isError: true, isBackgroundTask: true, _serverItemId: r.rid };
            } else if (isCsrStatusEnvelope(body) && body.status === "cancelled") {
              user.isCancelled = true;
              add.push([user]);
              continue;
            } else if (isErrorResponseBody(body)) {
              reply = { role: "assistant", content: getErrorMessage(body), isError: true, isBackgroundTask: true, _serverItemId: r.rid };
            } else {
              var text = ((platform === "openai" ? extractOpenAIText(body) : extractClaudeText(body)) || "").trim();
              var complete = text.indexOf(INDEXING_COMPLETE_MARKER) !== -1;
              if (complete) text = text.split(INDEXING_COMPLETE_MARKER).join("").trim();
              reply = { role: "assistant", content: text || EMPTY_INDEXING_REPLY, isBackgroundTask: true, _serverItemId: r.rid };
              if (complete) reply._indexComplete = true;
            }
            if (when) reply._ts = when;
            add.push([user, reply]);
          }
          add.sort(function(a, b) {
            return (a[0]._ts || 0) - (b[0]._ts || 0);
          });
          for (var k = 0; k < add.length; k++) self._insertByTime(add[k]);
          p.loaded = retryFrom !== -1 ? retryFrom : next;
          p.done = p.loaded >= ids.length;
        });
      }).catch(function(err) {
        p.error = getErrorMessage(err) || "The steps could not be loaded.";
      }).then(function() {
        p.loading = false;
        self.host.notify();
        self.updateHistoryCache();
      });
    }
    /** Insert bubbles before the first message that is newer than them; messages whose time
     *  is unknown are skipped over, and the end of the list takes them otherwise. A message's
     *  time is its `_ts`, else (2026-11-25) the time in its request id: a live worker pass
     *  adopted from the queue carries no `_ts`, and a file's older passes loaded by opening its
     *  row (loadRunPasses) used to land AFTER it, which split one run into two rows. */
    _insertByTime(bubbles) {
      var at = messageTimeMs(bubbles[0]);
      var idx = this.state.messages.length;
      if (at > 0) {
        for (var i = 0; i < this.state.messages.length; i++) {
          var t = messageTimeMs(this.state.messages[i]);
          if (t > 0 && t > at) {
            idx = i;
            break;
          }
        }
      }
      Array.prototype.splice.apply(this.state.messages, [idx, 0].concat(bubbles));
    }
    /**
     * Refresh the page progress ("175 of 530 pages") of the documents this page is still
     * tracking passes for, one read per file (config readIndexProgress, the MCP's
     * prog::<path> record). Runs on the ADOPT_TICK_MS check; a file with nothing tracked is
     * not asked about. Never throws.
     */
    _refreshPageProgress() {
      var read = chatEngineConfig().readIndexProgress;
      if (typeof read !== "function" || this._progressInflight) return;
      var id = this.host.getIdentity();
      if (!id.projectId || this.isPollingPaused() || !this.host.isViewMounted()) return;
      var svcId = id.projectId;
      var paths = [];
      for (var i = 0; i < this.bgTaskQueue.length; i++) {
        var e = this.bgTaskQueue[i];
        if (e && e.projectId === svcId && e.storagePath && paths.indexOf(e.storagePath) === -1) paths.push(e.storagePath);
      }
      if (!paths.length) return;
      var self = this;
      this._progressInflight = true;
      Promise.all(paths.map(function(path) {
        return Promise.resolve(read(svcId, path)).then(function(data) {
          return { path, data };
        }, function() {
          return { path, data: null };
        });
      })).then(function(rows) {
        self._progressInflight = false;
        if (self.host.getIdentity().projectId !== svcId) return;
        if (!self.state.indexPageProgress) self.state.indexPageProgress = {};
        var changed = false;
        for (var r = 0; r < rows.length; r++) {
          var d = rows[r].data;
          var saved = d && typeof d.pages_saved === "number" ? d.pages_saved : null;
          if (saved === null) continue;
          var total = d && typeof d.pages_total === "number" && d.pages_total > 0 ? d.pages_total : null;
          var prev = self.state.indexPageProgress[rows[r].path];
          if (prev && prev.saved === saved && prev.total === total) continue;
          self.state.indexPageProgress[rows[r].path] = { saved, total, at: Date.now() };
          changed = true;
        }
        if (changed) self.host.notify();
      }, function() {
        self._progressInflight = false;
      });
    }
    /** The page progress to show for a file's row, or null (see _refreshPageProgress). */
    pageProgressFor(storagePath, fileName) {
      var map = this.state.indexPageProgress;
      if (!map) return null;
      var p = storagePath ? map[storagePath] : void 0;
      if (!p && fileName) {
        var hit = null;
        for (var k in map) {
          if (k === fileName || k.slice(-(fileName.length + 1)) === "/" + fileName) {
            if (hit) {
              hit = null;
              break;
            }
            hit = k;
          }
        }
        if (hit) p = map[hit];
      }
      return p ? { saved: p.saved, total: p.total } : null;
    }
    _noteLiveLook(svcId, platform, results) {
      var ids = {};
      var complete = true;
      for (var r = 0; r < results.length; r++) {
        var list = results[r] && Array.isArray(results[r].list) ? results[r].list : [];
        if (list.length >= WORKER_PASS_ADOPT_LIMIT || results[r] && results[r].endOfList === false) complete = false;
        for (var i = 0; i < list.length; i++) if (list[i] && typeof list[i].id === "string") ids[list[i].id] = true;
      }
      this._lastLiveLook = complete ? { svcId, platform, at: Date.now(), ids } : null;
      if (complete) {
        var open = this._openMap();
        for (var oid in open) {
          var oi = open[oid];
          if (oi.failedPending && !oi.failedRecheck && oi.projectId === svcId && nowMs() - oi.failedPending >= FAILED_PASS_RECHECK_MIN_MS) {
            oi.failedRecheck = true;
            oi.terminalSeen = true;
          }
        }
      }
      if (complete) this._closeIdleFileRuns(svcId);
    }
    /**
     * Settle indexing passes from the queue instead of from their own polls (owner,
     * 2026-11-20): the worker's lanes AND the first passes this client sent. Runs on the
     * ADOPT_TICK_MS check, beside the adoption look.
     *
     * WHY. skapi-js runs every poll on one queue one at a time, each until its request
     * finishes. The worker runs a document's windows in parallel lanes on that one queue, so
     * a lane that finished waited behind every pass ahead of it (measured: passes done at
     * 17:04 shown at 17:06-17:07, one every ~5 s, after a 3-minute first pass).
     *
     * HOW. One compact listing each of the queue's `resolved` and `failed` rows (stubs, no
     * bodies). A tracked pass found there, or one missing from a COMPLETE running+pending look
     * taken after it was adopted (cancelled, removed), is read ONCE by id through the host's
     * csrHistoryItemLookup, the same row a poll's last read returns, and settled through
     * _settleBgOutcome exactly as its poll would have been. A lookup that still says
     * running/pending (the status index lags the table) leaves the pass for the next tick.
     */
    _settleByListing() {
      var self = this;
      if (this._listingLookInflight) return;
      var lookup = chatEngineConfig().csrHistoryItemLookup;
      if (typeof lookup !== "function") return;
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!id.projectId || platform !== "claude" && platform !== "openai") return;
      if (this.isPollingPaused() || !this.host.isViewMounted()) return;
      var svcId = id.projectId, owner = id.owner;
      var waiting = [];
      for (var i = 0; i < this.bgTaskQueue.length; i++) {
        var e = this.bgTaskQueue[i];
        if (e && e.byListing && e.projectId === svcId && e.platform === platform && !this._listingSettling[e.id]) waiting.push(e);
      }
      if (!waiting.length) return;
      var queue = bgIndexingQueueName(id.userId, svcId);
      var ask = function(status) {
        return Promise.resolve(getChatHistory(
          { service: svcId, owner, platform, queue, status, queue_exact: true, compact: true },
          { limit: WORKER_PASS_ADOPT_LIMIT, fetchMore: false }
        )).then(function(res) {
          return res && Array.isArray(res.list) ? res.list : [];
        }).catch(function() {
          return [];
        });
      };
      this._listingLookInflight = true;
      Promise.all([ask("resolved"), ask("failed")]).then(function(lists) {
        self._listingLookInflight = false;
        var now = self.host.getIdentity();
        if (now.projectId !== svcId || now.platform !== platform || !self.host.isViewMounted()) return;
        var finished = {};
        for (var l = 0; l < lists.length; l++) {
          for (var k = 0; k < lists[l].length; k++) {
            var row = lists[l][k];
            if (row && typeof row.id === "string") finished[row.id] = row;
          }
        }
        var look = self._lastLiveLook;
        var lookUsable = !!look && look.svcId === svcId && look.platform === platform && Date.now() - look.at <= 2 * ADOPT_TICK_MS;
        for (var w = 0; w < waiting.length; w++) {
          var entry2 = waiting[w];
          if (self.bgTaskQueue.indexOf(entry2) === -1) continue;
          var row2 = finished[entry2.id];
          var leftQueue = !row2 && lookUsable && !look.ids[entry2.id] && typeof entry2.adoptedAt === "number" && entry2.adoptedAt < look.at;
          if (!row2 && !leftQueue) continue;
          self._settleListedEntry(
            entry2,
            platform,
            lookup,
            row2 && typeof row2.executed === "number" && row2.executed > 0 ? row2.executed : void 0
          );
        }
      }, function() {
        self._listingLookInflight = false;
      });
    }
    /** One by-id read of a by-listing pass, then the shared settle. */
    _settleListedEntry(entry2, platform, lookup, executedAt) {
      var self = this;
      var owner = entry2.owner !== void 0 ? entry2.owner : entry2.identity ? entry2.identity.owner : this.host.getIdentity().owner;
      this._listingSettling[entry2.id] = true;
      Promise.resolve(lookup(buildHistoryItemFullId(platform, entry2.projectId, entry2.id), entry2.projectId, owner)).then(function(body) {
        delete self._listingSettling[entry2.id];
        if (self.bgTaskQueue.indexOf(entry2) === -1) return;
        if (isCsrStatusEnvelope(body) && (body.status === "running" || body.status === "pending")) return;
        self._settleBgOutcome(entry2, platform, Promise.resolve(body), function() {
          return executedAt;
        });
      }, function(err) {
        delete self._listingSettling[entry2.id];
        if (self.bgTaskQueue.indexOf(entry2) === -1) return;
        if (!isNotExistsError(err) && (isTransportFailure(err) || isAuthExpiredError(err))) return;
        self._settleBgOutcome(entry2, platform, Promise.reject(err), function() {
          return executedAt;
        });
      });
    }
    _adoptWorkerIndexingPasses(attempt, passive, single) {
      var self = this;
      if (this._adoptingWorkerPasses) return;
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!id.projectId || platform !== "claude" && platform !== "openai") return;
      if (this.isPollingPaused() || !this.host.isViewMounted()) return;
      var svcId = id.projectId, owner = id.owner;
      var queue = bgIndexingQueueName(id.userId, id.projectId);
      var ask = function(status) {
        return Promise.resolve(probeBgQueue(
          { service: svcId, owner, platform, queue, status, limit: WORKER_PASS_ADOPT_LIMIT },
          { maxAgeMs: 0 }
        )).then(function(entry2) {
          return entry2.result;
        }).catch(function() {
          return null;
        });
      };
      this._adoptingWorkerPasses = true;
      Promise.all([ask("running"), ask("pending")]).then(function(results) {
        self._adoptingWorkerPasses = false;
        var now = self.host.getIdentity();
        if (now.projectId !== svcId || now.platform !== platform) return;
        if (!self.host.isViewMounted()) return;
        if (results[0] !== null && results[1] !== null) {
          self._recordLiveIndexKeys(results);
          self._noteLiveLook(svcId, platform, results);
          self._ensureAdoptTick();
        }
        if (results[0] !== null) self._promoteListedRunning(results[0]);
        var emptyLook = results[0] !== null && results[1] !== null && !(results[0].list || []).length && !(results[1].list || []).length;
        var adoptedIds = [];
        var found = [];
        for (var ri = 0; ri < results.length; ri++) {
          var list = results[ri] && Array.isArray(results[ri].list) ? results[ri].list : [];
          for (var i = 0; i < list.length; i++) if (list[i]) found.push(list[i]);
        }
        found.sort(function(a, b) {
          var x = String(a.id || ""), y = String(b.id || "");
          return x < y ? -1 : x > y ? 1 : 0;
        });
        for (var fi = 0; fi < found.length; fi++) {
          if (self._adoptWorkerIndexingItem(found[fi], svcId, platform)) adoptedIds.push(found[fi].id);
        }
        if (adoptedIds.length) {
          self.drainBgTaskQueue();
          if (self._isTrackingAny(adoptedIds)) {
            self._ensureAdoptTick();
            return;
          }
        }
        if (single) return;
        if (passive && !self._hasLiveIndexEvidence(svcId)) {
          if (emptyLook) self._idleVerdictAt[svcId] = Date.now();
          return;
        }
        if (attempt + 1 >= WORKER_PASS_ADOPT_ATTEMPTS.length) {
          if (emptyLook) self._idleVerdictAt[svcId] = Date.now();
          self._nudgeIndexingDrain();
          return;
        }
        setTimeout(function() {
          var later = self.host.getIdentity();
          if (later.projectId !== svcId || later.platform !== platform) return;
          if (self.isPollingPaused() || !self.host.isViewMounted()) return;
          self._adoptWorkerIndexingPasses(attempt + 1, passive);
        }, WORKER_PASS_ADOPT_ATTEMPTS[attempt + 1]);
      }, function() {
        self._adoptingWorkerPasses = false;
      });
    }
    /** Anything at all suggesting THIS project's indexing may be live: a queued
     *  local entry, a recorded live key (the adopt look just wrote them), or an
     *  attached poll. Gates the passive adopt ladder's climb. */
    _hasLiveIndexEvidence(svcId) {
      for (var i = 0; i < this.bgTaskQueue.length; i++) {
        var e = this.bgTaskQueue[i];
        if (e && e.projectId === svcId) return true;
      }
      var keys = this.state.liveIndexKeys || {};
      for (var k in keys) {
        if (keys[k]) return true;
      }
      var found = false;
      this.historyItemPolls.forEach(function(h) {
        if (h && h.kind === "bg") found = true;
      });
      if (found) return true;
      var cutoff = Date.now() - RECENT_INDEX_PASS_EVIDENCE_MS;
      var idleAt = this._idleVerdictAt[svcId] || 0;
      if (idleAt > cutoff) cutoff = idleAt;
      var msgs = this.state.messages;
      for (var mi = msgs.length - 1; mi >= 0; mi--) {
        var m = msgs[mi];
        if (!m || !m._indexFile) continue;
        if (typeof m._ts !== "number") continue;
        if (m._ts >= cutoff) return true;
      }
      return false;
    }
    /** Any of these ids still queued or still polled, i.e. surviving work. */
    _isTrackingAny(ids) {
      for (var i = 0; i < ids.length; i++) {
        if (this.historyItemPolls.has(ids[i])) return true;
        for (var q = 0; q < this.bgTaskQueue.length; q++) {
          if (this.bgTaskQueue[q].id === ids[i]) return true;
        }
      }
      return false;
    }
    /** One live bg-queue item -> a BgTaskEntry, if it is an indexing pass this
     *  client is not already tracking. Returns whether it was adopted. */
    _adoptWorkerIndexingItem(item, svcId, platform) {
      if (!item || typeof item.id !== "string" || !item.id) return false;
      if (item.status !== "pending" && item.status !== "running") return false;
      if (typeof item.poll !== "function") return false;
      if (this.historyItemPolls.has(item.id)) return false;
      for (var q = 0; q < this.bgTaskQueue.length; q++) {
        if (this.bgTaskQueue[q].id === item.id) return false;
      }
      for (var m = 0; m < this.state.messages.length; m++) {
        var msg = this.state.messages[m];
        if (msg._serverItemId !== item.id) continue;
        if (!(msg.isPending || msg.isPendingInProcess || msg.isPendingQueued)) return false;
      }
      var userText;
      if (item.compact && typeof item.request_text === "string") {
        userText = item.request_text;
      } else {
        var body = item.request_body;
        if (!body || typeof body !== "object") return false;
        if (platform === "claude" ? !Array.isArray(body.messages) : !Array.isArray(body.input)) return false;
        userText = extractLastUserTextFromRequest(body);
      }
      if (!isIndexingRequestText(userText)) return false;
      var ref = parseIndexingRequestText(userText);
      if (!ref || !ref.name) return false;
      if (!this._isWorkerDrivenIndexing(ref.name, ref.mime)) return false;
      this.bgTaskQueue.push({
        projectId: svcId,
        platform,
        id: item.id,
        filename: ref.name,
        storagePath: ref.path,
        mime: ref.mime,
        size: ref.size,
        status: item.status === "running" ? "running" : "pending",
        poll: item.poll,
        // Drives the "(continuing)" label and marks this as a continuation for
        // _applyIndexCancellations, which must not read a CONTINUE pass as the
        // fresh first pass that lifts a stop.
        resumePass: ref.continued ? 1 : 0,
        // Settled by the 10-second queue check when the host can look a row up by id
        // (csrHistoryItemLookup); otherwise polled as before.
        byListing: typeof chatEngineConfig().csrHistoryItemLookup === "function",
        adoptedAt: Date.now()
      });
      return true;
    }
    /** Follow the chain on from a background indexing pass that just settled. */
    _followWorkerIndexingChain(filename, mime) {
      if (!this._isWorkerDrivenIndexing(filename, mime)) return;
      this._adoptWorkerIndexingPasses(0);
    }
    /** Best-effort server-side cancel of a bg-queue item that has no bubble (so
     *  cancelQueuedMessage, which drives one, has nothing to act on). */
    _cancelServerItem(serverId) {
      var id = this.host.getIdentity();
      if (!serverId || id.platform !== "claude" && id.platform !== "openai") return;
      var url = id.platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
      Promise.resolve(this.host.cancelRequest({
        url,
        method: "POST",
        id: serverId,
        queue: bgIndexingQueueName(id.userId, id.projectId),
        service: id.projectId,
        owner: id.owner
      })).catch(function() {
      });
    }
    // Inject "Indexing: <file>" bubbles for queued bg tasks + attach their polls.
    drainBgTaskQueue() {
      var self = this;
      var id = this.host.getIdentity();
      var svcId = id.projectId, plat = id.platform;
      if (!svcId || plat === "none" || !this.host.isViewMounted()) return;
      this._ensureReturnWatch();
      this._applyIndexCancellations();
      this._sweepCancelledIndexing();
      this._ensureAdoptTick();
      var presentIds = {};
      var pendingIds = {};
      this.state.messages.forEach(function(m) {
        var sid = m._serverItemId;
        if (sid == null) return;
        presentIds[sid] = true;
        if (m.isPending || m.isPendingInProcess || m.isPendingQueued) pendingIds[sid] = true;
      });
      for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
        var e = this.bgTaskQueue[i];
        if (e.projectId !== svcId || e.platform !== plat) continue;
        if (presentIds[e.id] && !pendingIds[e.id]) {
          this._flipRunFromSettledEntry(e);
          this.bgTaskQueue.splice(i, 1);
        }
      }
      var bgPollBudget = MAX_CONCURRENT_BG_POLLS - this._countBgPolls();
      var listingSettles = typeof chatEngineConfig().csrHistoryItemLookup === "function" || this._recNewMode();
      var injectedAny = false;
      var drainKey = this.getHistoryCacheKey();
      this.bgTaskQueue.forEach(function(entry2) {
        if (entry2.projectId !== svcId || entry2.platform !== plat) return;
        if (!entry2.identity) entry2.identity = Object.assign({}, id);
        if (entry2.owner === void 0) entry2.owner = entry2.identity.owner;
        if (entry2.ownerKey === void 0) entry2.ownerKey = drainKey;
        self.trackOpenItem(entry2.id, {
          ownerKey: entry2.ownerKey,
          projectId: entry2.projectId,
          owner: entry2.owner,
          platform: entry2.platform,
          // Its queue too: the look reads that queue's counters to know when to read it.
          queue: self._bgQueueOf(entry2),
          uid: entry2.identity.userId,
          kind: "indexing",
          state: entry2.status === "running" ? "running" : "queued"
        });
        if (!presentIds[entry2.id]) {
          var isRunning = entry2.status === "running";
          var userBubble = {
            role: "user",
            content: self.host.formatIndexingLabel(entry2.filename, entry2.mime, entry2.size, entry2.storagePath, entry2.isReindex, !!entry2.resumePass),
            isBackgroundTask: true,
            _serverItemId: entry2.id,
            // Structured ref so this live pass groups with the same file's passes
            // rebuilt from history (see indexing_groups.buildChatDisplayList).
            _indexFile: {
              name: entry2.filename,
              path: entry2.storagePath,
              mime: entry2.mime,
              size: entry2.size,
              isReindex: !!entry2.isReindex,
              continued: !!entry2.resumePass
            }
          };
          if (isRunning) userBubble.isPendingInProcess = true;
          else userBubble.isPendingQueued = true;
          var stageAt = self._stageIndex(self.state.messages, entry2.stageId);
          var runningBubble = isRunning ? { role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: entry2.id } : null;
          if (stageAt === -1) {
            self.state.messages.push(userBubble);
            if (runningBubble) self.state.messages.push(runningBubble);
          } else if (runningBubble) {
            self.state.messages.splice(stageAt, 0, userBubble, runningBubble);
          } else {
            self.state.messages.splice(stageAt, 0, userBubble);
          }
          presentIds[entry2.id] = true;
          injectedAny = true;
        }
        if (listingSettles && !entry2.byListing) {
          entry2.byListing = true;
          if (typeof entry2.adoptedAt !== "number") entry2.adoptedAt = Date.now();
        }
        if (!entry2.byListing && bgPollBudget > 0 && !self.isPollingPaused() && !self.historyItemPolls.has(entry2.id) && typeof entry2.poll === "function") {
          bgPollBudget--;
          var capturedPlat = plat;
          var capturedEntry = entry2;
          var executedAt;
          var bp = entry2.poll({
            latency: POLL_INTERVAL,
            // Status push (statusPushEnabled): a pass adopted from a listing is polled
            // slowly while frames arrive, like one this page dispatched. A dispatch
            // reply's poll decides that from the server's acknowledgement and
            // ignores this key.
            notify: statusPushEnabled(),
            onResponse: function(_res, meta) {
              if (meta && typeof meta.executed === "number" && meta.executed > 0) executedAt = meta.executed;
            }
          });
          self._trackPoll(entry2.id, "bg", bp);
          self._settleBgOutcome(capturedEntry, capturedPlat, bp, function() {
            return executedAt;
          });
        }
      });
      if (injectedAny) {
        this.host.notify();
        this.updateHistoryCache();
        this.host.scrollToBottomIfSticky(false);
      }
      this.promoteNextBgQueuedToRunning();
    }
    /**
     * Settle one background pass from the outcome of reading it: its poll (drainBgTaskQueue)
     * or a single by-id lookup made by the 10-second queue check (_settleByListing). Both
     * read the same row the same way, so they share this one path: the resolution, the
     * resume/chain follow-up, the failure bubble and run record, and the queue entry's removal.
     * A stopped poll (isPollStopped) leaves the bubble and the entry as they were.
     */
    _settleBgOutcome(entry2, plat, outcome, getExecutedAt) {
      var self = this;
      var capturedId = entry2.id, capturedPlat = plat;
      var capturedEntry = entry2;
      var ctx = {
        projectId: entry2.projectId,
        platform: entry2.platform,
        owner: entry2.owner !== void 0 ? entry2.owner : entry2.identity ? entry2.identity.owner : void 0,
        ownerKey: entry2.ownerKey
      };
      var wasStopped = false;
      var kept = false;
      var bgQueue = this._bgQueueOf(entry2);
      return outcome.then(function(response) {
        if (isPollStopped(response)) {
          wasStopped = true;
          return;
        }
        self.handleHistoryItemResolution(capturedId, response, capturedPlat, getExecutedAt(), ctx);
        var resumeKey = "resume:" + capturedEntry.projectId + ":" + capturedId;
        if (sideEffectDone(resumeKey) && capturedEntry.storagePath) self._forgetChain(capturedEntry.projectId, capturedEntry.storagePath, capturedId);
        runSettleSideEffect(capturedEntry.projectId, bgQueue, resumeKey, function() {
          self.maybeResumeIndexing(capturedEntry, response, capturedPlat);
        });
      }, function(err) {
        self.historyItemPolls.delete(capturedId);
        var workerDriven = self._isWorkerDrivenIndexing(capturedEntry.filename, capturedEntry.mime);
        if (isNotExistsError(err)) {
          self.applyTerminal(capturedId, cancelledEnvelope(capturedId), ctx);
          if (!workerDriven) {
            self._flipRunRecord(capturedEntry, "cancelled");
            self._nudgeIndexingDrain();
          }
          return;
        }
        if (isTransportFailure(err) || isAuthExpiredError(err)) {
          kept = true;
          console.warn("[chat-engine] a read of indexing pass " + capturedId + " failed on the way; left as it is", err);
          return;
        }
        self.applyTerminal(capturedId, pollErrorBody(err), ctx);
        if (!workerDriven) {
          self._flipRunRecord(capturedEntry, "error", self._runErrorText(err));
          self._nudgeIndexingDrain();
        }
      }).catch(function(e) {
        console.error("[chat-engine] settling indexing pass " + capturedId + " threw", e);
      }).then(function() {
        if (wasStopped || kept) return;
        var qi = self.bgTaskQueue.findIndex(function(q) {
          return q.id === capturedId;
        });
        if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
        var refresh = chatEngineConfig().refreshRecords;
        if (typeof refresh === "function" && !self.bgTaskQueue.some(function(q) {
          return !!q && q.projectId === capturedEntry.projectId;
        })) {
          runSettleSideEffect(capturedEntry.projectId, bgQueue, "records:" + capturedEntry.projectId + ":" + capturedId, function() {
            try {
              refresh(capturedEntry.projectId);
            } catch (e) {
            }
          });
        }
        self.drainBgTaskQueue();
      });
    }
    // Resume-across-passes: if a background INDEXING task for a paged file (spreadsheet or
    // text) finished WITHOUT the completion marker, the agent ran out of room before reading
    // the whole file - dispatch a CONTINUE pass (up to a cap) that resumes from where the
    // already-saved records leave off. Additive + guarded so it never loops forever and
    // never breaks the resolution path.
    //
    // VISION files (PDFs rendered to page images) are NOT resumed here: the proxy worker
    // advances their page window itself, off the renderer's true page count. Driving them
    // from the browser is what used to lose pages on long documents - the chain lived in tab
    // memory (a reload or a closed tab ended it), and it stopped whenever the model claimed
    // completion, which on an 88-page file happened at page 15. Continuing to dispatch here
    // as well would now double-index every window.
    /** Fire the consumer's done::-marker hook for a run whose completion this
     *  client knows DETERMINISTICALLY (see the two call sites in
     *  maybeResumeIndexing). Best-effort by contract; identity-checked so a
     *  project switch mid-settle cannot stamp the wrong service. */
    _mintDoneMarker(entry2) {
      try {
        var mint = chatEngineConfig().mintIndexDoneMarker;
        if (!mint || !entry2 || !entry2.storagePath || !entry2.projectId) return;
        if (!entry2.identity) {
          var id = this.host.getIdentity();
          if (!id || id.projectId !== entry2.projectId) return;
        }
        var path = entry2.storagePath;
        runSettleSideEffect(entry2.projectId, this._bgQueueOf(entry2), "done:" + entry2.projectId + ":" + path + ":" + entry2.id, function() {
          return mint({ service: entry2.projectId, storagePath: path });
        });
      } catch (_e) {
      }
    }
    /** Short, storable form of an error body for the run:: record. */
    _runErrorText(response) {
      var msg = "";
      try {
        msg = String(getErrorMessage(response) || "");
      } catch (_e) {
      }
      msg = msg.replace(/\s+/g, " ").trim();
      return msg ? msg.slice(0, 300) : "Indexing failed.";
    }
    /** Close the records of a run whose pass settled OFF-POLL — the answer came
     *  back as history (hidden tab, dead poll, resume refetch), so none of the
     *  poll-side settle handlers ran. Only for SINGLE-PASS files, where one
     *  settled pass is deterministically the whole run (the same contract as
     *  maybeResumeIndexing's single-pass branch); paged files stay with their
     *  drivers. Outcome is read from the settled bubbles' own flags, which is
     *  all the history mapping left us. Best-effort and idempotent throughout. */
    _flipRunFromSettledEntry(entry2) {
      try {
        if (!entry2 || !entry2.storagePath || !entry2.id || !entry2.projectId) return;
        if (isPagedReadFile(entry2.filename, entry2.mime)) return;
        if (this.cancelledIndexKeys.has(this._indexKeyOf(entry2))) return;
        if (this.state.stoppedIndexIds[entry2.id]) return;
        var userMsg = null, replyMsg = null;
        this.state.messages.forEach(function(m) {
          if (m._serverItemId !== entry2.id) return;
          if (m.role === "user") {
            if (!userMsg) userMsg = m;
          } else if (!replyMsg) replyMsg = m;
        });
        if (userMsg && userMsg.isCancelled || replyMsg && replyMsg.isCancelled) {
          this._flipRunRecord(entry2, "cancelled");
        } else if (replyMsg && replyMsg.isError) {
          var errText = typeof replyMsg.content === "string" ? replyMsg.content.replace(/\s+/g, " ").trim().slice(0, 300) : "";
          this._flipRunRecord(entry2, "error", errText || "Indexing failed.");
        } else if (replyMsg) {
          this._mintDoneMarker(entry2);
          this._flipRunRecord(entry2, "done");
        }
      } catch (_e) {
      }
    }
    /** Close the durable run:: record for an ending THIS client observed.
     *  service comes from the ENTRY, not the current identity: unlike the done::
     *  mint above, a status flip must land even if the user switched projects
     *  mid-settle — otherwise the record lies 'working' forever. Best-effort
     *  through upsertIndexRunRecordSafe; the consumer's precedence guard keeps
     *  repeats and races harmless. */
    _flipRunRecord(entry2, status, error) {
      if (!entry2 || !entry2.storagePath || !entry2.projectId) return;
      var patch = { status, finished: Date.now() };
      if (error) patch.error = error;
      var projectId = entry2.projectId, path = entry2.storagePath;
      this._forgetChain(projectId, path, entry2.id);
      runSettleSideEffect(projectId, this._bgQueueOf(entry2), "run:" + projectId + ":" + path + ":" + entry2.id + ":" + status, function() {
        return upsertIndexRunRecordSafe(projectId, path, patch, { report: true });
      });
    }
    maybeResumeIndexing(entry2, response, platform) {
      var self = this;
      var endOfClientChain = function() {
        self._nudgeIndexingDrain();
      };
      try {
        if (!entry2 || !entry2.storagePath) return;
        if (this.cancelledIndexKeys.has(this._indexKeyOf(entry2))) return;
        if (!isPagedReadFile(entry2.filename, entry2.mime)) {
          if (!isErrorResponseBody(response) && !this._isCancelledPollResult(response)) {
            this._mintDoneMarker(entry2);
            this._flipRunRecord(entry2, "done");
          } else if (this._isCancelledPollResult(response)) {
            this._flipRunRecord(entry2, "cancelled");
          } else {
            this._flipRunRecord(entry2, "error", this._runErrorText(response));
          }
          endOfClientChain();
          return;
        }
        if (isImageVisionFile(entry2.filename, entry2.mime)) return;
        if (windowedIndexingEnabled() && isWindowedReadFile(entry2.filename, entry2.mime)) return;
        if (isErrorResponseBody(response)) {
          this._flipRunRecord(entry2, "error", this._runErrorText(response));
          endOfClientChain();
          return;
        }
        var answer = (platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response)) || "";
        if (answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1) {
          this._mintDoneMarker(entry2);
          this._flipRunRecord(entry2, "done");
          endOfClientChain();
          return;
        }
        var pass = (entry2.resumePass || 0) + 1;
        if (pass > MAX_INDEXING_RESUME_PASSES) {
          this._flipRunRecord(entry2, "error", "Stopped after " + MAX_INDEXING_RESUME_PASSES + " passes without finishing.");
          endOfClientChain();
          return;
        }
        var id = entry2.identity && entry2.identity.projectId === entry2.projectId && entry2.identity.platform === entry2.platform ? entry2.identity : this.host.getIdentity();
        if (!id || id.platform === "none" || id.projectId !== entry2.projectId) {
          this._flipRunRecord(entry2, "error", "Indexing stopped: the session or project changed before the file finished.");
          endOfClientChain();
          return;
        }
        if (!claimSideEffect("next:" + entry2.projectId + ":" + entry2.storagePath + ":" + entry2.id)) return;
        this._sendNextIndexingPass(entry2, id, pass, 0);
      } catch (e) {
      }
    }
    /**
     * Send the next pass of a client-driven file (maybeResumeIndexing) and follow it. A POST
     * that failed on the way may still have been queued, so with a cref it becomes a pending
     * send the discovery listing looks for on the bg queue: found, it is followed like any
     * pass; not found by two complete listings, it is sent once more with a new cref. A
     * refusal, a second miss, or no way to look for it (no cref, no batch reads) ends the
     * chain: run:: says NEXT_PASS_NOT_SENT_TEXT.
     */
    _sendNextIndexingPass(entry2, id, pass, attempt) {
      var self = this;
      var platform = id.platform === "openai" ? "openai" : "claude";
      var canLook = this._recNewMode() && crefSupported();
      var cref = canLook ? newClientRef() : void 0;
      var queue = bgIndexingQueueName(id.userId || id.projectId, id.projectId);
      var follow = function(rid, status, poll) {
        for (var q = 0; q < self.bgTaskQueue.length; q++) if (self.bgTaskQueue[q] && self.bgTaskQueue[q].id === rid) return;
        self.bgTaskQueue.push({
          projectId: id.projectId,
          platform,
          id: rid,
          identity: Object.assign({}, id),
          owner: id.owner,
          ownerKey: entry2.ownerKey,
          filename: entry2.filename,
          storagePath: entry2.storagePath,
          isReindex: entry2.isReindex,
          mime: entry2.mime,
          size: entry2.size,
          status: status === "running" ? "running" : "pending",
          poll,
          resumePass: pass
          // Deliberately NOT stamped with entry.stageId. Only a batch's FIRST
          // pass anchors to the turn; a continuation appends, which is the
          // order the server queued it in and therefore the order
          // promoteNextBgQueuedToRunning should spin it in. It costs nothing
          // on screen: a continuation is folded into the run whose row
          // already sits above the turn, and renders nothing at its own
          // index (indexing_groups anchors a run at its FIRST loaded pass).
        });
        self.noteBgQueueChanged();
        self.drainBgTaskQueue();
      };
      var giveUp = function() {
        self._flipRunRecord(entry2, "error", NEXT_PASS_NOT_SENT_TEXT);
        self._nudgeIndexingDrain();
      };
      this.trackIndexDispatch(notifyAgentContinueIndexing({
        platform,
        model: id.model,
        service: id.projectId,
        // Without this the resume pass rebuilds its system prompt from the RAW
        // regional id (requests.ts falls back to `service`), and the model copies
        // that id verbatim into project_id tool calls, which the MCP schema
        // pattern rejects - the whole continue pass saves nothing.
        publicProjectId: id.publicProjectId,
        owner: id.owner,
        userId: id.userId || id.projectId,
        serviceName: id.serviceName,
        serviceDescription: id.serviceDescription,
        attachment: {
          name: entry2.filename,
          storagePath: entry2.storagePath,
          mime: entry2.mime,
          size: entry2.size,
          url: ""
        },
        cref
      }).then(function(ack) {
        if (ack && typeof ack.id === "string") follow(ack.id, ack.status, ack.poll);
      }, function(e) {
        console.error("[chat-engine] resume-indexing dispatch failed", e);
        if (!cref || !isTransportFailure(e) || isNotExistsError(e)) {
          giveUp();
          return;
        }
        self._recAddPendingSend({
          cref,
          key: entry2.ownerKey || chatCacheKey(id.projectId, platform, id.userId),
          projectId: id.projectId,
          owner: id.owner,
          platform,
          queue,
          // The pass that just settled is older than the one being looked for.
          watermark: entry2.id,
          params: null,
          uid: id.userId,
          kind: "indexing",
          onFound: function(row) {
            follow(row.id, row.status, void 0);
          },
          onMissing: function() {
            if (attempt < 1) self._sendNextIndexingPass(entry2, id, pass, attempt + 1);
            else giveUp();
          }
        });
      }));
    }
    // --- history fetch + pagination --------------------------------------
    // Initial load (fetchMore=false) replaces the list (with in-flight rescue +
    // cancelled-merge) and attaches polls to running/pending items; pagination
    // (fetchMore=true) prepends older messages. The DOM scroll-restore for the
    // older-prepend is the VIEW's job (it captures the pre-prepend scroll position
    // and restores after this resolves) — the engine never measures the DOM.
    loadHistory(fetchMore, token) {
      var self = this;
      var id = this.host.getIdentity();
      var loadKey = chatCacheKey(id.projectId, id.platform, id.userId);
      if (token === void 0) token = this.state.gateRefreshToken;
      if (this.state.loadingHistory && this.state.historyRequestToken === token || id.platform === "none" || !id.projectId) {
        return Promise.resolve();
      }
      if (!fetchMore && token === this._recFirstPageToken && this._recFirstPageDoneAt && nowMs() - this._recFirstPageDoneAt < CATCH_UP_MIN_GAP_MS) {
        return Promise.resolve();
      }
      this.state.historyRequestToken = token;
      this.state.loadingHistory = true;
      if (!fetchMore) {
        this._recFirstPageAt = nowMs();
        this._recFirstPageToken = token;
      }
      if (!fetchMore && loadKey !== this._liveIndexKey) {
        this._liveIndexKey = loadKey;
        this._resetLiveIndexKeys();
      }
      if (fetchMore) this.state.loadingOlderHistory = true;
      if (!fetchMore) this.state.passPaging = {};
      this.host.notify();
      var platform = id.platform;
      var projectId = id.projectId, owner = id.owner;
      var options = { fetchMore };
      if (fetchMore && this.state.historyStartKeyHistory.length) options.startKeyHistory = this.state.historyStartKeyHistory.slice();
      if (!fetchMore) options.deferBg = true;
      var fetchHistory = function() {
        return getSplitChatHistory({
          service: projectId,
          owner,
          platform,
          userId: id.userId,
          // An anonymous visitor's history is scoped server side by
          // ip + "(" + user_agent + ")", which two devices behind one NAT
          // share. Read this device's own queue instead. See
          // scopeSurfaceToQueue.
          scopeSurfaceToQueue: !!id.anonymous,
          // Chats only when a file's row can load its own passes (lazyIndexRowsEnabled).
          skipBg: self.lazyIndexRowsEnabled()
        }, options);
      };
      return Promise.resolve().then(fetchHistory).catch(function(err) {
        if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(fetchHistory);
        throw err;
      }).then(function(history) {
        if (token !== self.state.gateRefreshToken) {
          if (!fetchMore && self._recFirstPageToken !== self.state.gateRefreshToken) {
            self._recFirstPageOwed = true;
            self._recFirstPageAt = 0;
            self._recEnsure();
          }
          return;
        }
        var chatList = history && Array.isArray(history.list) ? history.list : [];
        chatList.forEach(function(item) {
          if (isBgIndexingQueue(item.queue_name)) {
            var clsText = item.compact ? item.request_text : extractLastUserTextFromRequest(item.request_body);
            if (isIndexingRequestText(clsText)) item._isBgTask = true;
            else item._isOnBgQueue = true;
          }
        });
        var list = chatList.sort(function(a, b) {
          var ai = typeof a.id === "string" ? a.id : "", bi = typeof b.id === "string" ? b.id : "";
          return ai > bi ? -1 : ai < bi ? 1 : 0;
        });
        var mapped = mapHistoryListToMessages(list, platform, {
          clearedAt: self.host.getClearedAt(),
          projectId: id.projectId,
          // So the `_ownerKey` stamped on server history matches loadKey and
          // the cache key. Without it every mapped bubble carries a
          // two-segment stamp that no comparison can ever match.
          userId: id.userId,
          formatIndexingLabel: self.host.formatIndexingLabel
        }).messages;
        self.applyHydratedBodies(mapped);
        self._adoptLocalAnswers(mapped, loadKey);
        var keptOlderPages = false;
        var keptScreenAwaitingBg = false;
        if (fetchMore) {
          var incomingKeys = {};
          mapped.forEach(function(m) {
            if (m._serverItemId) incomingKeys[m._serverItemId + "|" + m.role] = m;
          });
          var existing = self.state.messages.filter(function(m) {
            if (!m._serverItemId) return true;
            var inc = incomingKeys[m._serverItemId + "|" + m.role];
            if (!inc) return true;
            if (m._cancelling) inc._cancelling = m._cancelling;
            if (m._cancelError) inc._cancelError = m._cancelError;
            return false;
          });
          var mergedList = [];
          var pi = 0, ei = 0;
          while (pi < mapped.length && ei < existing.length) {
            var pm = mapped[pi], em = existing[ei];
            var eid = em._serverItemId;
            if (typeof eid !== "string") break;
            var pid = pm._serverItemId;
            if (typeof pid !== "string" || pid <= eid) {
              mergedList.push(pm);
              pi++;
            } else {
              mergedList.push(em);
              ei++;
            }
          }
          while (pi < mapped.length) mergedList.push(mapped[pi++]);
          while (ei < existing.length) mergedList.push(existing[ei++]);
          self.state.messages = mergedList;
        } else if (!mapped.length && history && (history.endOfList === false || history.bgPending) && self.state.messages.some(function(m) {
          return m._ownerKey === void 0 || m._ownerKey === loadKey;
        })) {
          if (history.endOfList !== false) keptScreenAwaitingBg = true;
        } else {
          if (self.state.typing) self.state.typingAbort = true;
          var serverIds = {};
          mapped.forEach(function(m) {
            if (m._serverItemId) serverIds[m._serverItemId] = 1;
          });
          var surfaceOldestId = void 0;
          mapped.forEach(function(m) {
            if (typeof m._serverItemId !== "string" || m._fromBgChain) return;
            if (surfaceOldestId === void 0 || m._serverItemId < surfaceOldestId) surfaceOldestId = m._serverItemId;
          });
          var locallyCancelled = {};
          self.state.messages.forEach(function(m) {
            if (m.isCancelled && m._serverItemId) locallyCancelled[m._serverItemId] = m;
          });
          var inFlightCancel = {};
          self.state.messages.forEach(function(m) {
            if (!m._serverItemId) return;
            if (m._cancelling || m._cancelError) inFlightCancel[m._serverItemId] = m;
          });
          var mappedHasPendingAssistant = mapped.some(function(m) {
            return m.isPending && m.role === "assistant" && !m.isBackgroundTask;
          });
          var rescued = [];
          for (var ri = 0; ri < self.state.messages.length; ri++) {
            var mm = self.state.messages[ri];
            if (shouldRescueInFlightMessage(mm, {
              hasServerId: function(sid) {
                return !!serverIds[sid];
              },
              pageHasPendingAssistant: mappedHasPendingAssistant,
              sending: !!self.state.sending,
              next: self.state.messages[ri + 1],
              loadKey
            })) rescued.push(mm);
          }
          var oldestInPage1 = void 0;
          mapped.forEach(function(m) {
            var sid = m._serverItemId;
            if (typeof sid !== "string") return;
            if (oldestInPage1 === void 0 || sid < oldestInPage1) oldestInPage1 = sid;
          });
          var sharesPage1 = self.state.messages.some(function(m) {
            return typeof m._serverItemId === "string" && !!serverIds[m._serverItemId];
          });
          var deferredBg = !!(history && history.bgPending);
          var retainBoundary = surfaceOldestId !== void 0 ? surfaceOldestId : oldestInPage1;
          var retainedOlder = !sharesPage1 || retainBoundary === void 0 ? [] : self.state.messages.filter(function(m) {
            if (typeof m._serverItemId !== "string") return false;
            if (m._ownerKey !== void 0 && m._ownerKey !== loadKey) return false;
            if (deferredBg && m.isBackgroundTask) return true;
            if (m._fromBgChain) return true;
            return m._serverItemId < retainBoundary;
          });
          var prependOlder = [];
          var interleave = [];
          retainedOlder.forEach(function(m) {
            var sid = m._serverItemId;
            if (serverIds[sid]) return;
            if (retainBoundary !== void 0 && sid < retainBoundary) prependOlder.push(m);
            else interleave.push(m);
          });
          var page1 = mapped;
          if (interleave.length) {
            var mergedP = [];
            var ii2 = 0, mi2 = 0;
            while (ii2 < interleave.length && mi2 < mapped.length) {
              var iv = interleave[ii2], mv = mapped[mi2];
              var mid2 = typeof mv._serverItemId === "string" ? mv._serverItemId : void 0;
              if (mid2 === void 0) break;
              if (iv._serverItemId <= mid2) {
                mergedP.push(iv);
                ii2++;
              } else {
                mergedP.push(mv);
                mi2++;
              }
            }
            while (ii2 < interleave.length) mergedP.push(interleave[ii2++]);
            while (mi2 < mapped.length) mergedP.push(mapped[mi2++]);
            page1 = mergedP;
          }
          keptOlderPages = prependOlder.length > 0 || interleave.length > 0;
          self.state.messages = prependOlder.length ? prependOlder.concat(page1) : page1;
          rescued.forEach(function(m) {
            if (m._serverItemId && self.state.messages.some(function(x) {
              return x._serverItemId === m._serverItemId && x.role === m.role;
            })) return;
            self.state.messages.push(m);
          });
          if (Object.keys(locallyCancelled).length) {
            for (var ci = 0; ci < self.state.messages.length; ci++) {
              var c = self.state.messages[ci];
              if (!c._serverItemId || !locallyCancelled[c._serverItemId] || c.isCancelled) continue;
              self.state.messages[ci] = {
                role: "user",
                content: c.content,
                isCancelled: true,
                _serverItemId: c._serverItemId,
                isBackgroundTask: c.isBackgroundTask,
                _indexFile: c._indexFile,
                _useBgQueue: c._useBgQueue,
                _ownerKey: c._ownerKey
              };
              if (ci + 1 < self.state.messages.length && self.state.messages[ci + 1].isPending && self.state.messages[ci + 1]._serverItemId === c._serverItemId) {
                self.state.messages.splice(ci + 1, 1);
              }
            }
          }
          for (var fi = 0; fi < self.state.messages.length; fi++) {
            var fm = self.state.messages[fi];
            var was = fm._serverItemId && inFlightCancel[fm._serverItemId];
            if (!was || fm.isCancelled) continue;
            if (!(fm.isPendingQueued || fm.isPendingInProcess || fm.isPending)) continue;
            if (was._cancelling) fm._cancelling = true;
            if (was._cancelError) fm._cancelError = was._cancelError;
          }
        }
        if (!keptOlderPages) {
          self.state.historyEndOfList = !!(history && history.endOfList);
          self.state.historyStartKeyHistory = history && Array.isArray(history.startKeyHistory) ? history.startKeyHistory : [];
          var clearedAt = self.host.getClearedAt();
          if (clearedAt) {
            var surfaceItems = chatList.filter(function(it) {
              return !(it && it._fromBgChain);
            });
            if (surfaceItems.length > 0) {
              var oldestUpdated = Number(surfaceItems[surfaceItems.length - 1] && surfaceItems[surfaceItems.length - 1].updated);
              if (isFinite(oldestUpdated) && oldestUpdated <= clearedAt) self.state.historyEndOfList = true;
            }
          }
        }
        if (self.state.historyRequestToken === token) {
          self.state.loadingHistory = false;
          self.state.loadingOlderHistory = false;
        }
        self.updateHistoryCache();
        self.host.notify();
        self._scheduleStreamRecovery(loadKey, platform, projectId, owner);
        var bgPending = !fetchMore && history && history.bgPending;
        if (bgPending) {
          var batchId = ++_bgHistoryBatchSeq;
          if (history.endOfList !== true && history.firstLoad === true) {
            self.state.bgHistoryLoading = true;
            self.host.notify();
          }
          var releaseBgFlag = function() {
            if (_bgHistoryBatchSeq === batchId) self.state.bgHistoryLoading = false;
          };
          bgPending.then(function(batch) {
            if (token !== self.state.gateRefreshToken) {
              releaseBgFlag();
              return;
            }
            var bList = batch && Array.isArray(batch.list) ? batch.list : [];
            bList.forEach(function(item) {
              if (isBgIndexingQueue(item.queue_name)) {
                var t = item.compact ? item.request_text : extractLastUserTextFromRequest(item.request_body);
                if (isIndexingRequestText(t)) item._isBgTask = true;
                else item._isOnBgQueue = true;
              }
            });
            var sorted = bList.sort(function(a, b) {
              var ai = typeof a.id === "string" ? a.id : "", bi = typeof b.id === "string" ? b.id : "";
              return ai > bi ? -1 : ai < bi ? 1 : 0;
            });
            var m2 = mapHistoryListToMessages(sorted, platform, {
              clearedAt: self.host.getClearedAt(),
              projectId: id.projectId,
              userId: id.userId,
              formatIndexingLabel: self.host.formatIndexingLabel
            }).messages;
            self.applyHydratedBodies(m2);
            if (keptScreenAwaitingBg && !m2.length && batch && batch.endOfList === true) {
              self.state.messages = self.state.messages.filter(function(m) {
                if (typeof m._serverItemId !== "string") return true;
                if (m._ownerKey !== void 0 && m._ownerKey !== loadKey) return true;
                return false;
              });
              self.state.historyEndOfList = true;
              releaseBgFlag();
              self.updateHistoryCache();
              self.host.notify();
              return;
            }
            var incoming = {};
            m2.forEach(function(m) {
              if (m._serverItemId) incoming[m._serverItemId + "|" + m.role] = true;
            });
            var baseList = self.state.messages.filter(function(m) {
              return !(m._serverItemId && incoming[m._serverItemId + "|" + m.role]);
            });
            var mergedList2 = [];
            var pi2 = 0, ei2 = 0;
            while (pi2 < m2.length && ei2 < baseList.length) {
              var pm2 = m2[pi2], em2 = baseList[ei2];
              var eid2 = em2._serverItemId;
              if (typeof eid2 !== "string") break;
              var pid2 = pm2._serverItemId;
              if (typeof pid2 !== "string" || pid2 <= eid2) {
                mergedList2.push(pm2);
                pi2++;
              } else {
                mergedList2.push(em2);
                ei2++;
              }
            }
            while (pi2 < m2.length) mergedList2.push(m2[pi2++]);
            while (ei2 < baseList.length) mergedList2.push(baseList[ei2++]);
            self.state.messages = mergedList2;
            if (batch && batch.endOfList === true) self.state.historyEndOfList = true;
            releaseBgFlag();
            self.updateHistoryCache();
            self.host.notify();
            if (self.host.settleScroll) self.host.settleScroll();
          }, function() {
            releaseBgFlag();
            self.host.notify();
          });
        }
        if (!fetchMore) {
          var followedByLook = false;
          var bgAllow = {};
          var bgHistBudget = MAX_CONCURRENT_BG_POLLS - self._countBgPolls();
          if (bgHistBudget > 0) {
            var bgIds = chatList.filter(function(it) {
              if (it.status !== "running" && it.status !== "pending") return false;
              if (!it.poll || !it.id) return false;
              if (!(it._isBgTask || it._isOnBgQueue)) return false;
              return !self.historyItemPolls.has(it.id);
            }).map(function(it) {
              return it.id;
            }).sort();
            for (var ba = 0; ba < bgIds.length && ba < bgHistBudget; ba++) bgAllow[bgIds[ba]] = true;
          }
          chatList.slice().sort(function(a, b) {
            var ai = typeof a.id === "string" ? a.id : "", bi = typeof b.id === "string" ? b.id : "";
            return ai < bi ? -1 : ai > bi ? 1 : 0;
          }).forEach(function(item) {
            if (item.status !== "running" && item.status !== "pending") return;
            if (!item.poll || !item.id) return;
            if (self.historyItemPolls.has(item.id)) return;
            if (self.isItemSettled(item.id) && !self._hasWaitingBubble(item.id, loadKey)) return;
            var itemCtx = { ownerKey: loadKey, projectId, owner, platform, queue: item.queue_name };
            self.trackOpenItem(item.id, {
              ownerKey: loadKey,
              projectId,
              owner,
              platform,
              queue: item.queue_name,
              kind: item._isBgTask ? "indexing" : "chat",
              state: item.status === "running" ? "running" : "queued",
              cref: typeof item.cref === "string" ? item.cref : void 0,
              anonymous: !!id.anonymous,
              uid: id.userId
            });
            if (item._isBgTask && self.trackHistoryIndexPass(item)) return;
            if (self._recNewMode()) {
              followedByLook = true;
              return;
            }
            if ((item._isBgTask || item._isOnBgQueue) && self.isPollingPaused()) return;
            if ((item._isBgTask || item._isOnBgQueue) && !bgAllow[item.id]) return;
            var capturedId = item.id;
            var isBg = !!(item._isBgTask || item._isOnBgQueue);
            var pollOpts = {
              // `meta.executed` rides on the poll's running ticks, so a pass this
              // path re-attached to (a reload or a remount while its chain was
              // still going) shows its duration at settle exactly as one polled
              // from the drain does. Without it, only passes started in this page
              // life would be stamped.
              onResponse: function(response, meta) {
                if (isPollStopped(response)) return;
                self.handleHistoryItemResolution(capturedId, response, platform, meta && meta.executed, itemCtx);
              },
              // Only the server's own answer changes the screen: NOT_EXISTS settles
              // the item as cancelled, a failure on the way leaves it as it is (the
              // next look settles it), and the read never sends anything again.
              onError: function(err) {
                self.onPollFailure(capturedId, err, itemCtx);
              }
            };
            var pp = isBg ? item.poll(Object.assign({ latency: POLL_INTERVAL, notify: statusPushEnabled() }, pollOpts)) : self._fgPollWithEarlyProbe(item, capturedId, pollOpts, {
              platform,
              projectId,
              owner,
              ownerKey: loadKey
            });
            self._trackPoll(capturedId, item._isBgTask || item._isOnBgQueue ? "bg" : "fg", pp);
            if (pp && pp.catch) pp.catch(function() {
            });
          });
          self.drainBgTaskQueue();
          if (followedByLook) void self._recSched().trigger("add");
        }
        if (!fetchMore) self.refreshLiveIndexState();
        if (!fetchMore) self._recFirstPageDoneAt = nowMs();
        if (!fetchMore) return self.host.settleScroll ? self.host.settleScroll() : self.host.scrollToBottomIfSticky();
      }).catch(function(err) {
        console.warn("[chat-engine] getChatHistory failed", err);
        if (!fetchMore && isTransportFailure(err) && token === self.state.gateRefreshToken) {
          self._recFirstPageOwed = true;
          self._recFirstPageAt = 0;
          self._recEnsure();
        }
      }).then(function() {
        if (self.state.historyRequestToken === token) {
          var wasLoading = self.state.loadingHistory || self.state.loadingOlderHistory;
          self.state.loadingHistory = false;
          self.state.loadingOlderHistory = false;
          if (wasLoading) self.host.notify();
        }
        if (self.host.onHistoryLoaded) self.host.onHistoryLoaded(!!fetchMore, token);
      });
    }
    // --- attachment upload orchestration ---------------------------------
    /**
     * The user cancelled this chip's upload (the widget's per-chip x or "Cancel all
     * uploads"). Stops the bytes now when they are moving (the host's abort), and
     * leaves a flag every later step of uploadSingleAttachment checks, so a cancel
     * that lands between steps (the get-signed-url round trip before the bytes, or
     * the src:: record and the indexing request after them) still stops the file
     * from being indexed and from being attached to the chat turn. A member whose
     * indexing request has already gone out is past cancelling: it shows as an
     * indexing row with its own Stop. Returns false for a chip that is not being
     * uploaded by this session any more.
     */
    cancelAttachmentUpload(att) {
      if (!att || att._cancelled) return false;
      if (att.status !== "uploading" && !att._batchId) return false;
      att._cancelled = true;
      if (typeof att._abort === "function") {
        try {
          att._abort();
        } catch (e) {
        }
      }
      return true;
    }
    // Upload one attachment (a file = 1 member, a folder = N) to db storage and
    // queue indexing per member. The bytes I/O + chip rendering go through host
    // hooks; the overwrite/reindex flow, status lifecycle, and indexing live here.
    uploadSingleAttachment(att, stageId) {
      var self = this;
      var id = this.host.getIdentity();
      var isIndexRetry = att.status === "indexError";
      att.status = "uploading";
      att.progress = null;
      att.errorMessage = "";
      att.errorCode = "";
      att.errorDetail = "";
      this.host.renderAttachmentChips();
      var members = att.kind === "folder" ? (att.files || []).map(function(f) {
        return { file: f.file, relPath: f.path, storagePath: self.host.storagePathFor(f.path) };
      }) : [{ file: att.file, relPath: att.name, storagePath: this.host.storagePathFor(att.name) }];
      var total = members.length;
      if (!total) return Promise.reject(new Error("Empty attachment"));
      var urls = [];
      var anyIndexFailed = false;
      var reusedCount = 0;
      att.reused = false;
      att._storedCount = 0;
      att._indexQueuedCount = 0;
      att._indexQueued = false;
      att._landedNew = [];
      var cancelError = function() {
        var e = new Error(UPLOAD_CANCELLED_MESSAGE);
        e.code = "CANCELLED";
        return e;
      };
      var checkCancel = function() {
        if (att._cancelled) throw cancelError();
      };
      delete att.duplicates;
      var chain = Promise.resolve();
      var findDuplicate = function(member) {
        if (typeof self.host.findDuplicateUpload !== "function") return Promise.resolve(null);
        var storedName = String(member.storagePath || "").split("/").filter(Boolean).pop() || member.file.name;
        return resolveSkipDuplicateFiles(id.projectId).then(function(on) {
          if (!on) return null;
          return Promise.resolve(self.host.findDuplicateUpload({ name: storedName, size: member.file.size })).then(function(hit) {
            return hit && typeof hit.storagePath === "string" && hit.storagePath ? hit.storagePath : null;
          });
        }).catch(function() {
          return null;
        });
      };
      members.forEach(function(member, idx) {
        chain = chain.then(function() {
          checkCancel();
          var hadExists = false;
          var skipped = false;
          var promotion = null;
          var duplicateOf = null;
          var existedBefore = false;
          var madeRecord = false;
          var sentAll = false;
          var onProg = function(p) {
            if (p && p.total && p.loaded >= p.total) sentAll = true;
            if (p && p.total) {
              att.progress = Math.floor((idx + p.loaded / p.total) / total * 100);
              self.host.renderAttachmentChips();
            }
          };
          var doMemberUpload = function(checkExistence) {
            checkCancel();
            sentAll = false;
            return self.host.uploadFile({
              file: member.file,
              storagePath: member.storagePath,
              checkExistence,
              onProgress: onProg,
              // The host hands its abort over just before the bytes start. A
              // cancel made during the get-signed-url round trip had nothing to
              // abort yet, so it is applied here, before anything is sent: a
              // storage POST that never completes leaves no object behind.
              setAbort: function(abort) {
                att._abort = abort;
                if (att._cancelled) {
                  try {
                    abort();
                  } catch (e) {
                  }
                }
              }
            }).then(function(r) {
              att._abort = null;
              att._storedCount = (att._storedCount || 0) + 1;
              if (checkExistence) att._landedNew.push(member.storagePath);
              return r;
            }, function(err) {
              att._abort = null;
              if (att._cancelled) {
                if (checkExistence && sentAll) att._landedNew.push(member.storagePath);
                throw cancelError();
              }
              throw err;
            });
          };
          if (isIndexRetry) {
            hadExists = true;
            existedBefore = true;
          }
          return (isIndexRetry ? Promise.resolve(null) : findDuplicate(member)).then(function(dup) {
            if (isIndexRetry) return;
            if (dup) {
              duplicateOf = dup;
              console.log("[chat-engine] skipping an upload the user already has:", member.storagePath, "->", dup);
              return;
            }
            return doMemberUpload(true);
          }).catch(function(err) {
            var code = err && (err.code || err.body && err.body.code);
            var msg = err && (err.message || err.body && err.body.message || (typeof err === "string" ? err : ""));
            var isExists = code === "EXISTS" || msg && /exist/i.test(msg);
            if (!isExists) throw err;
            return self.host.promptOverwrite(member.file.name).then(function(choice) {
              if (choice === "overwrite") {
                existedBefore = true;
                promotion = self.collectLinkedCopies([member.storagePath]);
                markImagePreviewStale(self.host.getIdentity().projectId || "default", member.storagePath);
                return doMemberUpload(false);
              }
              if (choice === "skip") {
                skipped = true;
                return;
              }
              hadExists = true;
              existedBefore = true;
            });
          }).then(function() {
            checkCancel();
            if (skipped) return;
            return Promise.resolve(self.host.getTemporaryUrl(duplicateOf || member.storagePath)).catch(function(err) {
              var ecode = err && (err.code || err.body && err.body.code);
              var emsg = String(err && (err.message || err.body && err.body.message) || err || "");
              var refused = /no access to this file/i.test(emsg) || ecode === "INVALID_REQUEST" && /access/i.test(emsg);
              if (duplicateOf || !refused || typeof self.host.ensureFileIndexRecord !== "function") throw err;
              madeRecord = !existedBefore;
              return Promise.resolve(self.host.ensureFileIndexRecord(member.storagePath, {
                name: member.file.name,
                mime: member.file.type || self.host.getMimeType(member.file.name),
                size: member.file.size
              })).then(function() {
                return self.host.getTemporaryUrl(member.storagePath);
              });
            });
          }).then(function(url) {
            if (att._cancelled) {
              var dropEarly = madeRecord && typeof self.host.deleteExistingFileRecord === "function" ? Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function() {
              }) : Promise.resolve();
              return dropEarly.then(function() {
                throw cancelError();
              });
            }
            if (skipped) return;
            if (duplicateOf) {
              urls.push({ name: member.relPath, url, storagePath: duplicateOf });
              if (!att.duplicates) att.duplicates = [];
              att.duplicates.push({
                label: member.relPath,
                storagePath: duplicateOf,
                name: member.file.name,
                size: member.file.size,
                mime: member.file.type || self.host.getMimeType(member.file.name) || void 0
              });
              reusedCount += 1;
              if (att.kind !== "folder") {
                att.uploadedUrl = url;
                att.storagePath = duplicateOf;
                att.reused = true;
              } else att.reusedCount = reusedCount;
              self.host.renderAttachmentChips();
              return;
            }
            urls.push({ name: member.relPath, url, storagePath: member.storagePath });
            if (att.kind !== "folder") {
              att.uploadedUrl = url;
              att.storagePath = member.storagePath;
            }
            var mime = member.file.type || self.host.getMimeType(member.file.name);
            var alreadyIndexing = false;
            var existingGroup = null;
            var clearedOld = false;
            var preIndex = self.claimIndexRun(member.storagePath).then(function(claimed) {
              alreadyIndexing = !claimed;
              if (alreadyIndexing) {
                console.log("[chat-engine] skipping a duplicate index request for", member.storagePath);
                return;
              }
              if (!existedBefore || att._cancelled) return;
              var readGroup = typeof self.host.readFileAccessGroup === "function" ? Promise.resolve(self.host.readFileAccessGroup(member.storagePath)).then(function(g) {
                existingGroup = g || null;
              }, function(err) {
                self.releaseIndexRun(member.storagePath);
                throw err;
              }) : Promise.resolve();
              return readGroup.then(function() {
                if (att._cancelled) return;
                if (typeof self.host.deleteExistingFileRecord === "function") {
                  clearedOld = true;
                  return Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function() {
                  });
                }
              });
            });
            preIndex = preIndex.then(function() {
              if (alreadyIndexing) return;
              if (att._cancelled && !clearedOld) return;
              if (typeof self.host.ensureFileIndexRecord !== "function") return;
              if (!existedBefore) madeRecord = true;
              return Promise.resolve(self.host.ensureFileIndexRecord(member.storagePath, {
                name: member.file.name,
                mime: mime || void 0,
                size: member.file.size
              }, existingGroup || void 0)).catch(function() {
              });
            });
            var accessGroup;
            preIndex = preIndex.then(function() {
              if (alreadyIndexing) return;
              if (existingGroup) {
                accessGroup = existingGroup;
                return;
              }
              if (typeof self.host.uploadAccessGroup !== "function") return;
              return Promise.resolve(self.host.uploadAccessGroup(member.storagePath)).then(function(g) {
                accessGroup = g || void 0;
              }).catch(function() {
              });
            });
            var abandonIfCancelled = function() {
              if (!att._cancelled) return;
              if (!alreadyIndexing) self.releaseIndexRun(member.storagePath);
              var drop = !existedBefore && !alreadyIndexing && madeRecord && typeof self.host.deleteExistingFileRecord === "function" ? Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function() {
              }) : Promise.resolve();
              return drop.then(function() {
                throw cancelError();
              });
            };
            return preIndex.then(function() {
              return abandonIfCancelled();
            }).then(function() {
              return parseAttachmentContent(member.file, member.file.name, mime || void 0);
            }).then(function(parsedContent) {
              return Promise.resolve(abandonIfCancelled()).then(function() {
                return parsedContent;
              });
            }).then(function(parsedContent) {
              if (alreadyIndexing) return;
              att._indexQueuedCount = (att._indexQueuedCount || 0) + 1;
              if (att.kind !== "folder") att._indexQueued = true;
              att._landedNew = (att._landedNew || []).filter(function(p) {
                return p !== member.storagePath;
              });
              self.host.renderAttachmentChips();
              return self.trackIndexDispatch(notifyAgentSaveAttachment({
                platform: id.platform,
                model: id.model,
                service: id.projectId,
                publicProjectId: id.publicProjectId,
                owner: id.owner,
                userId: id.userId || id.projectId,
                serviceName: id.serviceName,
                serviceDescription: id.serviceDescription,
                attachment: {
                  name: member.file.name,
                  storagePath: member.storagePath,
                  mime: mime || void 0,
                  size: member.file.size,
                  url,
                  accessGroup
                },
                parsedContent: parsedContent || void 0
              }).then(function(ack) {
                if (ack && typeof ack.id === "string") {
                  self.bgTaskQueue.push({
                    projectId: id.projectId,
                    platform: id.platform,
                    id: ack.id,
                    identity: Object.assign({}, id),
                    owner: id.owner,
                    filename: member.file.name,
                    storagePath: member.storagePath,
                    isReindex: hadExists,
                    mime: mime || void 0,
                    size: member.file.size,
                    status: ack.status === "running" ? "running" : "pending",
                    poll: ack.poll,
                    // Puts this file's row directly above the chat turn it was
                    // attached to (drainBgTaskQueue). Undefined for an
                    // attachment-only send, which appends.
                    stageId
                  });
                  self.noteBgQueueChanged();
                  self.drainBgTaskQueue();
                  if (promotion) {
                    var plan = promotion;
                    promotion = null;
                    plan.then(function(pl) {
                      return self.promoteLinkedCopies(pl);
                    }).catch(function() {
                    });
                  }
                }
              }, function(e) {
                console.error("[chat-engine] indexing request failed", e);
                self.releaseIndexRun(member.storagePath);
                anyIndexFailed = true;
                if (!att.errorCode && !att.errorDetail) {
                  att.errorCode = e && (e.code || e.body && e.body.code) || "";
                  att.errorDetail = e && (e.message || e.body && e.body.message) || (typeof e === "string" ? e : "");
                }
              }));
            });
          });
        });
      });
      return chain.then(function() {
        checkCancel();
        att._abort = null;
        att.progress = 100;
        if (att.kind === "folder") att.uploadedUrls = urls.map(function(u) {
          return { path: u.name, url: u.url, storagePath: u.storagePath };
        });
        att.status = anyIndexFailed ? "indexError" : "done";
        if (att.status === "indexError") att.errorMessage = "File indexing failed";
        self.host.renderAttachmentChips();
        return urls;
      });
    }
    // Upload all not-yet-done attachments sequentially. Resolves to the full
    // list of { name, url, storagePath } for composing the chat message.
    //
    // `batchId` scopes the run to the chips stamped with it at Send time. The
    // composer stays live during an upload, so by the time this runs the
    // attachment list can already hold chips the user picked for the NEXT
    // message — uploading those here would attach them to the wrong turn, and
    // collecting the previous batch's finished urls would attach files the user
    // already sent. Omitted (no batch) means every chip, the old behavior.
    //
    // `stageId` is the turn these chips were attached to, carried onto every indexing
    // task so its collapsed row renders directly ABOVE that turn's bubble (see
    // BgTaskEntry.stageId). Omitted for an attachment-only send, which has no turn.
    uploadPendingAttachments(batchId, stageId) {
      var self = this;
      this.host.resetOverwriteBatch();
      this._uploadBatches += 1;
      this.state.uploadingAttachments = true;
      this.host.updateComposerControls();
      this.host.renderAttachmentChips();
      var collected = [];
      var snapshot = this.state.attachments.filter(function(a) {
        return batchId ? a._batchId === batchId : true;
      });
      var chain = Promise.resolve();
      snapshot.forEach(function(att) {
        chain = chain.then(function() {
          if (!self.state.attachments.some(function(a) {
            return a.id === att.id;
          })) return;
          if (att.status === "done") {
            if (att.kind === "folder" && att.uploadedUrls) {
              att.uploadedUrls.forEach(function(u) {
                collected.push({ name: u.path, url: u.url, storagePath: u.storagePath });
              });
              return;
            }
            if (att.uploadedUrl) {
              collected.push({ name: att.name, url: att.uploadedUrl, storagePath: att.storagePath });
              return;
            }
          }
          return self.uploadSingleAttachment(att, stageId).then(function(us) {
            collected.push.apply(collected, us);
          }).catch(function(err) {
            var removed = !self.state.attachments.some(function(a) {
              return a.id === att.id;
            });
            var aborted = err && (err.message === "Aborted" || err === "Aborted");
            if (att._cancelled || isUploadCancelledError(err)) {
              att.status = "cancelled";
              att._abort = null;
              self.host.renderAttachmentChips();
              if (typeof att._onCancelSettled === "function") {
                try {
                  att._onCancelSettled((att._landedNew || []).slice());
                } catch (e) {
                }
              }
              return;
            }
            if (removed || aborted) return;
            att.status = "error";
            att.errorMessage = "File upload has failed";
            att.errorCode = err && (err.code || err.body && err.body.code) || "";
            att.errorDetail = err && (err.message || err.body && err.body.message) || (typeof err === "string" ? err : "");
            self.host.renderAttachmentChips();
          }).then(function() {
            att._settledBatch = att._batchId || true;
          });
        });
      });
      var done = function() {
        self._uploadBatches = Math.max(0, self._uploadBatches - 1);
        self.state.uploadingAttachments = self._uploadBatches > 0;
        self.host.updateComposerControls();
        self.host.renderAttachmentChips();
        return collected;
      };
      return chain.then(done, done);
    }
    // Stop timers / abort the typewriter (view teardown).
    stop() {
      this.state.typingAbort = true;
    }
    // Bump the gate token so any in-flight immediate-send result is dropped
    // (called by the view on a service/platform switch or history clear).
    bumpGate() {
      this.state.gateRefreshToken += 1;
    }
  };
  /** How many passes one "Load more" brings into a file's row. */
  _ChatSession.RUN_PASS_PAGE = 10;
  var ChatSession = _ChatSession;

  // src/index.js
  (function() {
    var MCP_PROD = "https://mcp.skapi.com";
    var MCP_DEV = "https://mcp.broadwayinc.computer";
    var BQ_VERSION = "1.21.15" ;
    var ATTACHMENT_URL_EXPIRES_SECONDS = 600;
    var GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
    var GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
    var GOOGLE_SCOPE = "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email";
    var MARKED_CDN = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
    var SK = {
      theme: "bq_embed:theme",
      mcpClient: "bq_embed:mcp_client",
      mcpToken: "bq_embed:mcp_token",
      mcpState: "bq_embed:mcp_state",
      // sessionStorage
      googleInProgress: "bq_embed:google_in_progress",
      // sessionStorage
      googleRedirect: "bq_embed:google_redirect",
      // sessionStorage
      clearHorizon: "bq_embed:clearedAt",
      anonId: "bq_embed:anon_id"
      // per-project anonymous device id
    };
    function h(tag, attrs) {
      var el = document.createElement(tag);
      if (attrs) {
        for (var k in attrs) {
          if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
          var v = attrs[k];
          if (v == null || v === false) continue;
          if (k === "class") el.className = v;
          else if (k === "html") el.innerHTML = v;
          else if (k === "text") el.textContent = v;
          else if (k === "dataset") {
            for (var dk in v) el.dataset[dk] = v[dk];
          } else if (k.slice(0, 2) === "on" && typeof v === "function") {
            el.addEventListener(k.slice(2).toLowerCase(), v);
          } else if (k === "style" && typeof v === "object") {
            for (var sk in v) el.style[sk] = v[sk];
          } else if (v === true) {
            el.setAttribute(k, "");
          } else {
            el.setAttribute(k, v);
          }
        }
      }
      for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
      return el;
    }
    function append(parent, child) {
      if (child == null || child === false) return;
      if (Array.isArray(child)) {
        child.forEach(function(c) {
          append(parent, c);
        });
      } else if (child instanceof Node) {
        parent.appendChild(child);
      } else {
        parent.appendChild(document.createTextNode(String(child)));
      }
    }
    function clear(el) {
      while (el && el.firstChild) el.removeChild(el.firstChild);
      return el;
    }
    function escapeHtml(s) {
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function getQueryParam(name) {
      var m = window.location.search.match(new RegExp("[?&]" + name + "=([^&]+)"));
      return m ? decodeURIComponent(m[1]) : null;
    }
    function cleanUrl() {
      try {
        var url = window.location.origin + window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, url);
      } catch (e) {
      }
    }
    function base64UrlEncode(bytes) {
      var str2 = "";
      for (var i = 0; i < bytes.length; i++) str2 += String.fromCharCode(bytes[i]);
      return btoa(str2).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function randBytes(n) {
      var b = new Uint8Array(n);
      crypto.getRandomValues(b);
      return b;
    }
    function safeJsonParse(raw, fallback) {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    }
    function lsGet(key) {
      try {
        return localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    }
    function lsSet(key, v) {
      try {
        localStorage.setItem(key, v);
      } catch (e) {
      }
    }
    function lsDel(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
      }
    }
    function ssGet(key) {
      try {
        return sessionStorage.getItem(key);
      } catch (e) {
        return null;
      }
    }
    function ssSet(key, v) {
      try {
        sessionStorage.setItem(key, v);
      } catch (e) {
      }
    }
    function ssDel(key) {
      try {
        sessionStorage.removeItem(key);
      } catch (e) {
      }
    }
    function getJwtSub(token) {
      if (!token || typeof token !== "string") return null;
      var parts = token.split(".");
      if (parts.length < 2) return null;
      try {
        var payload = JSON.parse(
          atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
        return payload && payload.sub ? payload.sub : null;
      } catch (e) {
        return null;
      }
    }
    var S = {
      skapi: null,
      opts: {},
      mountEl: null,
      // host-provided container
      root: null,
      // .bq-agent element we own
      booted: false,
      user: null,
      // current UserProfile or null
      service: null,
      // resolved service info ({ ai_agent, name, ... })
      projectId: null,
      owner: null,
      theme: null,
      // agent config (read-only, admin-provided)
      aiPlatform: "none",
      // "claude" | "openai" | "none"
      aiModel: "",
      // chat state (populated in the chat-engine phase)
      messages: [],
      attachments: [],
      view: null
      // current view name
    };
    function skey(base) {
      return base + ":" + (S.projectId || "default");
    }
    function anonymousAllowed() {
      if (S.opts && typeof S.opts.allowAnonymous === "boolean") return S.opts.allowAnonymous;
      var conf = S.service && S.service.conf || null;
      if (!conf) return false;
      return conf.require_login === false;
    }
    function isAnonymousSession() {
      return !S.user && anonymousAllowed();
    }
    function randomId() {
      try {
        var buf = new Uint8Array(16);
        (window.crypto || window.msCrypto).getRandomValues(buf);
        var out = "";
        for (var i = 0; i < buf.length; i++) out += ("0" + buf[i].toString(16)).slice(-2);
        return out;
      } catch (e) {
        return "x" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }
    }
    var _anonIdMemo = null;
    function anonDeviceId() {
      if (_anonIdMemo) return _anonIdMemo;
      var key = skey(SK.anonId);
      var stored = lsGet(key);
      if (stored) {
        _anonIdMemo = stored;
        return stored;
      }
      var minted = "anon_" + randomId();
      lsSet(key, minted);
      _anonIdMemo = lsGet(key) || minted;
      return _anonIdMemo;
    }
    function loadTheme() {
      var stored = lsGet(SK.theme);
      if (stored === "dark" || stored === "light") return stored;
      if (S.opts.theme === "dark" || S.opts.theme === "light") return S.opts.theme;
      try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
          return "dark";
        }
      } catch (e) {
      }
      return "light";
    }
    function applyTheme(theme) {
      S.theme = theme === "dark" ? "dark" : "light";
      if (S.root) S.root.setAttribute("data-bq-theme", S.theme);
      var modals = document.querySelectorAll(".bq-modal-root");
      for (var i = 0; i < modals.length; i++) {
        modals[i].setAttribute("data-bq-theme", S.theme);
      }
      lsSet(SK.theme, S.theme);
      var toggles = document.querySelectorAll("[data-bq-theme-toggle]");
      for (var j = 0; j < toggles.length; j++) {
        toggles[j].innerHTML = S.theme === "dark" ? THEME_ICON_SUN : THEME_ICON_MOON;
      }
    }
    function toggleTheme() {
      applyTheme(S.theme === "dark" ? "light" : "dark");
    }
    function getProfile(refresh) {
      try {
        return S.skapi.getProfile(refresh ? { refreshToken: true } : void 0).then(function(u) {
          return u || null;
        }).catch(function() {
          return null;
        });
      } catch (e) {
        return Promise.resolve(null);
      }
    }
    function refreshSkapiSession() {
      return getProfile(true).then(function(u) {
        return !!u;
      });
    }
    function loadServiceInfo() {
      S.projectId = S.skapi && (S.skapi.service || S.skapi.connection && S.skapi.connection.service) || S.projectId;
      S.owner = S.skapi && (S.skapi.owner || S.skapi.connection && S.skapi.connection.owner) || S.owner;
      return Promise.resolve().then(function() {
        if (typeof S.skapi.getConnectionInfo === "function") return S.skapi.getConnectionInfo();
        return S.skapi.connection || null;
      }).then(function(conn) {
        if (S.opts && S.opts.dev) console.log("[bunnyquery] loadServiceInfo", conn);
        if (conn) {
          S.projectId = conn.service || S.projectId;
          S.owner = conn.owner || S.owner;
        }
        return conn;
      }).catch(function() {
        return null;
      });
    }
    function skapiHasForwardRequest(sk) {
      return !!sk && typeof sk.forwardRequestHistory === "function" && typeof sk.forwardRequest === "function";
    }
    function skapiForwardWithSecret(secretName, request) {
      return S.skapi.forwardRequest(null, Object.assign({ secretName }, request));
    }
    function skapiCancelRequest(opts) {
      return S.skapi.cancelForwardRequest(opts);
    }
    function skapiEngineTransport(canStream) {
      return {
        forwardRequest: function(form, o) {
          return S.skapi.forwardRequest(form, o);
        },
        forwardRequestHistory: function(p, f) {
          return S.skapi.forwardRequestHistory(p, f);
        },
        forwardRequestFinalize: canStream ? function(requestId, data, options) {
          return S.skapi.forwardRequestFinalize(requestId, data, options);
        } : void 0,
        forwardRequestStream: canStream ? function(requestId, options) {
          return S.skapi.forwardRequestStream(requestId, options);
        } : void 0,
        // The reconciler's reads (skapi-js 2.7.0; agent.vue's ai_agent.ts same). With
        // the first two the engine follows every waiting request with one batch read
        // per look instead of a poll each; an embedder's older skapi-js hands over
        // none of them and the widget keeps today's polls.
        forwardRequestStatus: typeof S.skapi.forwardRequestStatus === "function" ? function(requests, opts) {
          return S.skapi.forwardRequestStatus(requests, opts);
        } : void 0,
        forwardRequestRead: typeof S.skapi.forwardRequestRead === "function" ? function(params) {
          return S.skapi.forwardRequestRead(params);
        } : void 0,
        forwardRequestQueueCounters: typeof S.skapi.forwardRequestQueueCounters === "function" ? function(queues, opts) {
          return S.skapi.forwardRequestQueueCounters(queues, opts);
        } : void 0
      };
    }
    function render(viewName, builder) {
      if (!S.root) return;
      S.view = viewName;
      clear(S.root);
      var node = builder();
      if (node) S.root.appendChild(node);
    }
    function composerPlaceholder() {
      if (typeof S.opts.inputPlaceholder === "string") return S.opts.inputPlaceholder;
      return "Ask anything about: " + (S.serviceName || "your project");
    }
    function brandTitleText() {
      if (typeof S.opts.title === "string") return S.opts.title;
      return "BunnyQuery" + (S.serviceName ? " \xB7 " + S.serviceName : "");
    }
    function brandTitleEl() {
      var text = brandTitleText();
      return h(
        "div",
        { class: "bq-title-left bq-brand" },
        h("span", { class: "bq-brand-title", title: text, text })
      );
    }
    function pageRoot(content) {
      return h(
        "div",
        { class: "bq-meta" },
        h(
          "div",
          { class: "bq-section-title" },
          h("div", { class: "bq-title-row" }, brandTitleEl())
        ),
        h(
          "div",
          { class: "bq-page" },
          h("div", { class: "bq-settings" }, content),
          pageFooter()
        )
      );
    }
    function pageFooter() {
      return h(
        "div",
        { class: "bq-page-footer" },
        h("a", {
          class: "bq-page-footer-link",
          href: "https://www.bunnyquery.com",
          target: "_blank",
          rel: "noopener noreferrer",
          text: "www.bunnyquery.com"
        }),
        h("div", { class: "bq-page-footer-version", text: "v" + BQ_VERSION })
      );
    }
    var BUNNY_FRAME_A = '  (\\(\\\n  ( - -)\n c(")(")';
    var BUNNY_FRAME_B = '  /)/)\n ( . .)\nc(")(")';
    function bunnyLoader(label, overlay) {
      return h(
        "div",
        {
          class: "bq-bunny-loader" + (overlay ? " bq-bunny-loader--overlay" : ""),
          "aria-hidden": "true",
          translate: "no"
        },
        h(
          "div",
          { class: "bq-bunny-stage" },
          h(
            "div",
            { class: "bq-bunny-track" },
            h(
              "div",
              { class: "bq-bunny-dir" },
              h("pre", { class: "bq-frame bq-frame-a", translate: "no", text: BUNNY_FRAME_A }),
              h("pre", { class: "bq-frame bq-frame-b", translate: "no", text: BUNNY_FRAME_B })
            )
          )
        ),
        label ? h("div", { class: "bq-bunny-loader__label", text: label }) : null
      );
    }
    function showLoading(label) {
      render("loading", function() {
        return h(
          "div",
          { class: "bq-page" },
          h(
            "div",
            { class: "bq-page-loading" },
            bunnyLoader("Loading...")
          ),
          pageFooter()
        );
      });
    }
    function mcpBaseUrl() {
      return String(S.opts.mcpBaseUrl || (S.opts.dev ? MCP_DEV : MCP_PROD)).replace(/\/+$/, "");
    }
    function mcpRedirectUri() {
      return window.location.origin + window.location.pathname;
    }
    function getStoredMcpClient() {
      return safeJsonParse(lsGet(skey(SK.mcpClient)), null);
    }
    function getStoredMcpToken() {
      return safeJsonParse(lsGet(skey(SK.mcpToken)), null);
    }
    function clearStoredMcpToken() {
      lsDel(skey(SK.mcpToken));
    }
    function generateCodeChallenge(verifier) {
      if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
        var data = new TextEncoder().encode(verifier);
        return crypto.subtle.digest("SHA-256", data).then(function(hash) {
          return { challenge: base64UrlEncode(new Uint8Array(hash)), method: "S256" };
        }).catch(function() {
          return { challenge: verifier, method: "plain" };
        });
      }
      return Promise.resolve({ challenge: verifier, method: "plain" });
    }
    function registerMcpClient() {
      var body = {
        client_name: "bunnyquery",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [mcpRedirectUri()],
        token_endpoint_auth_method: "client_secret_basic"
      };
      return fetch(mcpBaseUrl() + "/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function(res) {
        if (!res.ok) {
          return res.text().catch(function() {
            return "";
          }).then(function(t) {
            throw new Error("MCP /oauth/register failed: " + res.status + " " + t);
          });
        }
        return res.json();
      }).then(function(json) {
        if (!json || !json.client_id) throw new Error("MCP register missing client_id");
        var stored = Object.assign({}, json, { registered_at: Date.now() });
        lsSet(skey(SK.mcpClient), JSON.stringify(stored));
        return stored;
      });
    }
    function startMcpAuthorize(client, redirectAfter) {
      var verifier = base64UrlEncode(randBytes(32));
      var state = base64UrlEncode(randBytes(16));
      return generateCodeChallenge(verifier).then(function(cc) {
        ssSet(skey(SK.mcpState), JSON.stringify({
          state,
          codeVerifier: verifier,
          redirectAfter: redirectAfter
        }));
        var currentUri = mcpRedirectUri();
        var params = new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: currentUri,
          login_page: currentUri,
          state,
          code_challenge: cc.challenge,
          code_challenge_method: cc.method
        });
        window.location.replace(mcpBaseUrl() + "/oauth/authorize?" + params.toString());
      });
    }
    function beginMcpOAuthOnLogin(redirectAfter) {
      return registerMcpClient().then(function(client) {
        return startMcpAuthorize(client, redirectAfter);
      });
    }
    function isMcpOAuthCallback() {
      var code = getQueryParam("code");
      var state = getQueryParam("state");
      if (!code || !state) return false;
      var stored = safeJsonParse(ssGet(skey(SK.mcpState)), null);
      return !!(stored && stored.state === state);
    }
    function basicAuthHeader(id, secret) {
      return "Basic " + btoa(id + ":" + secret);
    }
    function completeMcpAuthorize() {
      var stored = safeJsonParse(ssGet(skey(SK.mcpState)), null);
      if (!stored) return Promise.reject(new Error("Missing MCP OAuth state"));
      ssDel(skey(SK.mcpState));
      var code = getQueryParam("code");
      var state = getQueryParam("state");
      if (stored.state !== state) return Promise.reject(new Error("MCP OAuth state mismatch"));
      var client = getStoredMcpClient();
      if (!client) return Promise.reject(new Error("No registered MCP client"));
      var body = new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: mcpRedirectUri(),
        code_verifier: stored.codeVerifier,
        client_id: client.client_id
      });
      var headers = { "Content-Type": "application/x-www-form-urlencoded" };
      if (client.client_secret) {
        headers.Authorization = basicAuthHeader(client.client_id, client.client_secret);
      }
      return fetch(mcpBaseUrl() + "/oauth/token", {
        method: "POST",
        headers,
        body: body.toString()
      }).then(function(res) {
        if (!res.ok) {
          return res.text().catch(function() {
            return "";
          }).then(function(t) {
            throw new Error("MCP /oauth/token failed: " + res.status + " " + t);
          });
        }
        return res.json();
      }).then(function(json) {
        if (!json || !json.access_token) throw new Error("MCP token missing access_token");
        var token = Object.assign({}, json, {
          expires_at: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1e3 : void 0
        });
        lsSet(skey(SK.mcpToken), JSON.stringify(token));
        return { token, redirectAfter: stored.redirectAfter || "chat" };
      });
    }
    function mcpGrantNeedsRefresh(user) {
      var tok = getStoredMcpToken();
      var now = Date.now();
      var tokenSub = getJwtSub(tok && tok.access_token);
      var currentSub = user && typeof user.user_id === "string" ? user.user_id : null;
      var expired = !tok || typeof tok.expires_at === "number" && tok.expires_at < now + 6e4;
      var mismatched = !!tok && !!currentSub && !!tokenSub && tokenSub !== currentSub;
      return expired || mismatched;
    }
    function refreshMcpToken() {
      var client = getStoredMcpClient();
      var current = getStoredMcpToken();
      if (!client || !current || !current.refresh_token) return Promise.resolve(null);
      var body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
        client_id: client.client_id
      });
      var headers = { "Content-Type": "application/x-www-form-urlencoded" };
      if (client.client_secret) {
        headers.Authorization = basicAuthHeader(client.client_id, client.client_secret);
      }
      return fetch(mcpBaseUrl() + "/oauth/token", {
        method: "POST",
        headers,
        body: body.toString()
      }).then(function(res) {
        return res.ok ? res.json() : null;
      }).then(function(json) {
        if (!json || !json.access_token) return null;
        var token = Object.assign({}, json, {
          refresh_token: json.refresh_token || current.refresh_token,
          expires_at: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1e3 : void 0
        });
        lsSet(skey(SK.mcpToken), JSON.stringify(token));
        return token;
      }).catch(function() {
        return null;
      });
    }
    function ensureMcpGrantFresh() {
      if (!S.user) return Promise.resolve(true);
      if (!mcpGrantNeedsRefresh(S.user)) {
        return syncMcpSession().then(function() {
          return true;
        });
      }
      return refreshMcpToken().then(function(tok) {
        if (tok && !mcpGrantNeedsRefresh(S.user)) return true;
        return syncMcpSession().then(function(t) {
          return !!(t && !mcpGrantNeedsRefresh(S.user));
        });
      });
    }
    var mcpSyncInFlight = null;
    function currentSkapiTokens() {
      var s = S.skapi && S.skapi.session;
      var id = s && s.idToken && s.idToken.jwtToken;
      var acc = s && s.accessToken && s.accessToken.jwtToken;
      if (!id || !acc) return null;
      return { id_token: id, access_token: acc, refresh_token: s.refreshToken && s.refreshToken.token || "" };
    }
    function syncMcpSession() {
      if (mcpSyncInFlight) return mcpSyncInFlight;
      var tokens = currentSkapiTokens();
      if (!tokens) return Promise.resolve(null);
      function exchange(client) {
        return fetch(mcpBaseUrl() + "/oauth/session-exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: client.client_id,
            redirect_uri: mcpRedirectUri(),
            id_token: tokens.id_token,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token
          })
        }).then(function(res) {
          return { client, res };
        });
      }
      var stored = getStoredMcpClient();
      mcpSyncInFlight = (stored ? Promise.resolve(stored) : registerMcpClient()).then(exchange).then(function(r) {
        return r.res.status === 401 ? registerMcpClient().then(exchange) : r;
      }).then(function(r) {
        if (!r.res.ok) return null;
        return r.res.json().then(function(j) {
          if (!j || !j.code) return null;
          var headers = { "Content-Type": "application/x-www-form-urlencoded" };
          if (r.client.client_secret) headers.Authorization = basicAuthHeader(r.client.client_id, r.client.client_secret);
          var body = new URLSearchParams({
            grant_type: "authorization_code",
            code: j.code,
            redirect_uri: mcpRedirectUri(),
            client_id: r.client.client_id
          });
          return fetch(mcpBaseUrl() + "/oauth/token", { method: "POST", headers, body: body.toString() }).then(function(tr) {
            if (!tr.ok) return null;
            return tr.json().then(function(json) {
              if (!json || !json.access_token) return null;
              var token = Object.assign({}, json, {
                expires_at: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1e3 : void 0
              });
              lsSet(skey(SK.mcpToken), JSON.stringify(token));
              return token;
            });
          });
        });
      }).catch(function(err) {
        try {
          console.error("[bunnyquery] MCP session sync failed", err);
        } catch (e) {
        }
        return null;
      }).then(function(t) {
        mcpSyncInFlight = null;
        return t;
      });
      return mcpSyncInFlight;
    }
    function googleEnabled() {
      return !!S.opts.googleClientId;
    }
    function googleLogin() {
      if (!googleEnabled()) return;
      var redirectUrl = window.location.origin + window.location.pathname;
      var rnd = isInboundPlatformOAuth() ? getQueryParam("state") : Math.random().toString(36).substring(2);
      ssSet(skey(SK.googleInProgress), "1");
      ssSet(skey(SK.googleRedirect), redirectUrl);
      var url = GOOGLE_AUTH_URL + "?client_id=" + encodeURIComponent(S.opts.googleClientId) + "&redirect_uri=" + encodeURIComponent(redirectUrl) + "&response_type=code&scope=" + encodeURIComponent(GOOGLE_SCOPE) + "&prompt=consent&state=" + encodeURIComponent(rnd) + "&access_type=offline";
      window.location.replace(url);
    }
    function isGoogleOAuthReturn() {
      return !!getQueryParam("code") && ssGet(skey(SK.googleInProgress)) === "1";
    }
    function completeGoogleOAuthReturn() {
      var code = getQueryParam("code");
      var redirectUrl = ssGet(skey(SK.googleRedirect)) || window.location.origin + window.location.pathname;
      var secretName = S.opts.googleClientSecretName || "ggl";
      return skapiForwardWithSecret(secretName, {
        url: GOOGLE_TOKEN_URL,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        data: {
          code,
          client_id: S.opts.googleClientId,
          client_secret: "$CLIENT_SECRET",
          redirect_uri: redirectUrl,
          grant_type: "authorization_code"
        }
      }).then(function(data) {
        ssDel(skey(SK.googleInProgress));
        ssDel(skey(SK.googleRedirect));
        if (!data || data.error || !data.access_token) {
          throw new Error(data && data.error || "Google login failed.");
        }
        return S.skapi.openIdLogin({ id: "by_skapi", token: data.access_token }).catch(function(err) {
          if (err && err.code === "ACCOUNT_EXISTS") {
            if (window.confirm(
              "An account with this Google account already exists.\nMerge accounts? Once merged you cannot login with the previous method."
            )) {
              return S.skapi.openIdLogin({ id: "by_skapi", token: data.access_token, merge: ["name"] });
            }
          }
          throw err;
        });
      });
    }
    function isInboundPlatformOAuth() {
      return getQueryParam("oauth") === "platform" && !!getQueryParam("state") && !!getQueryParam("redirect_uri");
    }
    function genOAuthCallbackUrl(state, session2, params) {
      var redirectUri = params && params.redirect_uri || getQueryParam("redirect_uri") || "";
      var code = {
        access_token: session2.accessToken && session2.accessToken.jwtToken,
        refresh_token: session2.refreshToken && session2.refreshToken.token,
        id_token: session2.idToken && session2.idToken.jwtToken
      };
      var encoded = btoa(JSON.stringify(code));
      return redirectUri + (redirectUri.indexOf("?") !== -1 ? "&" : "?") + "code=" + encodeURIComponent(encoded) + "&state=" + encodeURIComponent(state);
    }
    function returnOAuthToMCP() {
      var state = getQueryParam("state");
      if (!state) {
        renderLogin();
        return;
      }
      var stashed = safeJsonParse(ssGet("oauth:" + state), null);
      var params = stashed || {
        oauth: "platform",
        state,
        redirect_uri: getQueryParam("redirect_uri")
      };
      var waited = 0;
      (function attempt() {
        var session2 = S.skapi.session;
        if (session2 && session2.accessToken && session2.accessToken.jwtToken) {
          ssDel("oauth:" + state);
          window.location.replace(genOAuthCallbackUrl(state, session2, params));
          return;
        }
        if (waited >= 3e3) {
          console.error("[bunnyquery] OAuth bounce aborted: no skapi session.");
          renderLogin();
          return;
        }
        waited += 100;
        setTimeout(attempt, 100);
      })();
    }
    function stashInboundPlatformOAuth() {
      var state = getQueryParam("state");
      if (!state) return;
      try {
        var all = {};
        new URLSearchParams(window.location.search).forEach(function(v, k) {
          all[k] = v;
        });
        ssSet("oauth:" + state, JSON.stringify(all));
      } catch (e) {
      }
    }
    function authHeader(title) {
      return [
        title ? h("h1", { class: "bq-settings-title", text: title }) : null
      ];
    }
    var THEME_ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    var THEME_ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    function loadingBtnLabel(loading, label) {
      return loading ? h("span", { class: "bq-btn-spinner" }) : document.createTextNode(label);
    }
    function googleIconSvg() {
      return '<svg viewBox="0 0 48 48" style="width:20px;height:20px;flex:none"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
    }
    function loginErrorMessage(err) {
      if (!err) return "Login failed.";
      if (err.code === "USER_IS_DISABLED") return "This account is disabled.";
      if (err.code === "INCORRECT_USERNAME_OR_PASSWORD") return "Incorrect email or password.";
      if (err.code === "NOT_EXISTS") return "Incorrect email or password.";
      if (err.code === "SIGNUP_CONFIRMATION_NEEDED") return "Please confirm your email to log in.";
      if (err.message && err.message.indexOf("NOT_EXISTS") !== -1) return "The account does not exist.";
      return err.message || "Login failed.";
    }
    function renderLogin(prefill) {
      render("login", function() {
        var busy = false;
        var emailInput = h("input", {
          class: "bq-input-text",
          type: "email",
          autocomplete: "email",
          placeholder: "your@email.com",
          required: true,
          value: prefill && prefill.email || ""
        });
        var pwInput = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "current-password",
          placeholder: "Enter password",
          required: true
        });
        var submitBtn = h("button", { class: "btn", type: "submit" }, "Login");
        var errorBox = h("div", { class: "bq-error", style: { display: "none" } });
        function setBusy(b) {
          busy = b;
          emailInput.disabled = b;
          pwInput.disabled = b;
          submitBtn.disabled = b;
          clear(submitBtn).appendChild(loadingBtnLabel(b, "Login"));
        }
        function setError(msg) {
          errorBox.style.display = msg ? "" : "none";
          errorBox.textContent = msg || "";
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          setError("");
          setBusy(true);
          S.skapi.login({ email: emailInput.value, password: pwInput.value }).then(function() {
            if (isInboundPlatformOAuth()) {
              return returnOAuthToMCP();
            }
            return beginMcpOAuthOnLogin("chat").catch(function(err) {
              console.error("[bunnyquery] MCP OAuth bootstrap failed", err);
              enterAfterLogin();
            });
          }).catch(function(err) {
            setBusy(false);
            setError(loginErrorMessage(err));
            if (err && err.code === "SIGNUP_CONFIRMATION_NEEDED") {
              renderSignupConfirmation(emailInput.value);
            } else if (err && err.code === "USER_IS_DISABLED" && S.opts.signup) {
              renderEnableAccount(emailInput.value);
            }
          });
        }
        var actions = h("div", { class: "bq-actions" });
        actions.appendChild(h("button", {
          class: "bq-link",
          type: "button",
          onclick: function() {
            renderForgotPassword(emailInput.value);
          },
          text: "Forgot password?"
        }));
        if (S.opts.signup) {
          actions.appendChild(h("button", {
            class: "bq-link",
            type: "button",
            onclick: function() {
              renderSignup();
            },
            text: "Sign up \u2192"
          }));
        }
        var canReturnToChat = !S.user && anonymousAllowed();
        var form = h(
          "form",
          { class: "bq-form", onsubmit: submit },
          h("label", { class: "bq-label" }, h("span", { text: "Email" }), emailInput),
          h("label", { class: "bq-label" }, h("span", { text: "Password" }), pwInput),
          actions,
          errorBox,
          h("div", { class: "bq-form-bottom" }, submitBtn)
        );
        var children = [];
        if (canReturnToChat) {
          children.push(h(
            "div",
            { class: "bq-settings-top" },
            h("button", {
              class: "bq-link",
              type: "button",
              onclick: function() {
                enterAfterLogin();
              },
              text: "\u2190 Back to chat"
            })
          ));
        }
        children = children.concat(authHeader("Login")).concat([form]);
        if (googleEnabled()) {
          children.push(
            h(
              "div",
              { class: "bq-divider" },
              h("div", { class: "bq-divider-line" }),
              h("span", { class: "bq-divider-text", text: "or" }),
              h("div", { class: "bq-divider-line" })
            ),
            h(
              "button",
              { class: "bq-google", type: "button", onclick: function() {
                googleLogin();
              } },
              h("span", { html: googleIconSvg() }),
              h("span", { text: "Continue with Google" })
            )
          );
        }
        return pageRoot(children);
      });
    }
    function authShell(title, children, opts) {
      opts = opts || {};
      var kids = [];
      if (opts.topBack) {
        kids.push(h(
          "div",
          { class: "bq-settings-top" },
          h("button", {
            class: "bq-link",
            type: "button",
            onclick: opts.topBack.onClick,
            text: opts.topBack.label || "\u2190 Back"
          })
        ));
      }
      kids = kids.concat(authHeader(title)).concat(children);
      if (opts.back !== false && !opts.topBack) {
        kids.push(h(
          "div",
          { class: "bq-actions", style: { marginTop: "1.5rem" } },
          h("button", {
            class: "bq-link",
            type: "button",
            onclick: function() {
              renderLogin(opts.backPrefill);
            },
            text: "\u2190 Back to login"
          })
        ));
      }
      return pageRoot(kids);
    }
    function genericErrorMessage(err) {
      if (!err) return "Something went wrong. Please try again.";
      if (err.code === "EXISTS" || err.code === "UsernameExistsException" || err.message && err.message.indexOf("already") !== -1 && err.message.indexOf("use") !== -1) {
        return "This email is already in use.";
      }
      return err.message || "Something went wrong. Please try again.";
    }
    function renderSignup() {
      render("signup", function() {
        var busy = false;
        var email = h("input", {
          class: "bq-input-text",
          type: "email",
          autocomplete: "email",
          placeholder: "your@email.com",
          required: true
        });
        var name = h("input", {
          class: "bq-input-text",
          type: "text",
          autocomplete: "name",
          placeholder: "Your name",
          required: true
        });
        var pw = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "new-password",
          placeholder: "Create a password",
          required: true,
          minlength: "6",
          maxlength: "60"
        });
        var pw2 = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "new-password",
          placeholder: "Confirm password",
          required: true,
          minlength: "6",
          maxlength: "60"
        });
        var subscribe = h("input", { type: "checkbox", checked: true });
        var btn = h("button", { class: "btn", type: "submit" }, "Create account");
        var errBox = h("div", { class: "bq-error", style: { display: "none" } });
        function setBusy(b) {
          busy = b;
          [email, name, pw, pw2].forEach(function(i) {
            i.disabled = b;
          });
          subscribe.disabled = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Create account"));
        }
        function setError(m) {
          errBox.style.display = m ? "" : "none";
          errBox.textContent = m || "";
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          setError("");
          if (pw.value !== pw2.value) {
            setError("Passwords do not match.");
            return;
          }
          setBusy(true);
          var confirmUrl = S.opts.signupConfirmationUrl || window.location.origin + window.location.pathname;
          S.skapi.signup(
            { email: email.value, name: name.value, password: pw.value },
            { signup_confirmation: confirmUrl, email_subscription: !!subscribe.checked }
          ).then(function() {
            renderSignupConfirmation(email.value);
          }).catch(function(err) {
            setBusy(false);
            setError(genericErrorMessage(err));
          });
        }
        var form = h(
          "form",
          { class: "bq-form", onsubmit: submit },
          h("label", { class: "bq-label" }, h("span", { text: "Email" }), email),
          h("label", { class: "bq-label" }, h("span", { text: "Name" }), name),
          h("label", { class: "bq-label" }, h("span", { text: "Password" }), pw),
          h("label", { class: "bq-label" }, h("span", { text: "Confirm password" }), pw2),
          h("label", { class: "bq-checkbox" }, subscribe, h("span", { text: "Receive newsletters from admin" })),
          errBox,
          h("div", { class: "bq-form-bottom" }, btn)
        );
        return authShell("Sign up", [form]);
      });
    }
    function renderSignupConfirmation(email) {
      render("signup-confirmation", function() {
        var busy = false;
        var btn = h("button", { class: "btn", type: "button" }, "Resend confirmation email");
        var note = h("div", { class: "bq-step-note" });
        function setBusy(b) {
          busy = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Resend confirmation email"));
        }
        function setNote(m, ok) {
          note.className = ok ? "bq-success-box" : "bq-error";
          note.style.display = m ? "" : "none";
          note.textContent = m || "";
        }
        setNote("", true);
        note.style.display = "none";
        btn.addEventListener("click", function() {
          if (busy) return;
          setBusy(true);
          S.skapi.resendSignupConfirmation().then(function() {
            setBusy(false);
            setNote("Confirmation email sent. Check your inbox.", true);
          }).catch(function(err) {
            setBusy(false);
            var msg = err && err.message ? err.message : "Could not resend.";
            if (msg.indexOf("Least one login attempt") !== -1) {
              msg = "Request expired. Please log in again to receive a new confirmation email.";
            } else if (err && err.code === "INVALID_REQUEST") {
              msg = "This account has already been confirmed. You can log in.";
            }
            setNote(msg, false);
          });
        });
        return authShell("Verify your email", [
          h(
            "p",
            { class: "bq-settings-sub" },
            "We sent a confirmation link to ",
            h("strong", { text: email || "your email" }),
            ". Click it to activate your account, then log in."
          ),
          h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } }, btn, note)
        ], { backPrefill: { email } });
      });
    }
    function renderForgotPassword(prefillEmail) {
      var ctx = { step: 1, email: prefillEmail || "", code: "" };
      function go() {
        render("forgot-password", function() {
          if (ctx.step === 1) return stepRequest();
          if (ctx.step === 2) return stepVerify();
          if (ctx.step === 3) return stepReset();
          return stepDone();
        });
      }
      function stepRequest() {
        var busy = false;
        var email = h("input", {
          class: "bq-input-text",
          type: "email",
          autocomplete: "email",
          placeholder: "your@email.com",
          required: true,
          value: ctx.email
        });
        var btn = h("button", { class: "btn", type: "submit" }, "Send code");
        var errBox = h("div", { class: "bq-error", style: { display: "none" } });
        function setBusy(b) {
          busy = b;
          email.disabled = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Send code"));
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          errBox.style.display = "none";
          setBusy(true);
          ctx.email = email.value;
          S.skapi.forgotPassword({ email: ctx.email }).then(function() {
            ctx.step = 2;
            go();
          }).catch(function(err) {
            setBusy(false);
            errBox.style.display = "";
            errBox.textContent = err && err.message || "Could not send code.";
          });
        }
        return authShell("Reset password", [
          h("p", { class: "bq-step-note", text: "Enter your email and we'll send a verification code." }),
          h(
            "form",
            { class: "bq-form", onsubmit: submit },
            h("label", { class: "bq-label" }, h("span", { text: "Email" }), email),
            errBox,
            h("div", { class: "bq-form-bottom" }, btn)
          )
        ]);
      }
      function stepVerify() {
        var code = h("input", { class: "bq-input-text", type: "text", placeholder: "Enter verification code", required: true });
        var resendBusy = false;
        var resendBtn = h("button", { class: "bq-link", type: "button", text: "Resend code" });
        var note = h("div", { class: "bq-step-note", style: { display: "none" } });
        resendBtn.addEventListener("click", function() {
          if (resendBusy) return;
          resendBusy = true;
          resendBtn.textContent = "Resending\u2026";
          S.skapi.forgotPassword({ email: ctx.email }).then(function() {
            resendBusy = false;
            resendBtn.textContent = "Resend code";
            note.style.display = "";
            note.className = "bq-success-box";
            note.textContent = "Code re-sent.";
          }).catch(function(err) {
            resendBusy = false;
            resendBtn.textContent = "Resend code";
            note.style.display = "";
            note.className = "bq-error";
            note.textContent = err && err.message || "Could not resend.";
          });
        });
        function submit(e) {
          e.preventDefault();
          if (!code.value.trim()) return;
          ctx.code = code.value.trim();
          ctx.step = 3;
          go();
        }
        return authShell("Reset password", [
          h("p", { class: "bq-step-note" }, "We sent a code to ", h("strong", { text: ctx.email }), "."),
          h(
            "form",
            { class: "bq-form", onsubmit: submit },
            h("label", { class: "bq-label" }, h("span", { text: "Verification code" }), code),
            h("div", { class: "bq-actions" }, resendBtn),
            note,
            h("div", { class: "bq-form-bottom" }, h("button", { class: "btn", type: "submit" }, "Continue"))
          )
        ]);
      }
      function stepReset() {
        var busy = false;
        var pw = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "new-password",
          placeholder: "New password",
          required: true,
          minlength: "6",
          maxlength: "60"
        });
        var pw2 = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "new-password",
          placeholder: "Confirm new password",
          required: true,
          minlength: "6",
          maxlength: "60"
        });
        var btn = h("button", { class: "btn", type: "submit" }, "Reset password");
        var errBox = h("div", { class: "bq-error", style: { display: "none" } });
        function setBusy(b) {
          busy = b;
          pw.disabled = b;
          pw2.disabled = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Reset password"));
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          errBox.style.display = "none";
          if (pw.value !== pw2.value) {
            errBox.style.display = "";
            errBox.textContent = "Passwords do not match.";
            return;
          }
          setBusy(true);
          S.skapi.resetPassword({ email: ctx.email, code: ctx.code, new_password: pw.value }).then(function() {
            ctx.step = 4;
            go();
          }).catch(function(err) {
            setBusy(false);
            errBox.style.display = "";
            errBox.textContent = err && err.message || "Could not reset password.";
            ctx.step = 2;
            setTimeout(go, 1200);
          });
        }
        return authShell("Reset password", [
          h(
            "form",
            { class: "bq-form", onsubmit: submit },
            h("label", { class: "bq-label" }, h("span", { text: "New password" }), pw),
            h("label", { class: "bq-label" }, h("span", { text: "Confirm new password" }), pw2),
            errBox,
            h("div", { class: "bq-form-bottom" }, btn)
          )
        ]);
      }
      function stepDone() {
        return authShell("Password reset", [
          h("div", { class: "bq-success-box", text: "Your password has been changed. You can now log in with your new password." }),
          h(
            "div",
            { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
            h("button", { class: "btn", type: "button", onclick: function() {
              renderLogin({ email: ctx.email });
            } }, "Go to login")
          )
        ], { back: false });
      }
      go();
    }
    function renderEmailVerification(onDone) {
      var ctx = { step: 1, sending: false };
      function go() {
        render("email-verification", function() {
          return ctx.step === 1 ? stepEnter() : stepDone();
        });
      }
      function sendCode(noteEl) {
        if (ctx.sending) return Promise.resolve();
        ctx.sending = true;
        return S.skapi.verifyEmail().then(function() {
          ctx.sending = false;
          if (noteEl) {
            noteEl.style.display = "";
            noteEl.className = "bq-success-box";
            noteEl.textContent = "Code sent. Check your inbox.";
          }
        }).catch(function(err) {
          ctx.sending = false;
          if (noteEl) {
            noteEl.style.display = "";
            noteEl.className = "bq-error";
            noteEl.textContent = err && err.message || "Could not send code.";
          }
        });
      }
      function stepEnter() {
        var code = h("input", { class: "bq-input-text", type: "text", placeholder: "6-digit code", required: true });
        var btn = h("button", { class: "btn", type: "submit" }, "Verify");
        var note = h("div", { style: { display: "none" } });
        var resend = h("button", {
          class: "bq-link",
          type: "button",
          text: "Resend code",
          onclick: function() {
            sendCode(note);
          }
        });
        var busy = false;
        function setBusy(b) {
          busy = b;
          code.disabled = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Verify"));
        }
        function submit(e) {
          e.preventDefault();
          if (busy || !code.value.trim()) return;
          setBusy(true);
          S.skapi.verifyEmail({ code: code.value.trim() }).then(function() {
            ctx.step = 2;
            go();
          }).catch(function(err) {
            setBusy(false);
            note.style.display = "";
            note.className = "bq-error";
            note.textContent = err && err.message || "Invalid code.";
          });
        }
        var emailTxt = S.user && S.user.email || "your email";
        var shell = authShell("Verify your email", [
          h("p", { class: "bq-step-note" }, "We sent a code to ", h("strong", { text: emailTxt }), "."),
          h(
            "form",
            { class: "bq-form", onsubmit: submit },
            h("label", { class: "bq-label" }, h("span", { text: "Verification code" }), code),
            h("div", { class: "bq-actions" }, resend),
            note,
            h("div", { class: "bq-form-bottom" }, btn)
          )
        ], { topBack: {
          label: "\u2190 Back to settings",
          onClick: function() {
            renderChat();
            openChatSettings();
          }
        } });
        sendCode(note);
        return shell;
      }
      function stepDone() {
        return authShell("Email verified", [
          h("div", { class: "bq-success-box", text: (S.user && S.user.email || "Your email") + " has been verified." }),
          h(
            "div",
            { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
            h("button", { class: "btn", type: "button", onclick: function() {
              (onDone || renderChat)();
            } }, "Continue")
          )
        ], { back: false });
      }
      go();
    }
    function settingsSectionTitle(text) {
      return h("div", { class: "bq-settings-section-title", text });
    }
    function accountRow(label, valueNodes, actionLabel, onAction, opts) {
      opts = opts || {};
      return h(
        "div",
        { class: "bq-account-row" },
        h(
          "div",
          { class: "bq-account-row-main" },
          h("div", { class: "bq-account-label", text: label }),
          h("div", { class: "bq-account-value" + (opts.muted ? " is-muted" : "") }, valueNodes)
        ),
        onAction ? h("button", { class: "bq-link" + (opts.dangerAction ? " bq-link--danger" : ""), type: "button", onclick: onAction, text: actionLabel || "Change" }) : null
      );
    }
    function getNewsletterStatus(user) {
      var userId = user && typeof user.user_id === "string" ? user.user_id : null;
      if (!userId) return Promise.resolve(false);
      try {
        return Promise.resolve(S.skapi.getNewsletterSubscription({ group: "authorized", user_id: userId })).then(function(res) {
          var list = res && res.list ? res.list : res;
          if (!Array.isArray(list)) return false;
          return list.some(function(s) {
            return s && s.active && s.group === 1;
          });
        }).catch(function() {
          return false;
        });
      } catch (e) {
        return Promise.resolve(false);
      }
    }
    function toggleChatSettings() {
      if (CS.chatSettingsOpen) closeChatSettings();
      else openChatSettings();
    }
    function openChatSettings() {
      if (!CS.messagesBox || !CS.chatEl || !CS.composerEl) return;
      CS.chatSettingsOpen = true;
      if (CS.settingsBtnEl) CS.settingsBtnEl.classList.add("is-active");
      syncChatStatus();
      if (CS.composerEl.parentNode === CS.chatEl) CS.chatEl.removeChild(CS.composerEl);
      renderAccount();
    }
    function closeChatSettings() {
      CS.chatSettingsOpen = false;
      if (CS.settingsBtnEl) CS.settingsBtnEl.classList.remove("is-active");
      if (CS.composerEl && CS.chatEl && CS.composerEl.parentNode !== CS.chatEl) CS.chatEl.appendChild(CS.composerEl);
      renderMessages();
      scrollToBottom();
      ensureHistoryFillsViewport();
    }
    function renderAccount() {
      if (!CS.messagesBox) return;
      clear(CS.messagesBox);
      CS.messagesBox.appendChild(h(
        "div",
        { class: "bq-chat-settings" },
        h("div", { class: "bq-chat-settings-loading" }, bunnyLoader("Loading..."))
      ));
      getProfile().then(function(user) {
        if (user) S.user = user;
        return getNewsletterStatus(S.user);
      }).then(function(subscribed) {
        S.newsletterSubscribed = subscribed;
        renderSettingsIntoBox();
      }).catch(function() {
        renderSettingsIntoBox();
      });
    }
    function newsletterRow() {
      var checkbox = h("input", { type: "checkbox", checked: !!S.newsletterSubscribed });
      var busy = false;
      checkbox.addEventListener("change", function() {
        if (busy) return;
        busy = true;
        var want = checkbox.checked;
        var op = want ? S.skapi.subscribeNewsletter({ group: "authorized" }) : S.skapi.unsubscribeNewsletter({ group: "authorized" });
        Promise.resolve(op).then(function() {
          S.newsletterSubscribed = want;
          busy = false;
        }).catch(function(err) {
          checkbox.checked = !want;
          busy = false;
          alert(err && err.message || "Could not update subscription.");
        });
      });
      return h(
        "div",
        { class: "bq-account-row" },
        h(
          "label",
          { class: "bq-checkbox" },
          checkbox,
          h("span", { text: "Receive newsletter from admin" })
        )
      );
    }
    function themeRow() {
      var current = S.theme === "dark" ? "dark" : "light";
      function themeRadio(value, label) {
        var input = h("input", { type: "radio", name: "bq-theme" });
        input.checked = value === current;
        input.addEventListener("change", function() {
          if (input.checked) applyTheme(value);
        });
        return h("label", { class: "bq-checkbox" }, input, h("span", { text: label }));
      }
      return h(
        "div",
        { class: "bq-account-row" },
        // h("div", { class: "bq-account-row-main" },
        //     h("div", { class: "bq-account-label", text: "Theme" })),
        h(
          "div",
          { class: "bq-theme-radios" },
          themeRadio("light", "Light mode"),
          themeRadio("dark", "Dark mode")
        )
      );
    }
    function dangerItem(label, desc, btnLabel, onClick) {
      return h(
        "div",
        { class: "bq-danger-item" },
        h("div", { class: "bq-danger-item-title", text: label }),
        h("p", { class: "bq-danger-item-desc", text: desc }),
        h("button", { class: "btn btn--danger", type: "button", onclick: onClick, text: btnLabel })
      );
    }
    function renderSettingsIntoBox() {
      if (!CS.messagesBox) return;
      var u = S.user || {};
      var children = [];
      children.push(h(
        "div",
        { class: "bq-settings-top" },
        h("button", { class: "bq-link", type: "button", onclick: function() {
          closeChatSettings();
        }, text: "\u2190 Back to chat" })
      ));
      children.push(h("h1", { class: "bq-settings-title", text: "Settings" }));
      if (!u.email_verified) {
        children.push(h(
          "div",
          { class: "bq-account-tip" },
          h("strong", { text: "Verify your email. " }),
          document.createTextNode("A verified email is required to recover your password or re-enable your account if you ever lose access."),
          h(
            "div",
            { style: { marginTop: "0.75rem" } },
            h("button", {
              class: "btn",
              type: "button",
              onclick: function() {
                renderEmailVerification(renderChat);
              },
              text: "Verify now"
            })
          )
        ));
      }
      children.push(settingsSectionTitle("Theme"));
      children.push(h("div", { class: "bq-account-section" }, themeRow()));
      var emailValue = [
        document.createTextNode(u.email || "\u2014"),
        h("span", {
          class: "bq-verify-badge " + (u.email_verified ? "is-verified" : "is-unverified"),
          text: u.email_verified ? "verified" : "unverified"
        })
      ];
      children.push(settingsSectionTitle("Account"));
      children.push(h(
        "div",
        { class: "bq-account-section" },
        accountRow("Email", emailValue, "Change", function() {
          openChangeEmailModal();
        }),
        accountRow("Name", [document.createTextNode(u.name || "Unnamed user")], "Change", function() {
          openChangeNameModal();
        }),
        u.signup_ticket === "OIDPASS" ? accountRow("Password", [document.createTextNode("Managed by your login provider")], null, null, { muted: true }) : accountRow("Password", [document.createTextNode("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022")], "Change", function() {
          openChangePasswordModal();
        }),
        newsletterRow()
      ));
      var danger = [h("div", { class: "bq-account-danger-title", text: "Danger zone" })];
      danger.push(dangerItem(
        "Clear history",
        "Hide the current conversation. Your messages stay on the server but won't be shown here again.",
        "Clear history",
        function() {
          openClearHistoryModal();
        }
      ));
      if (S.opts.signup) {
        danger.push(dangerItem(
          "Remove account",
          "Remove your account and delete all your data. You can re-enable within 30 days by logging in.",
          "Remove account",
          function() {
            openDeleteAccountModal();
          }
        ));
      }
      children.push(h("div", { class: "bq-account-danger" }, danger));
      children.push(h(
        "div",
        { class: "bq-account-logout" },
        h("button", { class: "bq-link", type: "button", onclick: function() {
          logout();
        }, text: "Logout \u2192" })
      ));
      children.push(pageFooter());
      clear(CS.messagesBox);
      CS.messagesBox.appendChild(h("div", { class: "bq-chat-settings" }, children));
    }
    function modalForm(title, desc, fields, submitLabel, onSubmit) {
      return openModal(function(close) {
        var err = h("div", { class: "bq-error", style: { display: "none" } });
        var btn = h("button", { class: "btn", type: "submit" }, submitLabel);
        var busy = false;
        function setBusy(b) {
          busy = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, submitLabel));
        }
        function setErr(m) {
          err.style.display = m ? "" : "none";
          err.textContent = m || "";
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          setErr("");
          setBusy(true);
          Promise.resolve(onSubmit(close)).then(function(msg) {
            if (msg && msg.error) {
              setBusy(false);
              setErr(msg.error);
            }
          }).catch(function(e2) {
            setBusy(false);
            setErr(e2 && e2.message || "Something went wrong.");
          });
        }
        var labels = fields.map(function(f) {
          return h("label", { class: "bq-label" }, h("span", { text: f.label }), f.input);
        });
        return h(
          "div",
          { class: "bq-modal" },
          h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
          h("h2", { class: "bq-modal-title", text: title }),
          desc ? h("p", { class: "bq-modal-desc", text: desc }) : null,
          h("form", { class: "bq-form", onsubmit: submit }, labels.concat([
            err,
            h(
              "div",
              { class: "bq-modal-btns" },
              h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"),
              btn
            )
          ]))
        );
      });
    }
    function openChangeNameModal() {
      var input = h("input", { class: "bq-input-text", type: "text", value: S.user && S.user.name || "", placeholder: "Your name", required: true });
      modalForm("Change name", null, [{ label: "Name", input }], "Save", function(close) {
        return S.skapi.updateProfile({ name: input.value }).then(function() {
          if (S.user) S.user.name = input.value;
          close();
          renderAccount();
        });
      });
    }
    function openChangeEmailModal() {
      var input = h("input", { class: "bq-input-text", type: "email", value: S.user && S.user.email || "", placeholder: "your@email.com", required: true });
      modalForm(
        "Change email",
        "After changing your email you'll need to verify it. A verified email is required to recover your account.",
        [{ label: "New email", input }],
        "Save",
        function(close) {
          return S.skapi.updateProfile({ email: input.value }).then(function() {
            if (S.user) {
              S.user.email = input.value;
              S.user.email_verified = false;
            }
            close();
            renderEmailVerification(renderChat);
          });
        }
      );
    }
    function openChangePasswordModal() {
      var cur = h("input", { class: "bq-input-text", type: "password", autocomplete: "current-password", placeholder: "Current password", required: true });
      var pw = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password", placeholder: "New password", required: true, minlength: "6", maxlength: "60" });
      var pw2 = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password", placeholder: "Confirm new password", required: true, minlength: "6", maxlength: "60" });
      modalForm(
        "Change password",
        null,
        [{ label: "Current password", input: cur }, { label: "New password", input: pw }, { label: "Confirm new password", input: pw2 }],
        "Change password",
        function(close) {
          if (pw.value !== pw2.value) return { error: "New passwords do not match." };
          return S.skapi.changePassword({ current_password: cur.value, new_password: pw.value }).then(function() {
            close();
          });
        }
      );
    }
    function openDeleteAccountModal() {
      openModal(function(close) {
        var agree = h("input", { type: "checkbox" });
        var err = h("div", { class: "bq-error", style: { display: "none" } });
        var btn = h("button", { class: "btn btn--danger", type: "button" }, "Disable account");
        var busy = false;
        btn.addEventListener("click", function() {
          if (busy) return;
          if (!agree.checked) {
            err.style.display = "";
            err.textContent = "Please confirm you want to disable your account.";
            return;
          }
          err.style.display = "none";
          busy = true;
          btn.disabled = true;
          clear(btn).appendChild(loadingBtnLabel(true, "Disable account"));
          Promise.resolve(S.skapi.disableAccount()).then(function() {
            clearStoredMcpToken();
            S.user = null;
            close();
            renderBye();
          }).catch(function(e2) {
            busy = false;
            btn.disabled = false;
            clear(btn).appendChild(document.createTextNode("Disable account"));
            err.style.display = "";
            err.textContent = e2 && e2.message || "Could not disable account.";
          });
        });
        return h(
          "div",
          { class: "bq-modal" },
          h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
          h("div", { class: "bq-modal-delete-header" }, h("span", { text: "Disable account" })),
          h("p", { class: "bq-modal-desc" }, "Your data and projects will be hidden and permanently removed after 30 days. You can re-enable within that window by logging in."),
          h("label", { class: "bq-checkbox", style: { marginBottom: "1rem" } }, agree, h("span", { text: "I understand and want to disable my account." })),
          err,
          h(
            "div",
            { class: "bq-modal-btns" },
            h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"),
            btn
          )
        );
      });
    }
    function renderBye() {
      render("bye", function() {
        return pageRoot(authHeader("Account disabled").concat([
          h("p", { class: "bq-settings-sub" }, "Your account has been disabled. All your data will be removed after 90 days. You can recover within that period by logging in and following the recovery email."),
          h(
            "div",
            { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
            h("button", { class: "btn", type: "button", onclick: function() {
              renderLogin();
            }, text: "Back to login" })
          )
        ]));
      });
    }
    function renderEnableAccount(email) {
      var sent = false;
      render("enable-account", function() {
        var busy = false;
        var btn = h("button", { class: "btn", type: "button" }, "Re-send recovery email");
        var note = h("div", { style: { display: "none" } });
        function send() {
          if (busy) return;
          busy = true;
          btn.disabled = true;
          clear(btn).appendChild(loadingBtnLabel(true, "Re-send recovery email"));
          Promise.resolve(S.skapi.recoverAccount(window.location.origin + window.location.pathname)).then(function() {
            busy = false;
            btn.disabled = false;
            clear(btn).appendChild(document.createTextNode("Re-send recovery email"));
            note.style.display = "";
            note.className = "bq-success-box";
            note.textContent = "Recovery email sent. Check your inbox.";
          }).catch(function(err) {
            busy = false;
            btn.disabled = false;
            clear(btn).appendChild(document.createTextNode("Re-send recovery email"));
            note.style.display = "";
            note.className = "bq-error";
            note.textContent = err && err.message || "Could not send recovery email.";
          });
        }
        btn.addEventListener("click", send);
        if (!sent) {
          sent = true;
          send();
        }
        return authShell("Re-enable account", [
          h(
            "p",
            { class: "bq-settings-sub" },
            "We've sent a recovery link to ",
            h("strong", { text: email || "your email" }),
            ". Click it to re-enable your account."
          ),
          h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } }, btn, note)
        ]);
      });
    }
    var CS = {
      messages: [],
      // Rendered .bq-message nodes, indexed BY MESSAGE INDEX (sparse: a message
      // folded into a collapsed indexing row has no node of its own).
      messageEls: [],
      // Expanded background-indexing rows, keyed by FILE (group.key). Not by run:
      // runKey is renamed whenever an earlier pass of the run loads, which closed
      // a row the user had opened. Two runs of one file therefore share an open
      // state, which is the right reading of "show me this file's steps".
      indexGroupsOpen: {},
      messagesBox: null,
      // .bq-messages element
      sending: false,
      typing: false,
      typingAbort: false,
      typewriterQueue: Promise.resolve(),
      stickToBottom: true,
      loadingHistory: false,
      loadingOlderHistory: false,
      // The viewport-fill LOOP is running (createHistoryFiller.onRunningChange).
      // Spans the gaps between its pages, where loadingOlderHistory keeps dropping
      // back to false; a collapsed indexing row that is still waiting for its own
      // earlier passes renders off this rather than flickering once per page.
      // View-side, not delegated to session.state: the filler is view-side too.
      historyFilling: false,
      historyEndOfList: false,
      historyStartKeyHistory: [],
      historyRequestToken: 0,
      gateRefreshToken: 0,
      clearing: false,
      pollTimer: null,
      attachments: [],
      // [{ id, name, file, status, progress, uploadedUrl, storagePath, errorMessage }]
      uploadingAttachments: false,
      attachmentWarning: "",
      attachmentCapNotice: "",
      // informational "N files not added" when an add hit MAX_ATTACHMENT_FILE_COUNT
      attachmentCancelNotice: "",
      // "Upload cancelled: <file>." after the user cancelled uploads
      attachmentsRow: null,
      // .bq-attachments DOM node
      attachBtnEl: null,
      sendBtnEl: null,
      inputEl: null,
      // .bq-input textarea
      chatEl: null,
      // .bq-chat (for overflow height measurement)
      chatStatusEl: null,
      // .bq-chat-status ("Reconnecting..." / sign-in note)
      visibleAttachmentCount: Infinity
      // how many chips fit before "...(x) more"
    };
    var aiChatHistoryCache = {};
    var pendingAgentRequests = {};
    var historyItemPolls = /* @__PURE__ */ new Map();
    var bgTaskQueue = [];
    var cancelledServerIds = /* @__PURE__ */ new Set();
    var refreshingLinkMap = {};
    var refreshedExpiredLinkMap = {};
    var refreshingLinkPromises = /* @__PURE__ */ new Map();
    var unavailableLinkMap = {};
    var fileBlobCache = /* @__PURE__ */ new Map();
    var markedReady = null;
    function currentIdentity() {
      return {
        projectId: S.projectId,
        // Prefer the SDK's formatted token. The widget takes the page's own
        // skapi-js <script> pin, and builds older than 1.8.4 have no .project_id;
        // compose the formatted token exactly as buildSystemPrompt does, because
        // the raw regional id must never reach the indexing prompt - the model
        // copies it verbatim into project_id tool calls, which the MCP schema
        // pattern rejects.
        publicProjectId: S.skapi && S.skapi.project_id || (function() {
          if (S.projectId && S.owner && S.skapi && S.skapi.util && typeof S.skapi.util.formatServiceId === "function") {
            try {
              return S.skapi.util.formatServiceId(S.projectId, S.owner);
            } catch (e) {
            }
          }
          return void 0;
        })(),
        owner: S.owner,
        // The chat identity, which the engine turns into the request queue
        // name. An anonymous visitor gets their DEVICE id rather than the
        // project id: the old fallback gave every anonymous visitor of a
        // project the same queue, so they would have shared one transcript
        // and head-of-line-blocked each other's turns on a single FIFO.
        userId: S.user && S.user.user_id || (isAnonymousSession() ? anonDeviceId() : S.projectId),
        // Sends the turn's MCP tools to the project-scoped, credential-free
        // endpoint instead of the root one with an empty bearer.
        anonymous: isAnonymousSession(),
        platform: S.aiPlatform,
        model: S.aiModel || void 0,
        serviceName: S.serviceName,
        serviceDescription: S.serviceDescription
      };
    }
    var session = new ChatSession({
      getIdentity: function() {
        return currentIdentity();
      },
      buildSystemPrompt: function() {
        return buildSystemPrompt();
      },
      notify: function() {
        renderMessages();
      },
      refreshMessageBubble: function(i) {
        refreshMessageBubble(i);
      },
      scrollToBottom: function(smooth) {
        return scrollToBottom();
      },
      scrollToBottomIfSticky: function(smooth) {
        return scrollToBottomIfSticky();
      },
      // A first page can render shorter than the box (a file's every indexing
      // pass folds into ONE row), and a box that cannot scroll never fires the
      // scroll-to-top that is the sole trigger for loading page 2. Page out of
      // it here — only the view can measure.
      onHistoryLoaded: function(fetchMore, token) {
        if (!fetchMore) ensureHistoryFillsViewport(token);
      },
      settleScroll: function() {
        settleScrollAfterRefresh();
      },
      cancelRequest: function(opts) {
        return skapiCancelRequest(opts);
      },
      refreshSession: function() {
        return refreshSkapiSession();
      },
      formatIndexingLabel: function(name, mime, size, storagePath, reindex, continued) {
        return buildIndexingLabel(name, mime, size, storagePath, reindex, continued);
      },
      // The chat's message list is in the page. CS.messagesBox stays set after the
      // widget swaps the chat for another screen (sign-in, settings): the engine then
      // must not load history or draw into a list nobody sees.
      isViewMounted: function() {
        return !!CS.messagesBox && CS.messagesBox.isConnected !== false;
      },
      // The reconciler asks for a fresh run:: sweep of files still 'working' while they
      // are not seen live (every 30 s, no round limit); the sweep hands the working
      // paths back through session.syncFileRuns (maybeArmStubRecheck).
      recheckFileRuns: function(projectId) {
        if (projectId !== S.projectId) return;
        void refreshIndexMarkers(true);
      },
      getClearedAt: function() {
        return getClearedAt();
      },
      // attachment upload I/O (bunnyquery: get-signed-url + db CDN)
      uploadFile: function(a) {
        return uploadFileToDb(a.file, a.storagePath, a.onProgress, a.setAbort, a.checkExistence);
      },
      getTemporaryUrl: function(path) {
        return getTemporaryUrlDb(path, ATTACHMENT_URL_EXPIRES_SECONDS);
      },
      deleteExistingFileRecord: function(path) {
        return deleteFileIndexRecordDb(path);
      },
      ensureFileIndexRecord: function(path, meta, keepGroup) {
        if (keepGroup) return ensureFileIndexRecordDb(path, meta, keepGroup);
        return resolveUploadAccessGroup(path).then(function(g) {
          return ensureFileIndexRecordDb(path, meta, g);
        });
      },
      uploadAccessGroup: function(path) {
        return resolveUploadAccessGroup(path);
      },
      // Read BEFORE a re-index deletes the file's src:: record, so the file keeps
      // its visibility (mirrors agent.vue's readFileIndexAccessGroup).
      readFileAccessGroup: function(path) {
        return readFileIndexAccessGroupDb(path);
      },
      // "Already uploaded by this user?" from the src:: file records. The engine
      // asks only while the skip-duplicates switch is on; null means upload.
      findDuplicateUpload: function(file) {
        var uid = S.user && S.user.user_id;
        if (!uid) return Promise.resolve(null);
        return findDuplicateUpload(S.skapi, file, uid, { service: S.projectId });
      },
      // Every linked copy of the project (one shared index for identical files): an
      // Overwrite of an original sends its copies again (engine collectLinkedCopies).
      findLinkedCopies: function() {
        if (!S.skapi || !S.projectId || isAnonymousSession()) return Promise.resolve(null);
        return listLinkedCopies(S.skapi, S.projectId);
      },
      storagePathFor: function(relPath) {
        return attachmentStoragePath(relPath);
      },
      getMimeType: function(name) {
        return mimeGetType(name);
      },
      promptOverwrite: function(filename) {
        return promptOverwrite(filename);
      },
      resetOverwriteBatch: function() {
        resetOverwriteBatch();
        resetAccessGroupBatch();
      },
      renderAttachmentChips: function() {
        renderAttachmentChips();
      },
      updateComposerControls: function() {
        updateComposerControls();
      }
    });
    session.bgTaskQueue = bgTaskQueue;
    session.cancelledServerIds = cancelledServerIds;
    session.pendingAgentRequests = pendingAgentRequests;
    session.aiChatHistoryCache = aiChatHistoryCache;
    session.historyItemPolls = historyItemPolls;
    [
      "messages",
      "attachments",
      "uploadingAttachments",
      "sending",
      "typing",
      "typingAbort",
      "loadingHistory",
      "loadingOlderHistory",
      "historyEndOfList",
      "historyStartKeyHistory",
      "historyRequestToken",
      "gateRefreshToken"
    ].forEach(function(k) {
      Object.defineProperty(CS, k, {
        get: function() {
          return session.state[k];
        },
        set: function(v) {
          session.state[k] = v;
        },
        configurable: true,
        enumerable: true
      });
    });
    function hostDomain() {
      return S.opts.hostDomain || (S.opts.dev ? "skapi.app" : "skapi.com");
    }
    function raf2() {
      return new Promise(function(res) {
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            res();
          });
        });
      });
    }
    function mimeGetType(name) {
      var ext = (String(name || "").split(".").pop() || "").toLowerCase();
      var map = {
        txt: "text/plain",
        md: "text/markdown",
        csv: "text/csv",
        json: "application/json",
        html: "text/html",
        htm: "text/html",
        js: "text/javascript",
        ts: "text/plain",
        css: "text/css",
        xml: "application/xml",
        yaml: "text/yaml",
        yml: "text/yaml",
        pdf: "application/pdf",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        eml: "message/rfc822"
      };
      return map[ext] || null;
    }
    function loadMarked() {
      if (markedReady) return markedReady;
      if (window.marked && typeof window.marked.parse === "function") {
        markedReady = Promise.resolve();
        return markedReady;
      }
      markedReady = new Promise(function(resolve) {
        var s = document.createElement("script");
        s.src = MARKED_CDN;
        s.onload = function() {
          resolve();
        };
        s.onerror = function() {
          resolve();
        };
        document.head.appendChild(s);
      });
      return markedReady;
    }
    function buildSystemPrompt() {
      var promptProjectId = S.projectId || "";
      if (S.projectId && S.owner && S.skapi && S.skapi.util && typeof S.skapi.util.formatServiceId === "function") {
        try {
          promptProjectId = S.skapi.util.formatServiceId(S.projectId, S.owner);
        } catch (e) {
        }
      }
      return buildChatSystemPrompt({
        projectId: promptProjectId,
        serviceName: S.serviceName,
        serviceDescription: S.serviceDescription,
        // The opening bubble never enters the history (it is DOM the client
        // paints), so the model is told what it opened with. Same call as
        // buildGreetingEl, so the two can never disagree.
        greeting: greetingParts().text,
        canUpload: !uploadsFrozenForUser(),
        // Where THIS project's indexer writes, from the "bq::settings"
        // record. The MCP's auto-fill assumes "authorized"; on a project set
        // to public or private that would search the wrong group and answer
        // "nothing found". A SYNC CACHE READ, because the engine calls this
        // hook from paths with nowhere to put an await. Every send that
        // reaches it has settled the fetch first: sendMessage awaits
        // readyProjectSettings on the text-only branch, and the attachment
        // branch resolves the upload group before it dispatches.
        indexAccessGroup: projectUploadAccessGroup(S.projectId),
        // Whether this chat may reach the open web. The request builders
        // attach web_fetch / web_search on the same switch, so the prompt
        // follows the tool list. Same sync cache read as the group above,
        // settled by the same readyProjectSettings before a send.
        webAccess: webAccessEnabled(S.projectId)});
    }
    function refreshSkapiSession() {
      return S.skapi.getProfile({ refreshToken: true }).then(function() {
        return ensureMcpGrantFresh();
      }).then(function() {
        return true;
      }).catch(function() {
        return false;
      });
    }
    var attachmentUploadChain = Promise.resolve();
    var attachmentDispatchChain = Promise.resolve();
    var attachmentBatchSeq = 0;
    function enqueueAttachmentSend(job) {
      var uploaded = attachmentUploadChain.catch(function() {
      }).then(function() {
        return runAttachmentUpload(job);
      });
      attachmentUploadChain = uploaded;
      attachmentDispatchChain = attachmentDispatchChain.catch(function() {
      }).then(function() {
        return uploaded;
      }).then(function(urls) {
        return runAttachmentDispatch(job, urls);
      });
    }
    function runAttachmentUpload(job) {
      return session.uploadPendingAttachments(job.batchId, job.stageId).then(function(attachmentUrls) {
        var batchChips = CS.attachments.filter(function(a) {
          return a._batchId === job.batchId;
        });
        var failureGroups = groupAttachmentFailures(batchChips);
        var duplicates = [];
        batchChips.forEach(function(a) {
          (a.duplicates || []).forEach(function(d) {
            duplicates.push(d);
          });
        });
        clearSuccessfulAttachments(job.batchId);
        if (failureGroups.length || duplicates.length) showUploadErrorReport(failureGroups, duplicates);
        return attachmentUrls;
      }).catch(function(err) {
        console.error("[bunnyquery] attachment upload failed", err);
        updateComposerControls();
        renderAttachmentChips();
        if (job.stageId) session.settleStagedMessage(job.stageId);
        CS.messages.push({ role: "assistant", content: "Something went wrong while uploading attachments. " + (err && err.message || ""), isError: true });
        renderMessages();
        scrollToBottomIfSticky();
        return null;
      });
    }
    function runAttachmentDispatch(job, attachmentUrls) {
      if (!attachmentUrls || !job.text) return Promise.resolve();
      if (job.stageId) session.markStagedMessageIndexing(job.stageId);
      return session.awaitIndexingDrained(job.pinned.identity).then(function() {
        if (job.stageId) session.markStagedMessageReady(job.stageId);
        var c = composeUserMessage(job.text, attachmentUrls);
        session.dispatchComposedMessage(c.composed, true, c.composedForLlm, c.extractContent, c.fileUrls, job.pinned);
      });
    }
    function sendMessage() {
      var inputEl = CS.messagesBox && CS.messagesBox.parentNode && CS.messagesBox.parentNode.querySelector(".bq-input");
      var text = (inputEl ? inputEl.value : "").trim();
      var batchAttachments = composerAttachments();
      var hasAttachments = batchAttachments.length > 0;
      if (!text && !hasAttachments) return;
      if (!chatEnabled() || S.aiPlatform === "none") return;
      recomputeAttachmentWarning();
      if (CS.attachmentWarning) {
        renderAttachmentChips();
        updateComposerControls();
        return;
      }
      if (CS.attachmentCancelNotice) {
        CS.attachmentCancelNotice = "";
        renderAttachmentChips();
      }
      if (inputEl) {
        inputEl.value = "";
        autoGrowInput(inputEl);
      }
      updateComposerControls();
      CS.drafting = false;
      syncDraftingIndicator();
      if (!hasAttachments) {
        readyProjectSettings(S.projectId).then(function() {
          session.dispatchComposedMessage(text, false);
        });
        return;
      }
      attachmentBatchSeq += 1;
      var batchId = "batch_" + attachmentBatchSeq + "_" + Date.now();
      batchAttachments.forEach(function(a) {
        a._batchId = batchId;
      });
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      var stageId = text ? session.stageOutgoingMessage(text) : void 0;
      var pinned = {
        identity: currentIdentity(),
        systemPrompt: buildSystemPrompt(),
        stageId
      };
      enqueueAttachmentSend({ text, batchId, stageId, pinned });
    }
    function scrollToBottom() {
      if (typeof document !== "undefined" && document.hidden) {
        CS.stickToBottom = true;
        chatScrollAnchor.pinBottom();
        return Promise.resolve();
      }
      return raf2().then(function() {
        if (!CS.messagesBox) return;
        CS.stickToBottom = true;
        chatScrollAnchor.pinBottom();
      });
    }
    function scrollToBottomIfSticky() {
      if (!CS.stickToBottom) return Promise.resolve();
      if (typeof document !== "undefined" && document.hidden) {
        chatScrollAnchor.pinBottom();
        return Promise.resolve();
      }
      return raf2().then(function() {
        if (!CS.stickToBottom || !CS.messagesBox) return;
        chatScrollAnchor.pinBottom();
      });
    }
    function settleScrollAfterRefresh() {
      anchorWroteSinceScroll = true;
      if (CS.stickToBottom) scrollToBottomIfSticky();
      else chatScrollAnchor.hold();
    }
    var lastHistoryScrollTop = 0;
    var anchorWroteSinceScroll = false;
    function onHistoryScroll() {
      if (!CS.messagesBox || CS.chatSettingsOpen) return;
      var el = CS.messagesBox;
      if (typeof document !== "undefined" && document.hidden) {
        lastHistoryScrollTop = el.scrollTop;
        return;
      }
      var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
      var ours = anchorWroteSinceScroll;
      anchorWroteSinceScroll = false;
      if (!atBottom) CS.stickToBottom = false;
      else if (!ours && el.scrollTop >= lastHistoryScrollTop) CS.stickToBottom = true;
      lastHistoryScrollTop = el.scrollTop;
      chatScrollAnchor.remember();
      if (el.scrollTop <= 60) pageOlderHistoryUntilTaller();
    }
    function onMessagesFontsSettled() {
      chatScrollAnchor.hold();
    }
    function onMessagesImageSettled(e) {
      var t = e && e.target;
      if (!t || t.tagName !== "IMG") return;
      anchorWroteSinceScroll = true;
      chatScrollAnchor.absorb(previewLayoutBox(t));
    }
    var _touchStartY = 0;
    function onMessagesWheel(e) {
      if (e.deltaY < 0) CS.stickToBottom = false;
    }
    function onMessagesTouchStart(e) {
      _touchStartY = e.touches && e.touches[0] ? e.touches[0].clientY : 0;
    }
    function onMessagesTouchMove(e) {
      var y = e.touches && e.touches[0] ? e.touches[0].clientY : 0;
      if (y > _touchStartY + 4) CS.stickToBottom = false;
    }
    function getOrCreateFileHref(filename, body) {
      var key = filename + "\0" + body;
      var existing = fileBlobCache.get(key);
      if (existing) return existing;
      var prepared = prepareDownloadText(filename, body);
      var type = EXT_CONTENT_TYPES[extOf(filename)] || mimeGetType(filename) || "text/plain; charset=utf-8";
      var href = URL.createObjectURL(new Blob([prepared.text], { type }));
      fileBlobCache.set(key, href);
      return href;
    }
    function fileToAnchorHtml(filename, href) {
      return '<a class="bq-file-download" href="' + escapeHtml(href) + '" download="' + escapeHtml(filename) + '" target="_blank" rel="noopener noreferrer"><span class="bq-link-glyph" translate="no">\u2197</span>' + escapeHtml(filename) + "</a>";
    }
    function linkToAnchorHtml(link, allowImagePreview, fitLabel) {
      return renderInlineLinkHtml(link, {
        refreshing: !!refreshingLinkMap[link.expiredHref || link.href],
        allowImagePreview,
        unavailable: isLinkUnavailable(link, unavailableLinkMap),
        fitLabel: !!fitLabel
      });
    }
    function citationChipsHtml(note) {
      var cites = citationsFor(note);
      var html = "";
      for (var i = 0; i < cites.length; i++) {
        var part = citationLinkPart(cites[i], function(expiredHref) {
          return refreshedExpiredLinkMap[expiredHref];
        });
        html += linkToAnchorHtml(part, false);
      }
      return html;
    }
    function buildLinkPartFromGroups(full, g1, g2, g3, g4, g5, g6) {
      return classifyInlineLink(full, [g1, g2, g3, g4, g5, g6], {
        projectId: S.projectId,
        dbHostPrefix: "https://db." + hostDomain(),
        resolveFreshHref: function(expiredHref) {
          return refreshedExpiredLinkMap[expiredHref];
        }
      });
    }
    var genDotTick = 0, genDotTimer = null;
    function startGenDotTicker() {
      if (genDotTimer) return;
      genDotTimer = setInterval(function() {
        var els = CS.typing && CS.messagesBox ? CS.messagesBox.querySelectorAll(".bq-gen-dots") : [];
        if (!els.length) {
          clearInterval(genDotTimer);
          genDotTimer = null;
          genDotTick = 0;
          return;
        }
        genDotTick = (genDotTick + 1) % 3;
        for (var i = 0; i < els.length; i++) els[i].textContent = ".".repeat(genDotTick + 1);
      }, 400);
    }
    function parseMsgPartsHtml(content, opts) {
      var noPreviews = !!(opts && opts.imagePreviews === false);
      var fitLinks = !!(opts && opts.fitLinkLabels);
      var placeholderHtml = [];
      var PH = function(idx) {
        return "\uE000BQ" + idx + "\uE001";
      };
      var pushPlaceholder = function(anchorHtml) {
        var idx = placeholderHtml.length;
        placeholderHtml.push(anchorHtml);
        return PH(idx);
      };
      var working = String(content == null ? "" : content).replace(
        /```([^\n`]+?\.[^\s.`]+)\n([\s\S]*?)```/g,
        function(_full, filename, body) {
          return pushPlaceholder(fileToAnchorHtml(filename, getOrCreateFileHref(filename, body)));
        }
      );
      if (CS.typing) {
        var openFence = working.match(/```([^\n`]+?\.[^\s.`]+)\n?/);
        if (openFence && typeof openFence.index === "number") {
          working = working.slice(0, openFence.index) + "\n[generating " + openFence[1] + pushPlaceholder('<span class="bq-gen-dots">' + ".".repeat(genDotTick + 1) + "</span>") + "]";
          startGenDotTicker();
        }
      }
      var codeMasks = [];
      working = working.replace(/`[^`\n]+`/g, function(match) {
        var idx = codeMasks.length;
        codeMasks.push(match);
        return "\uE002C" + idx + "\uE003";
      });
      var previewsLeft = noPreviews ? 0 : IMAGE_PREVIEWS_PER_MESSAGE;
      var linkRe = createInlineLinkRegex();
      working = working.replace(linkRe, function(full) {
        var args = Array.prototype.slice.call(arguments, 1, 7);
        var built = buildLinkPartFromGroups(full, args[0], args[1], args[2], args[3], args[4], args[5]);
        if (!built) return full;
        var allow = previewsLeft > 0;
        var html2 = linkToAnchorHtml(built.part, allow, fitLinks);
        if (allow && built.part.image) previewsLeft--;
        return pushPlaceholder(html2) + (built.tail || "");
      });
      working = working.replace(/C(\d+)/g, function(_m, idx) {
        return codeMasks[Number(idx)] || "";
      });
      var html;
      if (window.marked && typeof window.marked.parse === "function") {
        html = window.marked.parse(working, { gfm: true, breaks: true, async: false });
      } else {
        html = "<p>" + escapeHtml(working).replace(/\n/g, "<br>") + "</p>";
      }
      return html.replace(/BQ(\d+)/g, function(_m, idx) {
        return placeholderHtml[Number(idx)] || "";
      });
    }
    var _uploadReservedKey = null;
    function uploadReservedKey() {
      if (!_uploadReservedKey) _uploadReservedKey = randomLowerString(16);
      return _uploadReservedKey;
    }
    function randomLowerString(n) {
      var c = "abcdefghijklmnopqrstuvwxyz0123456789", s = "";
      for (var i = 0; i < n; i++) s += c.charAt(Math.floor(Math.random() * c.length));
      return s;
    }
    function formatBytes(n) {
      n = Number(n) || 0;
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / (1024 * 1024)).toFixed(1) + " MB";
    }
    function buildIndexingLabel(name, mime, size, storagePath, reindex, continued) {
      var nameLabel = storagePath ? "[" + name + "](" + storagePath + ")" : name;
      if (continued) return "Indexing (continuing) " + nameLabel;
      var extras = [];
      if (mime) extras.push(mime);
      if (size != null && size !== "" && !isNaN(Number(size))) extras.push(formatBytes(size));
      return (reindex ? "Reindexing: " : "Indexing: ") + nameLabel + (extras.length ? " \xB7 " + extras.join(" \xB7 ") : "");
    }
    function sanitizeStorageSegment(name) {
      var n = String(name == null ? "file" : name).normalize("NFC").trim().replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/ {2,}/g, " ").replace(/_{2,}/g, "_").replace(/^[_ ]+/, "");
      return n || "file";
    }
    function attachmentStoragePath(relPath) {
      var uid = S.user && S.user.user_id ? S.user.user_id : "anon";
      var sanitized = String(relPath == null ? "file" : relPath).split("/").map(sanitizeStorageSegment).filter(Boolean).join("/");
      return uid + "/" + (sanitized || "file");
    }
    var UPLOAD_IDLE_TIMEOUT_MS = 60 * 1e3;
    var UPLOAD_SENT_WAIT_FACTOR = 5;
    function xhrUploadForm(url, form, onProgress, setAbort) {
      return new Promise(function(resolveUpload, rejectUpload) {
        var xhr = new XMLHttpRequest();
        var idleTimer = null, bodySent = false;
        function clearIdle() {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        }
        function resolve(v) {
          clearIdle();
          resolveUpload(v);
        }
        function reject(e) {
          clearIdle();
          rejectUpload(e);
        }
        function touch() {
          clearIdle();
          var wait = bodySent ? UPLOAD_IDLE_TIMEOUT_MS * UPLOAD_SENT_WAIT_FACTOR : UPLOAD_IDLE_TIMEOUT_MS;
          idleTimer = setTimeout(function() {
            idleTimer = null;
            var err = new Error(bodySent ? "Upload timeout: no answer " + Math.round(wait / 1e3) + " seconds after the file was sent." : "Upload timeout: nothing was sent for " + Math.round(wait / 1e3) + " seconds.");
            err.code = "TIMEOUT";
            reject(err);
            try {
              xhr.abort();
            } catch (e) {
            }
          }, wait);
        }
        xhr.open("POST", url);
        xhr.onload = function() {
          clearIdle();
          var result = xhr.responseText;
          try {
            result = JSON.parse(result);
          } catch (e) {
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(result);
          else reject(result);
        };
        xhr.onreadystatechange = function() {
          if (xhr.readyState === 4) clearIdle();
          else touch();
        };
        xhr.addEventListener("progress", function() {
          if (xhr.readyState !== 4) touch();
        });
        xhr.onerror = function() {
          reject(new Error("Network error"));
        };
        xhr.onabort = function() {
          reject(new Error("Aborted"));
        };
        xhr.ontimeout = function() {
          reject(new Error("Timeout"));
        };
        if (xhr.upload) {
          xhr.upload.addEventListener("progress", touch);
          xhr.upload.addEventListener("load", function() {
            bodySent = true;
            touch();
          });
        }
        if (xhr.upload && typeof onProgress === "function") xhr.upload.onprogress = onProgress;
        touch();
        xhr.send(form);
        if (typeof setAbort === "function") setAbort(function() {
          clearIdle();
          try {
            xhr.abort();
          } catch (e) {
          }
        });
      });
    }
    function uploadFileToDb(file, storagePath, onProgress, setAbort, checkExistence) {
      if (checkExistence === void 0) checkExistence = true;
      var params = {
        reserved_key: uploadReservedKey(),
        service: S.projectId,
        owner: S.owner,
        request: "db",
        key: storagePath,
        size: file.size || 0,
        contentType: file.type || mimeGetType(file.name) || null
      };
      if (checkExistence) params.check_existence = true;
      return S.skapi.util.request("get-signed-url", params, { auth: true }).then(function(signed) {
        var form = new FormData();
        var fields = signed && signed.fields ? signed.fields : {};
        for (var name in fields) form.append(name, fields[name]);
        form.append("file", file);
        return xhrUploadForm(signed.url, form, onProgress, setAbort).catch(function(err) {
          if (err && (err === "Aborted" || err.message === "Aborted")) throw err;
          var sum = summarizeUploadError(err);
          var e = new Error("Upload failed for " + file.name + (sum.message ? ": " + sum.message : ""));
          if (sum.code) e.code = sum.code;
          throw e;
        });
      });
    }
    function summarizeUploadError(err) {
      if (!err) return { code: "", message: "" };
      if (typeof err === "string") {
        var c = /<Code>([^<]+)<\/Code>/.exec(err), m = /<Message>([^<]+)<\/Message>/.exec(err);
        var code = c ? c[1] : "", msg = m ? m[1] : "";
        if (code || msg) return { code, message: msg || code };
        return { code: "", message: err.length > 300 ? err.slice(0, 300) : err };
      }
      var ecode = err.code || err.body && err.body.code || "";
      var emsg = err.message || err.body && err.body.message || "";
      if (ecode || emsg) return { code: ecode, message: emsg };
      try {
        return { code: "", message: JSON.stringify(err).slice(0, 300) };
      } catch (x) {
        return { code: "", message: String(err) };
      }
    }
    var DECORATION_START = /^[<>:"\\|?*]/;
    function deleteFileIndexDecorations(storagePath) {
      if (!S.skapi || typeof S.skapi.getUniqueId !== "function") return Promise.resolve();
      var prefix = "src::" + storagePath;
      return Promise.resolve(S.skapi.getUniqueId(
        { service: S.projectId, unique_id: prefix, condition: ">=" },
        { fetchMore: false, limit: 1e3 }
      )).then(function(found) {
        var list = found && found.list || [];
        var ids = [];
        for (var i = 0; i < list.length; i++) {
          var id = String(list[i] && list[i].unique_id || "");
          if (id && id !== prefix && id.indexOf(prefix) === 0 && DECORATION_START.test(id.slice(prefix.length))) ids.push(id);
        }
        return ids.reduce(function(p, uid) {
          return p.then(function() {
            return S.skapi.deleteRecords({ service: S.projectId, unique_id: uid }).catch(function() {
            });
          });
        }, Promise.resolve());
      }).catch(function(err) {
        try {
          console.warn("[bunnyquery] decoration sweep failed (non-fatal)", storagePath, err);
        } catch (e) {
        }
      });
    }
    function deleteFileIndexRecordDb(storagePath) {
      if (!storagePath || !S.skapi || typeof S.skapi.deleteRecords !== "function") return Promise.resolve();
      return resetFileIndexOnServer({ service: S.projectId, owner: S.owner || void 0, storagePath }).then(function(done) {
        if (done) return;
        return deleteFileIndexRecordInPage(storagePath);
      });
    }
    function deleteFileIndexRecordInPage(storagePath) {
      var doneDelete = S.skapi.deleteRecords({ service: S.projectId, unique_id: indexDoneUniqueId(storagePath) }).catch(function() {
      });
      var runDelete = S.skapi.deleteRecords({ service: S.projectId, unique_id: runIndexUniqueId(storagePath) }).catch(function() {
      });
      return deleteFileIndexDecorations(storagePath).then(function() {
        return S.skapi.deleteRecords({ service: S.projectId, unique_id: "src::" + storagePath }).catch(function() {
        });
      }).then(function() {
        return doneDelete;
      }).then(function() {
        return runDelete;
      });
    }
    function mintIndexDoneMarkerDb(service, storagePath) {
      if (!service || !storagePath || !S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
      return Promise.resolve(S.skapi.postRecord(null, {
        service,
        unique_id: indexDoneUniqueId(storagePath),
        table: { name: "__INDEXING__", access_group: "authorized" },
        reference: "src::" + storagePath,
        data: { source: storagePath, completed_at: Date.now() }
      })).catch(function(err) {
        var msg = String(err && err.message || err || "");
        if (msg.indexOf("is already taken") === -1) {
          console.warn("[bunnyquery] mintIndexDoneMarker failed (non-fatal)", storagePath, msg);
          throw err;
        }
      });
    }
    function upsertIndexRunRecordDb(service, storagePath, patch) {
      if (!service || !storagePath || !patch || !patch.status) return Promise.resolve();
      if (!S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
      var uid = runIndexUniqueId(storagePath);
      var TERMINAL = { done: true, error: true, cancelled: true };
      function patchData(base) {
        var d = {};
        for (var k in base || {}) d[k] = base[k];
        d.source = storagePath;
        d.status = patch.status;
        if (patch.filename) d.filename = patch.filename;
        if (typeof patch.started === "number") d.started = patch.started;
        if (typeof patch.finished === "number") d.finished = patch.finished;
        if (patch.error) d.error = patch.error;
        if (patch.queue) d.queue = patch.queue;
        if (patch.platform) d.platform = patch.platform;
        return d;
      }
      function createWith(reference) {
        var cfg = {
          service,
          unique_id: uid,
          table: { name: "__INDEXING__", access_group: "authorized" },
          data: patchData(null)
        };
        if (reference) cfg.reference = "src::" + storagePath;
        return S.skapi.postRecord(null, cfg);
      }
      function lookup() {
        return Promise.resolve(S.skapi.getRecords({ service, unique_id: uid })).then(function(found) {
          return found && found.list && found.list[0] || null;
        }).catch(function() {
          return null;
        });
      }
      function updateExisting(rec) {
        var existing = rec.data || {};
        if (patch.status === "working" && TERMINAL[String(existing.status)]) {
          var endedAt = typeof existing.finished === "number" ? existing.finished : typeof existing.started === "number" ? existing.started : 0;
          if (!(typeof patch.started === "number" && patch.started > endedAt)) return Promise.resolve(null);
        }
        if (patch.status !== "working" && String(existing.status) === patch.status) return Promise.resolve(null);
        return Promise.resolve(S.skapi.postRecord(null, {
          service,
          record_id: rec.record_id,
          data: patchData(existing)
        }));
      }
      function settleAsUpdate() {
        return lookup().then(function(rec) {
          if (rec && rec.record_id) return updateExisting(rec);
          return null;
        }).catch(function(err) {
          console.warn("[bunnyquery] upsertIndexRunRecord update failed (non-fatal)", storagePath, String(err && err.message || err || ""));
          throw err;
        });
      }
      function createChain() {
        return Promise.resolve(createWith(true)).catch(function(err) {
          var msg = String(err && err.message || err || "");
          if (msg.indexOf("is already taken") === -1) {
            return ensureFileIndexRecordDb(storagePath).then(function() {
              return createWith(true);
            }).catch(function(errRef) {
              var msgRef = String(errRef && errRef.message || errRef || "");
              if (msgRef.indexOf("is already taken") !== -1) return settleAsUpdate();
              return Promise.resolve(createWith(false)).catch(function(err2) {
                var msg2 = String(err2 && err2.message || err2 || "");
                if (msg2.indexOf("is already taken") === -1) {
                  console.warn("[bunnyquery] upsertIndexRunRecord create failed (non-fatal)", storagePath, msg2);
                  throw err2;
                }
                return settleAsUpdate();
              });
            });
          }
          return settleAsUpdate();
        });
      }
      if (patch.status !== "working") {
        return lookup().then(function(rec) {
          if (rec && rec.record_id) return updateExisting(rec);
          return createChain();
        });
      }
      return createChain();
    }
    function readFileIndexAccessGroupDb(storagePath) {
      if (!storagePath || !S.skapi || typeof S.skapi.getRecords !== "function") return Promise.resolve(null);
      return Promise.resolve(S.skapi.getRecords({ service: S.projectId, unique_id: "src::" + storagePath })).then(function(found) {
        var rec = found && found.list && found.list[0];
        var group = rec && rec.table ? rec.table.access_group : void 0;
        if (group === "private") return "private";
        if (group === 0 || group === "public") return "public";
        if (group === 1 || group === "authorized") return "authorized";
        return null;
      }, function(err) {
        var code = err && (err.code || err.error && err.error.code);
        var message = String(err && err.message || "");
        if (code === "NOT_EXISTS" || /unique id does not exist/i.test(message)) return null;
        throw err;
      });
    }
    function ensureFileIndexRecordDb(storagePath, meta, accessGroup) {
      if (!storagePath || !S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
      return Promise.resolve(S.skapi.postRecord(null, {
        service: S.projectId,
        unique_id: "src::" + storagePath,
        table: { name: "file_summaries", access_group: normalizeUploadAccessGroup(accessGroup) },
        // Deleting the file record must cascade to every record referencing it.
        source: { can_remove_referencing_records: true },
        data: {
          file_name: meta && meta.name || storagePath.split("/").pop() || storagePath,
          storage_path: storagePath,
          mime_type: meta && meta.mime || null,
          size_bytes: meta && typeof meta.size === "number" ? meta.size : null,
          indexed_at: Date.now(),
          note: "File-level record created at upload. The indexing agent enriches this with sheet names, column headers and row counts."
        }
      })).catch(function() {
      });
    }
    function getTemporaryUrlDb(path, expires, cdn, contentType, opts) {
      opts = opts || {};
      var body = {
        service: S.projectId,
        owner: S.owner,
        request: "get-db",
        key: path,
        expires: expires || ATTACHMENT_URL_EXPIRES_SECONDS,
        contentType: contentType || mimeGetType(path) || "application/octet-stream"
      };
      if (cdn !== false) body.generate_temporary_cdn_url = true;
      var reqOpts = { auth: true, method: "post" };
      if (cdn === false && opts.browserCache) {
        reqOpts.method = "get";
        reqOpts.stableGateway = true;
        body.nocache = previewMintCacheToken(opts.refresh);
        body.browser_cache = opts.browserCache;
        var uid = S.user && S.user.user_id;
        if (uid) body.uid = uid;
      }
      function unwrap(res) {
        var u = typeof res === "string" ? res : res && res.url;
        if (!u) throw new Error("No temporary URL returned.");
        if (/^https?:\/\//i.test(u)) return u;
        return "https://db." + hostDomain() + "/" + u;
      }
      return S.skapi.util.request("get-signed-url", body, reqOpts).then(unwrap);
    }
    var ATTACH_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    var FILE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    var MAX_CHATBOX_FILE_COUNT = 20;
    var MAX_ATTACHMENT_FILE_COUNT = 20;
    var VISIBLE_CHIP_CAP = 30;
    var ESTIMATED_BYTES_PER_TOKEN = 3;
    var ESTIMATED_PDF_BYTES_PER_TOKEN = 5e3;
    var ESTIMATED_IMAGE_TOKENS = 800;
    var TEXTLIKE_EXTENSION_RE = /\.(txt|md|markdown|rst|csv|tsv|json|jsonl|ndjson|ya?ml|xml|html?|css|less|scss|sass|js|mjs|cjs|ts|tsx|jsx|vue|svelte|astro|py|rb|go|rs|java|kt|swift|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|ps1|sql|log|conf|cfg|ini|toml|env|gitignore|dockerfile|makefile|lock)$/i;
    var PDF_EXTENSION_RE = /\.pdf$/i;
    var IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i;
    function estimateFileTokenCost(file) {
      var name = file.name || "", size = file.size || 0, type = (file.type || "").toLowerCase();
      if (TEXTLIKE_EXTENSION_RE.test(name) || type.indexOf("text/") === 0 || type.indexOf("json") !== -1 || type.indexOf("xml") !== -1) {
        return Math.ceil(size / ESTIMATED_BYTES_PER_TOKEN);
      }
      if (PDF_EXTENSION_RE.test(name) || type === "application/pdf") return Math.ceil(size / ESTIMATED_PDF_BYTES_PER_TOKEN);
      if (IMAGE_EXTENSION_RE.test(name) || type.indexOf("image/") === 0) return ESTIMATED_IMAGE_TOKENS;
      return 0;
    }
    function composerAttachments() {
      return CS.attachments.filter(function(a) {
        return !a._batchId;
      });
    }
    function attachmentsTokenEstimate() {
      var total = 0;
      composerAttachments().forEach(function(a) {
        if (a.kind === "folder") {
          (a.files || []).forEach(function(f) {
            total += estimateFileTokenCost(f.file);
          });
        } else if (a.file) total += estimateFileTokenCost(a.file);
      });
      return total;
    }
    function attachmentFileCount() {
      var n = 0;
      composerAttachments().forEach(function(a) {
        n += a.kind === "folder" ? a.files ? a.files.length : 0 : 1;
      });
      return n;
    }
    function currentInputTokenBudget() {
      var platform = S.aiPlatform;
      if (platform !== "claude" && platform !== "openai") return 0;
      return getInputTokenBudget(platform, S.aiModel, S.projectId);
    }
    function formatTokenCount(tokens) {
      if (tokens >= 1e3) {
        var k = tokens / 1e3;
        return (k >= 10 ? Math.round(k) : k.toFixed(1)) + "k";
      }
      return String(tokens);
    }
    function currentChatInputText() {
      var el = CS.inputEl || CS.messagesBox && CS.messagesBox.parentNode && CS.messagesBox.parentNode.querySelector(".bq-input");
      return el ? (el.value || "").trim() : "";
    }
    function recomputeAttachmentWarning() {
      if (!currentChatInputText()) {
        CS.attachmentWarning = "";
        return;
      }
      var count = attachmentFileCount();
      if (count > MAX_CHATBOX_FILE_COUNT) {
        CS.attachmentWarning = "You've attached " + count + " files. Up to " + MAX_CHATBOX_FILE_COUNT + " per message is recommended \u2014 remove " + (count - MAX_CHATBOX_FILE_COUNT) + " to send with a message.";
        return;
      }
      var budget = currentInputTokenBudget();
      var est = attachmentsTokenEstimate();
      if (budget && est > budget) {
        CS.attachmentWarning = "Attachments are ~" + formatTokenCount(est) + " tokens, which may exceed the ~" + formatTokenCount(budget) + "-token per-request limit. Remove some files to send with a message.";
        return;
      }
      CS.attachmentWarning = "";
    }
    function attachmentKey(a) {
      if (a.kind === "folder") {
        var total = 0;
        (a.files || []).forEach(function(f) {
          total += f.file && f.file.size || 0;
        });
        return "d|" + a.name + "|" + (a.files ? a.files.length : 0) + "|" + total;
      }
      return "f|" + a.name + "|" + (a.file ? a.file.size : 0) + "|" + (a.file ? a.file.lastModified : 0);
    }
    function newAttachment(props) {
      return Object.assign({
        id: "att_" + randomLowerString(10),
        status: "pending",
        progress: 0,
        uploadedUrl: "",
        storagePath: "",
        errorMessage: ""
      }, props);
    }
    function appendAttachments(attObjs) {
      var seen = {};
      CS.attachments.forEach(function(a) {
        seen[attachmentKey(a)] = true;
      });
      var remaining = MAX_ATTACHMENT_FILE_COUNT - attachmentFileCount();
      var dropped = 0;
      var changed = false;
      (attObjs || []).forEach(function(a) {
        if (!a) return;
        var k = attachmentKey(a);
        if (seen[k]) return;
        var count = a.kind === "folder" ? a.files ? a.files.length : 0 : 1;
        if (remaining <= 0) {
          dropped += count;
          return;
        }
        if (a.kind === "folder" && count > remaining) {
          dropped += count - remaining;
          a.files = a.files.slice(0, remaining);
          count = remaining;
        }
        seen[k] = true;
        CS.attachments.push(a);
        remaining -= count;
        changed = true;
      });
      CS.attachmentCancelNotice = "";
      CS.attachmentCapNotice = dropped > 0 ? "You can attach up to " + MAX_ATTACHMENT_FILE_COUNT + " files per message. " + dropped + " file" + (dropped === 1 ? " was" : "s were") + " not added." : "";
      if (changed) {
        recomputeAttachmentWarning();
        renderAttachmentChips();
        scheduleAttachmentOverflowRecompute();
      } else if (dropped > 0) {
        renderAttachmentChips();
      }
      updateComposerControls();
    }
    function addFilesToAttachments(files) {
      var objs = [];
      Array.prototype.slice.call(files || []).forEach(function(f) {
        if (!f || typeof f.size !== "number") return;
        objs.push(newAttachment({ kind: "file", name: f.name, file: f }));
      });
      if (objs.length) appendAttachments(objs);
    }
    function readEntry(entry2, prefix) {
      prefix = prefix || "";
      return new Promise(function(resolve) {
        if (!entry2) {
          resolve([]);
          return;
        }
        if (entry2.isFile) {
          entry2.file(function(file) {
            resolve([{ file, path: prefix + file.name }]);
          }, function() {
            resolve([]);
          });
          return;
        }
        if (entry2.isDirectory) {
          var reader2 = entry2.createReader();
          var all = [];
          var readBatch = function() {
            reader2.readEntries(function(entries) {
              if (!entries.length) {
                resolve(all);
                return;
              }
              Promise.all(entries.map(function(e) {
                return readEntry(e, prefix + entry2.name + "/");
              })).then(function(groups) {
                groups.forEach(function(g) {
                  all.push.apply(all, g);
                });
                readBatch();
              });
            }, function() {
              resolve(all);
            });
          };
          readBatch();
          return;
        }
        resolve([]);
      });
    }
    var ATTACHMENTS_MAX_HEIGHT_RATIO = 0.3;
    var _attOverflowFrame = 0;
    function scheduleAttachmentOverflowRecompute() {
      if (typeof requestAnimationFrame !== "function") {
        recomputeAttachmentOverflow();
        return;
      }
      if (_attOverflowFrame) cancelAnimationFrame(_attOverflowFrame);
      _attOverflowFrame = requestAnimationFrame(function() {
        _attOverflowFrame = 0;
        recomputeAttachmentOverflow();
      });
    }
    function recomputeAttachmentOverflow() {
      var row = CS.attachmentsRow, chat = CS.chatEl;
      var total = CS.attachments.length;
      if (!row || !chat) return;
      if (!total) {
        CS.visibleAttachmentCount = Infinity;
        return;
      }
      var count = Math.min(total, VISIBLE_CHIP_CAP);
      CS.visibleAttachmentCount = count;
      renderAttachmentChips();
      var maxHeight = chat.clientHeight * ATTACHMENTS_MAX_HEIGHT_RATIO;
      if (maxHeight <= 0) return;
      while (count > 0 && row.scrollHeight > maxHeight) {
        count--;
        CS.visibleAttachmentCount = count;
        renderAttachmentChips();
      }
    }
    function removeAttachments(ids) {
      var idset = {};
      ids.forEach(function(id) {
        idset[id] = true;
      });
      var inFlight = inFlightUploadAttachments().filter(function(a) {
        return idset[a.id];
      });
      if (inFlight.length) {
        cancelAttachmentUploads(inFlight);
        inFlight.forEach(function(a) {
          delete idset[a.id];
        });
      }
      CS.attachments = CS.attachments.filter(function(a) {
        if (idset[a.id] && a._batchId && a.status === "uploading") return true;
        if (idset[a.id]) {
          if (a._abort) {
            try {
              a._abort();
            } catch (e) {
            }
          }
          return false;
        }
        return true;
      });
      CS.visibleAttachmentCount = Infinity;
      CS.attachmentCapNotice = "";
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function removeAttachment(id) {
      var i = CS.attachments.findIndex(function(a) {
        return a.id === id;
      });
      if (i === -1) return;
      var att = CS.attachments[i];
      if (isInFlightUpload(att)) {
        cancelAttachmentUploads([att]);
        return;
      }
      if (att._abort) {
        try {
          att._abort();
        } catch (e) {
        }
      }
      CS.attachments.splice(i, 1);
      CS.attachmentCapNotice = "";
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function isInFlightUpload(a) {
      if (!a || a._cancelled) return false;
      if (a.kind !== "folder" && a._indexQueued) return false;
      if (a.status === "uploading") return true;
      if (a._settledBatch && a._settledBatch === a._batchId) return false;
      return !!a._batchId && a.status !== "done" && a.status !== "cancelled";
    }
    function inFlightUploadAttachments() {
      return CS.attachments.filter(isInFlightUpload);
    }
    function cancelAttachmentUploads(atts) {
      var cancelled = (atts || []).filter(isInFlightUpload);
      if (!cancelled.length) return;
      var ids = {};
      var notice = { list: cancelled, text: "" };
      cancelled.forEach(function(a) {
        a._onCancelSettled = function(landed) {
          discardCancelledUploads(a, landed, notice);
        };
        if (!session.cancelAttachmentUpload(a)) a._cancelled = true;
        ids[a.id] = true;
      });
      CS.attachments = CS.attachments.filter(function(a) {
        return !ids[a.id];
      });
      notice.text = uploadCancelNotice(cancelled);
      CS.attachmentCancelNotice = notice.text;
      CS.attachmentCapNotice = "";
      CS.visibleAttachmentCount = Infinity;
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function uploadCancelNotice(list) {
      var names = list.map(function(a) {
        return a.kind === "folder" ? a.name + "/" : a.name;
      });
      var text = list.length === 1 ? "Upload cancelled: " + names[0] + "." : list.length + " uploads cancelled: " + names.slice(0, 3).join(", ") + (names.length > 3 ? " and " + (names.length - 3) + " more." : ".");
      var queued = 0, checking = 0, removed = 0, kept = 0, reasons = [];
      list.forEach(function(a) {
        var q = a._indexQueuedCount || 0;
        queued += q;
        var d = a._discard;
        if (d && d.state === "done") {
          removed += d.removed;
          kept += d.kept;
          if (d.reason && reasons.indexOf(d.reason) === -1) reasons.push(d.reason);
          return;
        }
        if (d && d.state === "pending") {
          checking += d.count;
          return;
        }
        var landed = Math.max(0, (a._storedCount || 0) - q);
        if (!landed && a.status === "uploading" && (a.progress || 0) >= 100) landed = 1;
        checking += landed;
      });
      var one = list.length === 1 && !queued;
      if (queued) {
        text += " " + queued + (queued === 1 ? " file had" : " files had") + " already gone to indexing; stop " + (queued === 1 ? "it from its row" : "them from their rows") + " in the chat.";
      }
      if (checking) {
        text += " " + (one && checking === 1 ? "Its" : checking === 1 ? "One file's" : checking + " files'") + " bytes had already been sent; removing " + (checking === 1 ? "it" : "them") + " from storage.";
      }
      if (removed) {
        text += " " + (one && removed === 1 && !kept ? "Its bytes had already reached storage and were removed again." : removed === 1 ? "One file had already reached storage and was removed again." : removed + " files had already reached storage and were removed again.");
      }
      if (kept) {
        text += " " + (one && kept === 1 && !removed ? "It" : kept === 1 ? "One file" : kept + " files") + " had already reached storage and could not be removed, but " + (kept === 1 ? "it was" : "they were") + " not indexed or added to the chat." + (reasons.length ? " " + reasons.join(" ") : "");
      }
      return text;
    }
    function discardCancelledUploads(att, landed, notice) {
      var paths = (landed || []).filter(function(p, i, all) {
        return p && all.indexOf(p) === i;
      });
      if (!paths.length) {
        att._discard = { state: "done", removed: 0, kept: 0, reason: "" };
        refreshCancelNotice(notice);
        return;
      }
      att._discard = { state: "pending", count: paths.length };
      refreshCancelNotice(notice);
      var removed = 0, kept = 0, reason = "";
      paths.reduce(function(p, storagePath) {
        return p.then(function() {
          return discardUploadedFile(storagePath).then(function(out) {
            if (out.removed) removed += 1;
            else if (!out.gone) {
              kept += 1;
              if (!reason && out.message) reason = out.message.replace(/\s*(It|The file) was not removed\.$/, "");
            }
          });
        });
      }, Promise.resolve()).then(function() {
        att._discard = { state: "done", removed, kept, reason };
        refreshCancelNotice(notice);
      });
    }
    function discardUploadedFile(storagePath) {
      if (!S.skapi || typeof S.skapi.forwardRequest !== "function" || !S.projectId) {
        return Promise.resolve({ removed: false, message: "This page cannot reach the BunnyQuery server." });
      }
      return Promise.resolve(S.skapi.forwardRequest(null, {
        service: S.projectId,
        owner: S.owner || void 0,
        url: mcpBaseUrl() + "/internal/upload-discard",
        method: "POST",
        // "$ACCESS_TOKEN" is filled in by skapi with this user's own token: the
        // server acts for the user it names and nobody else.
        headers: { "content-type": "application/json", Authorization: "Bearer $ACCESS_TOKEN" },
        data: { project_id: S.projectId, path: storagePath }
      })).then(function(res) {
        var body = res;
        if (typeof body === "string") {
          try {
            body = JSON.parse(body);
          } catch (e) {
            body = { message: body };
          }
        }
        if (!body || typeof body !== "object" || typeof body.removed !== "boolean") {
          return { removed: false, message: "The server gave no answer about the file." };
        }
        return { removed: body.removed, gone: body.gone === true, message: typeof body.message === "string" ? body.message : "" };
      }, function(err) {
        var msg = err && (err.message || err.body && err.body.message) || (typeof err === "string" ? err : "");
        return { removed: false, message: msg ? "The server answered: " + String(msg).slice(0, 200).replace(/\.?$/, ".") : "The server could not be reached." };
      });
    }
    function refreshCancelNotice(notice) {
      if (!notice || CS.attachmentCancelNotice !== notice.text) return;
      notice.text = uploadCancelNotice(notice.list);
      CS.attachmentCancelNotice = notice.text;
      renderAttachmentChips();
      scheduleAttachmentOverflowRecompute();
    }
    function clearAttachments() {
      CS.attachments = CS.attachments.filter(function(a) {
        return !!a._batchId;
      });
      CS.attachmentWarning = "";
      CS.attachmentCapNotice = "";
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function clearSuccessfulAttachments(batchId) {
      CS.attachments = CS.attachments.filter(function(a) {
        if (a._batchId !== batchId) return true;
        if (a.status !== "error" && a.status !== "indexError") return false;
        a._abort = null;
        delete a._batchId;
        delete a._indexQueued;
        delete a._settledBatch;
        return true;
      });
      CS.attachmentCapNotice = "";
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    var ATTACHMENT_STATUS_PRIORITY = { uploading: 0, pending: 1, error: 2, indexError: 2, done: 3 };
    function attachmentStatusPriority(status) {
      var p = ATTACHMENT_STATUS_PRIORITY[status == null ? "pending" : status];
      return p === void 0 ? 99 : p;
    }
    function sortedAttachments() {
      return CS.attachments.map(function(a, i) {
        return { a, i };
      }).sort(function(x, y) {
        var px = attachmentStatusPriority(x.a.status);
        var py = attachmentStatusPriority(y.a.status);
        if (px !== py) return px - py;
        if (px === 0 || px === 2) return y.i - x.i;
        return x.i - y.i;
      }).map(function(e) {
        return e.a;
      });
    }
    function renderAttachmentChips() {
      var row = CS.attachmentsRow;
      if (!row) return;
      row.innerHTML = "";
      if (!CS.attachments.length && !CS.attachmentWarning && !CS.attachmentCapNotice && !CS.attachmentCancelNotice) {
        row.style.display = "none";
        return;
      }
      row.style.display = "";
      if (CS.attachmentCancelNotice) {
        var cancelNoticeClose = h("button", {
          class: "bq-attachment-remove",
          type: "button",
          title: "Dismiss",
          "aria-label": "Dismiss",
          text: "\xD7"
        });
        cancelNoticeClose.addEventListener("click", function(e) {
          e.stopPropagation();
          CS.attachmentCancelNotice = "";
          renderAttachmentChips();
          scheduleAttachmentOverflowRecompute();
        });
        row.appendChild(h(
          "div",
          { class: "bq-attachment-warning is-notice", role: "status" },
          h("span", { text: CS.attachmentCancelNotice }),
          cancelNoticeClose
        ));
      }
      if (CS.attachmentCapNotice) {
        row.appendChild(h("div", { class: "bq-attachment-warning" }, h("span", { text: CS.attachmentCapNotice })));
      }
      if (CS.attachmentWarning) {
        row.appendChild(h("div", { class: "bq-attachment-warning" }, h("span", { text: CS.attachmentWarning })));
      }
      var sorted = sortedAttachments();
      var vis = Math.min(CS.visibleAttachmentCount, VISIBLE_CHIP_CAP);
      var shown = vis >= sorted.length ? sorted : sorted.slice(0, Math.max(0, vis));
      var hidden = sorted.slice(shown.length);
      shown.forEach(function(att) {
        var isFolder = att.kind === "folder";
        var clickable = att.status === "done" && !isFolder && !!att.uploadedUrl;
        var finalizing = att.status === "uploading" && (att.progress || 0) >= 100;
        var preparing = att.status === "uploading" && att.progress == null;
        var cls = "bq-attachment";
        if (att.status === "uploading") cls += " is-uploading";
        if (preparing) cls += " is-preparing";
        else if (finalizing) cls += " is-finalizing";
        else if (att.status === "error") cls += " is-error";
        else if (att.status === "indexError") cls += " is-index-error";
        else if (att.status === "done") cls += " is-done";
        if (clickable) cls += " is-clickable";
        var chip = h("div", { class: cls });
        if (att.status === "uploading" && att.progress != null) chip.style.setProperty("--att-progress", att.progress + "%");
        chip.title = att.status === "error" ? "File upload has failed" : att.status === "indexError" ? "File indexing failed" : clickable ? "Open " + att.name : isFolder ? att.name + "/ \u2014 " + (att.files ? att.files.length : 0) + " file(s)" : att.name;
        if (clickable) chip.addEventListener("click", function() {
          window.open(att.uploadedUrl, "_blank", "noopener,noreferrer");
        });
        chip.appendChild(h("span", { class: "bq-attachment-icon", html: isFolder ? FOLDER_ICON_SVG : FILE_ICON_SVG }));
        chip.appendChild(h("span", { class: "bq-attachment-name", text: att.name, title: att.name }));
        var meta = att.status === "error" ? "(Failed)" : att.status === "indexError" ? "(Error)" : preparing ? "Preparing" : finalizing ? "Finalizing" : att.status === "uploading" ? att.progress + "%" : isFolder ? "(" + (att.files ? att.files.length : 0) + ")" : att.reused ? "already uploaded" : formatBytes(att.file ? att.file.size : att.size);
        chip.appendChild(h("span", { class: "bq-attachment-meta", text: meta }));
        if (clickable) chip.appendChild(h("span", { class: "bq-attachment-arrow", text: "\u2197" }));
        if (isInFlightUpload(att)) {
          var cancelBtn = h("button", {
            class: "bq-attachment-remove",
            type: "button",
            title: "Cancel upload",
            "aria-label": "Cancel upload of " + att.name,
            text: "\xD7"
          });
          cancelBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            cancelAttachmentUploads([att]);
          });
          chip.appendChild(cancelBtn);
        } else if (att.status !== "uploading" && att.status !== "done") {
          var rm = h("button", { class: "bq-attachment-remove", type: "button", title: "Remove", text: "\xD7" });
          rm.addEventListener("click", function(e) {
            e.stopPropagation();
            removeAttachment(att.id);
          });
          chip.appendChild(rm);
        }
        row.appendChild(chip);
      });
      if (hidden.length > 0) {
        var moreNames = hidden.slice(0, 50).map(function(a) {
          return a.kind === "folder" ? a.name + "/" : a.name;
        });
        if (hidden.length > moreNames.length) moreNames.push("...and " + (hidden.length - moreNames.length) + " more");
        var moreChip = h("div", {
          class: "bq-attachment bq-attachment-more",
          title: moreNames.join("\n")
        });
        moreChip.appendChild(h("span", { class: "bq-attachment-name", text: "\u2026(" + hidden.length + ") more" }));
        var moreRm = h("button", {
          class: "bq-attachment-remove",
          type: "button",
          title: "Remove these " + hidden.length,
          text: "\xD7"
        });
        moreRm.addEventListener("click", function(e) {
          e.stopPropagation();
          removeAttachments(hidden.map(function(a) {
            return a.id;
          }));
        });
        moreChip.appendChild(moreRm);
        row.appendChild(moreChip);
      } else if (composerAttachments().length >= 2) {
        var removeAll = h("button", {
          class: "bq-attachment-remove-all",
          type: "button",
          title: "Remove all attachments"
        }, "Remove all \xD7");
        removeAll.addEventListener("click", function(e) {
          e.stopPropagation();
          clearAttachments();
        });
        row.appendChild(removeAll);
      }
      var inFlight = inFlightUploadAttachments();
      if (inFlight.length >= 2) {
        var cancelAll = h("button", {
          class: "bq-attachment-remove-all",
          type: "button",
          title: "Cancel all " + inFlight.length + " uploads"
        }, "Cancel all uploads \xD7");
        cancelAll.addEventListener("click", function(e) {
          e.stopPropagation();
          cancelAttachmentUploads(inFlightUploadAttachments());
        });
        row.appendChild(cancelAll);
      }
    }
    function uploadsFrozenForUser() {
      if (!S.user) return true;
      var conf = S.service && S.service.conf || {};
      if (!conf.freeze_database) return false;
      var ag = S.user && typeof S.user.access_group === "number" ? S.user.access_group : 0;
      return ag < 99;
    }
    function updateComposerControls() {
      if (CS.attachBtnEl) CS.attachBtnEl.disabled = false;
      if (CS.inputEl) CS.inputEl.disabled = false;
      if (CS.sendBtnEl) {
        var hasText = !!(CS.inputEl && CS.inputEl.value.trim());
        var hasSendableAttachment = composerAttachments().some(function(a) {
          return a.status !== "done";
        });
        CS.sendBtnEl.disabled = !!CS.attachmentWarning || !hasText && !hasSendableAttachment;
      }
    }
    function onAttachInputChange(inputEl) {
      if (inputEl && inputEl.files && inputEl.files.length) addFilesToAttachments(inputEl.files);
      if (inputEl) inputEl.value = "";
    }
    function setupDragAndDrop(chatEl) {
      var depth = 0, overlay = null, preparing = null;
      function showOverlay() {
        if (overlay || S.aiPlatform === "none") return;
        overlay = h(
          "div",
          { class: "bq-drop-overlay" },
          h(
            "div",
            { class: "bq-drop-overlay-inner" },
            h("span", { html: ATTACH_ICON_SVG }),
            h("span", { text: "Drop files to attach" })
          )
        );
        chatEl.appendChild(overlay);
      }
      function hideOverlay() {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
      }
      function hasFiles(e) {
        var dt = e.dataTransfer;
        if (!dt) return false;
        if (dt.types) {
          for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === "Files") return true;
          return false;
        }
        return true;
      }
      chatEl.addEventListener("dragenter", function(e) {
        if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
        e.preventDefault();
        depth++;
        showOverlay();
      });
      chatEl.addEventListener("dragover", function(e) {
        if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      });
      chatEl.addEventListener("dragleave", function(e) {
        if (!hasFiles(e)) return;
        depth--;
        if (depth <= 0) {
          depth = 0;
          hideOverlay();
        }
      });
      chatEl.addEventListener("drop", function(e) {
        if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
        e.preventDefault();
        depth = 0;
        hideOverlay();
        if (preparing) return;
        preparing = h(
          "div",
          { class: "bq-drop-preparing", role: "status", "aria-live": "polite" },
          bunnyLoader("Preparing files...", false)
        );
        chatEl.appendChild(preparing);
        var done = function() {
          if (preparing && preparing.parentNode) preparing.parentNode.removeChild(preparing);
          preparing = null;
        };
        Promise.resolve().then(function() {
          return handleDrop(e.dataTransfer);
        }).then(done, done);
      });
    }
    function handleDrop(dt) {
      if (!dt) return;
      var items = dt.items;
      if (items && items.length) {
        var entries = [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it.kind !== "file") continue;
          var entry2 = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
          entries.push(entry2 || it.getAsFile());
        }
        return Promise.all(entries.map(function(entry3) {
          if (!entry3) return Promise.resolve(null);
          if (entry3 instanceof File) return Promise.resolve(newAttachment({ kind: "file", name: entry3.name, file: entry3 }));
          if (entry3.isFile) {
            return readEntry(entry3).then(function(files) {
              return files[0] ? newAttachment({ kind: "file", name: files[0].file.name, file: files[0].file }) : null;
            });
          }
          if (entry3.isDirectory) {
            return readEntry(entry3).then(function(files) {
              return newAttachment({ kind: "folder", name: entry3.name, files });
            });
          }
          return Promise.resolve(null);
        })).then(function(objs) {
          appendAttachments(objs.filter(Boolean));
        });
      } else if (dt.files && dt.files.length) {
        addFilesToAttachments(dt.files);
      }
    }
    function getPublicTemporaryUrl(remotePath) {
      if (!remotePath) return Promise.reject(new Error("Missing attachment path."));
      return getTemporaryUrlDb(remotePath, EXPIRED_LINK_REFRESH_EXPIRES_SECONDS, false);
    }
    var unavailableRepaintQueued = false;
    function queueUnavailableRepaint() {
      if (unavailableRepaintQueued) return;
      unavailableRepaintQueued = true;
      setTimeout(function() {
        unavailableRepaintQueued = false;
        renderMessages();
      }, 0);
    }
    function markLinkUnavailable(key) {
      if (!key || unavailableLinkMap[key]) return;
      unavailableLinkMap[key] = true;
      if (!refreshedLinkExpiryTimer) scheduleNextLinkExpiryBoundary();
      queueUnavailableRepaint();
    }
    function clearLinkUnavailable(keys) {
      var changed = false;
      for (var i = 0; i < (keys || []).length; i++) {
        var k = keys[i];
        if (!k || !unavailableLinkMap[k]) continue;
        delete unavailableLinkMap[k];
        changed = true;
      }
      if (changed) queueUnavailableRepaint();
    }
    function imagePreviewCtx() {
      return {
        scope: S.projectId || "default",
        mint: function(remotePath, contentType, refresh) {
          return getTemporaryUrlDb(remotePath, PREVIEW_URL_EXPIRES_SECONDS, false, contentType, {
            browserCache: PREVIEW_BROWSER_CACHE_SECONDS,
            refresh
          });
        },
        // An image arriving late pushes the conversation down under the
        // viewport. Re-pin only if the user was already at the bottom. A
        // paint is also proof the file is reachable, so it lifts any mark an
        // earlier failure left on this file's chips.
        onLoad: function(path) {
          clearLinkUnavailable(linkUnavailableKeysForPath(path));
          scrollToBottomIfSticky();
        },
        // The resizes an <img> makes with no event of its own to announce
        // them: the src landing, and the src being dropped for a retry (which
        // collapses an already-painted picture to nothing). load and error are
        // covered by the listener on the message box, which also catches the
        // markdown images this module never sees.
        onLayoutChange: function(img) {
          chatScrollAnchor.absorb(img);
        },
        // The mint was refused, or the url it minted would not load. Either
        // way there is no url for this file, so the caption chip left behind
        // must not keep offering a click that opens a dead tab.
        onError: function(path, err) {
          console.warn("[bunnyquery] image preview failed", path, err);
          markLinkUnavailable(linkUnavailableKeyForPath(path));
        }
      };
    }
    function hydrateMessageImagePreviews() {
      if (!CS.messagesBox) return;
      var nodes = CS.messagesBox.querySelectorAll("img.bq-img-preview:not([data-bq-img-state])");
      if (!nodes.length) return;
      var list = Array.prototype.filter.call(nodes, function(n) {
        return !(n.closest && n.closest(".bq-index-label"));
      });
      if (list.length) hydrateImagePreviews(list, imagePreviewCtx());
    }
    var refreshedLinkExpiryTimer = null;
    function expireAllRefreshedLinks() {
      var changed = false;
      for (var k in refreshedExpiredLinkMap) {
        delete refreshedExpiredLinkMap[k];
        changed = true;
      }
      for (var u in unavailableLinkMap) {
        delete unavailableLinkMap[u];
        changed = true;
      }
      return changed;
    }
    function scheduleNextLinkExpiryBoundary() {
      if (refreshedLinkExpiryTimer) clearTimeout(refreshedLinkExpiryTimer);
      var now = Date.now();
      var next = Math.ceil(now / LINK_REFRESH_WINDOW_MS) * LINK_REFRESH_WINDOW_MS;
      refreshedLinkExpiryTimer = setTimeout(function() {
        if (expireAllRefreshedLinks()) renderMessages();
        scheduleNextLinkExpiryBoundary();
      }, Math.max(1, next - now));
    }
    function fetchFreshHrefForExpiredLink(expiredHref, remotePath) {
      var cached = refreshedExpiredLinkMap[expiredHref];
      if (cached) return Promise.resolve(cached);
      var inFlight = refreshingLinkPromises.get(expiredHref);
      if (inFlight) return inFlight;
      var run = (function() {
        refreshingLinkMap[expiredHref] = true;
        var resolved = remotePath || extractRemotePathFromAttachmentHref(expiredHref, S.projectId);
        if (!resolved) return Promise.reject(new Error("Unable to refresh this expired attachment link."));
        return getPublicTemporaryUrl(resolved).then(function(fresh) {
          refreshedExpiredLinkMap[expiredHref] = fresh;
          scheduleNextLinkExpiryBoundary();
          return fresh;
        });
      })().then(
        function(v) {
          refreshingLinkPromises.delete(expiredHref);
          delete refreshingLinkMap[expiredHref];
          return v;
        },
        function(e) {
          refreshingLinkPromises.delete(expiredHref);
          delete refreshingLinkMap[expiredHref];
          throw e;
        }
      );
      refreshingLinkPromises.set(expiredHref, run);
      return run;
    }
    function onBubbleLinkClick(e) {
      var target = e.target;
      if (!target) return;
      var anchor = target.closest ? target.closest("a[data-bq-link]") : null;
      if (!anchor) return;
      if (anchor.dataset.bqUnavailable === "1") {
        e.preventDefault();
        return;
      }
      if (anchor.dataset.bqExpired !== "1") return;
      e.preventDefault();
      var originalHref = anchor.dataset.bqExpiredHref || anchor.href;
      if (refreshingLinkMap[originalHref]) return;
      var cached = refreshedExpiredLinkMap[originalHref];
      if (cached) {
        anchor.href = cached;
        anchor.dataset.bqExpired = "0";
        anchor.click();
        return;
      }
      var busy = document.createElement("span");
      busy.className = "bq-link-tail";
      busy.textContent = " (fetching...)";
      anchor.classList.add("is-refreshing");
      anchor.appendChild(busy);
      var unbusy = function() {
        anchor.classList.remove("is-refreshing");
        if (busy.parentNode) busy.parentNode.removeChild(busy);
      };
      fetchFreshHrefForExpiredLink(originalHref, anchor.dataset.bqRemotePath).then(function(fresh) {
        unbusy();
        anchor.href = fresh;
        anchor.dataset.bqExpired = "0";
        anchor.click();
      }).catch(function(err) {
        unbusy();
        console.error("[bunnyquery] expired link refresh failed", err);
        markLinkUnavailable(linkUnavailableKeyForHref(originalHref));
        if (anchor.dataset.bqRemotePath) markLinkUnavailable(linkUnavailableKeyForPath(anchor.dataset.bqRemotePath));
      });
    }
    function getClearHistoryStorageKey() {
      if (!S.projectId || S.aiPlatform === "none") return "";
      var key = SK.clearHorizon + ":" + S.projectId + "#" + S.aiPlatform;
      if (isAnonymousSession()) key += "#" + anonDeviceId();
      return key;
    }
    function getClearedAt() {
      var key = getClearHistoryStorageKey();
      if (!key) return 0;
      var raw = lsGet(key);
      var value = raw ? Number(raw) : 0;
      return isFinite(value) && value > 0 ? value : 0;
    }
    function setClearedAt(ts) {
      var key = getClearHistoryStorageKey();
      if (key) lsSet(key, String(ts));
    }
    function fetchOlderHistoryIfNeeded() {
      if (CS.historyEndOfList) return Promise.resolve(true);
      if (CS.loadingHistory || CS.loadingOlderHistory) return Promise.resolve(false);
      return session.loadHistory(true).then(function() {
        return true;
      });
    }
    function messagesBoxCanScroll() {
      if (!CS.messagesBox || CS.chatSettingsOpen) return true;
      var drafting = CS.draftingEl && CS.draftingEl.parentNode === CS.messagesBox ? CS.draftingEl.offsetHeight : 0;
      return CS.messagesBox.scrollHeight - drafting - CS.messagesBox.clientHeight > HISTORY_FILL_SLACK_PX;
    }
    function topVisibleRowKey() {
      var box = CS.messagesBox;
      if (!box) return null;
      var boxTop = box.getBoundingClientRect().top;
      var kids = box.children;
      for (var i = 0; i < kids.length; i++) {
        var key = kids[i].getAttribute && kids[i].getAttribute("data-row-key");
        if (!key) continue;
        if (kids[i].getBoundingClientRect().top - boxTop + kids[i].offsetHeight > 0) return key;
      }
      return null;
    }
    function contentAboveRow(key) {
      var box = CS.messagesBox;
      if (!box) return null;
      var boxTop = box.getBoundingClientRect().top;
      var kids = box.children;
      for (var i = 0; i < kids.length; i++) {
        if (!kids[i].getAttribute || kids[i].getAttribute("data-row-key") !== key) continue;
        return kids[i].getBoundingClientRect().top - boxTop + box.scrollTop;
      }
      return null;
    }
    var _historyFillToken = 0;
    var _historyFiller = createHistoryFiller({
      isEndOfList: function() {
        return !!CS.historyEndOfList;
      },
      isLoading: function() {
        return !!(CS.loadingHistory || CS.loadingOlderHistory);
      },
      // The settings panel occupies the messages box and suppresses
      // renderMessages, so a fill started before it opened must stop.
      isStale: function() {
        return _historyFillToken !== CS.gateRefreshToken || !CS.messagesBox || CS.chatSettingsOpen;
      },
      messageCount: function() {
        return CS.messages.length;
      },
      fetchOlder: function() {
        return fetchOlderHistoryIfNeeded();
      },
      // A collapsed indexing row whose run begins above the loaded window says
      // "loading" for as long as the pages that would complete it keep coming, and
      // that span is the LOOP, not a page (see createHistoryFiller). Rendering the
      // flip is safe from here: renderMessages never starts a fill of its own, and
      // the loop's own guard has already flipped before this is called.
      onRunningChange: function(running) {
        CS.historyFilling = running;
        renderMessages();
      }
    });
    function pageOlderHistoryUntil(isSatisfied, token) {
      if (token === void 0) token = CS.gateRefreshToken;
      if (token !== CS.gateRefreshToken) return Promise.resolve();
      _historyFillToken = token;
      return _historyFiller.fill(function() {
        return raf2().then(isSatisfied);
      });
    }
    function ensureHistoryFillsViewport(token) {
      return pageOlderHistoryUntil(messagesBoxCanScroll, token);
    }
    function pageOlderHistoryUntilTaller() {
      var anchorKey = topVisibleRowKey();
      var before = anchorKey ? contentAboveRow(anchorKey) : null;
      return pageOlderHistoryUntil(function() {
        if (!CS.messagesBox || !anchorKey || before === null) return true;
        var now = contentAboveRow(anchorKey);
        return now === null || now > before + HISTORY_FILL_SLACK_PX;
      });
    }
    function openClearHistoryModal() {
      if (!chatEnabled() || CS.sending || CS.typing) return;
      if (!CS.messages.length) return;
      var modal = openModal(function(close) {
        var clearBtn = h("button", { class: "btn btn--danger", type: "button" }, "Clear");
        clearBtn.addEventListener("click", function() {
          if (CS.clearing) return;
          CS.clearing = true;
          setClearedAt(Date.now());
          var key = session.getHistoryCacheKey();
          if (key) delete aiChatHistoryCache[key];
          CS.messages = [];
          CS.historyStartKeyHistory = [];
          CS.historyEndOfList = true;
          renderMessages();
          CS.clearing = false;
          close();
        });
        return h(
          "div",
          { class: "bq-modal" },
          h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
          h(
            "div",
            { class: "bq-modal-delete-header" },
            h("span", { text: "Clear chat history" })
          ),
          h("p", { class: "bq-modal-desc" }, "This hides the current conversation from view. Your messages stay on the server but won't be shown here again."),
          h(
            "div",
            { class: "bq-modal-btns" },
            h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"),
            clearBtn
          )
        );
      });
      return modal;
    }
    function chatEnabled() {
      return S.aiPlatform !== "none";
    }
    function autoGrowInput(el) {
      if (!el) return;
      var prevH = el.offsetHeight;
      el.style.height = "auto";
      var cs = window.getComputedStyle(el);
      var border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      var max = 192;
      var h2 = el.scrollHeight + border;
      if (h2 > max) {
        el.style.height = max + "px";
        el.style.overflowY = "auto";
      } else {
        el.style.height = h2 + "px";
        el.style.overflowY = "hidden";
      }
      var nextH = el.offsetHeight;
      if (CS.stickToBottom) chatScrollAnchor.pinBottom();
      if (nextH < prevH) ensureHistoryFillsViewport();
    }
    function buildMessageEl(msg, idx) {
      var cls = ["bq-message"];
      cls.push(msg.role === "user" ? "is-user" : "is-assistant");
      if (msg.isError) cls.push("is-error");
      if (msg.isRetried) cls.push("is-retried");
      if (msg.isCancelled) cls.push("is-cancelled");
      if (msg.isPendingQueued || msg.isPendingOlder) cls.push("is-pending-older");
      if (msg._dimSending || msg._cancelling) cls.push("is-sending-to-server");
      var bubble;
      if (msg.isPending && !msg._streaming || streamRecoveryPhase(msg) === "active") {
        bubble = h("div", { class: "bq-bubble" }, h("span", { class: "bq-loader" }));
        if (msg.role === "assistant" && !msg.isBackgroundTask && !streamRecoveryPhase(msg)) {
          var waitDisabled = !msg._serverItemId || msg._cancelling;
          var stopWaitBtn = h("button", {
            class: "bq-cancel-wait-btn" + (waitDisabled ? " is-disabled" : ""),
            type: "button",
            title: "Stop waiting for this reply",
            "aria-label": "Stop waiting for this reply",
            html: "&times;"
          });
          if (!waitDisabled) stopWaitBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            session.cancelPendingReply(msg, idx);
          });
          bubble.appendChild(stopWaitBtn);
          if (msg._cancelError) bubble.appendChild(h("span", { class: "bq-cancel-error", text: msg._cancelError }));
        }
      } else if (streamRecoveryPhase(msg)) {
        var labels = streamRecoveryLabels(streamRecoveryPhase(msg));
        bubble = h("div", { class: "bq-bubble is-stream-recover" + (streamRecoveryPhase(msg) === "failed" ? " is-stream-failed" : "") });
        bubble.appendChild(h("span", { class: "bq-stream-recover-note", text: labels.note }));
        var recoverBtn = h("button", { class: "bq-stream-recover-btn", type: "button", text: labels.action });
        recoverBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          session.recoverStreamedAnswer(msg._serverItemId);
        });
        bubble.appendChild(recoverBtn);
      } else {
        bubble = h("div", { class: "bq-bubble" });
        if (msg.role === "user" && msg.isPendingQueued) {
          var disabled = !msg._serverItemId || msg.isSendingToServer || msg._cancelling;
          var cancelBtn = h("button", {
            class: "bq-cancel-queue-btn" + (disabled ? " is-disabled" : ""),
            type: "button",
            title: "Cancel queued message",
            html: "&times;"
          });
          if (!disabled) cancelBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            session.cancelQueuedMessage(msg, idx);
          });
          bubble.appendChild(cancelBtn);
        }
        var md = h("div", { class: "bq-md", translate: "no", html: parseMsgPartsHtml(msg.content) });
        md.addEventListener("click", onBubbleLinkClick);
        bubble.appendChild(md);
        var citeNote = retrievalNoteOfAnswer(msg);
        if (citeNote) {
          var citeHtml = citationChipsHtml(citeNote);
          if (citeHtml) {
            var citeRow = h("div", { class: "bq-citations", translate: "no", html: citeHtml });
            citeRow.addEventListener("click", onBubbleLinkClick);
            bubble.appendChild(citeRow);
          }
          if (answerUsedNoDataTool(citeNote)) bubble.appendChild(h("span", { class: "bq-no-source-note", text: NO_DATA_TOOL_MARK }));
          if (session.canReportWrongAnswer(msg)) {
            var wrongSent = session.wrongAnswerReported(msg);
            var wrongBtn = h("button", { class: "bq-wrong-answer-btn", type: "button", text: session.wrongAnswerLabel });
            if (wrongSent) wrongBtn.disabled = true;
            else wrongBtn.addEventListener("click", function(e) {
              e.stopPropagation();
              wrongBtn.disabled = true;
              readyProjectSettings(S.projectId).then(function() {
                session.reportWrongAnswer(msg);
              });
            });
            bubble.appendChild(wrongBtn);
          }
        }
        if (msg.isUploadingAttachments) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(Uploading files...)" }));
        else if (msg.isAwaitingIndexing) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(Indexing files...)" }));
        else if (msg.isPendingQueued) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(In queue)" }));
        if (msg.isCancelled) bubble.appendChild(h("span", { class: "bq-cancel-error", text: "(cancelled)" }));
        if (msg._cancelError) bubble.appendChild(h("span", { class: "bq-cancel-error", text: msg._cancelError }));
        if (msg._notSent && session.canRetryNotSent(msg)) {
          var retryBtn = h("button", { class: "bq-wrong-answer-btn bq-retry-send-btn", type: "button", text: "Retry" });
          retryBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            retryBtn.disabled = true;
            session.retryNotSent(msg);
          });
          bubble.appendChild(retryBtn);
        }
        var ts = msg.isPending ? "" : formatChatTimestamp(msg._ts);
        if (ts && typeof msg._ts === "number" && typeof msg._tsStart === "number") {
          var dur = formatDuration(msg._ts - msg._tsStart);
          if (dur) ts += " (" + dur + ")";
        }
        if (ts) bubble.appendChild(h("time", { class: "bq-msg-time", text: ts }));
      }
      return h("div", { class: cls.join(" "), dataset: { msgIndex: String(idx) } }, bubble);
    }
    var INDEX_ICON_ACTIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 0 1-8.5 8.5 8.5 8.5 0 0 1-7.6-4.7"/><path d="M3.5 12A8.5 8.5 0 0 1 12 3.5a8.5 8.5 0 0 1 7.6 4.7"/><path d="M20 3.6v4.8h-4.8"/><path d="M4 20.4v-4.8h4.8"/></svg>';
    var INDEX_ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
    var INDEX_ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.6h.01"/></svg>';
    var INDEX_ICON_CANCELLED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.2 8.2l7.6 7.6"/></svg>';
    var INDEX_ICON_PENDING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.4V12l3.3 2"/></svg>';
    function indexGroupIcon(group) {
      if (group.status === "cancelled") return INDEX_ICON_CANCELLED;
      if (group.resolving) return INDEX_ICON_PENDING;
      if (!group.finished) return INDEX_ICON_ACTIVE;
      if (group.status === "error") return INDEX_ICON_ERROR;
      return INDEX_ICON_DONE;
    }
    function indexGroupVerb(group) {
      if (group.status === "cancelled") return "Indexing cancelled:";
      if (group.resolving) {
        return group.resolvingReason === "history" ? "Loading history:" : "Fetching status:";
      }
      if (group.queued) return "Queued:";
      if (!group.finished) return group.isReindex ? "Reindexing" : "Indexing";
      if (group.status === "error") return "Indexing failed:";
      return group.isReindex ? "Reindexed" : "Indexed";
    }
    function indexGroupLabel(group) {
      var nameLabel = group.path ? "[" + group.name + "](" + group.path + ")" : group.name;
      return indexGroupVerb(group) + " " + nameLabel;
    }
    function indexGroupCount(group) {
      var linkedLine = indexGroupLinkedLabel(group);
      if (linkedLine) return linkedLine;
      if (group.stub) return indexGroupDurationLabel(group);
      var prog = group.status === "active" && session && session.pageProgressFor ? session.pageProgressFor(group.path || group.key, group.name) : null;
      var pages = prog ? prog.total ? prog.saved + " of " + prog.total + " pages" : prog.saved + " pages" : "";
      var passes = group.passCount <= 1 && !group.mayHaveOlder ? "" : group.passCount + (group.mayHaveOlder ? "+" : "") + " passes";
      return [pages, passes, indexGroupDurationLabel(group)].filter(Boolean).join(" \xB7 ");
    }
    var markerSweep = { svc: "", at: 0, gen: 0, done: {}, runs: {}, partial: false, inflight: null };
    var MARKER_SWEEP_TTL_MS = 3e4;
    var MARKER_SWEEP_MAX_PAGES = 10;
    function sweepIndexMarkersDb() {
      if (!S.skapi || !S.projectId || typeof S.skapi.getRecords !== "function") return Promise.resolve(null);
      var svc = S.projectId;
      if (markerSweep.svc === svc && markerSweep.at && Date.now() - markerSweep.at < MARKER_SWEEP_TTL_MS) {
        return Promise.resolve(markerSweep);
      }
      if (markerSweep.inflight) {
        if (!markerSweep.at) {
          return markerSweep.inflight.then(function() {
            return sweepIndexMarkersDb();
          });
        }
        return markerSweep.inflight;
      }
      var gen = markerSweep.gen;
      var done = {};
      var runs = {};
      var partial = false;
      function page(fetchMore, n) {
        return Promise.resolve(S.skapi.getRecords(
          { service: svc, table: { name: "__INDEXING__", access_group: "authorized" } },
          { limit: 1e3, fetchMore, ascending: false }
        )).then(function(res) {
          var list = res && res.list || [];
          for (var i = 0; i < list.length; i++) {
            var uid = String(list[i] && list[i].unique_id || "");
            if (uid.indexOf("done::") === 0) {
              done[uid.slice(6)] = true;
            } else if (uid.indexOf("run::") === 0) {
              var path = uid.slice(5);
              var d = list[i] && list[i].data || {};
              var st = String(d.status || "");
              if (path && !runs[path] && (st === "working" || st === "done" || st === "error" || st === "cancelled")) {
                runs[path] = {
                  status: st,
                  filename: typeof d.filename === "string" ? d.filename : void 0,
                  started: typeof d.started === "number" ? d.started : void 0,
                  finished: typeof d.finished === "number" ? d.finished : void 0,
                  error: typeof d.error === "string" ? d.error : void 0,
                  platform: d.platform === "claude" || d.platform === "openai" ? d.platform : void 0,
                  owner: list[i] && typeof list[i].user_id === "string" ? list[i].user_id : void 0,
                  // a run LINKED to an identical file's index (engine identical.ts)
                  linked: d.linked === true ? true : void 0,
                  alias_of: d.linked === true && typeof d.alias_of === "string" ? d.alias_of : void 0,
                  link_ms: d.linked === true && typeof d.link_ms === "number" ? d.link_ms : void 0
                };
              }
            }
          }
          if (res && res.endOfList === false) {
            if (n < MARKER_SWEEP_MAX_PAGES - 1) return page(true, n + 1);
            partial = true;
          }
          return null;
        });
      }
      var p = page(false, 0).then(function() {
        if (S.projectId !== svc || markerSweep.gen !== gen) return markerSweep;
        markerSweep.svc = svc;
        markerSweep.at = Date.now();
        markerSweep.done = done;
        markerSweep.runs = runs;
        markerSweep.partial = partial;
        return markerSweep;
      });
      markerSweep.inflight = p;
      p.then(function() {
        markerSweep.inflight = null;
      }, function() {
        markerSweep.inflight = null;
      });
      return p;
    }
    function invalidateIndexMarkerSweep() {
      markerSweep.at = 0;
      markerSweep.gen++;
    }
    function maybeArmStubRecheck() {
      try {
        if (markerSweep.svc !== S.projectId || !session) return;
        var working = [];
        var info = {};
        for (var pth in markerSweep.runs) {
          var r = markerSweep.runs[pth];
          if (!r || r.status !== "working") continue;
          var fn = r.filename || pth.split("/").pop() || pth;
          if (markerSweep.done[pth] || markerSweep.done[fn]) continue;
          working.push(pth);
          info[pth] = { owner: r.owner, filename: r.filename };
        }
        session.syncFileRuns(S.projectId, working, info);
      } catch (e) {
      }
    }
    function refreshIndexMarkers(invalidate) {
      if (invalidate) invalidateIndexMarkerSweep();
      return sweepIndexMarkersDb().then(function(res) {
        if (res) {
          maybeArmStubRecheck();
          renderMessages();
        }
        return res;
      }).catch(function() {
        renderMessages();
        return null;
      });
    }
    function displayListOptions() {
      var liveIndex = session.getLiveIndexState();
      var fresh = markerSweep.svc === S.projectId;
      var stubs = void 0;
      if (fresh && !isAnonymousSession()) {
        stubs = {};
        var myId = S.user && S.user.user_id || "";
        for (var rp in markerSweep.runs) {
          var rr = markerSweep.runs[rp];
          if (rr && rr.owner && myId && rr.owner !== myId) continue;
          stubs[rp] = {
            status: rr.status,
            filename: rr.filename,
            started: rr.started,
            finished: rr.finished,
            error: rr.error,
            platform: rr.platform,
            owner: rr.owner,
            linked: rr.linked,
            alias_of: rr.alias_of,
            link_ms: rr.link_ms
          };
        }
      }
      return {
        hasMoreHistory: !CS.historyEndOfList,
        // Older pages coming in RIGHT NOW. CS.historyFilling, not just the
        // per-request flag: the viewport fill is many pages and that flag drops
        // to false between every one of them, which is once per page of flicker
        // on any row rendered off it.
        loadingOlderHistory: !!(CS.loadingOlderHistory || CS.historyFilling),
        liveIndexKeys: liveIndex.keys,
        liveIndexChecked: liveIndex.checked,
        // Which live files have a pass running: a live row without one says "Queued".
        liveIndexRunningKeys: liveIndex.running,
        liveIndexRunningChecked: liveIndex.runningChecked,
        // Runs the user stopped. A stop that landed on a RUNNING pass leaves no
        // cancelled bubble behind (that pass finishes and answers normally), so
        // without this the row reports the stop as a finished "Indexed".
        stoppedIndexIds: session.getStoppedIndexIds(),
        // Durable completion markers + run records (one sweep, see above).
        // doneKeys settle worker-run greens without a queue round trip;
        // runStubs paint rows for runs whose passes are not loaded yet.
        // Plus the files the queue check saw leave the queue (agent.vue same).
        doneKeys: Object.assign({}, fresh ? markerSweep.done : {}, liveIndex.settled || {}),
        runStubs: stubs,
        // Records are service-wide and horizon-blind; without this every
        // "Clear chat history" resurrected one row per indexed file.
        stubClearedAt: getClearedAt(),
        // A run:: record is per FILE; a chat is per (project, PLATFORM).
        stubPlatform: S.aiPlatform === "claude" || S.aiPlatform === "openai" ? S.aiPlatform : void 0
      };
    }
    var stopIndexState = { runKey: "", fileKey: "", handle: null };
    function indexGroupStoppable(group) {
      return !!group && !group.stub && !group.finished && !group.resolving && !group.stopped && !group.cancelling;
    }
    function findCancellableIndexGroup(runKey, fileKey) {
      if (!runKey) return null;
      var list = buildChatDisplayList(CS.messages, displayListOptions());
      var byFile = null;
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        if (row.kind !== "indexing") continue;
        var live = indexGroupStoppable(row.group) ? row.group : null;
        if (row.group.runKey === runKey) return live;
        if (!byFile && live && fileKey && row.group.key === fileKey) byFile = row.group;
      }
      return byFile;
    }
    var stopIndexOthers = { checked: false, row: null, text: null, box: null };
    function otherStoppableIndexGroups(target) {
      if (!target) return [];
      var list = buildChatDisplayList(CS.messages, displayListOptions());
      var others = [];
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        if (row.kind !== "indexing") continue;
        if (!indexGroupStoppable(row.group) || row.group.key === target.key) continue;
        others.push(row.group);
      }
      return others;
    }
    function countIndexFiles(groups) {
      var seen = {}, n = 0;
      for (var i = 0; i < groups.length; i++) {
        if (seen[groups[i].key]) continue;
        seen[groups[i].key] = true;
        n++;
      }
      return n;
    }
    function stopOthersLabel(n) {
      return n === 1 ? "Also stop the other file being indexed" : "Also stop the " + n + " other files being indexed";
    }
    function refreshStopIndexOthers() {
      if (!stopIndexOthers.row) return;
      var n = countIndexFiles(otherStoppableIndexGroups(findCancellableIndexGroup(stopIndexState.runKey, stopIndexState.fileKey)));
      if (!n) {
        stopIndexOthers.checked = false;
        if (stopIndexOthers.box) stopIndexOthers.box.checked = false;
      } else if (stopIndexOthers.text) {
        stopIndexOthers.text.textContent = stopOthersLabel(n);
      }
      stopIndexOthers.row.style.display = n ? "" : "none";
    }
    function stopIndexModalIsOpen() {
      var hnd = stopIndexState.handle;
      if (hnd && hnd.root && hnd.root.parentNode) return true;
      stopIndexState.runKey = "";
      stopIndexState.fileKey = "";
      stopIndexState.handle = null;
      return false;
    }
    function closeStopIndexModal() {
      var hnd = stopIndexState.handle;
      stopIndexState.runKey = "";
      stopIndexState.fileKey = "";
      stopIndexState.handle = null;
      if (hnd) hnd.close();
    }
    function syncStopIndexModal() {
      if (!stopIndexModalIsOpen()) return;
      if (!findCancellableIndexGroup(stopIndexState.runKey, stopIndexState.fileKey)) closeStopIndexModal();
      else refreshStopIndexOthers();
    }
    function openStopIndexModal(group) {
      if (!indexGroupStoppable(group)) return;
      closeStopIndexModal();
      stopIndexState.runKey = group.runKey;
      stopIndexState.fileKey = group.key;
      var name = group.name;
      stopIndexState.handle = openModal(function(close) {
        var stopBtn = h("button", { class: "btn btn--danger", type: "button" }, "Stop indexing");
        stopBtn.addEventListener("click", function() {
          var runKey = stopIndexState.runKey;
          var fileKey = stopIndexState.fileKey;
          var alsoOthers = stopIndexOthers.checked;
          closeStopIndexModal();
          var live = findCancellableIndexGroup(runKey, fileKey);
          var others = alsoOthers ? otherStoppableIndexGroups(live) : [];
          if (live) session.cancelIndexingGroup(live);
          for (var oi = 0; oi < others.length; oi++) session.cancelIndexingGroup(others[oi]);
        });
        var othersBox = h("input", { type: "checkbox" });
        othersBox.addEventListener("change", function() {
          stopIndexOthers.checked = !!othersBox.checked;
        });
        var othersText = h("span");
        var othersRow = h("label", { class: "bq-overwrite-applyall" }, othersBox, othersText);
        stopIndexOthers.checked = false;
        stopIndexOthers.box = othersBox;
        stopIndexOthers.text = othersText;
        stopIndexOthers.row = othersRow;
        refreshStopIndexOthers();
        return h(
          "div",
          { class: "bq-modal" },
          h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
          h("div", { class: "bq-modal-delete-header" }, h("span", { text: "Stop indexing" })),
          // The file name is user data: translate="no" keeps a browser
          // translator from rewriting it (agent.vue tags it the same way).
          h(
            "p",
            { class: "bq-modal-desc" },
            "Stop indexing \u201C",
            h("span", { translate: "no", text: name }),
            "\u201D?"
          ),
          h(
            "p",
            { class: "bq-modal-desc bq-modal-delete-warn" },
            "Whatever has been indexed so far stays searchable, and the pass already running finishes on the server. The remaining passes are dropped, not paused, so the file stays partly indexed until you reindex it."
          ),
          othersRow,
          h(
            "div",
            { class: "bq-modal-btns" },
            h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Keep indexing"),
            stopBtn
          )
        );
      });
    }
    function toggleIndexGroup(key) {
      if (CS.indexGroupsOpen[key]) delete CS.indexGroupsOpen[key];
      else {
        CS.indexGroupsOpen[key] = true;
        hydrateCompactIndexGroup(key);
        if (session.lazyIndexRowsEnabled()) {
          var og = findIndexGroup(key);
          if (og && og.path && !session.runPassPaging(og.path)) void session.loadRunPasses(og.path, og.name);
        } else {
          void loadIndexGroupHistory(key);
        }
      }
      renderMessages();
      ensureHistoryFillsViewport();
    }
    var INDEX_GROUP_FETCH_MAX_PAGES = 40;
    var indexGroupFetching = {};
    function findIndexGroup(key) {
      try {
        var entries = buildChatDisplayList(CS.messages, displayListOptions());
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].kind === "indexing" && entries[i].group.key === key) return entries[i].group;
        }
      } catch (e) {
      }
      return null;
    }
    function groupNeedsHistory(key) {
      if (CS.historyEndOfList) return false;
      try {
        var entries = buildChatDisplayList(CS.messages, displayListOptions());
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].kind !== "indexing" || entries[i].group.key !== key) continue;
          return !!(entries[i].group.stub || entries[i].group.mayHaveOlder);
        }
      } catch (e) {
      }
      return false;
    }
    function loadIndexGroupHistory(key) {
      if (indexGroupFetching[key]) return Promise.resolve();
      if (!groupNeedsHistory(key)) return Promise.resolve();
      indexGroupFetching[key] = true;
      renderMessages();
      var pages = 0, waits = 0;
      function step() {
        if (!CS.indexGroupsOpen[key]) return null;
        if (!groupNeedsHistory(key)) return null;
        if (pages >= INDEX_GROUP_FETCH_MAX_PAGES) return null;
        if (CS.loadingOlderHistory || CS.historyFilling || session.state.bgHistoryLoading) {
          if (++waits > 240) return null;
          return new Promise(function(r) {
            setTimeout(r, 250);
          }).then(step);
        }
        pages++;
        return fetchOlderHistoryIfNeeded().then(step);
      }
      return Promise.resolve(step()).catch(function() {
      }).then(function() {
        delete indexGroupFetching[key];
        hydrateCompactIndexGroup(key);
        renderMessages();
      });
    }
    function hydrateCompactIndexGroup(key) {
      try {
        var entries = buildChatDisplayList(session.state.messages, displayListOptions());
        for (var i = 0; i < entries.length; i++) {
          var en = entries[i];
          if (en.kind !== "indexing" || en.group.key !== key) continue;
          var ids = [];
          for (var mi = 0; mi < en.group.members.length; mi++) {
            var m = en.group.members[mi].msg;
            if (m && m._compact && m.role === "assistant" && m._serverItemId && !m.isError && !m.isPending) ids.push(m._serverItemId);
          }
          if (ids.length) session.hydrateCompactItems(ids);
          return;
        }
      } catch (e) {
      }
    }
    function buildIndexGroupEl(group, isOpen) {
      var cls = ["bq-index-group"];
      if (group.resolving) cls.push("is-resolving");
      if (!group.resolving && !group.finished && group.status !== "cancelled") cls.push("is-active");
      if (!group.resolving && group.finished && group.status === "done") cls.push("is-indexed");
      if (group.finished && group.status === "error") cls.push("is-error");
      if (isOpen) cls.push("is-open");
      var label = h(
        "span",
        { class: "bq-index-label" },
        h("span", { class: "bq-md", html: parseMsgPartsHtml(indexGroupLabel(group), { imagePreviews: false, fitLinkLabels: true }) })
      );
      label.addEventListener("click", function(e) {
        if (e.target && e.target.closest && e.target.closest("a")) e.stopPropagation();
        onBubbleLinkClick(e);
      });
      var cancelBtn = null;
      if (indexGroupStoppable(group) || group.cancelling) {
        cancelBtn = h("button", {
          class: "bq-index-cancel" + (group.cancelling ? " is-disabled" : ""),
          type: "button",
          title: group.cancelling ? "Stopping..." : "Stop indexing this file",
          "aria-label": "Stop indexing " + group.name,
          text: group.cancelling ? "Stopping..." : "Stop"
        });
        if (group.cancelling) cancelBtn.disabled = true;
        else cancelBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          openStopIndexModal(group);
        });
        cancelBtn.addEventListener("keydown", function(e) {
          e.stopPropagation();
        });
      }
      var head = h(
        "div",
        {
          class: "bq-index-head",
          role: "button",
          tabindex: "0",
          "aria-expanded": isOpen ? "true" : "false",
          title: isOpen ? "Hide indexing steps" : "Show indexing steps",
          onclick: function() {
            toggleIndexGroup(group.key);
          },
          onkeydown: function(e) {
            if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
            e.preventDefault();
            toggleIndexGroup(group.key);
          }
        },
        h("span", { class: "bq-index-icon", html: indexGroupIcon(group) }),
        label,
        indexGroupCount(group) ? h("span", { class: "bq-index-count", text: indexGroupCount(group) }) : null,
        // Spinning arrows while this row's history is being paged in —
        // separate from the status icon, so a green (done) row spins too.
        indexGroupFetching[group.key] ? h("span", { class: "bq-index-fetch", html: INDEX_ICON_ACTIVE, title: "Fetching this file's indexing history" }) : null,
        cancelBtn,
        h("span", { class: "bq-index-chevron", text: "\u25B6" })
      );
      var el = h("div", { class: cls.join(" ") }, head);
      if (group.cancelError) {
        el.appendChild(h("div", {
          class: "bq-index-note is-error",
          text: "Could not stop this file: " + group.cancelError
        }));
      }
      var paging = group.path ? session.runPassPaging(group.path) : null;
      if (isOpen && session.lazyIndexRowsEnabled()) {
        if (paging && paging.loading) {
          el.appendChild(h(
            "div",
            { class: "bq-index-note" },
            h("span", { text: "Loading this file's indexing steps" }),
            h("span", { class: "bq-loader" })
          ));
        } else if (paging && paging.error) {
          el.appendChild(h("div", { class: "bq-index-note is-error", text: "Could not load the steps: " + paging.error }));
        } else if (!group.path && !group.visibleMembers.length) {
          el.appendChild(h("div", { class: "bq-index-note", text: "This file's indexing steps can't be listed." }));
        } else if (paging && paging.done && !group.visibleMembers.length) {
          el.appendChild(h("div", {
            class: "bq-index-note",
            text: "The steps of this indexing run were not recorded. Steps are kept for files indexed from now on."
          }));
        }
        if (group.path && !(paging && (paging.loading || paging.done))) {
          var moreBtn = h("button", { class: "bq-index-more", type: "button", text: "Load more" });
          moreBtn.addEventListener("click", function(ev) {
            ev.stopPropagation();
            void session.loadRunPasses(group.path, group.name);
          });
          moreBtn.addEventListener("keydown", function(ev) {
            ev.stopPropagation();
          });
          el.appendChild(moreBtn);
        }
      } else if (isOpen && indexGroupFetching[group.key]) {
        el.appendChild(h(
          "div",
          { class: "bq-index-note" },
          h("span", { text: "Loading this file's indexing history" }),
          h("span", { class: "bq-loader" })
        ));
      } else if (isOpen && group.mayHaveOlder) {
        var loadingNow = group.resolvingReason === "history" || group.stub && session.state.bgHistoryLoading;
        el.appendChild(h("div", {
          class: "bq-index-note",
          text: "Earlier passes of this file are further back in the conversation. " + (loadingNow ? "Loading them now." : "Scroll up to load them.")
        }));
      } else if (isOpen && !group.visibleMembers.length) {
        el.appendChild(h("div", {
          class: "bq-index-note",
          text: "This file's indexing steps aren't in this chat's history. They may belong to another chat or platform, or the conversation was cleared."
        }));
      }
      return el;
    }
    function greetingParts() {
      return buildChatGreeting({
        projectName: S.serviceName,
        canUpload: !uploadsFrozenForUser(),
        // A project can replace the sentence entirely from its settings page.
        // A SYNC cache read, so it is '' until the settings fetch settles --
        // refreshGreetingEl below is what picks it up when it lands.
        custom: projectChatGreeting(S.projectId)
      });
    }
    function refreshGreetingEl() {
      if (!CS.messagesBox) return;
      var cur = CS.messagesBox.querySelector(".bq-empty-greeting");
      if (!cur) return;
      var next = buildGreetingEl();
      if (next.textContent === cur.textContent) return;
      cur.parentNode.replaceChild(next, cur);
    }
    function buildGreetingEl() {
      var parts = greetingParts();
      var name = parts.name ? [document.createTextNode(" "), h("strong", { translate: "no", text: parts.name })] : null;
      var bubble = h("div", { class: "bq-bubble" });
      append(bubble, parts.lead);
      append(bubble, name);
      append(bubble, parts.tail);
      return h("div", { class: "bq-message is-assistant bq-empty-greeting" }, bubble);
    }
    function historyLoadingEl(initial) {
      if (initial) {
        return h(
          "div",
          { class: "bq-history-loading is-initial" },
          bunnyLoader("Fetching history...")
        );
      }
      return h(
        "div",
        { class: "bq-history-loading" },
        h(
          "span",
          { class: "bq-history-loading-inner" },
          h("span", { text: "Fetching history" }),
          h("span", { class: "bq-loader" })
        )
      );
    }
    function rowAnchorKey(msg, index) {
      if (!msg) return null;
      var id = msg._serverItemId || msg._localId;
      return id ? "s" + id + ":" + msg.role : "i" + index;
    }
    function indexGroupAnchorId(group) {
      return group.anchorId || "";
    }
    var chatScrollAnchor = createScrollAnchor({
      getBox: function() {
        return CS.messagesBox;
      },
      isStuck: function() {
        return !!CS.stickToBottom;
      },
      rawFallback: true
    });
    function captureScrollAnchor() {
      return chatScrollAnchor.capture();
    }
    function restoreScrollAnchor(anchor) {
      var box = CS.messagesBox;
      if (!box) return;
      if (CS.stickToBottom) {
        chatScrollAnchor.pinBottom();
        return;
      }
      anchorWroteSinceScroll = true;
      chatScrollAnchor.restore(anchor);
    }
    function syncDraftingIndicator() {
      if (!CS.messagesBox) return;
      if (CS.drafting && !CS.chatSettingsOpen) {
        if (!CS.draftingEl) {
          CS.draftingEl = h(
            "div",
            { class: "bq-message is-user bq-user-drafting", "aria-hidden": "true" },
            h("div", { class: "bq-bubble" }, h("span", { class: "bq-loader" }))
          );
        }
        CS.messagesBox.appendChild(CS.draftingEl);
      } else if (CS.draftingEl && CS.draftingEl.parentNode) {
        CS.draftingEl.parentNode.removeChild(CS.draftingEl);
      }
    }
    function chatStatusText() {
      if (session.state.signInNeeded) return "Sign in to see the latest answers.";
      if (session.state.reconnecting) return "Reconnecting...";
      return "";
    }
    function syncChatStatus() {
      var el = CS.chatStatusEl;
      if (!el) return;
      var text = CS.chatSettingsOpen ? "" : chatStatusText();
      if (el._bqText === text) return;
      el._bqText = text;
      clear(el);
      if (text) el.appendChild(h("span", { class: "bq-chat-status-inner", text }));
      el.hidden = !text;
    }
    function renderMessages() {
      syncStopIndexModal();
      syncChatStatus();
      var _lk = session.getLiveIndexState().keys || {};
      var _lc = 0;
      for (var _k in _lk) _lc++;
      if (CS._lastLiveKeyCount > 0 && _lc < CS._lastLiveKeyCount) void refreshIndexMarkers(true);
      CS._lastLiveKeyCount = _lc;
      if (!CS.messagesBox) return;
      if (CS.chatSettingsOpen) return;
      var anchor = captureScrollAnchor();
      clear(CS.messagesBox);
      CS.messageEls = [];
      if (CS.loadingOlderHistory) CS.messagesBox.appendChild(historyLoadingEl(false));
      else if (session.state.bgHistoryLoading) {
        CS.messagesBox.appendChild(h(
          "div",
          { class: "bq-history-loading" },
          h(
            "span",
            { class: "bq-history-loading-inner" },
            h("span", { text: "Loading indexing history" }),
            h("span", { class: "bq-loader" })
          )
        ));
      }
      CS.messagesBox.appendChild(buildGreetingEl());
      if (!CS.messages.length) {
        if (CS.loadingHistory && !CS.loadingOlderHistory) {
          CS.messagesBox.appendChild(historyLoadingEl(true));
          syncDraftingIndicator();
          restoreScrollAnchor(anchor);
          return;
        }
        var emptyStubEls = [];
        try {
          var emptyEntries = buildChatDisplayList([], displayListOptions());
          for (var ge = 0; ge < emptyEntries.length; ge++) {
            if (emptyEntries[ge].kind !== "indexing") continue;
            var sg = emptyEntries[ge].group;
            var stubEl = buildIndexGroupEl(sg, !!CS.indexGroupsOpen[sg.key]);
            stubEl.setAttribute("data-row-key", "g" + sg.runKey);
            stubEl.setAttribute("data-row-pos", indexGroupAnchorId(sg));
            emptyStubEls.push(stubEl);
          }
        } catch (e) {
        }
        for (var gse = 0; gse < emptyStubEls.length; gse++) CS.messagesBox.appendChild(emptyStubEls[gse]);
        syncDraftingIndicator();
        restoreScrollAnchor(anchor);
        return;
      }
      var rows = buildChatDisplayList(CS.messages, displayListOptions());
      try {
        if (markerSweep.svc === S.projectId) {
          var moSeen = S._mintObserved || (S._mintObserved = {});
          for (var moi = 0; moi < rows.length; moi++) {
            var moe = rows[moi];
            if (moe.kind !== "indexing" || moe.group.stub) continue;
            var mog = moe.group;
            if (!mog.path || !mog.finished || mog.status !== "done" || mog.resolving) continue;
            if (!(mog.driver === "single" || markerSweep.done[mog.path])) continue;
            var morec = markerSweep.runs[mog.path];
            if ((!morec || morec.status === "working") && !moSeen[mog.path]) {
              moSeen[mog.path] = true;
              var moFirst = mog.members && mog.members[0] && mog.members[0].msg && mog.members[0].msg._ts;
              var moLast = mog.members && mog.members.length && mog.members[mog.members.length - 1].msg && mog.members[mog.members.length - 1].msg._ts;
              var moPatch = { status: "done", finished: typeof moLast === "number" ? moLast : Date.now() };
              if (typeof moFirst === "number") moPatch.started = moFirst;
              if (mog.name) moPatch.filename = mog.name;
              if (S.aiPlatform === "claude" || S.aiPlatform === "openai") moPatch.platform = S.aiPlatform;
              upsertIndexRunRecordDb(S.projectId, mog.path, moPatch).catch(function() {
              });
              if (morec) morec.status = "done";
              else markerSweep.runs[mog.path] = { status: "done" };
            }
          }
        }
      } catch (e) {
      }
      rows.forEach(function(row) {
        if (row.kind === "indexing") {
          var isOpen = !!CS.indexGroupsOpen[row.group.key];
          var groupEl = buildIndexGroupEl(row.group, isOpen);
          groupEl.setAttribute("data-row-key", "g" + row.group.runKey);
          groupEl.setAttribute("data-row-pos", indexGroupAnchorId(row.group));
          CS.messagesBox.appendChild(groupEl);
          if (!isOpen) return;
          row.group.visibleMembers.forEach(function(member) {
            var pass = buildMessageEl(member.msg, member.index);
            pass.classList.add("bq-index-pass");
            pass.setAttribute("data-row-key", rowAnchorKey(member.msg, member.index));
            CS.messageEls[member.index] = pass;
            CS.messagesBox.appendChild(pass);
          });
          if (!row.group.finished && !row.group.resolving && row.group.status !== "cancelled") {
            CS.messagesBox.appendChild(h("div", {
              class: "bq-index-pass bq-index-tail",
              "aria-hidden": "true"
            }, h("span", { class: "bq-loader" })));
          }
          return;
        }
        var el = buildMessageEl(row.msg, row.index);
        el.setAttribute("data-row-key", rowAnchorKey(row.msg, row.index));
        CS.messageEls[row.index] = el;
        CS.messagesBox.appendChild(el);
      });
      syncDraftingIndicator();
      hydrateMessageImagePreviews();
      restoreScrollAnchor(anchor);
    }
    function refreshMessageBubble(idx) {
      if (idx < 0 || idx >= CS.messages.length) return;
      var oldEl = CS.messageEls[idx];
      if (!oldEl || !oldEl.parentNode) return;
      anchorWroteSinceScroll = true;
      chatScrollAnchor.preserve(function() {
        var newEl = buildMessageEl(CS.messages[idx], idx);
        if (oldEl.classList.contains("bq-index-pass")) newEl.classList.add("bq-index-pass");
        oldEl.parentNode.replaceChild(newEl, oldEl);
        CS.messageEls[idx] = newEl;
        hydrateMessageImagePreviews();
      });
    }
    function renderChat() {
      primeProjectSettings(S.projectId);
      (function(openedFor) {
        readyProjectSettings(openedFor).then(function() {
          if (S.projectId === openedFor) refreshGreetingEl();
        });
      })(S.projectId);
      clearImagePreviewCache(S.projectId || "default");
      chatScrollAnchor.forget();
      for (var uk in unavailableLinkMap) delete unavailableLinkMap[uk];
      var prevMessages = CS.messages || [];
      CS.messages = [];
      CS.messageEls = [];
      CS.indexGroupsOpen = {};
      CS.sending = false;
      CS.typing = false;
      CS.typingAbort = true;
      CS.drafting = false;
      CS.draftingEl = null;
      CS.historyEndOfList = false;
      CS.historyStartKeyHistory = [];
      CS.stickToBottom = true;
      CS.attachments = [];
      CS.uploadingAttachments = false;
      CS.attachmentWarning = "";
      CS.attachmentCapNotice = "";
      CS.attachmentCancelNotice = "";
      CS.attachmentsRow = null;
      CS.attachBtnEl = null;
      CS.sendBtnEl = null;
      CS.inputEl = null;
      CS.chatEl = null;
      CS.visibleAttachmentCount = Infinity;
      CS.chatSettingsOpen = false;
      CS.settingsBtnEl = null;
      CS.composerEl = null;
      CS.chatStatusEl = null;
      CS.gateRefreshToken += 1;
      if (CS.pollTimer) {
        clearInterval(CS.pollTimer);
        CS.pollTimer = null;
      }
      render("chat", function() {
        var settingsBtn = h("button", {
          class: "bq-icon-btn",
          type: "button",
          title: "Settings",
          "aria-label": "Settings",
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
          onclick: function() {
            toggleChatSettings();
          }
        });
        CS.settingsBtnEl = settingsBtn;
        var headerRight = isAnonymousSession() ? S.opts.showLogin === false ? null : h("button", {
          class: "bq-link",
          type: "button",
          title: "Login",
          onclick: function() {
            renderLogin();
          },
          text: "Login"
        }) : settingsBtn;
        if (isAnonymousSession()) CS.settingsBtnEl = null;
        var header = h(
          "div",
          { class: "bq-section-title" },
          h(
            "div",
            { class: "bq-title-row" },
            brandTitleEl(),
            h("div", { class: "bq-title-right" }, headerRight)
          )
        );
        var chatArea;
        if (S.aiPlatform === "none") {
          chatArea = h(
            "div",
            { class: "bq-chat" },
            h(
              "div",
              { class: "bq-disabled-overlay" },
              h(
                "div",
                { class: "bq-disabled-inner" },
                h("div", { text: "This chat isn't available yet \u2014 the project admin hasn't set up an AI agent." })
              )
            )
          );
          return h("div", { class: "bq-meta" }, header, chatArea);
        }
        var box = h("div", { class: "bq-messages" });
        box.addEventListener("scroll", onHistoryScroll, { passive: true });
        box.addEventListener("wheel", onMessagesWheel, { passive: true });
        box.addEventListener("touchstart", onMessagesTouchStart, { passive: true });
        box.addEventListener("touchmove", onMessagesTouchMove, { passive: true });
        box.addEventListener("load", onMessagesImageSettled, true);
        box.addEventListener("error", onMessagesImageSettled, true);
        if (document.fonts && document.fonts.addEventListener) {
          document.fonts.addEventListener("loadingdone", onMessagesFontsSettled);
        }
        CS.messagesBox = box;
        var input = h("textarea", { class: "bq-input", rows: "1", placeholder: composerPlaceholder() });
        CS.inputEl = input;
        var composing = false;
        input.addEventListener("compositionstart", function() {
          composing = true;
        });
        input.addEventListener("compositionend", function() {
          composing = false;
        });
        input.addEventListener("input", function() {
          autoGrowInput(input);
          var prev = CS.attachmentWarning;
          recomputeAttachmentWarning();
          updateComposerControls();
          if (CS.attachmentWarning !== prev) {
            renderAttachmentChips();
            scheduleAttachmentOverflowRecompute();
          }
          var drafting = !!input.value.trim();
          if (drafting !== CS.drafting) {
            CS.drafting = drafting;
            syncDraftingIndicator();
            scrollToBottomIfSticky();
          }
        });
        input.addEventListener("keydown", function(e) {
          if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
          if (composing || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          sendMessage();
        });
        requestAnimationFrame(function() {
          autoGrowInput(input);
        });
        var attachDisabled = uploadsFrozenForUser();
        if (attachDisabled) input.classList.add("bq-input--noattach");
        var attachFileInput = null, attachBtn = null;
        if (!attachDisabled) {
          attachFileInput = h("input", { class: "bq-attach-input", type: "file", multiple: "multiple" });
          attachFileInput.addEventListener("change", function() {
            onAttachInputChange(attachFileInput);
          });
          attachBtn = h("button", { class: "bq-attach-btn", type: "button", title: "Attach files", html: ATTACH_ICON_SVG });
          attachBtn.addEventListener("click", function() {
            attachFileInput.click();
          });
          CS.attachBtnEl = attachBtn;
        }
        var attachmentsRow = h("div", { class: "bq-attachments" });
        attachmentsRow.style.display = "none";
        CS.attachmentsRow = attachmentsRow;
        var sendBtn = h("button", { class: "btn", type: "submit" }, "Send");
        CS.sendBtnEl = sendBtn;
        var composer = h(
          "form",
          { class: "bq-input-row", onsubmit: function(e) {
            e.preventDefault();
            sendMessage();
          } },
          attachmentsRow,
          h("div", { class: "bq-input-wrap" }, attachBtn, attachFileInput, input),
          sendBtn
        );
        var chatStatus = h("div", { class: "bq-chat-status", role: "status", "aria-live": "polite" });
        chatStatus.hidden = true;
        CS.chatStatusEl = chatStatus;
        chatArea = h("div", { class: "bq-chat" }, box, chatStatus, composer);
        CS.chatEl = chatArea;
        CS.composerEl = composer;
        syncChatStatus();
        updateComposerControls();
        if (!attachDisabled) setupDragAndDrop(chatArea);
        return h("div", { class: "bq-meta" }, header, chatArea);
      });
      if (S.aiPlatform === "none") return;
      void refreshIndexMarkers();
      loadMarked().then(function() {
        renderMessages();
        var cacheKey2 = session.getHistoryCacheKey();
        var loaded = session.aiChatHistoryCache && session.aiChatHistoryCache[cacheKey2];
        if (loaded) {
          var restored = session.settleDeadStagedMessages(loaded.messages || []).filter(function(m) {
            return m && (m._ownerKey === void 0 || m._ownerKey === cacheKey2);
          }).map(function(m) {
            return m.role === "user" ? Object.assign({}, m, { content: sanitizeAttachmentLinksForHistory(m.content) }) : m;
          });
          var cachedStageIds = {};
          restored.forEach(function(m) {
            if (m._stageId) cachedStageIds[m._stageId] = true;
          });
          var stagedLive = prevMessages.filter(function(m) {
            return m && m._stageId && !cachedStageIds[m._stageId] && (m._ownerKey === void 0 || m._ownerKey === cacheKey2);
          });
          CS.messages = restored.concat(stagedLive);
          CS.historyEndOfList = !!loaded.endOfList;
          CS.historyStartKeyHistory = Array.isArray(loaded.startKeyHistory) ? loaded.startKeyHistory.slice() : [];
          session.aiChatHistoryCache[cacheKey2] = Object.assign({}, loaded, { messages: restored });
          renderMessages();
          scrollToBottom();
        }
        session.noteViewOpened();
        return session.loadHistory(false, CS.gateRefreshToken);
      }).then(function() {
      });
    }
    function openModal(builder, opts) {
      var dismissible = !(opts && opts.dismissible === false);
      var root = h("div", { class: "bq-modal-root", "data-bq-theme": S.theme });
      var backdrop = h("div", { class: "bq-modal-backdrop" });
      var close = function() {
        if (root.parentNode) root.parentNode.removeChild(root);
      };
      if (dismissible) backdrop.addEventListener("click", close);
      root.appendChild(backdrop);
      root.appendChild(builder(close));
      document.body.appendChild(root);
      return { root, close };
    }
    var overwriteState = { resolver: null, sticky: null, handle: null, applyToAll: false };
    function resetOverwriteBatch() {
      overwriteState.sticky = null;
      overwriteState.applyToAll = false;
    }
    function chooseOverwrite(choice) {
      if (overwriteState.applyToAll) overwriteState.sticky = choice;
      if (overwriteState.handle) {
        overwriteState.handle.close();
        overwriteState.handle = null;
      }
      var r = overwriteState.resolver;
      overwriteState.resolver = null;
      if (r) r(choice);
    }
    var accessGroupState = { resolver: null, sticky: null, handle: null, applyToAll: false, choice: "authorized", perPath: {} };
    function resetAccessGroupBatch() {
      accessGroupState.sticky = null;
      accessGroupState.applyToAll = false;
      accessGroupState.perPath = {};
    }
    function chooseAccessGroup(choice) {
      var picked = normalizeUploadAccessGroup(choice);
      if (accessGroupState.applyToAll) accessGroupState.sticky = picked;
      if (accessGroupState.handle) {
        accessGroupState.handle.close();
        accessGroupState.handle = null;
      }
      var r = accessGroupState.resolver;
      accessGroupState.resolver = null;
      if (r) r(picked);
    }
    var accessGroupChain = Promise.resolve();
    function resolveUploadAccessGroup(storagePath) {
      return readyProjectSettings(S.projectId).then(function() {
        return decideUploadAccessGroup(storagePath);
      });
    }
    function decideUploadAccessGroup(storagePath) {
      var svc = S.projectId;
      if (!projectAsksUploadAccess(svc)) return Promise.resolve(projectUploadAccessGroup(svc));
      var fallback = projectUploadAccessGroup(svc);
      if (accessGroupState.sticky) return Promise.resolve(accessGroupState.sticky);
      var pathKey = String(storagePath || "");
      if (pathKey && accessGroupState.perPath[pathKey]) {
        return Promise.resolve(accessGroupState.perPath[pathKey]);
      }
      var run = accessGroupChain.then(function() {
        if (accessGroupState.sticky) return accessGroupState.sticky;
        if (pathKey && accessGroupState.perPath[pathKey]) {
          return accessGroupState.perPath[pathKey];
        }
        accessGroupState.applyToAll = false;
        accessGroupState.choice = fallback;
        var filename = String(storagePath || "").split("/").pop() || "this file";
        return new Promise(function(resolve) {
          accessGroupState.resolver = resolve;
          accessGroupState.handle = openModal(function() {
            var list = h("div", { class: "bq-access-options" });
            UPLOAD_ACCESS_GROUPS.forEach(function(g) {
              var input = h("input", { type: "radio", name: "bq-access-group", value: g });
              input.checked = g === accessGroupState.choice;
              input.addEventListener("change", function() {
                if (input.checked) accessGroupState.choice = g;
              });
              list.appendChild(h(
                "label",
                { class: "bq-access-option" },
                input,
                h("span", { class: "bq-access-option-label", text: UPLOAD_ACCESS_LABELS[g] }),
                h("span", { class: "bq-access-option-hint", text: UPLOAD_ACCESS_HINTS[g] })
              ));
            });
            var applyCb = h("input", { type: "checkbox" });
            applyCb.addEventListener("change", function() {
              accessGroupState.applyToAll = !!applyCb.checked;
            });
            var applyLabel = h(
              "label",
              { class: "bq-overwrite-applyall" },
              applyCb,
              h("span", { text: "Apply to all remaining files" })
            );
            return h(
              "div",
              { class: "bq-modal" },
              h("div", { class: "bq-modal-delete-header" }, h("span", { text: "Who can read this file?" })),
              h(
                "p",
                { class: "bq-modal-desc" },
                "Choose who can ask questions about \u201C" + filename + "\u201D once it is indexed."
              ),
              list,
              applyLabel,
              h(
                "div",
                { class: "bq-modal-btns" },
                h("button", { class: "btn", type: "button", onclick: function() {
                  chooseAccessGroup(accessGroupState.choice);
                } }, "Upload")
              )
            );
          }, { dismissible: false });
        });
      });
      accessGroupChain = run.catch(function() {
        return void 0;
      });
      return run.then(function(picked) {
        var g = normalizeUploadAccessGroup(picked);
        if (pathKey) accessGroupState.perPath[pathKey] = g;
        return g;
      }).catch(function() {
        return fallback;
      });
    }
    function promptOverwrite(filename) {
      if (overwriteState.sticky) return Promise.resolve(overwriteState.sticky);
      overwriteState.applyToAll = false;
      return new Promise(function(resolve) {
        overwriteState.resolver = resolve;
        overwriteState.handle = openModal(function() {
          var applyCb = h("input", { type: "checkbox" });
          applyCb.addEventListener("change", function() {
            overwriteState.applyToAll = !!applyCb.checked;
          });
          var applyLabel = h(
            "label",
            { class: "bq-overwrite-applyall" },
            applyCb,
            h("span", { text: "Apply to all remaining files" })
          );
          return h(
            "div",
            { class: "bq-modal" },
            h("div", { class: "bq-modal-delete-header" }, h("span", { text: "File already exists" })),
            h(
              "p",
              { class: "bq-modal-desc" },
              "A file named \u201C" + filename + "\u201D already exists. Skip it, keep the existing file and just reindex it, or overwrite it completely?"
            ),
            h("p", { class: "bq-modal-desc", text: "Re-indexing also removes everything search has learned about this file from people's questions and corrections." }),
            applyLabel,
            h(
              "div",
              { class: "bq-modal-btns" },
              h("button", { class: "btn btn--outline", type: "button", onclick: function() {
                chooseOverwrite("skip");
              } }, "Skip"),
              h("button", { class: "btn btn--outline", type: "button", onclick: function() {
                chooseOverwrite("reindex");
              } }, "Reindex only"),
              h("button", { class: "btn btn--danger", type: "button", onclick: function() {
                chooseOverwrite("overwrite");
              } }, "Overwrite")
            )
          );
        }, { dismissible: false });
      });
    }
    function showUploadErrorReport(groups, duplicates) {
      groups = groups || [];
      duplicates = duplicates || [];
      if (!groups.length && !duplicates.length) return;
      var totalFiles = groups.reduce(function(n, g) {
        return n + g.files.length;
      }, 0);
      var title = totalFiles ? totalFiles === 1 ? "1 file could not be added" : totalFiles + " files could not be added" : duplicates.length === 1 ? "1 file was already uploaded" : duplicates.length + " files were already uploaded";
      var reindexing = false;
      var handle = openModal(function(close) {
        var body = [];
        if (groups.length) {
          body.push(h("p", { class: "bq-modal-desc", text: "These files were not added to your message. They stay in the attachment row so you can remove or retry them." }));
          body.push(h("div", { class: "bq-upload-error-list" }, groups.map(function(g) {
            var heading = g.code ? g.code + ": " + g.message : g.message;
            return h(
              "div",
              { class: "bq-upload-error-group" },
              h("p", { class: "bq-upload-error-heading", text: heading }),
              h(
                "ul",
                { class: "bq-upload-error-files" },
                g.files.map(function(name) {
                  return h("li", { text: name, translate: "no" });
                })
              )
            );
          })));
        }
        var closeBtn = h("button", { class: "btn btn--outline", type: "button", onclick: function() {
          if (!reindexing) close();
        } }, "Close");
        var reindexBtn = null;
        if (duplicates.length) {
          body.push(h("p", { class: "bq-modal-desc", text: "This account had already uploaded these files, with the same name and size. The stored copy was attached to your message; nothing was uploaded or indexed again." }));
          body.push(h(
            "div",
            { class: "bq-upload-error-list" },
            h(
              "div",
              { class: "bq-upload-error-group" },
              h("p", { class: "bq-upload-error-heading", text: "already uploaded (same name and size)" }),
              h(
                "ul",
                { class: "bq-upload-error-files" },
                duplicates.map(function(d) {
                  return h("li", { text: d.label, translate: "no" });
                })
              )
            )
          ));
          body.push(h("p", { class: "bq-modal-desc", text: `To index the stored copies again, choose Reindex. Re-indexing also removes everything search has learned about this file from people's questions and corrections. To upload such files again instead, turn off "Skip duplicate files" in the project settings.` }));
          reindexBtn = h("button", { class: "btn", type: "button", onclick: function() {
            if (reindexing) return;
            reindexing = true;
            reindexBtn.disabled = true;
            closeBtn.disabled = true;
            reindexBtn.textContent = "Reindexing...";
            session.reindexStoredFiles(duplicates).then(function() {
              close();
            });
          } }, "Reindex");
        }
        return h(
          "div",
          { class: "bq-modal" },
          h("div", { class: "bq-modal-delete-header" }, h("span", { text: title })),
          body,
          h("div", { class: "bq-modal-btns" }, closeBtn, reindexBtn)
        );
      });
      return handle;
    }
    function parseAiAgentValue2(value) {
      var raw = (value || "").trim();
      var platform = raw, model = "";
      if (raw.indexOf("#") !== -1) {
        var parts = raw.split("#");
        platform = parts[0];
        model = parts[1] || "";
      }
      var normalized = platform === "claude" || platform === "openai" ? platform : "none";
      return { raw, platform: normalized, model, hasPlatform: normalized !== "none" };
    }
    function applyAgentConfig() {
      var conn = S.service || {};
      var raw = conn.ai_agent || "";
      var parsed = parseAiAgentValue2(raw);
      S.aiPlatform = parsed.platform;
      S.aiModel = parsed.model;
      setProjectContextWindow(S.projectId, parseAiAgentValue(raw).contextWindow);
      S.serviceName = conn.service_name || "";
      S.serviceDescription = conn.service_description || "";
    }
    function logout() {
      showLoading();
      clearStoredMcpToken();
      Promise.resolve().then(function() {
        return S.skapi.logout();
      }).catch(function() {
      }).then(function() {
        S.user = null;
        if (anonymousAllowed()) return enterAfterLogin();
        renderLogin();
      });
    }
    function enterAfterLogin() {
      showLoading();
      return Promise.resolve().then(function() {
        return S.user ? S.user : getProfile().then(function(u) {
          S.user = u;
          return u;
        });
      }).then(function(u) {
        if (u && session && session.noteSignedIn) session.noteSignedIn();
      }).then(function() {
        return loadServiceInfo();
      }).then(function(conn) {
        if (conn) S.service = conn;
        applyAgentConfig();
      }).then(function() {
        renderChat();
      }).catch(function(err) {
        console.error("[bunnyquery] enterAfterLogin failed", err);
        renderChat();
      });
    }
    function boot() {
      showLoading();
      return loadServiceInfo().then(function(conn) {
        if (conn) {
          S.service = conn;
          applyAgentConfig();
        }
      }).catch(function() {
      }).then(bootFlow);
    }
    function bootFlow() {
      if (isInboundPlatformOAuth()) {
        stashInboundPlatformOAuth();
        return getProfile().then(function(user) {
          S.user = user;
          if (user) {
            returnOAuthToMCP();
            return;
          }
          renderLogin();
        });
      }
      if (isGoogleOAuthReturn()) {
        return completeGoogleOAuthReturn().then(function() {
          var st = getQueryParam("state");
          if (st && ssGet("oauth:" + st)) {
            returnOAuthToMCP();
            return;
          }
          cleanUrl();
          return beginMcpOAuthOnLogin("chat");
        }).catch(function(err) {
          console.error("[bunnyquery] Google OAuth return failed", err);
          cleanUrl();
          renderLogin();
        });
      }
      if (isMcpOAuthCallback()) {
        return completeMcpAuthorize().then(function() {
          cleanUrl();
          return enterAfterLogin();
        }).catch(function(err) {
          console.error("[bunnyquery] MCP OAuth token exchange failed", err);
          cleanUrl();
          return enterAfterLogin();
        });
      }
      if (getQueryParam("code") || getQueryParam("oauth")) cleanUrl();
      return getProfile().then(function(user) {
        S.user = user;
        if (!user) {
          if (anonymousAllowed()) return enterAfterLogin();
          renderLogin();
          return;
        }
        if (mcpGrantNeedsRefresh(user)) {
          return syncMcpSession().then(function(synced) {
            if (synced && !mcpGrantNeedsRefresh(user)) return enterAfterLogin();
            return refreshMcpToken().then(function(tok) {
              if (tok && !mcpGrantNeedsRefresh(user)) return enterAfterLogin();
              return beginMcpOAuthOnLogin("chat").catch(function(err) {
                console.error("[bunnyquery] MCP refresh failed", err);
                return enterAfterLogin();
              });
            });
          });
        }
        syncMcpSession();
        return enterAfterLogin();
      });
    }
    function init(skapi, target, opts) {
      if (S.booted) {
        console.warn("[bunnyquery] already initialised");
        return PUBLIC;
      }
      if (!skapi) throw new Error("BunnyQuery.init: a Skapi instance is required");
      if (!skapiHasForwardRequest(skapi)) {
        throw new Error("BunnyQuery.init: this page's skapi-js is too old (it has no forwardRequest / forwardRequestHistory). Load skapi-js 2.1.0 or newer, e.g. https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js");
      }
      var mountEl = typeof target === "string" ? document.getElementById(target) : target;
      if (!mountEl) throw new Error("BunnyQuery.init: mount element not found: " + target);
      S.skapi = skapi;
      S.opts = Object.assign({
        theme: "light",
        // Header title. null keeps "BunnyQuery \u00b7 <project name>"; a string
        // replaces the whole line, "" hides it. See brandTitleText.
        title: null,
        // Placeholder in the chat composer. null keeps
        // "Ask anything about: <project name>".
        inputPlaceholder: null,
        // Whether an ANONYMOUS visitor is offered a Login button in the chat
        // header. Only ever shown to a signed-out visitor in the first place
        // (a signed-in user gets the settings gear there), so this turns that
        // one affordance off for an embed that does its own auth, or that
        // does not want visitors making accounts at all. Signed-in users are
        // unaffected either way.
        showLogin: true,
        // Image for the little face on assistant chat bubbles. Any CSS image
        // url value (an https url or a data: uri). null keeps the bundled
        // bunny. Applied as the --bq-bubble-face custom property, which
        // chat.css reads with the default as its fallback.
        bubbleFace: null,
        signup: false,
        // include signup (and thus delete/recover account)
        dev: false,
        // use the MCP dev host (mcp.broadwayinc.computer)
        mcpBaseUrl: null,
        // override the MCP OAuth server base entirely
        googleClientId: null,
        googleClientSecretName: "ggl",
        signupConfirmationUrl: null,
        // defaults to current host page
        hostDomain: null,
        // db-CDN host; null → skapi.app (dev) / skapi.com (prod)
        attachmentParsers: null,
        // client-side attachment parsers, e.g. [createHwpParser()]
        // Open the chat with no login for visitors without an account.
        // null → follow the project's own "Allow anonymous users" setting
        // (getConnectionInfo().conf.require_login); true/false pins it.
        allowAnonymous: null,
        // Whether the chat's answers may reach the open web (Claude web_fetch,
        // OpenAI web_search). null = follow the project's own "Web access for
        // answers" setting on its Project Settings page (`web_access` in the
        // bq::settings record), which is off unless the owner turned it on;
        // true/false pins it for this page, both ways. Read at
        // configureChatEngine time and when each chat request is built.
        webAccess: null,
        // Whether a chat attachment the signed-in user ALREADY uploaded to this
        // project (same file name, same size, same uploader) is skipped: not
        // uploaded again, not indexed again, the message using the stored
        // copy. null = follow the project's own "Skip duplicate files" setting
        // (`skip_duplicate_files` in the bq::settings record), which is ON
        // unless the owner turned it off. The project setting is the ceiling:
        // false here restricts below it for this page, true has no effect on
        // a project that turned it off.
        skipDuplicateFiles: null,
        // Reuse the MCP tool listing OpenAI returned on an earlier chat turn, so
        // OpenAI skips fetching it again (about 0.6 s per turn). On unless false
        // (verified live on dev 2026-11-25). See configureChatEngine `reuseMcpToolList`.
        reuseMcpToolList: true,
        // Server-driven windowed indexing; read at configureChatEngine time.
        // Listed here so the defaults object is the full opt surface.
        windowedIndexing: true,
        // The worker writes the ending of a file read in one pass (an image); see the
        // engine's configureChatEngine `workerIndexEndings`. Opt-in until every region's
        // worker carries it.
        workerIndexEndings: false,
        // Deliver the streamed reply over skapi's WEBSOCKET as well as the poll.
        // OFF unless the embedder asks, because this widget runs on someone else's
        // page with someone else's skapi instance: skapi's joinRealtime REPLACES
        // the connection's group rather than adding to it, so for the length of a
        // turn this would take the room out from under whatever the host app uses
        // realtime for, and the host would see its own messages simply stop. Only
        // an embedder who knows their app does not use realtime (or does not mind)
        // can answer that, so only they can turn it on. Purely an accelerator: with
        // it off the reply still streams, on the poll's cadence.
        // Streaming itself is not an option: the widget streams whenever the page's
        // skapi-js can (see canStream in init) and buffers, with a warning, when it
        // cannot. Before 1.16.0 this key meant "stream at all" and the socket was
        // `liveStreamingRealtime`; that name is now ignored.
        liveStreaming: false,
        // Request STATUS PUSH (engine ChatEngineConfig.statusPush): indexing passes are
        // dispatched with `notify`, their polls slow down to a heartbeat while status
        // frames arrive on skapi's websocket, and the chat catches up when the socket
        // comes back. OFF unless the embedder asks, for the same reason as
        // `liveStreaming`: it keeps a websocket open on the host page's skapi instance.
        // Needs skapi-js 2.5.0 or newer on the page; an older one leaves it off.
        statusPush: false
      }, opts || {});
      S.mountEl = mountEl;
      clear(mountEl);
      S.root = h("div", { class: "bq-agent" });
      mountEl.appendChild(S.root);
      if (typeof S.opts.bubbleFace === "string" && S.opts.bubbleFace) {
        S.root.style.setProperty("--bq-bubble-face", 'url("' + S.opts.bubbleFace.replace(/"/g, '\\"') + '")');
      }
      applyTheme(loadTheme());
      S.booted = true;
      console.log("[bunnyquery] v" + BQ_VERSION);
      var canStream = skapiSupportsStreaming(S.skapi);
      if (!canStream) {
        console.warn(
          "[bunnyquery] this page's skapi-js has no forwardRequestStream/forwardRequestFinalize, so skapi's half of the stream flag would be dropped and every reply would read back empty. Replies are buffered - update skapi-js to stream them."
        );
      }
      configureProjectSettings(function(service) {
        if (!S.skapi || typeof S.skapi.getRecords !== "function") return Promise.resolve(null);
        return Promise.resolve(S.skapi.getRecords({ service, unique_id: PROJECT_SETTINGS_UNIQUE_ID })).then(function(res) {
          var rec = res && res.list && res.list[0] || null;
          return rec && rec.data || null;
        });
      });
      configureChatEngine(Object.assign({
        // Single-item csr-poll point lookup: how the engine hydrates a
        // compact history stub's real body when an indexing row expands.
        // A document's page progress, the MCP's prog::<path> record (agent.vue same).
        // A file's indexing pass ids, from the "pass::<path>#<id>" records the worker
        // writes as each pass starts (agent.vue same).
        listIndexPasses: function(service, storagePath) {
          var prefix = "pass::" + storagePath + "#";
          var ids = [], seen = {};
          var page = function(fetchMore) {
            return Promise.resolve(S.skapi.getUniqueId(
              { service, unique_id: prefix, condition: ">=" },
              { fetchMore, limit: 1e3 }
            )).then(function(found) {
              var list = found && found.list || [];
              for (var i = 0; i < list.length; i++) {
                var u = String(list[i] && list[i].unique_id || "");
                if (u.indexOf(prefix) !== 0) continue;
                var rid = u.slice(prefix.length);
                if (!/^[0-9A-V]{13}:[0-9A-V]{13}$/.test(rid) || seen[rid]) continue;
                seen[rid] = true;
                ids.push(rid);
              }
              if (found && found.endOfList === false && list.length) return page(true);
              return ids;
            });
          };
          return page(false);
        },
        readIndexProgress: function(service, storagePath) {
          return S.skapi.getRecords({ service, unique_id: "prog::" + storagePath }).then(function(found) {
            return found && found.list && found.list[0] && found.list[0].data || null;
          });
        },
        csrHistoryItemLookup: function(fullId, service, owner) {
          var signedIn = !!(S.skapi && S.skapi.session);
          return S.skapi.util.request("csr-poll", { id: fullId, service, owner }, { auth: signedIn });
        },
        // Durable index markers. Both read S lazily at call time — S.skapi /
        // S.projectId are not set yet when init() runs.
        // Both return the write's promise: a failed write rejects, and the engine
        // writes it again under its settle lock.
        mintIndexDoneMarker: function(info) {
          return mintIndexDoneMarkerDb(info.service, info.storagePath);
        },
        upsertIndexRunRecord: function(info) {
          return upsertIndexRunRecordDb(info.service, info.storagePath, info.patch);
        },
        mcpBaseUrl: mcpBaseUrl(),
        poll: 0,
        // Server-driven windowed indexing. Off by default in the engine because the
        // worker must strip `_skapi_window` first, or the provider rejects the whole
        // call with no retry. `apply_file_windows` is deployed in every region
        // (verified 2026-07-27 against the deployed ClientSecretKeyPollingWorker in
        // all 7), so the widget now opts in like agent.vue does. Without it the
        // widget fell back to the client-driven CONTINUE loop capped at
        // MAX_INDEXING_RESUME_PASSES, which needs the tab kept open and stops early
        // on a big file. Pass windowedIndexing: false in init opts to opt back out.
        windowedIndexing: S.opts.windowedIndexing !== false,
        // single-pass files: the worker writes their done:: / run:: (opt-in, see defaults)
        workerIndexEndings: S.opts.workerIndexEndings === true,
        // Client-side attachment parsers (e.g. an .hwp parser) passed via init opts.
        attachmentParsers: S.opts.attachmentParsers || void 0,
        // Web access for chat answers. Handed over ONLY when the embedder
        // pinned it: an undefined here means "ask the project", and the engine
        // then reads the project's `web_access` setting when it builds each
        // chat request (off unless the owner turned it on). Passing the null
        // default through would read as a decision.
        webAccess: typeof S.opts.webAccess === "boolean" ? S.opts.webAccess : void 0,
        // Skip duplicate uploads. Same hand-over rule: only a pinned boolean is
        // passed, and the project's setting is the ceiling the engine applies.
        skipDuplicateFiles: typeof S.opts.skipDuplicateFiles === "boolean" ? S.opts.skipDuplicateFiles : void 0,
        // OpenAI MCP tool-list reuse across chat turns: on unless an explicit false.
        reuseMcpToolList: S.opts.reuseMcpToolList !== false,
        // ---- live streaming (mirrored in agent.vue's ai_agent.ts) --------
        // Streaming itself is not passed: the engine streams whenever the two
        // hooks below are handed over, which skapiEngineTransport does only when
        // canStream. What the embedder chooses is the socket: `liveStreaming` here
        // is the engine's socket-delivery key. ANDed with canStream so a page whose
        // SDK cannot stream never asks for a socket on a buffered reply.
        liveStreaming: canStream && S.opts.liveStreaming === true,
        // ---- request status push (mirrored in agent.vue's ai_agent.ts) ----
        // Only an explicit true, and only when the page's skapi-js has the hooks
        // (2.5.0 or newer); the engine then does nothing different without them.
        statusPush: S.opts.statusPush === true && !!S.skapi && typeof S.skapi.onRequestStatus === "function",
        onRequestStatus: S.skapi && typeof S.skapi.onRequestStatus === "function" ? S.skapi.onRequestStatus.bind(S.skapi) : void 0,
        isRequestStatusLive: S.skapi && typeof S.skapi.isRequestStatusLive === "function" ? S.skapi.isRequestStatusLive.bind(S.skapi) : void 0
        // The transport: dispatch and history, plus the finalize hook that stores
        // a streamed turn's kept version and the chunk reader that is the second
        // half of the durability guarantee. The two optional hooks are handed
        // over only when canStream says the SDK has them. skapiEngineTransport
        // says what each one is for, and picks the family.
      }, skapiEngineTransport(canStream)));
      if (!S._resizeBound && typeof window !== "undefined" && window.addEventListener) {
        S._resizeBound = true;
        window.addEventListener("resize", function() {
          scheduleAttachmentOverflowRecompute();
          scrollToBottomIfSticky();
          ensureHistoryFillsViewport();
        });
      }
      if (!S._visBound && typeof document !== "undefined" && document.addEventListener) {
        S._visBound = true;
        document.addEventListener("visibilitychange", function() {
          if (document.visibilityState === "hidden") {
            if (session && session.pausePolling) session.pausePolling("hidden");
            return;
          }
          if (document.visibilityState === "visible") {
            if (session && session.reconcileNow) void session.reconcileNow("visible");
            if (session && session.resumePolling) void session.resumePolling("hidden");
            if (S.user && mcpGrantNeedsRefresh(S.user)) {
              Promise.resolve().then(ensureMcpGrantFresh).catch(function() {
              });
            }
          }
        });
      }
      if (!S._loginBound && S.skapi) {
        var loginListeners = null;
        try {
          loginListeners = S.skapi.onLogin;
        } catch (e) {
          loginListeners = null;
        }
        if (Array.isArray(loginListeners)) {
          S._loginBound = true;
          try {
            S.skapi.onLogin = function(u) {
              if (u && session && session.noteSignedIn) session.noteSignedIn();
            };
          } catch (e) {
          }
        }
      }
      boot();
      return PUBLIC;
    }
    var PUBLIC = {
      init,
      // Register a client-side attachment parser (e.g. createHwpParser()) so the
      // widget parses matching uploads in-browser and sends the text for indexing.
      // Can be called before or after init(); also settable via init opts.attachmentParsers.
      registerAttachmentParser,
      setTheme: function(t) {
        applyTheme(t);
      },
      toggleTheme,
      logout,
      version: BQ_VERSION,
      _state: S
      // exposed for later-phase modules / debugging
    };
    if (typeof window !== "undefined") {
      window.BunnyQuery = PUBLIC;
    }
  })();

})();
