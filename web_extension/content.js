// content.js
// ----------------------------------------
// ✅ 역할
// - hook.js를 페이지(main world)에 주입해서 /chat/message 요청을 캡처
// - hook.js → window.postMessage 로 넘어온 SEND_CFG를 background로 전달
// - DOM MutationObserver로 시스템 메시지(입장/좋아요 등) 텍스트를 감지해서
//   background로 CHAT_EVENT 전송
//   (단, 채팅 리스트에서 "사용자 채팅 DOM"은 system 후보에서 제외)
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

    // 입장
    if (/님이\s*입장하였습니다\.?\s*$/.test(t)) return true;

    // 좋아요 버튼
    if (/님이\s*좋아요를\s*(누르셨어요|눌렀어요)\.?\s*$/.test(t)) return true;

    // 좋아요 N개 (스티커 포함)
    // → 문장 끝에서만 허용 (감사합니다 같은 꼬리 붙으면 매치 안 되게)
    if (/좋아요\s+\d+\s*개[.!…]*\s*$/.test(t)) return true;

    return false;
}

function extractTextFromNode(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    return node.innerText || node.textContent || "";
}

// 🔴 “입력창/텍스트박스 안에서 생긴 노드인지” 체크
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
        } catch {
            // ignore
        }
        el = el.parentElement;
    }
    return false;
}

// 🔹 채팅 리스트용: 가장 가까운 li.sc-kcoZcm 찾기
function findChatLi(node) {
    if (!node) return null;

    let el =
        node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body) {
        if (el.tagName === "LI" && el.classList.contains("sc-kcoZcm")) {
            return el;
        }
        el = el.parentElement;
    }
    return null;
}

// 한 번 처리한 li 는 다시 안 보기 위한 캐시 (중복 방지용 – 선택)
const processedLis = new WeakSet();

function handleAddedNode(node) {
    // 0) 입력 영역 안에서 생긴 변화는 전부 무시
    if (isInsideUserInputArea(node)) {
        return;
    }

    // 1) 우선 이 노드 "안에" 사용자 채팅 말풍선이 있는지부터 검사
    //    (data-index 래퍼 div 가 추가될 때, 그 div 안에 live-comment-list-item-container 가 들어있음)
    if (node.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (node);
        if (
            el.matches(
                ".live-comment-list-item-container, .comment-wrap, .comment-text"
            ) ||
            el.querySelector(
                ".live-comment-list-item-container, .comment-wrap, .comment-text"
            )
        ) {
            // 사용자 채팅이니까 system 후보에서 제외
            // clog("[EVENT] user chat container (ignore for system):", extractTextFromNode(el).trim());
            return;
        }
    }

    // 2) 채팅 리스트(li.sc-kcoZcm) 안에서 생긴 변화인지 확인
    const li = findChatLi(node);
    if (li) {
        if (processedLis.has(li)) return;
        processedLis.add(li);

        const rawFromLi = extractTextFromNode(li);
        const textFromLi = String(rawFromLi ?? "").trim();
        if (!textFromLi) return;

        // li 안에 live-comment-list-item-container 가 있으면 사용자 채팅
        if (li.querySelector(".live-comment-list-item-container")) {
            // clog("[EVENT] user chat li (ignore for system):", textFromLi);
            return;
        }

        // live-comment-list-item-container 가 없는 li.sc-kcoZcm 은
        //   스푼 시스템이 그린 메시지(입장/좋아요/좋아요 스티커 등)
        if (isSystemMessageText(textFromLi)) {
            sendSystemMessageToBG(textFromLi);
        }
        return;
    }

    // 3) 채팅 리스트 밖에서 생긴 노드에 대해서는
    //    예전 B 로직 그대로 fallback (혹시 모를 케이스 대비)
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
