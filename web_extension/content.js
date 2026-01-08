// content.js
// ----------------------------------------
// ✅ 역할
// - hook.js를 페이지(main world)에 주입해서 /chat/message 요청을 캡처
// - hook.js → window.postMessage 로 넘어온 SEND_CFG를 background로 전달
// - DOM MutationObserver로 시스템 메시지(입장/좋아요 등) 텍스트를 감지해서
//   background로 CHAT_EVENT 전송
// - background에서 오는 AUTO_SEND_CHAT을 받아서 실제 /chat/message API 호출
// ----------------------------------------
let SEND_CFG = null;

const DEBUG = true;
function clog(...args) {
    if (DEBUG) console.log("[CONTENT]", ...args);
}

// ------------------------------
// 1) hook.js 주입
// ------------------------------
(function injectHook() {
    try {
        clog("content script loaded");

        const s = document.createElement("script");
        s.src = chrome.runtime.getURL("hook.js");
        s.onload = () => {
            clog("hook injected via src:", s.src);
            s.remove();
        };
        (document.head || document.documentElement).appendChild(s);
    } catch (e) {
        console.warn("[CONTENT] hook inject failed:", e);
    }
})();

// ------------------------------
// 2) hook.js → background로 SEND_CFG 전달
// ------------------------------
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__SPOON_EXT__ !== true) return;

    if (data.type === "CAPTURE_SEND_CFG" && data.cfg?.url) {
        SEND_CFG = data.cfg; // 🔹 로컬에도 저장
        clog("CAPTURE_SEND_CFG from hook:", data.cfg);

        try {
            chrome.runtime.sendMessage({
                action: "SET_SEND_CFG",
                cfg: data.cfg,
            });
        } catch (e) {
            console.warn("[CONTENT] sendMessage SET_SEND_CFG error:", e);
        }
    }
});

// ------------------------------
// 3) 시스템 메시지 → background로 CHAT_EVENT 보내기
// ------------------------------
function sendSystemMessageToBG(text) {
    const msgText = String(text ?? "").trim();
    if (!msgText) return;

    clog("SYSTEM DETECTED:", msgText);

    try {
        chrome.runtime.sendMessage({
            action: "CHAT_EVENT",
            payload: {
                kind: "system",
                text: msgText,
            },
        });
    } catch (e) {
        console.warn("[CONTENT] sendSystemMessageToBG error:", e);
    }
}

// ------------------------------
// 4) DOM MutationObserver로 시스템 메시지 감지
// ------------------------------
function isSystemMessageText(text) {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return false;

    if (/님이\s*입장하였습니다/.test(t)) return true;
    if (/님이\s*좋아요를\s*(누르셨어요|눌렀어요)/.test(t)) return true;
    if (/좋아요\s+\d+\s*개/.test(t)) return true;

    return false;
}

function extractTextFromNode(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    return node.innerText || node.textContent || "";
}

// 🔴 새로 추가: “입력창/텍스트박스 안에서 생긴 노드인지” 체크
function isInsideUserInputArea(node) {
    if (!node) return false;

    let el =
        node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body) {
        try {
            if (
                el.matches(
                    [
                        "textarea",
                        "input",
                        "[contenteditable='true']",
                        "[role='textbox']",
                        "[data-testid*='input']",
                    ].join(",")
                )
            ) {
                return true;
            }
        } catch (e) {
            // matches 에러 나면 그냥 패스
        }
        el = el.parentElement;
    }
    return false;
}

function handleAddedNode(node) {
    // 입력 영역 안에서 생긴 변화는 전부 무시!
    if (isInsideUserInputArea(node)) {
        return;
    }

    const raw = extractTextFromNode(node);
    if (!raw) return;

    const text = raw.trim();
    if (!text) return;

    if (isSystemMessageText(text)) {
        sendSystemMessageToBG(text);
    }
}

function setupMutationObserver() {
    try {
        const target = document.body;
        if (!target) {
            setTimeout(setupMutationObserver, 500);
            return;
        }

        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === "childList" && m.addedNodes?.length) {
                    m.addedNodes.forEach((node) => {
                        handleAddedNode(node);
                    });
                }
            }
        });

        observer.observe(target, {
            childList: true,
            subtree: true,
        });

        clog("MutationObserver attached on <body>");
    } catch (e) {
        console.warn("[CONTENT] setupMutationObserver error:", e);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupMutationObserver, {
        once: true,
    });
} else {
    setupMutationObserver();
}

// ------------------------------
// 5) background → AUTO_SEND_CHAT 처리 (API 전송)
// ------------------------------
function lowerKeyMap(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
        out[k.toLowerCase()] = obj[k];
    }
    return out;
}

async function sendChatViaApi(message) {
    if (!SEND_CFG || !SEND_CFG.url) {
        clog("AUTO_SEND_CHAT but SEND_CFG is not ready yet");
        return;
    }

    const url = SEND_CFG.url;
    const headers = { ...(SEND_CFG.headers || {}) };
    const lower = lowerKeyMap(headers);

    if (!("content-type" in lower)) {
        headers["content-type"] = "application/json";
    }

    const body = JSON.stringify({
        message,
        messageType: "GENERAL_MESSAGE",
    });

    clog("AUTO_SEND_CHAT fetch:", { url, body });

    const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        credentials: "include",
    });

    const text = await res.text().catch(() => "");
    clog("AUTO_SEND_CHAT result:", res.status, text.slice(0, 200));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
        if (!msg || msg.action !== "AUTO_SEND_CHAT") return;

        const message = msg.message;
        if (!message) {
            sendResponse?.({ ok: false, error: "no message" });
            return true;
        }

        sendChatViaApi(message)
            .then(() => {
                sendResponse?.({ ok: true });
            })
            .catch((e) => {
                console.warn("[CONTENT] AUTO_SEND_CHAT error:", e);
                sendResponse?.({ ok: false, error: String(e) });
            });

        return true;
    } catch (e) {
        console.warn("[CONTENT] onMessage(AUTO_SEND_CHAT) error:", e);
    }
});
