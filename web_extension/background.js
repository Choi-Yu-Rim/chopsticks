let nativePort = null;

function connectToNativeHost() {
    const hostName = "com.spoon.connector";
    try {
        nativePort = chrome.runtime.connectNative(hostName);

        nativePort.onMessage.addListener((msg) => {
            console.log("📥 native -> extension:", msg);
        });

        nativePort.onDisconnect.addListener(() => {
            // MV3에서 disconnect 이유를 확인하려면 lastError를 꼭 찍어야 함
            const err = chrome.runtime.lastError?.message;
            console.log("❌ native host disconnected.", err ? `reason: ${err}` : "");
            nativePort = null;
        });

        console.log("✅ native host connected");
    } catch (e) {
        console.error("❌ connectNative exception:", e);
        nativePort = null;
    }
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || !message.action) return;

    // 1) 채팅 이벤트: 일단 로그만
    if (message.action === "CHAT_EVENT") {
        console.log("📨 CHAT_EVENT:", message.val);
        return;
    }

    // 2) token/live_id 동기화: native host로 전달
    if (message.action === "FINAL_SYNC") {
        if (!nativePort) connectToNativeHost();

        if (!nativePort) {
            console.error("❌ nativePort가 null이라 postMessage 불가");
            return;
        }

        try {
            nativePort.postMessage(message.val);
            console.log("🚀 extension -> native host:", message.val);
        } catch (e) {
            console.error("❌ postMessage failed:", e);
        }
    }
});

// ==============================
// Rule Engine v1 (reply proposal)
// ==============================

const AUTO_REPLY_ON = true;

// 중복 이벤트 방지
const seen = new Set();
function makeSeenKey(evt) {
    const text = (evt.parts || [])
        .filter(p => p.type === "text")
        .map(p => p.text)
        .join(" ")
        .slice(0, 50);

    return `${evt.kind}|${evt.idx}|${evt.user}|${text}`;
}

function extractText(evt) {
    return (evt.parts || [])
        .filter(p => p.type === "text")
        .map(p => p.text)
        .join(" ")
        .trim();
}

// 🎯 핵심: 조건 → 응답 결정
function proposeReply(evt) {
    if (!AUTO_REPLY_ON) return null;
    if (!evt) return null;

    const text = extractText(evt);

    // 1️⃣ 시스템 입장 메시지
    if (evt.kind === "system" && text.includes("입장")) {
        return "어서오세요 🙌 편하게 놀다 가세요!";
    }

    // 2️⃣ 인사
    if (evt.kind === "chat" && /안녕|하이|hello/i.test(text)) {
        return `${evt.user}님 안녕하세요 😊`;
    }

    // 3️⃣ 좋아요 / 하트
    if (evt.kind === "chat" && /좋아요|하트|❤️|💙/.test(text)) {
        return "감사해요 💖";
    }

    return null;
}

