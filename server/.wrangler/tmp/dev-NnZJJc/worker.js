var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var UPSTREAM = "https://openrouter.ai/api/v1";
var MAX_BODY = 12 * 1024 * 1024;
var counters = /* @__PURE__ */ new Map();
var countersDay = "";
function opt(env, name, def) {
  const v = env[name];
  return v === void 0 || v === "" ? def : v;
}
__name(opt, "opt");
function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(opt(env, "ALLOWED_ORIGINS", "https://stairrax.github.io")).split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? origin || "*" : "null",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin"
    }
  };
}
__name(cors, "cors");
function json(status, data, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}
__name(json, "json");
var fail = /* @__PURE__ */ __name((status, code, message, headers) => json(status, { error: { code, message, proxy: true } }, headers), "fail");
function count(who, limit) {
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  if (day !== countersDay) {
    counters.clear();
    countersDay = day;
  }
  const n = (counters.get(who) || 0) + 1;
  if (n > limit) return false;
  counters.set(who, n);
  return true;
}
__name(count, "count");
function models(env) {
  return String(opt(env, "MODELS", "google/gemini-2.5-flash")).split(",").map((s) => s.trim()).filter(Boolean);
}
__name(models, "models");
var worker_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1(?=\/)/, "");
    const c = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (path === "/" || path === "") return new Response("ok", { headers: c.headers });
    if (!c.ok) return fail(403, "origin", "\u042D\u0442\u043E\u0442 \u0441\u0435\u0440\u0432\u0435\u0440 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F \xAB\u0414\u0438\u043A\u0442\u043E\u0440 \u043A\u043E\u043D\u0441\u043F\u0435\u043A\u0442\u043E\u0432\xBB.", c.headers);
    if (req.method === "GET" && path === "/models") {
      return json(200, { data: models(env).map((id) => ({ id })) }, c.headers);
    }
    if (req.method !== "POST" || path !== "/chat/completions") return fail(404, "not_found", "\u041D\u0435\u0442 \u0442\u0430\u043A\u043E\u0433\u043E \u0430\u0434\u0440\u0435\u0441\u0430.", c.headers);
    if (!env.OPENROUTER_KEY) return fail(503, "unavailable", "\u0411\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435.", c.headers);
    if (+(req.headers.get("Content-Length") || 0) > MAX_BODY) return fail(413, "too_large", "\u0417\u0430\u043F\u0440\u043E\u0441 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439.", c.headers);
    let body;
    try {
      body = await req.json();
    } catch {
      return fail(400, "bad_request", "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441.", c.headers);
    }
    if (!Array.isArray(body?.messages) || !body.messages.length) return fail(400, "bad_request", "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441.", c.headers);
    const device = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").slice(0, 64) || "none";
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const limitText = "\u041D\u0430 \u0441\u0435\u0433\u043E\u0434\u043D\u044F \u0431\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u044B\u0435 \u0437\u0430\u043F\u0440\u043E\u0441\u044B \u0437\u0430\u043A\u043E\u043D\u0447\u0438\u043B\u0438\u0441\u044C. \u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u0435 \u0437\u0430\u0432\u0442\u0440\u0430 \u0438\u043B\u0438 \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u0441\u0432\u043E\u0439 \u043A\u043B\u044E\u0447: \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u2192 \u041D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u0437\u0430\u043D\u043E\u0432\u043E.";
    if (!count("d|" + device, +opt(env, "DAILY_PER_DEVICE", 300)) || !count("ip|" + ip, +opt(env, "DAILY_PER_IP", 1500))) {
      return fail(429, "daily_limit", limitText, c.headers);
    }
    const list = models(env);
    const maxTokens = +opt(env, "MAX_TOKENS", 16e3);
    const out = {
      model: list[0],
      messages: body.messages,
      temperature: typeof body.temperature === "number" ? body.temperature : void 0,
      max_tokens: Math.min(+body.max_tokens || maxTokens, maxTokens),
      stream: body.stream === true
    };
    if (list.length > 1) out.models = list.slice(0, 3);
    let up;
    try {
      up = await fetch(UPSTREAM + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + env.OPENROUTER_KEY,
          "HTTP-Referer": opt(env, "APP_URL", "https://stairrax.github.io/helper-with-conspects/"),
          "X-Title": "Konspekt Diktor"
        },
        body: JSON.stringify(out)
      });
    } catch {
      return fail(502, "upstream", "\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435\u0439\u0440\u043E\u0441\u0435\u0442\u0438 \u043D\u0435 \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0451 \u0440\u0430\u0437.", c.headers);
    }
    if ([401, 402, 403].includes(up.status)) {
      return fail(503, "unavailable", "\u0411\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043F\u043E\u0437\u0436\u0435 \u0438\u043B\u0438 \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u0441\u0432\u043E\u0439 \u043A\u043B\u044E\u0447: \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u2192 \u041D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u0437\u0430\u043D\u043E\u0432\u043E.", c.headers);
    }
    return new Response(up.body, {
      status: up.status,
      headers: { ...c.headers, "Content-Type": up.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" }
    });
  }
};

// ../../../../root/.npm/_npx/4657ece8094f916a/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../root/.npm/_npx/4657ece8094f916a/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-Ujs2bm/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../root/.npm/_npx/4657ece8094f916a/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Ujs2bm/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
