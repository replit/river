// python-client/tests/test_server_handshake.ts
import http from "node:http";
import { WebSocketServer } from "ws";

// node_modules/nanoid/index.js
import { webcrypto as crypto } from "node:crypto";
var POOL_SIZE_MULTIPLIER = 128;
var pool;
var poolOffset;
function fillPool(bytes) {
  if (!pool || pool.length < bytes) {
    pool = Buffer.allocUnsafe(bytes * POOL_SIZE_MULTIPLIER);
    crypto.getRandomValues(pool);
    poolOffset = 0;
  } else if (poolOffset + bytes > pool.length) {
    crypto.getRandomValues(pool);
    poolOffset = 0;
  }
  poolOffset += bytes;
}
function random(bytes) {
  fillPool(bytes |= 0);
  return pool.subarray(poolOffset - bytes, poolOffset);
}
function customRandom(alphabet2, defaultSize, getRandom) {
  let mask = (2 << 31 - Math.clz32(alphabet2.length - 1 | 1)) - 1;
  let step = Math.ceil(1.6 * mask * defaultSize / alphabet2.length);
  return (size = defaultSize) => {
    let id = "";
    while (true) {
      let bytes = getRandom(step);
      let i = step;
      while (i--) {
        id += alphabet2[bytes[i] & mask] || "";
        if (id.length >= size) return id;
      }
    }
  };
}
function customAlphabet(alphabet2, size = 21) {
  return customRandom(alphabet2, size, random);
}

// transport/id.ts
var alphabet = customAlphabet(
  "1234567890abcdefghijklmnopqrstuvxyzABCDEFGHIJKLMNOPQRSTUVXYZ"
);
var generateId = () => alphabet(12);

// transport/connection.ts
var Connection = class {
  id;
  telemetry;
  constructor() {
    this.id = `conn-${generateId()}`;
  }
  get loggingMetadata() {
    const metadata = { connId: this.id };
    if (this.telemetry?.span.isRecording()) {
      const spanContext = this.telemetry.span.spanContext();
      metadata.telemetry = {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId
      };
    }
    return metadata;
  }
  dataListener;
  closeListener;
  errorListener;
  onData(msg) {
    this.dataListener?.(msg);
  }
  onError(err) {
    this.errorListener?.(err);
  }
  onClose() {
    this.closeListener?.();
    this.telemetry?.span.end();
  }
  /**
   * Set the callback for when a message is received.
   * @param cb The message handler callback.
   */
  setDataListener(cb) {
    this.dataListener = cb;
  }
  removeDataListener() {
    this.dataListener = void 0;
  }
  /**
   * Set the callback for when the connection is closed.
   * This should also be called if an error happens and after notifying the error listener.
   * @param cb The callback to call when the connection is closed.
   */
  setCloseListener(cb) {
    this.closeListener = cb;
  }
  removeCloseListener() {
    this.closeListener = void 0;
  }
  /**
   * Set the callback for when an error is received.
   * This should only be used for logging errors, all cleanup
   * should be delegated to setCloseListener.
   *
   * The implementer should take care such that the implemented
   * connection will call both the close and error callbacks
   * on an error.
   *
   * @param cb The callback to call when an error is received.
   */
  setErrorListener(cb) {
    this.errorListener = cb;
  }
  removeErrorListener() {
    this.errorListener = void 0;
  }
};

// transport/impls/ws/connection.ts
var WS_HEALTHY_CLOSE_CODE = 1e3;
var WebSocketCloseError = class extends Error {
  code;
  reason;
  constructor(code, reason) {
    super(`websocket closed with code and reason: ${code} - ${reason}`);
    this.code = code;
    this.reason = reason;
  }
};
var WebSocketConnection = class extends Connection {
  ws;
  extras;
  get loggingMetadata() {
    const metadata = super.loggingMetadata;
    if (this.extras) {
      metadata.extras = this.extras;
    }
    return metadata;
  }
  constructor(ws, extras) {
    super();
    this.ws = ws;
    this.extras = extras;
    this.ws.binaryType = "arraybuffer";
    let didError = false;
    this.ws.onerror = () => {
      didError = true;
    };
    this.ws.onclose = ({ code, reason }) => {
      if (didError) {
        const err = new WebSocketCloseError(code, reason);
        this.onError(err);
      }
      this.onClose();
    };
    this.ws.onmessage = (msg) => {
      this.onData(msg.data);
    };
  }
  send(payload) {
    try {
      this.ws.send(payload);
      return true;
    } catch {
      return false;
    }
  }
  close() {
    this.ws.close(WS_HEALTHY_CLOSE_CODE);
  }
};

// node_modules/@opentelemetry/api/build/esm/platform/node/globalThis.js
var _globalThis = typeof globalThis === "object" ? globalThis : global;

// node_modules/@opentelemetry/api/build/esm/version.js
var VERSION = "1.8.0";

// node_modules/@opentelemetry/api/build/esm/internal/semver.js
var re = /^(\d+)\.(\d+)\.(\d+)(-(.+))?$/;
function _makeCompatibilityCheck(ownVersion) {
  var acceptedVersions = /* @__PURE__ */ new Set([ownVersion]);
  var rejectedVersions = /* @__PURE__ */ new Set();
  var myVersionMatch = ownVersion.match(re);
  if (!myVersionMatch) {
    return function() {
      return false;
    };
  }
  var ownVersionParsed = {
    major: +myVersionMatch[1],
    minor: +myVersionMatch[2],
    patch: +myVersionMatch[3],
    prerelease: myVersionMatch[4]
  };
  if (ownVersionParsed.prerelease != null) {
    return function isExactmatch(globalVersion) {
      return globalVersion === ownVersion;
    };
  }
  function _reject(v) {
    rejectedVersions.add(v);
    return false;
  }
  function _accept(v) {
    acceptedVersions.add(v);
    return true;
  }
  return function isCompatible2(globalVersion) {
    if (acceptedVersions.has(globalVersion)) {
      return true;
    }
    if (rejectedVersions.has(globalVersion)) {
      return false;
    }
    var globalVersionMatch = globalVersion.match(re);
    if (!globalVersionMatch) {
      return _reject(globalVersion);
    }
    var globalVersionParsed = {
      major: +globalVersionMatch[1],
      minor: +globalVersionMatch[2],
      patch: +globalVersionMatch[3],
      prerelease: globalVersionMatch[4]
    };
    if (globalVersionParsed.prerelease != null) {
      return _reject(globalVersion);
    }
    if (ownVersionParsed.major !== globalVersionParsed.major) {
      return _reject(globalVersion);
    }
    if (ownVersionParsed.major === 0) {
      if (ownVersionParsed.minor === globalVersionParsed.minor && ownVersionParsed.patch <= globalVersionParsed.patch) {
        return _accept(globalVersion);
      }
      return _reject(globalVersion);
    }
    if (ownVersionParsed.minor <= globalVersionParsed.minor) {
      return _accept(globalVersion);
    }
    return _reject(globalVersion);
  };
}
var isCompatible = _makeCompatibilityCheck(VERSION);

// node_modules/@opentelemetry/api/build/esm/internal/global-utils.js
var major = VERSION.split(".")[0];
var GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for("opentelemetry.js.api." + major);
var _global = _globalThis;
function registerGlobal(type, instance, diag2, allowOverride) {
  var _a;
  if (allowOverride === void 0) {
    allowOverride = false;
  }
  var api = _global[GLOBAL_OPENTELEMETRY_API_KEY] = (_a = _global[GLOBAL_OPENTELEMETRY_API_KEY]) !== null && _a !== void 0 ? _a : {
    version: VERSION
  };
  if (!allowOverride && api[type]) {
    var err = new Error("@opentelemetry/api: Attempted duplicate registration of API: " + type);
    diag2.error(err.stack || err.message);
    return false;
  }
  if (api.version !== VERSION) {
    var err = new Error("@opentelemetry/api: Registration of version v" + api.version + " for " + type + " does not match previously registered API v" + VERSION);
    diag2.error(err.stack || err.message);
    return false;
  }
  api[type] = instance;
  diag2.debug("@opentelemetry/api: Registered a global for " + type + " v" + VERSION + ".");
  return true;
}
function getGlobal(type) {
  var _a, _b;
  var globalVersion = (_a = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _a === void 0 ? void 0 : _a.version;
  if (!globalVersion || !isCompatible(globalVersion)) {
    return;
  }
  return (_b = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _b === void 0 ? void 0 : _b[type];
}
function unregisterGlobal(type, diag2) {
  diag2.debug("@opentelemetry/api: Unregistering a global for " + type + " v" + VERSION + ".");
  var api = _global[GLOBAL_OPENTELEMETRY_API_KEY];
  if (api) {
    delete api[type];
  }
}

// node_modules/@opentelemetry/api/build/esm/diag/ComponentLogger.js
var __read = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __spreadArray = function(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
};
var DiagComponentLogger = (
  /** @class */
  function() {
    function DiagComponentLogger2(props) {
      this._namespace = props.namespace || "DiagComponentLogger";
    }
    DiagComponentLogger2.prototype.debug = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("debug", this._namespace, args);
    };
    DiagComponentLogger2.prototype.error = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("error", this._namespace, args);
    };
    DiagComponentLogger2.prototype.info = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("info", this._namespace, args);
    };
    DiagComponentLogger2.prototype.warn = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("warn", this._namespace, args);
    };
    DiagComponentLogger2.prototype.verbose = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("verbose", this._namespace, args);
    };
    return DiagComponentLogger2;
  }()
);
function logProxy(funcName, namespace, args) {
  var logger = getGlobal("diag");
  if (!logger) {
    return;
  }
  args.unshift(namespace);
  return logger[funcName].apply(logger, __spreadArray([], __read(args), false));
}

// node_modules/@opentelemetry/api/build/esm/diag/types.js
var DiagLogLevel;
(function(DiagLogLevel2) {
  DiagLogLevel2[DiagLogLevel2["NONE"] = 0] = "NONE";
  DiagLogLevel2[DiagLogLevel2["ERROR"] = 30] = "ERROR";
  DiagLogLevel2[DiagLogLevel2["WARN"] = 50] = "WARN";
  DiagLogLevel2[DiagLogLevel2["INFO"] = 60] = "INFO";
  DiagLogLevel2[DiagLogLevel2["DEBUG"] = 70] = "DEBUG";
  DiagLogLevel2[DiagLogLevel2["VERBOSE"] = 80] = "VERBOSE";
  DiagLogLevel2[DiagLogLevel2["ALL"] = 9999] = "ALL";
})(DiagLogLevel || (DiagLogLevel = {}));

// node_modules/@opentelemetry/api/build/esm/diag/internal/logLevelLogger.js
function createLogLevelDiagLogger(maxLevel, logger) {
  if (maxLevel < DiagLogLevel.NONE) {
    maxLevel = DiagLogLevel.NONE;
  } else if (maxLevel > DiagLogLevel.ALL) {
    maxLevel = DiagLogLevel.ALL;
  }
  logger = logger || {};
  function _filterFunc(funcName, theLevel) {
    var theFunc = logger[funcName];
    if (typeof theFunc === "function" && maxLevel >= theLevel) {
      return theFunc.bind(logger);
    }
    return function() {
    };
  }
  return {
    error: _filterFunc("error", DiagLogLevel.ERROR),
    warn: _filterFunc("warn", DiagLogLevel.WARN),
    info: _filterFunc("info", DiagLogLevel.INFO),
    debug: _filterFunc("debug", DiagLogLevel.DEBUG),
    verbose: _filterFunc("verbose", DiagLogLevel.VERBOSE)
  };
}

// node_modules/@opentelemetry/api/build/esm/api/diag.js
var __read2 = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __spreadArray2 = function(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
};
var API_NAME = "diag";
var DiagAPI = (
  /** @class */
  function() {
    function DiagAPI2() {
      function _logProxy(funcName) {
        return function() {
          var args = [];
          for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
          }
          var logger = getGlobal("diag");
          if (!logger)
            return;
          return logger[funcName].apply(logger, __spreadArray2([], __read2(args), false));
        };
      }
      var self = this;
      var setLogger = function(logger, optionsOrLogLevel) {
        var _a, _b, _c;
        if (optionsOrLogLevel === void 0) {
          optionsOrLogLevel = { logLevel: DiagLogLevel.INFO };
        }
        if (logger === self) {
          var err = new Error("Cannot use diag as the logger for itself. Please use a DiagLogger implementation like ConsoleDiagLogger or a custom implementation");
          self.error((_a = err.stack) !== null && _a !== void 0 ? _a : err.message);
          return false;
        }
        if (typeof optionsOrLogLevel === "number") {
          optionsOrLogLevel = {
            logLevel: optionsOrLogLevel
          };
        }
        var oldLogger = getGlobal("diag");
        var newLogger = createLogLevelDiagLogger((_b = optionsOrLogLevel.logLevel) !== null && _b !== void 0 ? _b : DiagLogLevel.INFO, logger);
        if (oldLogger && !optionsOrLogLevel.suppressOverrideMessage) {
          var stack = (_c = new Error().stack) !== null && _c !== void 0 ? _c : "<failed to generate stacktrace>";
          oldLogger.warn("Current logger will be overwritten from " + stack);
          newLogger.warn("Current logger will overwrite one already registered from " + stack);
        }
        return registerGlobal("diag", newLogger, self, true);
      };
      self.setLogger = setLogger;
      self.disable = function() {
        unregisterGlobal(API_NAME, self);
      };
      self.createComponentLogger = function(options) {
        return new DiagComponentLogger(options);
      };
      self.verbose = _logProxy("verbose");
      self.debug = _logProxy("debug");
      self.info = _logProxy("info");
      self.warn = _logProxy("warn");
      self.error = _logProxy("error");
    }
    DiagAPI2.instance = function() {
      if (!this._instance) {
        this._instance = new DiagAPI2();
      }
      return this._instance;
    };
    return DiagAPI2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/baggage/internal/baggage-impl.js
var __read3 = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __values = function(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m) return m.call(o);
  if (o && typeof o.length === "number") return {
    next: function() {
      if (o && i >= o.length) o = void 0;
      return { value: o && o[i++], done: !o };
    }
  };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
};
var BaggageImpl = (
  /** @class */
  function() {
    function BaggageImpl2(entries) {
      this._entries = entries ? new Map(entries) : /* @__PURE__ */ new Map();
    }
    BaggageImpl2.prototype.getEntry = function(key) {
      var entry = this._entries.get(key);
      if (!entry) {
        return void 0;
      }
      return Object.assign({}, entry);
    };
    BaggageImpl2.prototype.getAllEntries = function() {
      return Array.from(this._entries.entries()).map(function(_a) {
        var _b = __read3(_a, 2), k = _b[0], v = _b[1];
        return [k, v];
      });
    };
    BaggageImpl2.prototype.setEntry = function(key, entry) {
      var newBaggage = new BaggageImpl2(this._entries);
      newBaggage._entries.set(key, entry);
      return newBaggage;
    };
    BaggageImpl2.prototype.removeEntry = function(key) {
      var newBaggage = new BaggageImpl2(this._entries);
      newBaggage._entries.delete(key);
      return newBaggage;
    };
    BaggageImpl2.prototype.removeEntries = function() {
      var e_1, _a;
      var keys = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        keys[_i] = arguments[_i];
      }
      var newBaggage = new BaggageImpl2(this._entries);
      try {
        for (var keys_1 = __values(keys), keys_1_1 = keys_1.next(); !keys_1_1.done; keys_1_1 = keys_1.next()) {
          var key = keys_1_1.value;
          newBaggage._entries.delete(key);
        }
      } catch (e_1_1) {
        e_1 = { error: e_1_1 };
      } finally {
        try {
          if (keys_1_1 && !keys_1_1.done && (_a = keys_1.return)) _a.call(keys_1);
        } finally {
          if (e_1) throw e_1.error;
        }
      }
      return newBaggage;
    };
    BaggageImpl2.prototype.clear = function() {
      return new BaggageImpl2();
    };
    return BaggageImpl2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/baggage/utils.js
var diag = DiagAPI.instance();
function createBaggage(entries) {
  if (entries === void 0) {
    entries = {};
  }
  return new BaggageImpl(new Map(Object.entries(entries)));
}

// node_modules/@opentelemetry/api/build/esm/context/context.js
function createContextKey(description) {
  return Symbol.for(description);
}
var BaseContext = (
  /** @class */
  /* @__PURE__ */ function() {
    function BaseContext2(parentContext) {
      var self = this;
      self._currentContext = parentContext ? new Map(parentContext) : /* @__PURE__ */ new Map();
      self.getValue = function(key) {
        return self._currentContext.get(key);
      };
      self.setValue = function(key, value) {
        var context2 = new BaseContext2(self._currentContext);
        context2._currentContext.set(key, value);
        return context2;
      };
      self.deleteValue = function(key) {
        var context2 = new BaseContext2(self._currentContext);
        context2._currentContext.delete(key);
        return context2;
      };
    }
    return BaseContext2;
  }()
);
var ROOT_CONTEXT = new BaseContext();

// node_modules/@opentelemetry/api/build/esm/propagation/TextMapPropagator.js
var defaultTextMapGetter = {
  get: function(carrier, key) {
    if (carrier == null) {
      return void 0;
    }
    return carrier[key];
  },
  keys: function(carrier) {
    if (carrier == null) {
      return [];
    }
    return Object.keys(carrier);
  }
};
var defaultTextMapSetter = {
  set: function(carrier, key, value) {
    if (carrier == null) {
      return;
    }
    carrier[key] = value;
  }
};

// node_modules/@opentelemetry/api/build/esm/context/NoopContextManager.js
var __read4 = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __spreadArray3 = function(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
};
var NoopContextManager = (
  /** @class */
  function() {
    function NoopContextManager2() {
    }
    NoopContextManager2.prototype.active = function() {
      return ROOT_CONTEXT;
    };
    NoopContextManager2.prototype.with = function(_context, fn, thisArg) {
      var args = [];
      for (var _i = 3; _i < arguments.length; _i++) {
        args[_i - 3] = arguments[_i];
      }
      return fn.call.apply(fn, __spreadArray3([thisArg], __read4(args), false));
    };
    NoopContextManager2.prototype.bind = function(_context, target) {
      return target;
    };
    NoopContextManager2.prototype.enable = function() {
      return this;
    };
    NoopContextManager2.prototype.disable = function() {
      return this;
    };
    return NoopContextManager2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/api/context.js
var __read5 = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __spreadArray4 = function(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
};
var API_NAME2 = "context";
var NOOP_CONTEXT_MANAGER = new NoopContextManager();
var ContextAPI = (
  /** @class */
  function() {
    function ContextAPI2() {
    }
    ContextAPI2.getInstance = function() {
      if (!this._instance) {
        this._instance = new ContextAPI2();
      }
      return this._instance;
    };
    ContextAPI2.prototype.setGlobalContextManager = function(contextManager) {
      return registerGlobal(API_NAME2, contextManager, DiagAPI.instance());
    };
    ContextAPI2.prototype.active = function() {
      return this._getContextManager().active();
    };
    ContextAPI2.prototype.with = function(context2, fn, thisArg) {
      var _a;
      var args = [];
      for (var _i = 3; _i < arguments.length; _i++) {
        args[_i - 3] = arguments[_i];
      }
      return (_a = this._getContextManager()).with.apply(_a, __spreadArray4([context2, fn, thisArg], __read5(args), false));
    };
    ContextAPI2.prototype.bind = function(context2, target) {
      return this._getContextManager().bind(context2, target);
    };
    ContextAPI2.prototype._getContextManager = function() {
      return getGlobal(API_NAME2) || NOOP_CONTEXT_MANAGER;
    };
    ContextAPI2.prototype.disable = function() {
      this._getContextManager().disable();
      unregisterGlobal(API_NAME2, DiagAPI.instance());
    };
    return ContextAPI2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/trace/trace_flags.js
var TraceFlags;
(function(TraceFlags2) {
  TraceFlags2[TraceFlags2["NONE"] = 0] = "NONE";
  TraceFlags2[TraceFlags2["SAMPLED"] = 1] = "SAMPLED";
})(TraceFlags || (TraceFlags = {}));

// node_modules/@opentelemetry/api/build/esm/trace/invalid-span-constants.js
var INVALID_SPANID = "0000000000000000";
var INVALID_TRACEID = "00000000000000000000000000000000";
var INVALID_SPAN_CONTEXT = {
  traceId: INVALID_TRACEID,
  spanId: INVALID_SPANID,
  traceFlags: TraceFlags.NONE
};

// node_modules/@opentelemetry/api/build/esm/trace/NonRecordingSpan.js
var NonRecordingSpan = (
  /** @class */
  function() {
    function NonRecordingSpan2(_spanContext) {
      if (_spanContext === void 0) {
        _spanContext = INVALID_SPAN_CONTEXT;
      }
      this._spanContext = _spanContext;
    }
    NonRecordingSpan2.prototype.spanContext = function() {
      return this._spanContext;
    };
    NonRecordingSpan2.prototype.setAttribute = function(_key, _value) {
      return this;
    };
    NonRecordingSpan2.prototype.setAttributes = function(_attributes) {
      return this;
    };
    NonRecordingSpan2.prototype.addEvent = function(_name, _attributes) {
      return this;
    };
    NonRecordingSpan2.prototype.setStatus = function(_status) {
      return this;
    };
    NonRecordingSpan2.prototype.updateName = function(_name) {
      return this;
    };
    NonRecordingSpan2.prototype.end = function(_endTime) {
    };
    NonRecordingSpan2.prototype.isRecording = function() {
      return false;
    };
    NonRecordingSpan2.prototype.recordException = function(_exception, _time) {
    };
    return NonRecordingSpan2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/trace/context-utils.js
var SPAN_KEY = createContextKey("OpenTelemetry Context Key SPAN");
function getSpan(context2) {
  return context2.getValue(SPAN_KEY) || void 0;
}
function getActiveSpan() {
  return getSpan(ContextAPI.getInstance().active());
}
function setSpan(context2, span) {
  return context2.setValue(SPAN_KEY, span);
}
function deleteSpan(context2) {
  return context2.deleteValue(SPAN_KEY);
}
function setSpanContext(context2, spanContext) {
  return setSpan(context2, new NonRecordingSpan(spanContext));
}
function getSpanContext(context2) {
  var _a;
  return (_a = getSpan(context2)) === null || _a === void 0 ? void 0 : _a.spanContext();
}

// node_modules/@opentelemetry/api/build/esm/trace/spancontext-utils.js
var VALID_TRACEID_REGEX = /^([0-9a-f]{32})$/i;
var VALID_SPANID_REGEX = /^[0-9a-f]{16}$/i;
function isValidTraceId(traceId) {
  return VALID_TRACEID_REGEX.test(traceId) && traceId !== INVALID_TRACEID;
}
function isValidSpanId(spanId) {
  return VALID_SPANID_REGEX.test(spanId) && spanId !== INVALID_SPANID;
}
function isSpanContextValid(spanContext) {
  return isValidTraceId(spanContext.traceId) && isValidSpanId(spanContext.spanId);
}
function wrapSpanContext(spanContext) {
  return new NonRecordingSpan(spanContext);
}

// node_modules/@opentelemetry/api/build/esm/trace/NoopTracer.js
var contextApi = ContextAPI.getInstance();
var NoopTracer = (
  /** @class */
  function() {
    function NoopTracer2() {
    }
    NoopTracer2.prototype.startSpan = function(name, options, context2) {
      if (context2 === void 0) {
        context2 = contextApi.active();
      }
      var root = Boolean(options === null || options === void 0 ? void 0 : options.root);
      if (root) {
        return new NonRecordingSpan();
      }
      var parentFromContext = context2 && getSpanContext(context2);
      if (isSpanContext(parentFromContext) && isSpanContextValid(parentFromContext)) {
        return new NonRecordingSpan(parentFromContext);
      } else {
        return new NonRecordingSpan();
      }
    };
    NoopTracer2.prototype.startActiveSpan = function(name, arg2, arg3, arg4) {
      var opts;
      var ctx;
      var fn;
      if (arguments.length < 2) {
        return;
      } else if (arguments.length === 2) {
        fn = arg2;
      } else if (arguments.length === 3) {
        opts = arg2;
        fn = arg3;
      } else {
        opts = arg2;
        ctx = arg3;
        fn = arg4;
      }
      var parentContext = ctx !== null && ctx !== void 0 ? ctx : contextApi.active();
      var span = this.startSpan(name, opts, parentContext);
      var contextWithSpanSet = setSpan(parentContext, span);
      return contextApi.with(contextWithSpanSet, fn, void 0, span);
    };
    return NoopTracer2;
  }()
);
function isSpanContext(spanContext) {
  return typeof spanContext === "object" && typeof spanContext["spanId"] === "string" && typeof spanContext["traceId"] === "string" && typeof spanContext["traceFlags"] === "number";
}

// node_modules/@opentelemetry/api/build/esm/trace/ProxyTracer.js
var NOOP_TRACER = new NoopTracer();
var ProxyTracer = (
  /** @class */
  function() {
    function ProxyTracer2(_provider, name, version2, options) {
      this._provider = _provider;
      this.name = name;
      this.version = version2;
      this.options = options;
    }
    ProxyTracer2.prototype.startSpan = function(name, options, context2) {
      return this._getTracer().startSpan(name, options, context2);
    };
    ProxyTracer2.prototype.startActiveSpan = function(_name, _options, _context, _fn) {
      var tracer = this._getTracer();
      return Reflect.apply(tracer.startActiveSpan, tracer, arguments);
    };
    ProxyTracer2.prototype._getTracer = function() {
      if (this._delegate) {
        return this._delegate;
      }
      var tracer = this._provider.getDelegateTracer(this.name, this.version, this.options);
      if (!tracer) {
        return NOOP_TRACER;
      }
      this._delegate = tracer;
      return this._delegate;
    };
    return ProxyTracer2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/trace/NoopTracerProvider.js
var NoopTracerProvider = (
  /** @class */
  function() {
    function NoopTracerProvider2() {
    }
    NoopTracerProvider2.prototype.getTracer = function(_name, _version, _options) {
      return new NoopTracer();
    };
    return NoopTracerProvider2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/trace/ProxyTracerProvider.js
var NOOP_TRACER_PROVIDER = new NoopTracerProvider();
var ProxyTracerProvider = (
  /** @class */
  function() {
    function ProxyTracerProvider2() {
    }
    ProxyTracerProvider2.prototype.getTracer = function(name, version2, options) {
      var _a;
      return (_a = this.getDelegateTracer(name, version2, options)) !== null && _a !== void 0 ? _a : new ProxyTracer(this, name, version2, options);
    };
    ProxyTracerProvider2.prototype.getDelegate = function() {
      var _a;
      return (_a = this._delegate) !== null && _a !== void 0 ? _a : NOOP_TRACER_PROVIDER;
    };
    ProxyTracerProvider2.prototype.setDelegate = function(delegate) {
      this._delegate = delegate;
    };
    ProxyTracerProvider2.prototype.getDelegateTracer = function(name, version2, options) {
      var _a;
      return (_a = this._delegate) === null || _a === void 0 ? void 0 : _a.getTracer(name, version2, options);
    };
    return ProxyTracerProvider2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/trace/span_kind.js
var SpanKind;
(function(SpanKind2) {
  SpanKind2[SpanKind2["INTERNAL"] = 0] = "INTERNAL";
  SpanKind2[SpanKind2["SERVER"] = 1] = "SERVER";
  SpanKind2[SpanKind2["CLIENT"] = 2] = "CLIENT";
  SpanKind2[SpanKind2["PRODUCER"] = 3] = "PRODUCER";
  SpanKind2[SpanKind2["CONSUMER"] = 4] = "CONSUMER";
})(SpanKind || (SpanKind = {}));

// node_modules/@opentelemetry/api/build/esm/trace/status.js
var SpanStatusCode;
(function(SpanStatusCode2) {
  SpanStatusCode2[SpanStatusCode2["UNSET"] = 0] = "UNSET";
  SpanStatusCode2[SpanStatusCode2["OK"] = 1] = "OK";
  SpanStatusCode2[SpanStatusCode2["ERROR"] = 2] = "ERROR";
})(SpanStatusCode || (SpanStatusCode = {}));

// node_modules/@opentelemetry/api/build/esm/context-api.js
var context = ContextAPI.getInstance();

// node_modules/@opentelemetry/api/build/esm/propagation/NoopTextMapPropagator.js
var NoopTextMapPropagator = (
  /** @class */
  function() {
    function NoopTextMapPropagator2() {
    }
    NoopTextMapPropagator2.prototype.inject = function(_context, _carrier) {
    };
    NoopTextMapPropagator2.prototype.extract = function(context2, _carrier) {
      return context2;
    };
    NoopTextMapPropagator2.prototype.fields = function() {
      return [];
    };
    return NoopTextMapPropagator2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/baggage/context-helpers.js
var BAGGAGE_KEY = createContextKey("OpenTelemetry Baggage Key");
function getBaggage(context2) {
  return context2.getValue(BAGGAGE_KEY) || void 0;
}
function getActiveBaggage() {
  return getBaggage(ContextAPI.getInstance().active());
}
function setBaggage(context2, baggage) {
  return context2.setValue(BAGGAGE_KEY, baggage);
}
function deleteBaggage(context2) {
  return context2.deleteValue(BAGGAGE_KEY);
}

// node_modules/@opentelemetry/api/build/esm/api/propagation.js
var API_NAME3 = "propagation";
var NOOP_TEXT_MAP_PROPAGATOR = new NoopTextMapPropagator();
var PropagationAPI = (
  /** @class */
  function() {
    function PropagationAPI2() {
      this.createBaggage = createBaggage;
      this.getBaggage = getBaggage;
      this.getActiveBaggage = getActiveBaggage;
      this.setBaggage = setBaggage;
      this.deleteBaggage = deleteBaggage;
    }
    PropagationAPI2.getInstance = function() {
      if (!this._instance) {
        this._instance = new PropagationAPI2();
      }
      return this._instance;
    };
    PropagationAPI2.prototype.setGlobalPropagator = function(propagator) {
      return registerGlobal(API_NAME3, propagator, DiagAPI.instance());
    };
    PropagationAPI2.prototype.inject = function(context2, carrier, setter) {
      if (setter === void 0) {
        setter = defaultTextMapSetter;
      }
      return this._getGlobalPropagator().inject(context2, carrier, setter);
    };
    PropagationAPI2.prototype.extract = function(context2, carrier, getter) {
      if (getter === void 0) {
        getter = defaultTextMapGetter;
      }
      return this._getGlobalPropagator().extract(context2, carrier, getter);
    };
    PropagationAPI2.prototype.fields = function() {
      return this._getGlobalPropagator().fields();
    };
    PropagationAPI2.prototype.disable = function() {
      unregisterGlobal(API_NAME3, DiagAPI.instance());
    };
    PropagationAPI2.prototype._getGlobalPropagator = function() {
      return getGlobal(API_NAME3) || NOOP_TEXT_MAP_PROPAGATOR;
    };
    return PropagationAPI2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/propagation-api.js
var propagation = PropagationAPI.getInstance();

// node_modules/@opentelemetry/api/build/esm/api/trace.js
var API_NAME4 = "trace";
var TraceAPI = (
  /** @class */
  function() {
    function TraceAPI2() {
      this._proxyTracerProvider = new ProxyTracerProvider();
      this.wrapSpanContext = wrapSpanContext;
      this.isSpanContextValid = isSpanContextValid;
      this.deleteSpan = deleteSpan;
      this.getSpan = getSpan;
      this.getActiveSpan = getActiveSpan;
      this.getSpanContext = getSpanContext;
      this.setSpan = setSpan;
      this.setSpanContext = setSpanContext;
    }
    TraceAPI2.getInstance = function() {
      if (!this._instance) {
        this._instance = new TraceAPI2();
      }
      return this._instance;
    };
    TraceAPI2.prototype.setGlobalTracerProvider = function(provider) {
      var success = registerGlobal(API_NAME4, this._proxyTracerProvider, DiagAPI.instance());
      if (success) {
        this._proxyTracerProvider.setDelegate(provider);
      }
      return success;
    };
    TraceAPI2.prototype.getTracerProvider = function() {
      return getGlobal(API_NAME4) || this._proxyTracerProvider;
    };
    TraceAPI2.prototype.getTracer = function(name, version2) {
      return this.getTracerProvider().getTracer(name, version2);
    };
    TraceAPI2.prototype.disable = function() {
      unregisterGlobal(API_NAME4, DiagAPI.instance());
      this._proxyTracerProvider = new ProxyTracerProvider();
    };
    return TraceAPI2;
  }()
);

// node_modules/@opentelemetry/api/build/esm/trace-api.js
var trace = TraceAPI.getInstance();

// transport/message.ts
import { Type } from "@sinclair/typebox";
var TransportMessageSchema = (t) => Type.Object({
  id: Type.String(),
  from: Type.String(),
  to: Type.String(),
  seq: Type.Integer(),
  ack: Type.Integer(),
  serviceName: Type.Optional(Type.String()),
  procedureName: Type.Optional(Type.String()),
  streamId: Type.String(),
  controlFlags: Type.Integer(),
  tracing: Type.Optional(
    Type.Object({
      traceparent: Type.String(),
      tracestate: Type.String()
    })
  ),
  payload: t
});
var ControlMessageAckSchema = Type.Object({
  type: Type.Literal("ACK")
});
var ControlMessageCloseSchema = Type.Object({
  type: Type.Literal("CLOSE")
});
var currentProtocolVersion = "v2.0";
var acceptedProtocolVersions = ["v1.1", currentProtocolVersion];
function isAcceptedProtocolVersion(version2) {
  return acceptedProtocolVersions.includes(version2);
}
var ControlMessageHandshakeRequestSchema = Type.Object({
  type: Type.Literal("HANDSHAKE_REQ"),
  protocolVersion: Type.String(),
  sessionId: Type.String(),
  /**
   * Specifies what the server's expected session state (from the pov of the client). This can be
   * used by the server to know whether this is a new or a reestablished connection, and whether it
   * is compatible with what it already has.
   */
  expectedSessionState: Type.Object({
    // what the client expects the server to send next
    nextExpectedSeq: Type.Integer(),
    nextSentSeq: Type.Integer()
  }),
  metadata: Type.Optional(Type.Unknown())
});
var HandshakeErrorRetriableResponseCodes = Type.Union([
  Type.Literal("SESSION_STATE_MISMATCH")
]);
var HandshakeErrorCustomHandlerFatalResponseCodes = Type.Union([
  // The custom validation handler rejected the handler because the client is unsupported.
  Type.Literal("REJECTED_UNSUPPORTED_CLIENT"),
  // The custom validation handler rejected the handshake.
  Type.Literal("REJECTED_BY_CUSTOM_HANDLER")
]);
var HandshakeErrorFatalResponseCodes = Type.Union([
  HandshakeErrorCustomHandlerFatalResponseCodes,
  // The ciient sent a handshake that doesn't comply with the extended handshake metadata.
  Type.Literal("MALFORMED_HANDSHAKE_META"),
  // The ciient sent a handshake that doesn't comply with ControlMessageHandshakeRequestSchema.
  Type.Literal("MALFORMED_HANDSHAKE"),
  // The client's protocol version does not match the server's.
  Type.Literal("PROTOCOL_VERSION_MISMATCH")
]);
var HandshakeErrorResponseCodes = Type.Union([
  HandshakeErrorRetriableResponseCodes,
  HandshakeErrorFatalResponseCodes
]);
var ControlMessageHandshakeResponseSchema = Type.Object({
  type: Type.Literal("HANDSHAKE_RESP"),
  status: Type.Union([
    Type.Object({
      ok: Type.Literal(true),
      sessionId: Type.String()
    }),
    Type.Object({
      ok: Type.Literal(false),
      reason: Type.String(),
      code: HandshakeErrorResponseCodes
    })
  ])
});
var ControlMessagePayloadSchema = Type.Union([
  ControlMessageCloseSchema,
  ControlMessageAckSchema,
  ControlMessageHandshakeRequestSchema,
  ControlMessageHandshakeResponseSchema
]);
var OpaqueTransportMessageSchema = TransportMessageSchema(
  Type.Unknown()
);
function handshakeResponseMessage({
  from,
  to,
  status
}) {
  return {
    id: generateId(),
    from,
    to,
    seq: 0,
    ack: 0,
    streamId: generateId(),
    controlFlags: 0,
    payload: {
      type: "HANDSHAKE_RESP",
      status
    }
  };
}
function closeStreamMessage(streamId) {
  return {
    streamId,
    controlFlags: 8 /* StreamClosedBit */,
    payload: {
      type: "CLOSE"
    }
  };
}
function cancelMessage(streamId, payload) {
  return {
    streamId,
    controlFlags: 4 /* StreamCancelBit */,
    payload
  };
}
function isAck(controlFlag) {
  return (controlFlag & 1 /* AckBit */) === 1 /* AckBit */;
}
function isStreamOpen(controlFlag) {
  return (
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison */
    (controlFlag & 2 /* StreamOpenBit */) === 2 /* StreamOpenBit */
  );
}
function isStreamClose(controlFlag) {
  return (
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison */
    (controlFlag & 8 /* StreamClosedBit */) === 8 /* StreamClosedBit */
  );
}
function isStreamCancel(controlFlag) {
  return (
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison */
    (controlFlag & 4 /* StreamCancelBit */) === 4 /* StreamCancelBit */
  );
}

// codec/json.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function uint8ArrayToBase64(uint8Array) {
  let binary = "";
  uint8Array.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const uint8Array = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    uint8Array[i] = binaryString.charCodeAt(i);
  }
  return uint8Array;
}
var NaiveJsonCodec = {
  toBuffer: (obj) => {
    return encoder.encode(
      JSON.stringify(obj, function replacer(key) {
        const val = this[key];
        if (val instanceof Uint8Array) {
          return { $t: uint8ArrayToBase64(val) };
        } else if (typeof val === "bigint") {
          return { $b: val.toString() };
        } else {
          return val;
        }
      })
    );
  },
  fromBuffer: (buff) => {
    const parsed = JSON.parse(
      decoder.decode(buff),
      function reviver(_key, val) {
        if (val?.$t !== void 0) {
          return base64ToUint8Array(val.$t);
        } else if (val?.$b !== void 0) {
          return BigInt(val.$b);
        } else {
          return val;
        }
      }
    );
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("unpacked msg is not an object");
    }
    return parsed;
  }
};

// transport/options.ts
var defaultTransportOptions = {
  heartbeatIntervalMs: 1e3,
  heartbeatsUntilDead: 2,
  sessionDisconnectGraceMs: 5e3,
  connectionTimeoutMs: 2e3,
  handshakeTimeoutMs: 1e3,
  enableTransparentSessionReconnects: true,
  codec: NaiveJsonCodec
};
var defaultConnectionRetryOptions = {
  baseIntervalMs: 150,
  maxJitterMs: 200,
  maxBackoffMs: 32e3,
  attemptBudgetCapacity: 5,
  budgetRestoreIntervalMs: 200,
  isFatalConnectionError: () => false
};
var defaultClientTransportOptions = {
  ...defaultTransportOptions,
  ...defaultConnectionRetryOptions
};
var defaultServerTransportOptions = {
  ...defaultTransportOptions
};

// logging/log.ts
var LoggingLevels = {
  debug: -1,
  info: 0,
  warn: 1,
  error: 2
};
var cleanedLogFn = (log) => {
  return (msg, metadata) => {
    if (metadata && !metadata.telemetry) {
      const span = trace.getSpan(context.active());
      if (span) {
        metadata.telemetry = {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId
        };
      }
    }
    if (!metadata?.transportMessage) {
      log(msg, metadata);
      return;
    }
    const { payload, ...rest } = metadata.transportMessage;
    metadata.transportMessage = rest;
    log(msg, metadata);
  };
};
var BaseLogger = class {
  minLevel;
  output;
  constructor(output, minLevel = "info") {
    this.minLevel = minLevel;
    this.output = output;
  }
  debug(msg, metadata) {
    if (LoggingLevels[this.minLevel] <= LoggingLevels.debug) {
      this.output(msg, metadata ?? {}, "debug");
    }
  }
  info(msg, metadata) {
    if (LoggingLevels[this.minLevel] <= LoggingLevels.info) {
      this.output(msg, metadata ?? {}, "info");
    }
  }
  warn(msg, metadata) {
    if (LoggingLevels[this.minLevel] <= LoggingLevels.warn) {
      this.output(msg, metadata ?? {}, "warn");
    }
  }
  error(msg, metadata) {
    if (LoggingLevels[this.minLevel] <= LoggingLevels.error) {
      this.output(msg, metadata ?? {}, "error");
    }
  }
};
var createLogProxy = (log) => ({
  debug: cleanedLogFn(log.debug.bind(log)),
  info: cleanedLogFn(log.info.bind(log)),
  warn: cleanedLogFn(log.warn.bind(log)),
  error: cleanedLogFn(log.error.bind(log))
});

// transport/events.ts
var ProtocolError = {
  RetriesExceeded: "conn_retry_exceeded",
  HandshakeFailed: "handshake_failed",
  MessageOrderingViolated: "message_ordering_violated",
  InvalidMessage: "invalid_message",
  MessageSendFailure: "message_send_failure"
};
var EventDispatcher = class {
  eventListeners = {};
  removeAllListeners() {
    this.eventListeners = {};
  }
  numberOfListeners(eventType) {
    return this.eventListeners[eventType]?.size ?? 0;
  }
  addEventListener(eventType, handler) {
    if (!this.eventListeners[eventType]) {
      this.eventListeners[eventType] = /* @__PURE__ */ new Set();
    }
    this.eventListeners[eventType]?.add(handler);
  }
  removeEventListener(eventType, handler) {
    const handlers = this.eventListeners[eventType];
    if (handlers) {
      this.eventListeners[eventType]?.delete(handler);
    }
  }
  dispatchEvent(eventType, event) {
    const handlers = this.eventListeners[eventType];
    if (handlers) {
      const copy = [...handlers];
      for (const handler of copy) {
        handler(event);
      }
    }
  }
};

// transport/sessionStateMachine/common.ts
var ERR_CONSUMED = `session state has been consumed and is no longer valid`;
var StateMachineState = class {
  /*
   * Whether this state has been consumed
   * and we've moved on to another state
   */
  _isConsumed;
  /**
   * Cleanup this state machine state and mark it as consumed.
   * After calling close, it is an error to access any properties on the state.
   * You should never need to call this as a consumer.
   *
   * If you're looking to close the session from the client,
   * use `.hardDisconnect` on the client transport.
   */
  close() {
    this._handleClose();
  }
  constructor() {
    this._isConsumed = false;
    return new Proxy(this, {
      get(target, prop) {
        if (prop === "_isConsumed" || prop === "id" || prop === "state") {
          return Reflect.get(target, prop);
        }
        if (prop === "_handleStateExit") {
          return () => {
            target._isConsumed = true;
            target._handleStateExit();
          };
        }
        if (prop === "_handleClose") {
          return () => {
            target._isConsumed = true;
            target._handleStateExit();
            target._handleClose();
          };
        }
        if (target._isConsumed) {
          throw new Error(
            `${ERR_CONSUMED}: getting ${prop.toString()} on consumed state`
          );
        }
        return Reflect.get(target, prop);
      },
      set(target, prop, value) {
        if (target._isConsumed) {
          throw new Error(
            `${ERR_CONSUMED}: setting ${prop.toString()} on consumed state`
          );
        }
        return Reflect.set(target, prop, value);
      }
    });
  }
};
var CommonSession = class extends StateMachineState {
  from;
  options;
  codec;
  tracer;
  log;
  constructor({ from, options, log, tracer, codec }) {
    super();
    this.from = from;
    this.options = options;
    this.log = log;
    this.tracer = tracer;
    this.codec = codec;
  }
};
var IdentifiedSession = class extends CommonSession {
  id;
  telemetry;
  to;
  protocolVersion;
  /**
   * Index of the message we will send next (excluding handshake)
   */
  seq;
  /**
   * Last seq we sent over the wire this session (excluding handshake) and retransmissions
   */
  seqSent;
  /**
   * Number of unique messages we've received this session (excluding handshake)
   */
  ack;
  sendBuffer;
  constructor(props) {
    const {
      id,
      to,
      seq,
      ack,
      sendBuffer,
      telemetry,
      log,
      protocolVersion,
      seqSent: messagesSent
    } = props;
    super(props);
    this.id = id;
    this.to = to;
    this.seq = seq;
    this.ack = ack;
    this.sendBuffer = sendBuffer;
    this.telemetry = telemetry;
    this.log = log;
    this.protocolVersion = protocolVersion;
    this.seqSent = messagesSent;
  }
  get loggingMetadata() {
    const metadata = {
      clientId: this.from,
      connectedTo: this.to,
      sessionId: this.id
    };
    if (this.telemetry.span.isRecording()) {
      const spanContext = this.telemetry.span.spanContext();
      metadata.telemetry = {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId
      };
    }
    return metadata;
  }
  constructMsg(partialMsg) {
    const msg = {
      ...partialMsg,
      id: generateId(),
      to: this.to,
      from: this.from,
      seq: this.seq,
      ack: this.ack
    };
    this.seq++;
    return msg;
  }
  nextSeq() {
    return this.sendBuffer.length > 0 ? this.sendBuffer[0].seq : this.seq;
  }
  send(msg) {
    const constructedMsg = this.constructMsg(msg);
    this.sendBuffer.push(constructedMsg);
    return {
      ok: true,
      value: constructedMsg.id
    };
  }
  _handleStateExit() {
  }
  _handleClose() {
    this.sendBuffer.length = 0;
    this.telemetry.span.end();
  }
};
var IdentifiedSessionWithGracePeriod = class extends IdentifiedSession {
  graceExpiryTime;
  gracePeriodTimeout;
  listeners;
  constructor(props) {
    super(props);
    this.listeners = props.listeners;
    this.graceExpiryTime = props.graceExpiryTime;
    this.gracePeriodTimeout = setTimeout(() => {
      this.listeners.onSessionGracePeriodElapsed();
    }, this.graceExpiryTime - Date.now());
  }
  _handleStateExit() {
    super._handleStateExit();
    if (this.gracePeriodTimeout) {
      clearTimeout(this.gracePeriodTimeout);
      this.gracePeriodTimeout = void 0;
    }
  }
  _handleClose() {
    super._handleClose();
  }
};
function sendMessage(conn, codec, msg) {
  const buff = codec.toBuffer(msg);
  if (!buff.ok) {
    return buff;
  }
  const sent = conn.send(buff.value);
  if (!sent) {
    return {
      ok: false,
      reason: "failed to send message"
    };
  }
  return {
    ok: true,
    value: msg.id
  };
}

// transport/sessionStateMachine/SessionConnecting.ts
var SessionConnecting = class extends IdentifiedSessionWithGracePeriod {
  state = "Connecting" /* Connecting */;
  connPromise;
  listeners;
  connectionTimeout;
  constructor(props) {
    super(props);
    this.connPromise = props.connPromise;
    this.listeners = props.listeners;
    this.connPromise.then(
      (conn) => {
        if (this._isConsumed) return;
        this.listeners.onConnectionEstablished(conn);
      },
      (err) => {
        if (this._isConsumed) return;
        this.listeners.onConnectionFailed(err);
      }
    );
    this.connectionTimeout = setTimeout(() => {
      this.listeners.onConnectionTimeout();
    }, this.options.connectionTimeoutMs);
  }
  // close a pending connection if it resolves, ignore errors if the promise
  // ends up rejected anyways
  bestEffortClose() {
    const logger = this.log;
    const metadata = this.loggingMetadata;
    this.connPromise.then((conn) => {
      conn.close();
      logger?.info(
        "connection eventually resolved but session has transitioned, closed connection",
        {
          ...metadata,
          ...conn.loggingMetadata
        }
      );
    }).catch(() => {
    });
  }
  _handleStateExit() {
    super._handleStateExit();
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = void 0;
    }
  }
  _handleClose() {
    super._handleClose();
    this.bestEffortClose();
  }
};

// transport/sessionStateMachine/SessionNoConnection.ts
var SessionNoConnection = class extends IdentifiedSessionWithGracePeriod {
  state = "NoConnection" /* NoConnection */;
  _handleClose() {
    super._handleClose();
  }
  _handleStateExit() {
    super._handleStateExit();
  }
};

// router/services.ts
import { Type as Type3, Kind as Kind2 } from "@sinclair/typebox";

// router/errors.ts
import {
  Kind,
  Type as Type2
} from "@sinclair/typebox";
var UNCAUGHT_ERROR_CODE = "UNCAUGHT_ERROR";
var UNEXPECTED_DISCONNECT_CODE = "UNEXPECTED_DISCONNECT";
var INVALID_REQUEST_CODE = "INVALID_REQUEST";
var CANCEL_CODE = "CANCEL";
var ErrResultSchema = (t) => Type2.Object({
  ok: Type2.Literal(false),
  payload: t
});
var ValidationErrorDetails = Type2.Object({
  path: Type2.String(),
  message: Type2.String()
});
var ValidationErrors = Type2.Array(ValidationErrorDetails);
function castTypeboxValueErrors(errors) {
  const result = [];
  for (const error of errors) {
    result.push({
      path: error.path,
      message: error.message
    });
  }
  return result;
}
var CancelErrorSchema = Type2.Object({
  code: Type2.Literal(CANCEL_CODE),
  message: Type2.String()
});
var CancelResultSchema = ErrResultSchema(CancelErrorSchema);
var ReaderErrorSchema = Type2.Union([
  Type2.Object({
    code: Type2.Literal(UNCAUGHT_ERROR_CODE),
    message: Type2.String()
  }),
  Type2.Object({
    code: Type2.Literal(UNEXPECTED_DISCONNECT_CODE),
    message: Type2.String()
  }),
  Type2.Object({
    code: Type2.Literal(INVALID_REQUEST_CODE),
    message: Type2.String(),
    extras: Type2.Optional(
      Type2.Object({
        firstValidationErrors: Type2.Array(ValidationErrorDetails),
        totalErrors: Type2.Number()
      })
    )
  }),
  CancelErrorSchema
]);
var ReaderErrorResultSchema = ErrResultSchema(ReaderErrorSchema);
function isUnion(schema) {
  return schema[Kind] === "Union";
}
function flattenErrorType(errType) {
  if (!isUnion(errType)) {
    return errType;
  }
  const flattenedTypes = [];
  function flatten(type) {
    if (isUnion(type)) {
      for (const t of type.anyOf) {
        flatten(t);
      }
    } else {
      flattenedTypes.push(type);
    }
  }
  flatten(errType);
  return Type2.Union(flattenedTypes);
}

// router/services.ts
function Strict(schema) {
  return JSON.parse(JSON.stringify(schema));
}
function createServiceSchema() {
  return class ServiceSchema2 {
    /**
     * Factory function for creating a fresh state.
     */
    initializeState;
    /**
     * The procedures for this service.
     */
    procedures;
    /**
     * @param config - The configuration for this service.
     * @param procedures - The procedures for this service.
     */
    constructor(config, procedures) {
      this.initializeState = config.initializeState;
      this.procedures = procedures;
    }
    /**
     * Creates a {@link ServiceScaffold}, which can be used to define procedures
     * that can then be merged into a {@link ServiceSchema}, via the scaffold's
     * `finalize` method.
     *
     * There are two patterns that work well with this method. The first is using
     * it to separate the definition of procedures from the definition of the
     * service's configuration:
     * ```ts
     * const MyServiceScaffold = ServiceSchema.scaffold({
     *   initializeState: () => ({ count: 0 }),
     * });
     *
     * const incrementProcedures = MyServiceScaffold.procedures({
     *   increment: Procedure.rpc({
     *     requestInit: Type.Object({ amount: Type.Number() }),
     *     responseData: Type.Object({ current: Type.Number() }),
     *     async handler(ctx, init) {
     *       ctx.state.count += init.amount;
     *       return Ok({ current: ctx.state.count });
     *     }
     *   }),
     * })
     *
     * const MyService = MyServiceScaffold.finalize({
     *   ...incrementProcedures,
     *   // you can also directly define procedures here
     * });
     * ```
     * This might be really handy if you have a very large service and you're
     * wanting to split it over multiple files. You can define the scaffold
     * in one file, and then import that scaffold in other files where you
     * define procedures - and then finally import the scaffolds and your
     * procedure objects in a final file where you finalize the scaffold into
     * a service schema.
     *
     * The other way is to use it like in a builder pattern:
     * ```ts
     * const MyService = ServiceSchema
     *   .scaffold({ initializeState: () => ({ count: 0 }) })
     *   .finalize({
     *     increment: Procedure.rpc({
     *       requestInit: Type.Object({ amount: Type.Number() }),
     *       responseData: Type.Object({ current: Type.Number() }),
     *       async handler(ctx, init) {
     *         ctx.state.count += init.amount;
     *         return Ok({ current: ctx.state.count });
     *       }
     *     }),
     *   })
     * ```
     * Depending on your preferences, this may be a more appealing way to define
     * a schema versus using the {@link ServiceSchema.define} method.
     */
    static scaffold(config) {
      return new ServiceScaffold(config);
    }
    // actual implementation
    static define(configOrProcedures, maybeProcedures) {
      let config;
      let procedures;
      if ("initializeState" in configOrProcedures && typeof configOrProcedures.initializeState === "function") {
        if (!maybeProcedures) {
          throw new Error("Expected procedures to be defined");
        }
        config = configOrProcedures;
        procedures = maybeProcedures;
      } else {
        config = { initializeState: () => ({}) };
        procedures = configOrProcedures;
      }
      return new ServiceSchema2(config, procedures);
    }
    /**
     * Serializes this schema's procedures into a plain object that is JSON compatible.
     */
    serialize() {
      return {
        procedures: Object.fromEntries(
          Object.entries(this.procedures).map(([procName, procDef]) => [
            procName,
            {
              init: Strict(procDef.requestInit),
              output: Strict(procDef.responseData),
              errors: getSerializedProcErrors(procDef),
              // Only add `description` field if the type declares it.
              ..."description" in procDef ? { description: procDef.description } : {},
              type: procDef.type,
              // Only add the `input` field if the type declares it.
              ..."requestData" in procDef ? {
                input: Strict(procDef.requestData)
              } : {}
            }
          ])
        )
      };
    }
    // TODO remove once clients migrate to v2
    /**
     * Same as {@link ServiceSchema.serialize}, but with a format that is compatible with
     * protocol v1. This is useful to be able to continue to generate schemas for older
     * clients as they are still supported.
     */
    serializeV1Compat() {
      return {
        procedures: Object.fromEntries(
          Object.entries(this.procedures).map(
            ([procName, procDef]) => {
              if (procDef.type === "rpc" || procDef.type === "subscription") {
                return [
                  procName,
                  {
                    // BACKWARDS COMPAT: map init to input for protocolv1
                    // this is the only change needed to make it compatible.
                    input: Strict(procDef.requestInit),
                    output: Strict(procDef.responseData),
                    errors: getSerializedProcErrors(procDef),
                    // Only add `description` field if the type declares it.
                    ..."description" in procDef ? { description: procDef.description } : {},
                    type: procDef.type
                  }
                ];
              }
              return [
                procName,
                {
                  init: Strict(procDef.requestInit),
                  output: Strict(procDef.responseData),
                  errors: getSerializedProcErrors(procDef),
                  // Only add `description` field if the type declares it.
                  ..."description" in procDef ? { description: procDef.description } : {},
                  type: procDef.type,
                  input: Strict(procDef.requestData)
                }
              ];
            }
          )
        )
      };
    }
    /**
     * Instantiates this schema into a {@link Service} object.
     *
     * You probably don't need this, usually the River server will handle this
     * for you.
     */
    instantiate(extendedContext) {
      const state = this.initializeState(extendedContext);
      const dispose = async () => {
        await state[Symbol.asyncDispose]?.();
        state[Symbol.dispose]?.();
      };
      return Object.freeze({
        state,
        procedures: this.procedures,
        [Symbol.asyncDispose]: dispose
      });
    }
  };
}
function getSerializedProcErrors(procDef) {
  if (!("responseError" in procDef) || procDef.responseError[Kind2] === "Never") {
    return Strict(ReaderErrorSchema);
  }
  const withProtocolErrors = flattenErrorType(
    Type3.Union([procDef.responseError, ReaderErrorSchema])
  );
  return Strict(withProtocolErrors);
}
var ServiceScaffold = class {
  /**
   * The configuration for this service.
   */
  config;
  /**
   * @param config - The configuration for this service.
   */
  constructor(config) {
    this.config = config;
  }
  /**
   * Define procedures for this service. Use the {@link Procedure} constructors
   * to create them. This returns the procedures object, which can then be
   * passed to {@link ServiceSchema.finalize} to create a {@link ServiceSchema}.
   *
   * @example
   * ```
   * const myProcedures = MyServiceScaffold.procedures({
   *   myRPC: Procedure.rpc({
   *     // ...
   *   }),
   * });
   *
   * const MyService = MyServiceScaffold.finalize({
   *   ...myProcedures,
   * });
   * ```
   *
   * @param procedures - The procedures for this service.
   */
  procedures(procedures) {
    return procedures;
  }
  /**
   * Finalizes the scaffold into a {@link ServiceSchema}. This is where you
   * provide the service's procedures and get a {@link ServiceSchema} in return.
   *
   * You can directly define procedures here, or you can define them separately
   * with the {@link ServiceScaffold.procedures} method, and then pass them here.
   *
   * @example
   * ```
   * const MyService = MyServiceScaffold.finalize({
   *  myRPC: Procedure.rpc({
   *   // ...
   *  }),
   *  // e.g. from the procedures method
   *  ...myOtherProcedures,
   * });
   * ```
   */
  finalize(procedures) {
    return createServiceSchema().define(
      this.config,
      procedures
    );
  }
};

// router/result.ts
import { Type as Type4 } from "@sinclair/typebox";
var AnyResultSchema = Type4.Union([
  Type4.Object({
    ok: Type4.Literal(false),
    payload: Type4.Object({
      code: Type4.String(),
      message: Type4.String(),
      extras: Type4.Optional(Type4.Unknown())
    })
  }),
  Type4.Object({
    ok: Type4.Literal(true),
    payload: Type4.Unknown()
  })
]);
function Ok(payload) {
  return {
    ok: true,
    payload
  };
}
function Err(error) {
  return {
    ok: false,
    payload: error
  };
}

// router/streams.ts
var ReadableBrokenError = {
  code: "READABLE_BROKEN",
  message: "Readable was broken before it is fully consumed"
};
function createPromiseWithResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    // @ts-expect-error promise callbacks are sync
    resolve,
    // @ts-expect-error promise callbacks are sync
    reject
  };
}
var ReadableImpl = class {
  /**
   * Whether the {@link Readable} is closed.
   *
   * Closed {@link Readable}s are done receiving values, but that doesn't affect
   * any other aspect of the {@link Readable} such as it's consumability.
   */
  closed = false;
  /**
   * Whether the {@link Readable} is locked.
   *
   * @see {@link Readable}'s typedoc to understand locking
   */
  locked = false;
  /**
   * Whether {@link break} was called.
   *
   * @see {@link break} for more information
   */
  broken = false;
  /**
   * This flag allows us to avoid emitting a {@link ReadableBrokenError} after {@link break} was called
   * in cases where the {@link queue} is fully consumed and {@link ReadableImpl} is {@link closed}. This is just an
   * ergonomic feature to avoid emitting an error in our iteration when we don't have to.
   */
  brokenWithValuesLeftToRead = false;
  /**
   * A list of values that have been pushed to the {@link ReadableImpl} but not yet emitted to the user.
   */
  queue = [];
  /**
   * Used by methods in the class to signal to the iterator that it
   * should check for the next value.
   */
  next = null;
  /**
   * Consumes the {@link Readable} and returns an {@link AsyncIterator} that can be used
   * to iterate over the values in the {@link Readable}.
   */
  [Symbol.asyncIterator]() {
    if (this.locked) {
      throw new TypeError("Readable is already locked");
    }
    this.locked = true;
    let didSignalBreak = false;
    return {
      next: async () => {
        if (didSignalBreak) {
          return {
            done: true,
            value: void 0
          };
        }
        while (this.queue.length === 0) {
          if (this.closed && !this.brokenWithValuesLeftToRead) {
            return {
              done: true,
              value: void 0
            };
          }
          if (this.broken) {
            didSignalBreak = true;
            return {
              done: false,
              value: Err(ReadableBrokenError)
            };
          }
          if (!this.next) {
            this.next = createPromiseWithResolvers();
          }
          await this.next.promise;
          this.next = null;
        }
        const value = this.queue.shift();
        return { done: false, value };
      },
      return: async () => {
        this.break();
        return { done: true, value: void 0 };
      }
    };
  }
  /**
   * Collects all the values from the {@link Readable} into an array.
   *
   * @see {@link Readable}'s typedoc for more information
   */
  async collect() {
    const array = [];
    for await (const value of this) {
      array.push(value);
    }
    return array;
  }
  /**
   * Breaks the {@link Readable} and signals an error to any iterators waiting for the next value.
   *
   * @see {@link Readable}'s typedoc for more information
   */
  break() {
    if (this.broken) {
      return;
    }
    this.locked = true;
    this.broken = true;
    this.brokenWithValuesLeftToRead = this.queue.length > 0;
    this.queue.length = 0;
    this.next?.resolve();
  }
  /**
   * Whether the {@link Readable} is readable.
   *
   * @see {@link Readable}'s typedoc for more information
   */
  isReadable() {
    return !this.locked && !this.broken;
  }
  /**
   * Pushes a value to be read.
   */
  _pushValue(value) {
    if (this.broken) {
      return;
    }
    if (this.closed) {
      throw new Error("Cannot push to closed Readable");
    }
    this.queue.push(value);
    this.next?.resolve();
  }
  /**
   * Triggers the close of the {@link Readable}. Make sure to push all remaining
   * values before calling this method.
   */
  _triggerClose() {
    if (this.closed) {
      throw new Error("Unexpected closing multiple times");
    }
    this.closed = true;
    this.next?.resolve();
  }
  /**
   * @internal meant for use within river, not exposed as a public API
   */
  _hasValuesInQueue() {
    return this.queue.length > 0;
  }
  /**
   * Whether the {@link Readable} is closed.
   */
  isClosed() {
    return this.closed;
  }
};
var WritableImpl = class {
  /**
   * Passed via constructor to pass on calls to {@link write}
   */
  writeCb;
  /**
   * Passed via constructor to pass on calls to {@link close}
   */
  closeCb;
  /**
   * Whether {@link close} was called, and {@link Writable} is not writable anymore.
   */
  closed = false;
  constructor(callbacks) {
    this.writeCb = callbacks.writeCb;
    this.closeCb = callbacks.closeCb;
  }
  write(value) {
    if (this.closed) {
      throw new Error("Cannot write to closed Writable");
    }
    this.writeCb(value);
  }
  isWritable() {
    return !this.closed;
  }
  close(value) {
    if (this.closed) {
      return;
    }
    if (value !== void 0) {
      this.writeCb(value);
    }
    this.closed = true;
    this.writeCb = () => void 0;
    this.closeCb();
    this.closeCb = () => void 0;
  }
  /**
   * @internal meant for use within river, not exposed as a public API
   */
  isClosed() {
    return this.closed;
  }
};

// router/procedures.ts
import { Type as Type5 } from "@sinclair/typebox";
function rpc({
  requestInit,
  responseData,
  responseError = Type5.Never(),
  description,
  handler
}) {
  return {
    ...description ? { description } : {},
    type: "rpc",
    requestInit,
    responseData,
    responseError,
    handler
  };
}
function upload({
  requestInit,
  requestData,
  responseData,
  responseError = Type5.Never(),
  description,
  handler
}) {
  return {
    type: "upload",
    ...description ? { description } : {},
    requestInit,
    requestData,
    responseData,
    responseError,
    handler
  };
}
function subscription({
  requestInit,
  responseData,
  responseError = Type5.Never(),
  description,
  handler
}) {
  return {
    type: "subscription",
    ...description ? { description } : {},
    requestInit,
    responseData,
    responseError,
    handler
  };
}
function stream({
  requestInit,
  requestData,
  responseData,
  responseError = Type5.Never(),
  description,
  handler
}) {
  return {
    type: "stream",
    ...description ? { description } : {},
    requestInit,
    requestData,
    responseData,
    responseError,
    handler
  };
}
var Procedure = {
  rpc,
  upload,
  subscription,
  stream
};

// router/server.ts
import { Value } from "@sinclair/typebox/value";

// transport/stringifyError.ts
function coerceErrorString(err) {
  if (err instanceof Error) {
    return err.message || "unknown reason";
  }
  return `[coerced to error] ${String(err)}`;
}

// router/server.ts
var RiverServer = class {
  transport;
  contextMap;
  log;
  middlewares;
  /**
   * We create a tombstones for streams cancelled by the server
   * so that we don't hit errors when the client has inflight
   * requests it sent before it saw the cancel.
   * We track cancelled streams for every client separately, so
   * that bad clients don't affect good clients.
   */
  serverCancelledStreams;
  maxCancelledStreamTombstonesPerSession;
  streams;
  services;
  unregisterTransportListeners;
  constructor(transport, services2, handshakeOptions, extendedContext, maxCancelledStreamTombstonesPerSession = 200, middlewares = []) {
    const instances = {};
    this.middlewares = middlewares;
    this.services = instances;
    this.contextMap = /* @__PURE__ */ new Map();
    extendedContext = extendedContext ?? {};
    for (const [name, service] of Object.entries(services2)) {
      const instance = service.instantiate(extendedContext);
      instances[name] = instance;
      this.contextMap.set(instance, {
        ...extendedContext,
        state: instance.state
      });
    }
    if (handshakeOptions) {
      transport.extendHandshake(handshakeOptions);
    }
    this.transport = transport;
    this.streams = /* @__PURE__ */ new Map();
    this.serverCancelledStreams = /* @__PURE__ */ new Map();
    this.maxCancelledStreamTombstonesPerSession = maxCancelledStreamTombstonesPerSession;
    this.log = transport.log;
    const handleCreatingNewStreams = (message) => {
      if (message.to !== this.transport.clientId) {
        this.log?.info(
          `got msg with destination that isn't this server, ignoring`,
          {
            clientId: this.transport.clientId,
            transportMessage: message
          }
        );
        return;
      }
      const streamId = message.streamId;
      const stream2 = this.streams.get(streamId);
      if (stream2) {
        stream2.handleMsg(message);
        return;
      }
      if (this.serverCancelledStreams.get(message.from)?.has(streamId)) {
        return;
      }
      const newStreamProps = this.validateNewProcStream(message);
      if (!newStreamProps) {
        return;
      }
      createHandlerSpan(
        transport.tracer,
        newStreamProps.initialSession,
        newStreamProps.procedure.type,
        newStreamProps.serviceName,
        newStreamProps.procedureName,
        newStreamProps.streamId,
        newStreamProps.tracingCtx,
        (span) => {
          this.createNewProcStream(span, newStreamProps);
        }
      );
    };
    const handleSessionStatus = (evt) => {
      if (evt.status !== "closing") return;
      const disconnectedClientId = evt.session.to;
      this.log?.info(
        `got session disconnect from ${disconnectedClientId}, cleaning up streams`,
        evt.session.loggingMetadata
      );
      for (const stream2 of this.streams.values()) {
        if (stream2.from === disconnectedClientId) {
          stream2.handleSessionDisconnect();
        }
      }
      this.serverCancelledStreams.delete(disconnectedClientId);
    };
    const handleTransportStatus = (evt) => {
      if (evt.status !== "closed") return;
      this.unregisterTransportListeners();
    };
    this.unregisterTransportListeners = () => {
      this.transport.removeEventListener("message", handleCreatingNewStreams);
      this.transport.removeEventListener("sessionStatus", handleSessionStatus);
      this.transport.removeEventListener(
        "transportStatus",
        handleTransportStatus
      );
    };
    this.transport.addEventListener("message", handleCreatingNewStreams);
    this.transport.addEventListener("sessionStatus", handleSessionStatus);
    this.transport.addEventListener("transportStatus", handleTransportStatus);
  }
  createNewProcStream(span, props) {
    const {
      streamId,
      initialSession,
      procedureName,
      serviceName,
      procedure,
      sessionMetadata,
      serviceContext,
      initPayload,
      procClosesWithInit,
      passInitAsDataForBackwardsCompat
    } = props;
    const {
      to: from,
      loggingMetadata,
      protocolVersion,
      id: sessionId
    } = initialSession;
    loggingMetadata.telemetry = {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId
    };
    let cleanClose = true;
    const onMessage = (msg) => {
      if (msg.from !== from) {
        this.log?.error("got stream message from unexpected client", {
          ...loggingMetadata,
          transportMessage: msg,
          tags: ["invariant-violation"]
        });
        return;
      }
      if (isStreamCancelBackwardsCompat(msg.controlFlags, protocolVersion)) {
        let cancelResult;
        if (Value.Check(CancelResultSchema, msg.payload)) {
          cancelResult = msg.payload;
        } else {
          cancelResult = Err({
            code: CANCEL_CODE,
            message: "stream cancelled, client sent invalid payload"
          });
          this.log?.warn("got stream cancel without a valid protocol error", {
            ...loggingMetadata,
            transportMessage: msg,
            validationErrors: [
              ...Value.Errors(CancelResultSchema, msg.payload)
            ],
            tags: ["invalid-request"]
          });
        }
        if (!reqReadable.isClosed()) {
          reqReadable._pushValue(cancelResult);
          closeReadable();
        }
        resWritable.close();
        return;
      }
      if (reqReadable.isClosed()) {
        this.log?.warn("received message after request stream is closed", {
          ...loggingMetadata,
          transportMessage: msg,
          tags: ["invalid-request"]
        });
        onServerCancel({
          code: INVALID_REQUEST_CODE,
          message: "received message after request stream is closed"
        });
        return;
      }
      if ("requestData" in procedure && Value.Check(procedure.requestData, msg.payload)) {
        reqReadable._pushValue(Ok(msg.payload));
        if (isStreamCloseBackwardsCompat(msg.controlFlags, protocolVersion)) {
          closeReadable();
        }
        return;
      }
      if (Value.Check(ControlMessagePayloadSchema, msg.payload) && isStreamCloseBackwardsCompat(msg.controlFlags, protocolVersion)) {
        closeReadable();
        return;
      }
      let validationErrors;
      let errMessage;
      if ("requestData" in procedure) {
        errMessage = "message in requestData position did not match schema";
        validationErrors = castTypeboxValueErrors(
          Value.Errors(procedure.requestData, msg.payload)
        );
      } else {
        validationErrors = castTypeboxValueErrors(
          Value.Errors(ControlMessagePayloadSchema, msg.payload)
        );
        errMessage = "message in control payload position did not match schema";
      }
      this.log?.warn(errMessage, {
        ...loggingMetadata,
        transportMessage: msg,
        validationErrors: validationErrors.map((error) => ({
          path: error.path,
          message: error.message
        })),
        tags: ["invalid-request"]
      });
      onServerCancel({
        code: INVALID_REQUEST_CODE,
        message: errMessage,
        extras: {
          totalErrors: validationErrors.length,
          firstValidationErrors: validationErrors.slice(0, 5)
        }
      });
    };
    const finishedController = new AbortController();
    const procStream = {
      from,
      streamId,
      procedureName,
      serviceName,
      sessionMetadata,
      procedure,
      handleMsg: onMessage,
      handleSessionDisconnect: () => {
        cleanClose = false;
        const errPayload = {
          code: UNEXPECTED_DISCONNECT_CODE,
          message: "client unexpectedly disconnected"
        };
        if (!reqReadable.isClosed()) {
          reqReadable._pushValue(Err(errPayload));
          closeReadable();
        }
        resWritable.close();
      }
    };
    const sessionScopedSend = this.transport.getSessionBoundSendFn(
      from,
      sessionId
    );
    const cancelStream = (streamId2, payload) => {
      this.cancelStream(from, sessionScopedSend, streamId2, payload);
    };
    const onServerCancel = (e) => {
      recordRiverError(span, e);
      if (reqReadable.isClosed() && resWritable.isClosed()) {
        return;
      }
      cleanClose = false;
      const result = Err(e);
      if (!reqReadable.isClosed()) {
        reqReadable._pushValue(result);
        closeReadable();
      }
      resWritable.close();
      cancelStream(streamId, result);
    };
    const cleanup = () => {
      finishedController.abort();
      this.streams.delete(streamId);
    };
    const procClosesWithResponse = procedure.type === "rpc" || procedure.type === "upload";
    const reqReadable = new ReadableImpl();
    const closeReadable = () => {
      reqReadable._triggerClose();
      if (protocolVersion === "v1.1") {
        if (!procClosesWithResponse && !resWritable.isClosed()) {
          resWritable.close();
        }
      }
      if (resWritable.isClosed()) {
        cleanup();
      }
    };
    if (passInitAsDataForBackwardsCompat) {
      reqReadable._pushValue(Ok(initPayload));
    }
    const resWritable = new WritableImpl({
      writeCb: (response) => {
        if (!response.ok) {
          recordRiverError(span, response.payload);
        }
        sessionScopedSend({
          streamId,
          controlFlags: procClosesWithResponse ? getStreamCloseBackwardsCompat(protocolVersion) : 0,
          payload: response
        });
        if (procClosesWithResponse) {
          resWritable.close();
        }
      },
      // close callback
      closeCb: () => {
        if (!procClosesWithResponse && cleanClose) {
          const message = closeStreamMessage(streamId);
          message.controlFlags = getStreamCloseBackwardsCompat(protocolVersion);
          sessionScopedSend(message);
        }
        if (protocolVersion === "v1.1") {
          if (!reqReadable.isClosed()) {
            closeReadable();
          }
        }
        if (reqReadable.isClosed()) {
          cleanup();
        }
      }
    });
    const onHandlerError = (err, span2) => {
      const errorMsg = coerceErrorString(err);
      span2.recordException(err instanceof Error ? err : new Error(errorMsg));
      this.log?.error(
        `${serviceName}.${procedureName} handler threw an uncaught error`,
        {
          ...loggingMetadata,
          transportMessage: {
            procedureName,
            serviceName
          },
          extras: {
            error: errorMsg,
            originalException: err
          },
          tags: ["uncaught-handler-error"]
        }
      );
      onServerCancel({
        code: UNCAUGHT_ERROR_CODE,
        message: errorMsg
      });
    };
    if (procClosesWithInit) {
      closeReadable();
    }
    const handlerContextWithSpan = {
      ...serviceContext,
      from,
      sessionId,
      metadata: sessionMetadata,
      span,
      cancel: (message) => {
        const errRes = {
          code: CANCEL_CODE,
          message: message ?? "cancelled by server procedure handler"
        };
        onServerCancel(errRes);
        return Err(errRes);
      },
      signal: finishedController.signal
    };
    const middlewareContext = {
      ...serviceContext,
      sessionId,
      from,
      metadata: sessionMetadata,
      span,
      signal: finishedController.signal,
      streamId,
      procedureName,
      serviceName
    };
    const runProcedureHandler = async () => {
      switch (procedure.type) {
        case "rpc":
          try {
            const responsePayload = await procedure.handler({
              ctx: handlerContextWithSpan,
              reqInit: initPayload
            });
            if (resWritable.isClosed()) {
              return;
            }
            resWritable.write(responsePayload);
          } catch (err) {
            onHandlerError(err, span);
          } finally {
            span.end();
          }
          break;
        case "stream":
          try {
            await procedure.handler({
              ctx: handlerContextWithSpan,
              reqInit: initPayload,
              reqReadable,
              resWritable
            });
          } catch (err) {
            onHandlerError(err, span);
          } finally {
            span.end();
          }
          break;
        case "subscription":
          try {
            await procedure.handler({
              ctx: handlerContextWithSpan,
              reqInit: initPayload,
              resWritable
            });
          } catch (err) {
            onHandlerError(err, span);
          } finally {
            span.end();
          }
          break;
        case "upload":
          try {
            const responsePayload = await procedure.handler({
              ctx: handlerContextWithSpan,
              reqInit: initPayload,
              reqReadable
            });
            if (resWritable.isClosed()) {
              return;
            }
            resWritable.write(responsePayload);
          } catch (err) {
            onHandlerError(err, span);
          } finally {
            span.end();
          }
          break;
      }
    };
    this.middlewares.reduceRight(
      (next, middleware) => {
        return () => {
          middleware({
            ctx: middlewareContext,
            reqInit: initPayload,
            next
          });
        };
      },
      () => {
        void runProcedureHandler();
      }
    )();
    if (!finishedController.signal.aborted) {
      this.streams.set(streamId, procStream);
    }
  }
  getContext(service, serviceName) {
    const context2 = this.contextMap.get(service);
    if (!context2) {
      const err = `no context found for ${serviceName}`;
      this.log?.error(err, {
        clientId: this.transport.clientId,
        tags: ["invariant-violation"]
      });
      throw new Error(err);
    }
    return context2;
  }
  validateNewProcStream(initMessage) {
    const session = this.transport.sessions.get(initMessage.from);
    if (!session) {
      this.log?.error(`couldn't find session for ${initMessage.from}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ["invariant-violation"]
      });
      return null;
    }
    const sessionScopedSend = this.transport.getSessionBoundSendFn(
      initMessage.from,
      session.id
    );
    const cancelStream = (streamId, payload) => {
      this.cancelStream(initMessage.from, sessionScopedSend, streamId, payload);
    };
    const sessionMetadata = this.transport.sessionHandshakeMetadata.get(
      session.to
    );
    if (!sessionMetadata) {
      const errMessage = `session doesn't have handshake metadata`;
      this.log?.error(errMessage, {
        ...session.loggingMetadata,
        tags: ["invariant-violation"]
      });
      cancelStream(
        initMessage.streamId,
        Err({
          code: UNCAUGHT_ERROR_CODE,
          message: errMessage
        })
      );
      return null;
    }
    if (!isStreamOpen(initMessage.controlFlags)) {
      const errMessage = `can't create a new procedure stream from a message that doesn't have the stream open bit set`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ["invalid-request"]
      });
      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage
        })
      );
      return null;
    }
    if (!initMessage.serviceName) {
      const errMessage = `missing service name in stream open message`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        transportMessage: initMessage,
        tags: ["invalid-request"]
      });
      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage
        })
      );
      return null;
    }
    if (!initMessage.procedureName) {
      const errMessage = `missing procedure name in stream open message`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        transportMessage: initMessage,
        tags: ["invalid-request"]
      });
      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage
        })
      );
      return null;
    }
    if (!(initMessage.serviceName in this.services)) {
      const errMessage = `couldn't find service ${initMessage.serviceName}`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ["invalid-request"]
      });
      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage
        })
      );
      return null;
    }
    const service = this.services[initMessage.serviceName];
    if (!(initMessage.procedureName in service.procedures)) {
      const errMessage = `couldn't find a matching procedure for ${initMessage.serviceName}.${initMessage.procedureName}`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        transportMessage: initMessage,
        tags: ["invalid-request"]
      });
      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage
        })
      );
      return null;
    }
    const serviceContext = this.getContext(service, initMessage.serviceName);
    const procedure = service.procedures[initMessage.procedureName];
    if (!["rpc", "upload", "stream", "subscription"].includes(procedure.type)) {
      this.log?.error(
        `got request for invalid procedure type ${procedure.type} at ${initMessage.serviceName}.${initMessage.procedureName}`,
        {
          ...session.loggingMetadata,
          transportMessage: initMessage,
          tags: ["invariant-violation"]
        }
      );
      return null;
    }
    let passInitAsDataForBackwardsCompat = false;
    if (session.protocolVersion === "v1.1" && (procedure.type === "upload" || procedure.type === "stream") && Value.Check(procedure.requestData, initMessage.payload) && Value.Check(procedure.requestInit, {})) {
      passInitAsDataForBackwardsCompat = true;
    } else if (!Value.Check(procedure.requestInit, initMessage.payload)) {
      const errMessage = `procedure init failed validation`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ["invalid-request"]
      });
      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage
        })
      );
      return null;
    }
    return {
      initialSession: session,
      streamId: initMessage.streamId,
      procedureName: initMessage.procedureName,
      serviceName: initMessage.serviceName,
      tracingCtx: initMessage.tracing,
      initPayload: initMessage.payload,
      sessionMetadata,
      procedure,
      serviceContext,
      procClosesWithInit: isStreamCloseBackwardsCompat(
        initMessage.controlFlags,
        session.protocolVersion
      ),
      passInitAsDataForBackwardsCompat
    };
  }
  cancelStream(to, sessionScopedSend, streamId, payload) {
    let cancelledStreamsInSession = this.serverCancelledStreams.get(to);
    if (!cancelledStreamsInSession) {
      cancelledStreamsInSession = new LRUSet(
        this.maxCancelledStreamTombstonesPerSession
      );
      this.serverCancelledStreams.set(to, cancelledStreamsInSession);
    }
    cancelledStreamsInSession.add(streamId);
    const msg = cancelMessage(streamId, payload);
    sessionScopedSend(msg);
  }
  async close() {
    this.unregisterTransportListeners();
    for (const serviceName of Object.keys(this.services)) {
      const service = this.services[serviceName];
      await service[Symbol.asyncDispose]();
    }
  }
};
var LRUSet = class {
  items;
  maxItems;
  constructor(maxItems) {
    this.items = /* @__PURE__ */ new Set();
    this.maxItems = maxItems;
  }
  add(item) {
    if (this.items.has(item)) {
      this.items.delete(item);
    } else if (this.items.size >= this.maxItems) {
      const first = this.items.values().next();
      if (!first.done) {
        this.items.delete(first.value);
      }
    }
    this.items.add(item);
  }
  has(item) {
    return this.items.has(item);
  }
};
function isStreamCancelBackwardsCompat(controlFlags, protocolVersion) {
  if (protocolVersion === "v1.1") {
    return false;
  }
  return isStreamCancel(controlFlags);
}
function isStreamCloseBackwardsCompat(controlFlags, protocolVersion) {
  if (protocolVersion === "v1.1") {
    return isStreamCancel(controlFlags);
  }
  return isStreamClose(controlFlags);
}
function getStreamCloseBackwardsCompat(protocolVersion) {
  if (protocolVersion === "v1.1") {
    return 4 /* StreamCancelBit */;
  }
  return 8 /* StreamClosedBit */;
}
function createServer(transport, services2, providedServerOptions) {
  return new RiverServer(
    transport,
    services2,
    providedServerOptions?.handshakeOptions,
    providedServerOptions?.extendedContext,
    providedServerOptions?.maxCancelledStreamTombstonesPerSession,
    providedServerOptions?.middlewares
  );
}

// router/handshake.ts
function createServerHandshakeOptions(schema, validate) {
  return { schema, validate };
}

// package.json
var version = "0.212.2";

// tracing/index.ts
function createSessionTelemetryInfo(tracer, sessionId, to, from, propagationCtx) {
  const parentCtx = propagationCtx ? propagation.extract(context.active(), propagationCtx) : context.active();
  const span = tracer.startSpan(
    `river.session`,
    {
      attributes: {
        component: "river",
        "river.session.id": sessionId,
        "river.session.to": to,
        "river.session.from": from
      }
    },
    parentCtx
  );
  const ctx = trace.setSpan(parentCtx, span);
  return { span, ctx };
}
function createConnectionTelemetryInfo(tracer, connection, info) {
  const span = tracer.startSpan(
    `river.connection`,
    {
      attributes: {
        component: "river",
        "river.connection.id": connection.id
      },
      links: [{ context: info.span.spanContext() }]
    },
    info.ctx
  );
  const ctx = trace.setSpan(info.ctx, span);
  return { span, ctx };
}
function createHandlerSpan(tracer, session, kind, serviceName, procedureName, streamId, tracing, fn) {
  const ctx = tracing ? propagation.extract(context.active(), tracing) : context.active();
  return tracer.startActiveSpan(
    `river.server.${serviceName}.${procedureName}`,
    {
      attributes: {
        component: "river",
        "river.method.kind": kind,
        "river.method.service": serviceName,
        "river.method.name": procedureName,
        "river.streamId": streamId,
        "span.kind": "server"
      },
      links: [{ context: session.telemetry.span.spanContext() }],
      kind: SpanKind.SERVER
    },
    ctx,
    fn
  );
}
function recordRiverError(span, error) {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message
  });
  span.setAttributes({
    "river.error_code": error.code,
    "river.error_message": error.message
  });
}
function getTracer() {
  return trace.getTracer("river", version);
}

// transport/sessionStateMachine/SessionWaitingForHandshake.ts
var SessionWaitingForHandshake = class extends CommonSession {
  state = "WaitingForHandshake" /* WaitingForHandshake */;
  conn;
  listeners;
  handshakeTimeout;
  constructor(props) {
    super(props);
    this.conn = props.conn;
    this.listeners = props.listeners;
    this.handshakeTimeout = setTimeout(() => {
      this.listeners.onHandshakeTimeout();
    }, this.options.handshakeTimeoutMs);
    this.conn.setDataListener(this.onHandshakeData);
    this.conn.setErrorListener(this.listeners.onConnectionErrored);
    this.conn.setCloseListener(this.listeners.onConnectionClosed);
  }
  get loggingMetadata() {
    return {
      clientId: this.from,
      connId: this.conn.id,
      ...this.conn.loggingMetadata
    };
  }
  onHandshakeData = (msg) => {
    const parsedMsgRes = this.codec.fromBuffer(msg);
    if (!parsedMsgRes.ok) {
      this.listeners.onInvalidHandshake(
        `could not parse handshake message: ${parsedMsgRes.reason}`,
        "MALFORMED_HANDSHAKE"
      );
      return;
    }
    this.listeners.onHandshake(parsedMsgRes.value);
  };
  sendHandshake(msg) {
    return sendMessage(this.conn, this.codec, msg);
  }
  _handleStateExit() {
    this.conn.removeDataListener();
    this.conn.removeErrorListener();
    this.conn.removeCloseListener();
    clearTimeout(this.handshakeTimeout);
    this.handshakeTimeout = void 0;
  }
  _handleClose() {
    this.conn.close();
  }
};

// transport/sessionStateMachine/SessionHandshaking.ts
var SessionHandshaking = class extends IdentifiedSessionWithGracePeriod {
  state = "Handshaking" /* Handshaking */;
  conn;
  listeners;
  handshakeTimeout;
  constructor(props) {
    super(props);
    this.conn = props.conn;
    this.listeners = props.listeners;
    this.handshakeTimeout = setTimeout(() => {
      this.listeners.onHandshakeTimeout();
    }, this.options.handshakeTimeoutMs);
    this.conn.setDataListener(this.onHandshakeData);
    this.conn.setErrorListener(this.listeners.onConnectionErrored);
    this.conn.setCloseListener(this.listeners.onConnectionClosed);
  }
  get loggingMetadata() {
    return {
      ...super.loggingMetadata,
      ...this.conn.loggingMetadata
    };
  }
  onHandshakeData = (msg) => {
    const parsedMsgRes = this.codec.fromBuffer(msg);
    if (!parsedMsgRes.ok) {
      this.listeners.onInvalidHandshake(
        `could not parse handshake message: ${parsedMsgRes.reason}`,
        "MALFORMED_HANDSHAKE"
      );
      return;
    }
    this.listeners.onHandshake(parsedMsgRes.value);
  };
  sendHandshake(msg) {
    return sendMessage(this.conn, this.codec, msg);
  }
  _handleStateExit() {
    super._handleStateExit();
    this.conn.removeDataListener();
    this.conn.removeErrorListener();
    this.conn.removeCloseListener();
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = void 0;
    }
  }
  _handleClose() {
    super._handleClose();
    this.conn.close();
  }
};

// transport/sessionStateMachine/SessionConnected.ts
var SessionConnected = class extends IdentifiedSession {
  state = "Connected" /* Connected */;
  conn;
  listeners;
  heartbeatHandle;
  heartbeatMissTimeout;
  isActivelyHeartbeating = false;
  updateBookkeeping(ack, seq) {
    this.sendBuffer = this.sendBuffer.filter((unacked) => unacked.seq >= ack);
    this.ack = seq + 1;
    if (this.heartbeatMissTimeout) {
      clearTimeout(this.heartbeatMissTimeout);
    }
    this.startMissingHeartbeatTimeout();
  }
  assertSendOrdering(constructedMsg) {
    if (constructedMsg.seq > this.seqSent + 1) {
      const msg = `invariant violation: would have sent out of order msg (seq: ${constructedMsg.seq}, expected: ${this.seqSent} + 1)`;
      this.log?.error(msg, {
        ...this.loggingMetadata,
        transportMessage: constructedMsg,
        tags: ["invariant-violation"]
      });
      throw new Error(msg);
    }
  }
  send(msg) {
    const constructedMsg = this.constructMsg(msg);
    this.assertSendOrdering(constructedMsg);
    this.sendBuffer.push(constructedMsg);
    const res = sendMessage(this.conn, this.codec, constructedMsg);
    if (!res.ok) {
      this.listeners.onMessageSendFailure(constructedMsg, res.reason);
      return res;
    }
    this.seqSent = constructedMsg.seq;
    return res;
  }
  constructor(props) {
    super(props);
    this.conn = props.conn;
    this.listeners = props.listeners;
    this.conn.setDataListener(this.onMessageData);
    this.conn.setCloseListener(this.listeners.onConnectionClosed);
    this.conn.setErrorListener(this.listeners.onConnectionErrored);
  }
  sendBufferedMessages() {
    if (this.sendBuffer.length > 0) {
      this.log?.info(
        `sending ${this.sendBuffer.length} buffered messages, starting at seq ${this.nextSeq()}`,
        this.loggingMetadata
      );
      for (const msg of this.sendBuffer) {
        this.assertSendOrdering(msg);
        const res = sendMessage(this.conn, this.codec, msg);
        if (!res.ok) {
          this.listeners.onMessageSendFailure(msg, res.reason);
          return res;
        }
        this.seqSent = msg.seq;
      }
    }
    return { ok: true, value: void 0 };
  }
  get loggingMetadata() {
    return {
      ...super.loggingMetadata,
      ...this.conn.loggingMetadata
    };
  }
  startMissingHeartbeatTimeout() {
    const maxMisses = this.options.heartbeatsUntilDead;
    const missDuration = maxMisses * this.options.heartbeatIntervalMs;
    this.heartbeatMissTimeout = setTimeout(() => {
      this.log?.info(
        `closing connection to ${this.to} due to inactivity (missed ${maxMisses} heartbeats which is ${missDuration}ms)`,
        this.loggingMetadata
      );
      this.telemetry.span.addEvent(
        "closing connection due to missing heartbeat"
      );
      this.conn.close();
    }, missDuration);
  }
  startActiveHeartbeat() {
    this.isActivelyHeartbeating = true;
    this.heartbeatHandle = setInterval(() => {
      this.sendHeartbeat();
    }, this.options.heartbeatIntervalMs);
  }
  sendHeartbeat() {
    this.log?.debug("sending heartbeat", this.loggingMetadata);
    const heartbeat = {
      streamId: "heartbeat",
      controlFlags: 1 /* AckBit */,
      payload: {
        type: "ACK"
      }
    };
    this.send(heartbeat);
  }
  onMessageData = (msg) => {
    const parsedMsgRes = this.codec.fromBuffer(msg);
    if (!parsedMsgRes.ok) {
      this.listeners.onInvalidMessage(
        `could not parse message: ${parsedMsgRes.reason}`
      );
      return;
    }
    const parsedMsg = parsedMsgRes.value;
    if (parsedMsg.seq !== this.ack) {
      if (parsedMsg.seq < this.ack) {
        this.log?.debug(
          `received duplicate msg (got seq: ${parsedMsg.seq}, wanted seq: ${this.ack}), discarding`,
          {
            ...this.loggingMetadata,
            transportMessage: parsedMsg
          }
        );
      } else {
        const reason = `received out-of-order msg, closing connection (got seq: ${parsedMsg.seq}, wanted seq: ${this.ack})`;
        this.log?.error(reason, {
          ...this.loggingMetadata,
          transportMessage: parsedMsg,
          tags: ["invariant-violation"]
        });
        this.telemetry.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: reason
        });
        this.conn.close();
      }
      return;
    }
    this.log?.debug(`received msg`, {
      ...this.loggingMetadata,
      transportMessage: parsedMsg
    });
    this.updateBookkeeping(parsedMsg.ack, parsedMsg.seq);
    if (!isAck(parsedMsg.controlFlags)) {
      this.listeners.onMessage(parsedMsg);
      return;
    }
    this.log?.debug(`discarding msg (ack bit set)`, {
      ...this.loggingMetadata,
      transportMessage: parsedMsg
    });
    if (!this.isActivelyHeartbeating) {
      this.sendHeartbeat();
    }
  };
  _handleStateExit() {
    super._handleStateExit();
    this.conn.removeDataListener();
    this.conn.removeCloseListener();
    this.conn.removeErrorListener();
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = void 0;
    }
    if (this.heartbeatMissTimeout) {
      clearTimeout(this.heartbeatMissTimeout);
      this.heartbeatMissTimeout = void 0;
    }
  }
  _handleClose() {
    super._handleClose();
    this.conn.close();
  }
};

// transport/sessionStateMachine/SessionBackingOff.ts
var SessionBackingOff = class extends IdentifiedSessionWithGracePeriod {
  state = "BackingOff" /* BackingOff */;
  listeners;
  backoffTimeout;
  constructor(props) {
    super(props);
    this.listeners = props.listeners;
    this.backoffTimeout = setTimeout(() => {
      this.listeners.onBackoffFinished();
    }, props.backoffMs);
  }
  _handleClose() {
    super._handleClose();
  }
  _handleStateExit() {
    super._handleStateExit();
    if (this.backoffTimeout) {
      clearTimeout(this.backoffTimeout);
      this.backoffTimeout = void 0;
    }
  }
};

// codec/adapter.ts
import { Value as Value2 } from "@sinclair/typebox/value";
var CodecMessageAdapter = class {
  constructor(codec) {
    this.codec = codec;
  }
  toBuffer(msg) {
    try {
      return {
        ok: true,
        value: this.codec.toBuffer(msg)
      };
    } catch (e) {
      return {
        ok: false,
        reason: coerceErrorString(e)
      };
    }
  }
  fromBuffer(buf) {
    try {
      const parsedMsg = this.codec.fromBuffer(buf);
      if (!Value2.Check(OpaqueTransportMessageSchema, parsedMsg)) {
        return {
          ok: false,
          reason: "transport message schema mismatch"
        };
      }
      return {
        ok: true,
        value: parsedMsg
      };
    } catch (e) {
      return {
        ok: false,
        reason: coerceErrorString(e)
      };
    }
  }
};

// transport/sessionStateMachine/transitions.ts
function inheritSharedSession(session) {
  return {
    id: session.id,
    from: session.from,
    to: session.to,
    seq: session.seq,
    ack: session.ack,
    seqSent: session.seqSent,
    sendBuffer: session.sendBuffer,
    telemetry: session.telemetry,
    options: session.options,
    log: session.log,
    tracer: session.tracer,
    protocolVersion: session.protocolVersion,
    codec: session.codec
  };
}
function inheritSharedSessionWithGrace(session) {
  return {
    ...inheritSharedSession(session),
    graceExpiryTime: session.graceExpiryTime
  };
}
var SessionStateGraph = {
  entrypoints: {
    NoConnection: (to, from, listeners, options, protocolVersion, tracer, log) => {
      const id = `session-${generateId()}`;
      const telemetry = createSessionTelemetryInfo(tracer, id, to, from);
      const sendBuffer = [];
      const session = new SessionNoConnection({
        listeners,
        id,
        from,
        to,
        seq: 0,
        ack: 0,
        seqSent: 0,
        graceExpiryTime: Date.now() + options.sessionDisconnectGraceMs,
        sendBuffer,
        telemetry,
        options,
        protocolVersion,
        tracer,
        log,
        codec: new CodecMessageAdapter(options.codec)
      });
      session.log?.info(`session ${session.id} created in NoConnection state`, {
        ...session.loggingMetadata,
        tags: ["state-transition"]
      });
      return session;
    },
    WaitingForHandshake: (from, conn, listeners, options, tracer, log) => {
      const session = new SessionWaitingForHandshake({
        conn,
        listeners,
        from,
        options,
        tracer,
        log,
        codec: new CodecMessageAdapter(options.codec)
      });
      session.log?.info(`session created in WaitingForHandshake state`, {
        ...session.loggingMetadata,
        tags: ["state-transition"]
      });
      return session;
    }
  },
  // All of the transitions 'move'/'consume' the old session and return a new one.
  // After a session is transitioned, any usage of the old session will throw.
  transition: {
    // happy path transitions
    NoConnectionToBackingOff: (oldSession, backoffMs, listeners) => {
      const carriedState = inheritSharedSessionWithGrace(oldSession);
      oldSession._handleStateExit();
      const session = new SessionBackingOff({
        backoffMs,
        listeners,
        ...carriedState
      });
      session.log?.info(
        `session ${session.id} transition from NoConnection to BackingOff`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    },
    BackingOffToConnecting: (oldSession, connPromise, listeners) => {
      const carriedState = inheritSharedSessionWithGrace(oldSession);
      oldSession._handleStateExit();
      const session = new SessionConnecting({
        connPromise,
        listeners,
        ...carriedState
      });
      session.log?.info(
        `session ${session.id} transition from BackingOff to Connecting`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    },
    ConnectingToHandshaking: (oldSession, conn, listeners) => {
      const carriedState = inheritSharedSessionWithGrace(oldSession);
      oldSession._handleStateExit();
      const session = new SessionHandshaking({
        conn,
        listeners,
        ...carriedState
      });
      conn.telemetry = createConnectionTelemetryInfo(
        session.tracer,
        conn,
        session.telemetry
      );
      session.log?.info(
        `session ${session.id} transition from Connecting to Handshaking`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    },
    HandshakingToConnected: (oldSession, listeners) => {
      const carriedState = inheritSharedSession(oldSession);
      const conn = oldSession.conn;
      oldSession._handleStateExit();
      const session = new SessionConnected({
        conn,
        listeners,
        ...carriedState
      });
      session.startMissingHeartbeatTimeout();
      session.log?.info(
        `session ${session.id} transition from Handshaking to Connected`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    },
    WaitingForHandshakeToConnected: (pendingSession, oldSession, sessionId, to, propagationCtx, listeners, protocolVersion) => {
      const conn = pendingSession.conn;
      const { from, options } = pendingSession;
      const carriedState = oldSession ? (
        // old session exists, inherit state
        inheritSharedSession(oldSession)
      ) : (
        // old session does not exist, create new state
        {
          id: sessionId,
          from,
          to,
          seq: 0,
          ack: 0,
          seqSent: 0,
          sendBuffer: [],
          telemetry: createSessionTelemetryInfo(
            pendingSession.tracer,
            sessionId,
            to,
            from,
            propagationCtx
          ),
          options,
          tracer: pendingSession.tracer,
          log: pendingSession.log,
          protocolVersion,
          codec: new CodecMessageAdapter(options.codec)
        }
      );
      pendingSession._handleStateExit();
      oldSession?._handleStateExit();
      const session = new SessionConnected({
        conn,
        listeners,
        ...carriedState
      });
      session.startMissingHeartbeatTimeout();
      conn.telemetry = createConnectionTelemetryInfo(
        session.tracer,
        conn,
        session.telemetry
      );
      session.log?.info(
        `session ${session.id} transition from WaitingForHandshake to Connected`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    },
    // disconnect paths
    BackingOffToNoConnection: (oldSession, listeners) => {
      const carriedState = inheritSharedSessionWithGrace(oldSession);
      oldSession._handleStateExit();
      const session = new SessionNoConnection({
        listeners,
        ...carriedState
      });
      session.log?.info(
        `session ${session.id} transition from BackingOff to NoConnection`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    },
    ConnectingToNoConnection: (oldSession, listeners) => {
      const carriedState = inheritSharedSessionWithGrace(oldSession);
      oldSession.bestEffortClose();
      oldSession._handleStateExit();
      const session = new SessionNoConnection({
        listeners,
        ...carriedState
      });
      session.log?.info(
        `session ${session.id} transition from Connecting to NoConnection`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    },
    HandshakingToNoConnection: (oldSession, listeners) => {
      const carriedState = inheritSharedSessionWithGrace(oldSession);
      oldSession.conn.close();
      oldSession._handleStateExit();
      const session = new SessionNoConnection({
        listeners,
        ...carriedState
      });
      session.log?.info(
        `session ${session.id} transition from Handshaking to NoConnection`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    },
    ConnectedToNoConnection: (oldSession, listeners) => {
      const carriedState = inheritSharedSession(oldSession);
      const graceExpiryTime = Date.now() + oldSession.options.sessionDisconnectGraceMs;
      oldSession.conn.close();
      oldSession._handleStateExit();
      const session = new SessionNoConnection({
        listeners,
        graceExpiryTime,
        ...carriedState
      });
      session.log?.info(
        `session ${session.id} transition from Connected to NoConnection`,
        {
          ...session.loggingMetadata,
          tags: ["state-transition"]
        }
      );
      return session;
    }
  }
};
var transitions = SessionStateGraph.transition;
var ClientSessionStateGraph = {
  entrypoint: SessionStateGraph.entrypoints.NoConnection,
  transition: {
    // happy paths
    // NoConnection -> BackingOff: attempt to connect
    NoConnectionToBackingOff: transitions.NoConnectionToBackingOff,
    // BackingOff -> Connecting: backoff period elapsed, start connection
    BackingOffToConnecting: transitions.BackingOffToConnecting,
    // Connecting -> Handshaking: connection established, start handshake
    ConnectingToHandshaking: transitions.ConnectingToHandshaking,
    // Handshaking -> Connected: handshake complete, session ready
    HandshakingToConnected: transitions.HandshakingToConnected,
    // disconnect paths
    // BackingOff -> NoConnection: unused
    BackingOffToNoConnection: transitions.BackingOffToNoConnection,
    // Connecting -> NoConnection: connection failed or connection timeout
    ConnectingToNoConnection: transitions.ConnectingToNoConnection,
    // Handshaking -> NoConnection: connection closed or handshake timeout
    HandshakingToNoConnection: transitions.HandshakingToNoConnection,
    // Connected -> NoConnection: connection closed
    ConnectedToNoConnection: transitions.ConnectedToNoConnection
    // destroy/close paths
    // NoConnection -> x: grace period elapsed
    // BackingOff -> x: grace period elapsed
    // Connecting -> x: grace period elapsed
    // Handshaking -> x: grace period elapsed or invalid handshake message or handshake rejection
    // Connected -> x: grace period elapsed or invalid message
  }
};
var ServerSessionStateGraph = {
  entrypoint: SessionStateGraph.entrypoints.WaitingForHandshake,
  transition: {
    // happy paths
    // WaitingForHandshake -> Connected: handshake complete, session ready
    WaitingForHandshakeToConnected: transitions.WaitingForHandshakeToConnected,
    // disconnect paths
    // Connected -> NoConnection: connection closed
    ConnectedToNoConnection: transitions.ConnectedToNoConnection
    // destroy/close paths
    // WaitingForHandshake -> x: handshake timeout elapsed or invalid handshake message or handshake rejection or connection closed
  }
};

// transport/transport.ts
var Transport = class {
  /**
   * The status of the transport.
   */
  status;
  /**
   * The client ID of this transport.
   */
  clientId;
  /**
   * The event dispatcher for handling events of type EventTypes.
   */
  eventDispatcher;
  /**
   * The options for this transport.
   */
  options;
  log;
  tracer;
  sessions;
  /**
   * Creates a new Transport instance.
   * @param codec The codec used to encode and decode messages.
   * @param clientId The client ID of this transport.
   */
  constructor(clientId, providedOptions) {
    this.options = { ...defaultTransportOptions, ...providedOptions };
    this.eventDispatcher = new EventDispatcher();
    this.clientId = clientId;
    this.status = "open";
    this.sessions = /* @__PURE__ */ new Map();
    this.tracer = getTracer();
  }
  bindLogger(fn, level) {
    if (typeof fn === "function") {
      this.log = createLogProxy(new BaseLogger(fn, level));
      return;
    }
    this.log = createLogProxy(fn);
  }
  /**
   * Called when a message is received by this transport.
   * You generally shouldn't need to override this in downstream transport implementations.
   * @param message The received message.
   */
  handleMsg(message) {
    if (this.getStatus() !== "open") return;
    this.eventDispatcher.dispatchEvent("message", message);
  }
  /**
   * Adds a listener to this transport.
   * @param the type of event to listen for
   * @param handler The message handler to add.
   */
  addEventListener(type, handler) {
    this.eventDispatcher.addEventListener(type, handler);
  }
  /**
   * Removes a listener from this transport.
   * @param the type of event to un-listen on
   * @param handler The message handler to remove.
   */
  removeEventListener(type, handler) {
    this.eventDispatcher.removeEventListener(type, handler);
  }
  protocolError(message) {
    this.eventDispatcher.dispatchEvent("protocolError", message);
  }
  /**
   * Default close implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.close() at the end.
   * Closes the transport. Any messages sent while the transport is closed will be silently discarded.
   */
  close() {
    this.status = "closed";
    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      this.deleteSession(session);
    }
    this.eventDispatcher.dispatchEvent("transportStatus", {
      status: this.status
    });
    this.eventDispatcher.removeAllListeners();
    this.log?.info(`manually closed transport`, { clientId: this.clientId });
  }
  getStatus() {
    return this.status;
  }
  // state transitions
  createSession(session) {
    const activeSession = this.sessions.get(session.to);
    if (activeSession) {
      const msg = `attempt to create session for ${session.to} but active session (${activeSession.id}) already exists`;
      this.log?.error(msg, {
        ...session.loggingMetadata,
        tags: ["invariant-violation"]
      });
      throw new Error(msg);
    }
    this.sessions.set(session.to, session);
    this.eventDispatcher.dispatchEvent("sessionStatus", {
      status: "created",
      session
    });
    this.eventDispatcher.dispatchEvent("sessionTransition", {
      state: session.state,
      id: session.id
    });
  }
  updateSession(session) {
    const activeSession = this.sessions.get(session.to);
    if (!activeSession) {
      const msg = `attempt to transition session for ${session.to} but no active session exists`;
      this.log?.error(msg, {
        ...session.loggingMetadata,
        tags: ["invariant-violation"]
      });
      throw new Error(msg);
    }
    if (activeSession.id !== session.id) {
      const msg = `attempt to transition active session for ${session.to} but active session (${activeSession.id}) is different from handle (${session.id})`;
      this.log?.error(msg, {
        ...session.loggingMetadata,
        tags: ["invariant-violation"]
      });
      throw new Error(msg);
    }
    this.sessions.set(session.to, session);
    this.eventDispatcher.dispatchEvent("sessionTransition", {
      state: session.state,
      id: session.id
    });
  }
  deleteSession(session, options) {
    if (session._isConsumed) return;
    const loggingMetadata = session.loggingMetadata;
    if (loggingMetadata.tags && options?.unhealthy) {
      loggingMetadata.tags.push("unhealthy-session");
    }
    session.log?.info(`closing session ${session.id}`, loggingMetadata);
    this.eventDispatcher.dispatchEvent("sessionStatus", {
      status: "closing",
      session
    });
    const to = session.to;
    session.close();
    this.sessions.delete(to);
    this.eventDispatcher.dispatchEvent("sessionStatus", {
      status: "closed",
      session: { id: session.id, to }
    });
  }
  // common listeners
  onSessionGracePeriodElapsed(session) {
    this.log?.info(
      `session to ${session.to} grace period elapsed, closing`,
      session.loggingMetadata
    );
    this.deleteSession(session);
  }
  onConnectingFailed(session) {
    const noConnectionSession = SessionStateGraph.transition.ConnectingToNoConnection(session, {
      onSessionGracePeriodElapsed: () => {
        this.onSessionGracePeriodElapsed(noConnectionSession);
      }
    });
    this.updateSession(noConnectionSession);
    return noConnectionSession;
  }
  onConnClosed(session) {
    let noConnectionSession;
    if (session.state === "Handshaking" /* Handshaking */) {
      noConnectionSession = SessionStateGraph.transition.HandshakingToNoConnection(session, {
        onSessionGracePeriodElapsed: () => {
          this.onSessionGracePeriodElapsed(noConnectionSession);
        }
      });
    } else {
      noConnectionSession = SessionStateGraph.transition.ConnectedToNoConnection(session, {
        onSessionGracePeriodElapsed: () => {
          this.onSessionGracePeriodElapsed(noConnectionSession);
        }
      });
    }
    this.updateSession(noConnectionSession);
    return noConnectionSession;
  }
  /**
   * Gets a send closure scoped to a specific session. Sending using the returned
   * closure after the session has transitioned to a different state will be a noop.
   *
   * Session objects themselves can become stale as they transition between
   * states. As stale sessions cannot be used again (and will throw), holding
   * onto a session object is not recommended.
   */
  getSessionBoundSendFn(to, sessionId) {
    if (this.getStatus() !== "open") {
      throw new Error("cannot get a bound send function on a closed transport");
    }
    return (msg) => {
      const session = this.sessions.get(to);
      if (!session) {
        throw new Error(
          `session scope for ${sessionId} has ended (close), can't send`
        );
      }
      const sameSession = session.id === sessionId;
      if (!sameSession || session._isConsumed) {
        throw new Error(
          `session scope for ${sessionId} has ended (transition), can't send`
        );
      }
      const res = session.send(msg);
      if (!res.ok) {
        throw new Error(res.reason);
      }
      return res.value;
    };
  }
};

// transport/server.ts
import { Value as Value3 } from "@sinclair/typebox/value";
var ServerTransport = class extends Transport {
  /**
   * The options for this transport.
   */
  options;
  /**
   * Optional handshake options for the server.
   */
  handshakeExtensions;
  /**
   * A map of session handshake data for each session.
   */
  sessionHandshakeMetadata = /* @__PURE__ */ new Map();
  sessions = /* @__PURE__ */ new Map();
  pendingSessions = /* @__PURE__ */ new Set();
  constructor(clientId, providedOptions) {
    super(clientId, providedOptions);
    this.sessions = /* @__PURE__ */ new Map();
    this.options = {
      ...defaultServerTransportOptions,
      ...providedOptions
    };
    this.log?.info(`initiated server transport`, {
      clientId: this.clientId,
      protocolVersion: currentProtocolVersion
    });
  }
  extendHandshake(options) {
    this.handshakeExtensions = options;
  }
  deletePendingSession(pendingSession) {
    pendingSession.close();
    this.pendingSessions.delete(pendingSession);
  }
  deleteSession(session, options) {
    this.sessionHandshakeMetadata.delete(session.to);
    super.deleteSession(session, options);
  }
  handleConnection(conn) {
    if (this.getStatus() !== "open") return;
    this.log?.info(`new incoming connection`, {
      ...conn.loggingMetadata,
      clientId: this.clientId
    });
    let receivedHandshake = false;
    const pendingSession = ServerSessionStateGraph.entrypoint(
      this.clientId,
      conn,
      {
        onConnectionClosed: () => {
          this.log?.warn(
            `connection from unknown closed before handshake finished`,
            pendingSession.loggingMetadata
          );
          this.deletePendingSession(pendingSession);
        },
        onConnectionErrored: (err) => {
          const errorString = coerceErrorString(err);
          this.log?.warn(
            `connection from unknown errored before handshake finished: ${errorString}`,
            pendingSession.loggingMetadata
          );
          this.deletePendingSession(pendingSession);
        },
        onHandshakeTimeout: () => {
          this.log?.warn(
            `connection from unknown timed out before handshake finished`,
            pendingSession.loggingMetadata
          );
          this.deletePendingSession(pendingSession);
        },
        onHandshake: (msg) => {
          if (receivedHandshake) {
            this.log?.error(
              `received multiple handshake messages from pending session`,
              {
                ...pendingSession.loggingMetadata,
                connectedTo: msg.from,
                transportMessage: msg
              }
            );
            this.deletePendingSession(pendingSession);
            return;
          }
          receivedHandshake = true;
          void this.onHandshakeRequest(pendingSession, msg);
        },
        onInvalidHandshake: (reason, code) => {
          this.log?.error(
            `invalid handshake: ${reason}`,
            pendingSession.loggingMetadata
          );
          this.deletePendingSession(pendingSession);
          this.protocolError({
            type: ProtocolError.HandshakeFailed,
            code,
            message: reason
          });
        }
      },
      this.options,
      this.tracer,
      this.log
    );
    this.pendingSessions.add(pendingSession);
  }
  rejectHandshakeRequest(session, to, reason, code, metadata) {
    session.conn.telemetry?.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: reason
    });
    this.log?.warn(reason, metadata);
    const responseMsg = handshakeResponseMessage({
      from: this.clientId,
      to,
      status: {
        ok: false,
        code,
        reason
      }
    });
    const res = session.sendHandshake(responseMsg);
    if (!res.ok) {
      this.log?.error(`failed to send handshake response: ${res.reason}`, {
        ...session.loggingMetadata,
        transportMessage: responseMsg
      });
      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: res.reason
      });
      this.deletePendingSession(session);
      return;
    }
    this.protocolError({
      type: ProtocolError.HandshakeFailed,
      code,
      message: reason
    });
    this.deletePendingSession(session);
  }
  async onHandshakeRequest(session, msg) {
    if (!Value3.Check(ControlMessageHandshakeRequestSchema, msg.payload)) {
      this.rejectHandshakeRequest(
        session,
        msg.from,
        "received invalid handshake request",
        "MALFORMED_HANDSHAKE",
        {
          ...session.loggingMetadata,
          transportMessage: msg,
          connectedTo: msg.from,
          validationErrors: [
            ...Value3.Errors(ControlMessageHandshakeRequestSchema, msg.payload)
          ]
        }
      );
      return;
    }
    const gotVersion = msg.payload.protocolVersion;
    if (!isAcceptedProtocolVersion(gotVersion)) {
      this.rejectHandshakeRequest(
        session,
        msg.from,
        `expected protocol version oneof [${acceptedProtocolVersions.toString()}], got ${gotVersion}`,
        "PROTOCOL_VERSION_MISMATCH",
        {
          ...session.loggingMetadata,
          connectedTo: msg.from,
          transportMessage: msg
        }
      );
      return;
    }
    let parsedMetadata = {};
    if (this.handshakeExtensions) {
      if (!Value3.Check(this.handshakeExtensions.schema, msg.payload.metadata)) {
        this.rejectHandshakeRequest(
          session,
          msg.from,
          "received malformed handshake metadata",
          "MALFORMED_HANDSHAKE_META",
          {
            ...session.loggingMetadata,
            connectedTo: msg.from,
            validationErrors: [
              ...Value3.Errors(
                this.handshakeExtensions.schema,
                msg.payload.metadata
              )
            ]
          }
        );
        return;
      }
      const previousParsedMetadata = this.sessionHandshakeMetadata.get(
        msg.from
      );
      const parsedMetadataOrFailureCode = await this.handshakeExtensions.validate(
        msg.payload.metadata,
        previousParsedMetadata
      );
      if (session._isConsumed) {
        return;
      }
      if (Value3.Check(
        HandshakeErrorCustomHandlerFatalResponseCodes,
        parsedMetadataOrFailureCode
      )) {
        this.rejectHandshakeRequest(
          session,
          msg.from,
          "rejected by handshake handler",
          parsedMetadataOrFailureCode,
          {
            ...session.loggingMetadata,
            connectedTo: msg.from,
            clientId: this.clientId
          }
        );
        return;
      }
      parsedMetadata = parsedMetadataOrFailureCode;
    }
    let connectCase = "new session";
    const clientNextExpectedSeq = msg.payload.expectedSessionState.nextExpectedSeq;
    const clientNextSentSeq = msg.payload.expectedSessionState.nextSentSeq;
    let oldSession = this.sessions.get(msg.from);
    if (this.options.enableTransparentSessionReconnects && oldSession && oldSession.id === msg.payload.sessionId) {
      connectCase = "transparent reconnection";
      const ourNextSeq = oldSession.nextSeq();
      const ourAck = oldSession.ack;
      if (clientNextSentSeq > ourAck) {
        this.rejectHandshakeRequest(
          session,
          msg.from,
          `client is in the future: server wanted next message to be ${ourAck} but client would have sent ${clientNextSentSeq}`,
          "SESSION_STATE_MISMATCH",
          {
            ...session.loggingMetadata,
            connectedTo: msg.from,
            transportMessage: msg
          }
        );
        return;
      }
      if (ourNextSeq > clientNextExpectedSeq) {
        this.rejectHandshakeRequest(
          session,
          msg.from,
          `server is in the future: client wanted next message to be ${clientNextExpectedSeq} but server would have sent ${ourNextSeq}`,
          "SESSION_STATE_MISMATCH",
          {
            ...session.loggingMetadata,
            connectedTo: msg.from,
            transportMessage: msg
          }
        );
        return;
      }
      if (oldSession.state !== "NoConnection" /* NoConnection */) {
        const noConnectionSession = ServerSessionStateGraph.transition.ConnectedToNoConnection(
          oldSession,
          {
            onSessionGracePeriodElapsed: () => {
              this.onSessionGracePeriodElapsed(noConnectionSession);
            }
          }
        );
        oldSession = noConnectionSession;
        this.updateSession(oldSession);
      }
    } else if (oldSession) {
      connectCase = "hard reconnection";
      this.log?.info(
        `client is reconnecting to a new session (${msg.payload.sessionId}) with an old session (${oldSession.id}) already existing, closing old session`,
        {
          ...session.loggingMetadata,
          connectedTo: msg.from,
          sessionId: msg.payload.sessionId
        }
      );
      this.deleteSession(oldSession);
      oldSession = void 0;
    }
    if (!oldSession && (clientNextSentSeq > 0 || clientNextExpectedSeq > 0)) {
      connectCase = "unknown session";
      const rejectionMessage = this.options.enableTransparentSessionReconnects ? `client is trying to reconnect to a session the server don't know about: ${msg.payload.sessionId}` : `client is attempting a transparent reconnect to a session but the server does not support it: ${msg.payload.sessionId}`;
      this.rejectHandshakeRequest(
        session,
        msg.from,
        rejectionMessage,
        "SESSION_STATE_MISMATCH",
        {
          ...session.loggingMetadata,
          connectedTo: msg.from,
          transportMessage: msg
        }
      );
      return;
    }
    const sessionId = msg.payload.sessionId;
    this.log?.info(
      `handshake from ${msg.from} ok (${connectCase}), responding with handshake success`,
      {
        ...session.loggingMetadata,
        connectedTo: msg.from
      }
    );
    const responseMsg = handshakeResponseMessage({
      from: this.clientId,
      to: msg.from,
      status: {
        ok: true,
        sessionId
      }
    });
    const res = session.sendHandshake(responseMsg);
    if (!res.ok) {
      this.log?.error(`failed to send handshake response: ${res.reason}`, {
        ...session.loggingMetadata,
        transportMessage: responseMsg
      });
      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: res.reason
      });
      this.deletePendingSession(session);
      return;
    }
    this.pendingSessions.delete(session);
    const connectedSession = ServerSessionStateGraph.transition.WaitingForHandshakeToConnected(
      session,
      // by this point oldSession is either no connection or we dont have an old session
      oldSession,
      sessionId,
      msg.from,
      msg.tracing,
      {
        onConnectionErrored: (err) => {
          const errStr = coerceErrorString(err);
          this.log?.warn(
            `connection to ${connectedSession.to} errored: ${errStr}`,
            connectedSession.loggingMetadata
          );
        },
        onConnectionClosed: () => {
          this.log?.info(
            `connection to ${connectedSession.to} closed`,
            connectedSession.loggingMetadata
          );
          this.onConnClosed(connectedSession);
        },
        onMessage: (msg2) => {
          this.handleMsg(msg2);
        },
        onInvalidMessage: (reason) => {
          this.log?.error(`invalid message: ${reason}`, {
            ...connectedSession.loggingMetadata,
            transportMessage: msg
          });
          this.protocolError({
            type: ProtocolError.InvalidMessage,
            message: reason
          });
          this.deleteSession(connectedSession, { unhealthy: true });
        },
        onMessageSendFailure: (msg2, reason) => {
          this.log?.error(`failed to send message: ${reason}`, {
            ...connectedSession.loggingMetadata,
            transportMessage: msg2
          });
          this.protocolError({
            type: ProtocolError.MessageSendFailure,
            message: reason
          });
          this.deleteSession(connectedSession, { unhealthy: true });
        }
      },
      gotVersion
    );
    const bufferSendRes = connectedSession.sendBufferedMessages();
    if (!bufferSendRes.ok) {
      return;
    }
    this.sessionHandshakeMetadata.set(connectedSession.to, parsedMetadata);
    if (oldSession) {
      this.updateSession(connectedSession);
    } else {
      this.createSession(connectedSession);
    }
    connectedSession.startActiveHeartbeat();
  }
};

// transport/impls/ws/server.ts
function cleanHeaders(headers) {
  const cleanedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.startsWith("sec-") && value) {
      const cleanedValue = Array.isArray(value) ? value[0] : value;
      cleanedHeaders[key] = cleanedValue;
    }
  }
  return cleanedHeaders;
}
var WebSocketServerTransport = class extends ServerTransport {
  wss;
  constructor(wss, clientId, providedOptions) {
    super(clientId, providedOptions);
    this.wss = wss;
    this.wss.on("connection", this.connectionHandler);
  }
  connectionHandler = (ws, req) => {
    const conn = new WebSocketConnection(ws, {
      headers: cleanHeaders(req.headersDistinct)
    });
    this.handleConnection(conn);
  };
  close() {
    super.close();
    this.wss.off("connection", this.connectionHandler);
  }
};

// python-client/tests/test_server_handshake.ts
import { Type as Type6 } from "@sinclair/typebox";
var ServiceSchema = createServiceSchema();
var HandshakeTestServiceSchema = ServiceSchema.define({
  echo: Procedure.rpc({
    requestInit: Type6.Object({ msg: Type6.String() }),
    responseData: Type6.Object({ response: Type6.String() }),
    responseError: Type6.Never(),
    async handler({ reqInit }) {
      return Ok({ response: reqInit.msg });
    }
  })
});
var services = {
  test: HandshakeTestServiceSchema
};
var handshakeSchema = Type6.Object({ token: Type6.String() });
async function main() {
  const httpServer = http.createServer();
  const port = await new Promise((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("couldn't get port"));
    });
  });
  const wss = new WebSocketServer({ server: httpServer });
  const serverTransport = new WebSocketServerTransport(
    wss,
    "HANDSHAKE_SERVER"
  );
  const _server = createServer(serverTransport, services, {
    handshakeOptions: createServerHandshakeOptions(
      handshakeSchema,
      (metadata) => {
        if (metadata.token !== "valid-token") {
          return "REJECTED_BY_CUSTOM_HANDLER";
        }
        return {};
      }
    )
  });
  process.stdout.write(`RIVER_PORT=${port}
`);
  process.on("SIGTERM", () => {
    void _server.close().then(() => {
      httpServer.close();
      process.exit(0);
    });
  });
  process.on("SIGINT", () => {
    void _server.close().then(() => {
      httpServer.close();
      process.exit(0);
    });
  });
}
main().catch((err) => {
  console.error("Failed to start handshake test server:", err);
  process.exit(1);
});
