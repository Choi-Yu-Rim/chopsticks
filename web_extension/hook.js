// hook.js - main world에서 /chat/message 요청 가로채기
(function () {
    const TARGET_RE = /\/lives\/[^/]+\/chat\/message(\?|$)/;

    console.log("[HOOK] hook.js loaded");

    function headersToObject(headers) {
        const obj = {};
        if (!headers) return obj;

        // Headers 인스턴스
        if (headers instanceof Headers) {
            headers.forEach((v, k) => (obj[k] = v));
            return obj;
        }
        // 배열 형태: [[k,v], ...]
        if (Array.isArray(headers)) {
            for (const [k, v] of headers) {
                obj[String(k)] = String(v);
            }
            return obj;
        }
        // plain object
        if (typeof headers === "object") {
            for (const k of Object.keys(headers)) {
                obj[k] = String(headers[k]);
            }
            return obj;
        }

        return obj;
    }

    function postCfg(url, headers) {
        const cfg = { url, headers: headersToObject(headers) };
        console.log("[HOOK] CAPTURE_SEND_CFG:", cfg);
        window.postMessage(
            {
                __SPOON_EXT__: true,
                type: "CAPTURE_SEND_CFG",
                cfg,
            },
            "*"
        );
    }

    // ---------------- fetch hook ----------------
    const _fetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            const url = typeof input === "string" ? input : input?.url || "";
            const method = (init?.method || "GET").toUpperCase();

            if (TARGET_RE.test(url) && method === "POST") {
                console.log("[HOOK] fetch hit:", url);
                postCfg(url, init?.headers);
            }
        } catch (e) {
            console.warn("[HOOK] fetch hook error:", e);
        }
        return _fetch.apply(this, arguments);
    };

    // ---------------- XHR hook ----------------
    const _open = XMLHttpRequest.prototype.open;
    const _setHeader = XMLHttpRequest.prototype.setRequestHeader;
    const _send = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this.__spoon_cfg = { method, url, headers: {} };
        return _open.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try {
            if (this.__spoon_cfg) {
                this.__spoon_cfg.headers[k] = String(v);
            }
        } catch (e) {
            console.warn("[HOOK] setRequestHeader error:", e);
        }
        return _setHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        try {
            const s = this.__spoon_cfg;
            if (
                s &&
                TARGET_RE.test(s.url) &&
                String(s.method || "GET").toUpperCase() === "POST"
            ) {
                console.log("[HOOK] XHR hit:", s.url);
                postCfg(s.url, s.headers);
            }
        } catch (e) {
            console.warn("[HOOK] XHR send hook error:", e);
        }
        return _send.apply(this, arguments);
    };
})();
