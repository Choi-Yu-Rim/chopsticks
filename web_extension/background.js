// background.js
// ----------------------------------------
// ✅ 역할
// - content.js에서 오는 CHAT_EVENT 처리
//   - 시스템 메시지 텍스트를 보고 자동응답 문구 생성
//   - 디듀프(같은 이벤트 여러 번 방지) + rate limit
//   - 해당 탭으로 AUTO_SEND_CHAT 메시지 전송
//
// ❌ 더 이상 여기서 fetch(HTTP 요청)를 직접 날리지 않음
//    → 실제 /chat/message POST는 content.js가 수행
// ----------------------------------------

const DEBUG = true;

// 튜닝값
const SEND_MIN_INTERVAL_MS = 850;
const DEDUPE_WINDOW_MS = 2500;

// 상태
/** @type {Map<string, number>} key -> lastSeenTs */
const seenEvents = new Map();

/** @type {{tabId:number, message:string, key:string, enqueuedAt:number}[]} */
const sendQueue = [];

let sending = false;
let lastSendAt = 0;

// ===== util =====
function log(...args) {
    if (DEBUG) console.log("[BG]", ...args);
}
function now() {
    return Date.now();
}
function norm(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isDuplicateEvent(key) {
    const t = now();
    const last = seenEvents.get(key);
    if (last && t - last < DEDUPE_WINDOW_MS) return true;
    seenEvents.set(key, t);
    return false;
}

function sendMessageToTab(tabId, payload) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, payload, () => {
            const err = chrome.runtime.lastError;
            if (err) {
                log("sendMessageToTab error:", err.message || err);
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

// ===== 시스템 메시지 → 자동응답 문구 =====
function parseSystemTextToReply(rawText) {
    const text = norm(rawText);
    if (!text) return null;

    // 1) 입장: "[닉네임]님이 입장하였습니다."
    let m = text.match(/^(.+?)님이\s*입장하였습니다\.?$/);
    if (m) {
        const nick = m[1].trim();
        return {
            reply: `어서오세요 ${nick}님 🙌 편하게 놀다 가세요!`,
            key: `enter:${nick}`,
        };
    }

    // 2) 좋아요 클릭: "[닉네임]님이 좋아요를 누르셨어요."
    m = text.match(/^(.+?)님이\s*좋아요를\s*(?:누르셨어요|눌렀어요)\.?$/);
    if (m) {
        const nick = m[1].trim();
        return {
            reply: `${nick}님 좋아요 감사합니다 💖`,
            key: `likeClick:${nick}`,
        };
    }

    // 3) 좋아요 N개: "[닉네임] 좋아요 10개"
    m = text.match(/^(.+?)\s+좋아요\s+(\d+)\s*개\s*'?$/);
    if (m) {
        const nick = m[1].trim();
        const n = m[2].trim();
        return {
            reply: `❣️ ${nick}님 좋아요 ${n}개 감사합니다 ❣️`,
            key: `likeN:${nick}:${n}`,
        };
    }

    return null;
}

// ===== 전송 큐 (rate limit + 재시도) =====
function enqueueSend(tabId, message, key) {
    sendQueue.push({
        tabId,
        message,
        key,
        enqueuedAt: now(),
    });
    void pumpQueue();
}

async function pumpQueue() {
    if (sending) return;
    sending = true;

    try {
        while (sendQueue.length > 0) {
            const job = sendQueue.shift();

            const gap = now() - lastSendAt;
            if (gap < SEND_MIN_INTERVAL_MS) {
                await sleep(SEND_MIN_INTERVAL_MS - gap);
            }

            const { tabId, message } = job;
            if (tabId == null) {
                log("no tabId for job, drop:", message);
                continue;
            }

            log("AUTO_SEND_CHAT -> tab", tabId, "msg:", message);

            const ok = await sendMessageToTab(tabId, {
                action: "AUTO_SEND_CHAT",
                message,
            });
            lastSendAt = now();

            if (!ok && now() - job.enqueuedAt < 10_000) {
                // 1회 정도 재시도
                sendQueue.push(job);
                await sleep(200);
            }
        }
    } finally {
        sending = false;
    }
}

// ===== runtime.onMessage =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
        if (!msg || !msg.action) return;

        // SET_SEND_CFG는 이제 백그라운드에서 안 써도 되지만
        // 디버깅용 로그는 남겨두자
        if (msg.action === "SET_SEND_CFG") {
            log("SET_SEND_CFG (bg는 참고만 함):", {
                url: msg.cfg?.url,
                headerKeys: Object.keys(msg.cfg?.headers || {}),
            });
            sendResponse?.({ ok: true });
            return true;
        }

        if (msg.action === "CHAT_EVENT") {
            const tabId = sender?.tab?.id;
            const evt = msg.val || msg.payload || {};
            const kind = evt.kind || "";

            let rawText = norm(evt.text || "");
            if (!rawText && Array.isArray(evt.parts)) {
                rawText = norm(
                    evt.parts
                        .map((p) => (p && p.text ? String(p.text) : ""))
                        .filter(Boolean)
                        .join(" ")
                );
            }

            if (!rawText) {
                log("CHAT_EVENT but no text:", evt);
                sendResponse?.({ ok: true });
                return true;
            }

            if (kind !== "system") {
                log("CHAT (user, ignore for auto-reply):", rawText);
                sendResponse?.({ ok: true });
                return true;
            }

            const parsed = parseSystemTextToReply(rawText);
            log("SYSTEM:", rawText, "=>", parsed?.reply ?? "(no match)");

            if (!parsed?.reply) {
                sendResponse?.({ ok: true });
                return true;
            }

            if (isDuplicateEvent(parsed.key)) {
                log("deduped:", parsed.key);
                sendResponse?.({ ok: true });
                return true;
            }

            if (tabId == null) {
                log("CHAT_EVENT has no tabId, cannot send AUTO_SEND_CHAT");
                sendResponse?.({ ok: true });
                return true;
            }

            enqueueSend(tabId, parsed.reply, parsed.key);

            sendResponse?.({ ok: true });
            return true;
        }
    } catch (e) {
        log("onMessage error:", e);
    }
});

log("✅ background service worker booted (AUTO_SEND_CHAT → content fetch 모드)");
