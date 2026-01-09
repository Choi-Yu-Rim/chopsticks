// content.js
console.log("✅ content script loaded");

let EXT_INVALIDATED = false;

/**
 * background로 안전하게 메시지 보내기
 * (지금 좋아요 자동응답에는 안 쓰지만, 다른 기능에서 쓸 수 있어서 남겨둠)
 */
function safeSendMessage(payload) {
    if (EXT_INVALIDATED) return;

    try {
        chrome.runtime.sendMessage(payload);
    } catch (e) {
        const msg = String(e?.message || e || "");
        if (msg.includes("Extension context invalidated")) {
            EXT_INVALIDATED = true;
            console.warn("⚠️ Extension context invalidated. Stop sending messages.");
        } else {
            console.error("❌ safeSendMessage error:", e);
        }
    }
}

/* ------------------------------------------------------------------
 *  채팅 입력창 & 타이핑 상태 관리
 * ------------------------------------------------------------------ */

let isUserTyping = false;
let typingResetTimer = null;

/**
 * 채팅 입력창 DOM 찾기
 */
function getChatInput() {
    const input =
        document.querySelector('textarea[placeholder="대화를 입력하세요."]') ||
        document.querySelector('input[placeholder="대화를 입력하세요."]');
    return input;
}

/**
 * 유저가 타이핑 중인지 감지
 * - keydown / input / composition* 이벤트가 들어오면 isUserTyping = true
 * - 마지막 입력 후 1.5초 지나면 자동으로 false
 * - blur 되면 바로 false
 */
function attachTypingWatcher() {
    const input = getChatInput();
    if (!input) {
        console.warn("⚠️ chat input not found for typing watcher. retry in 2s");
        setTimeout(attachTypingWatcher, 2000);
        return;
    }

    const markTyping = () => {
        isUserTyping = true;
        if (typingResetTimer) clearTimeout(typingResetTimer);
        typingResetTimer = setTimeout(() => {
            isUserTyping = false;
        }, 1500);
    };

    ["keydown", "input", "compositionstart", "compositionupdate", "compositionend"].forEach(
        (type) => {
            input.addEventListener(type, markTyping);
        }
    );

    input.addEventListener("blur", () => {
        isUserTyping = false;
        if (typingResetTimer) {
            clearTimeout(typingResetTimer);
            typingResetTimer = null;
        }
    });

    console.log("👀 Typing watcher attached");
}

/**
 * 채팅창에 메시지를 직접 입력/전송
 * - 이 함수는 "유저가 타이핑 중이 아닐 때"만 사용됨 (processLikeQueue에서 보장)
 * - 실행 전/후로 입력값과 커서 위치를 백업/복구해서, 혹시 남아 있던 텍스트도 유지
 */
function sendChatMessageViaDom(message) {
    try {
        if (!message || !message.trim()) {
            console.warn("⚠️ empty message, skip sendChatMessageViaDom");
            return false;
        }

        let input = getChatInput();

        // 입력창이 버튼/박스 뒤에 숨어 있으면 열어주기
        if (!input) {
            const openBox = Array.from(
                document.querySelectorAll("button, div, span")
            ).find((el) => (el.textContent || "").includes("대화를 입력하세요."));
            if (openBox) {
                openBox.click();
            }
            input = getChatInput();
        }

        if (!input) {
            console.warn("⚠️ chat input not found");
            return false;
        }

        // 현재 입력값 & 상태 백업
        const wasFocused = document.activeElement === input;
        const prevValue = input.value;
        const prevSelectionStart = input.selectionStart;
        const prevSelectionEnd = input.selectionEnd;

        // value 세팅 (React 우회용)
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && typeof desc.set === "function") {
            desc.set.call(input, message);
        } else {
            input.value = message;
        }
        input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));

        // 전송 버튼 or Enter
        const sendBtn =
            document.querySelector('button[aria-label="보내기"]') ||
            document.querySelector('button[title="보내기"]') ||
            Array.from(document.querySelectorAll("button")).find((btn) => {
                const txt = (btn.textContent || "").trim();
                return txt === "전송" || txt === "보내기";
            });

        if (sendBtn) {
            sendBtn.click();
        } else {
            const keydown = new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
            });
            input.dispatchEvent(keydown);

            const keyup = new KeyboardEvent("keyup", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
            });
            input.dispatchEvent(keyup);
        }

        // 아주 짧은 딜레이 뒤에 원래 입력값/커서 복구
        setTimeout(() => {
            try {
                const proto2 = Object.getPrototypeOf(input);
                const desc2 = Object.getOwnPropertyDescriptor(proto2, "value");
                if (desc2 && typeof desc2.set === "function") {
                    desc2.set.call(input, prevValue);
                } else {
                    input.value = prevValue;
                }
                input.dispatchEvent(
                    new Event("input", { bubbles: true, cancelable: true })
                );

                if (wasFocused) {
                    input.focus();
                    if (
                        typeof prevSelectionStart === "number" &&
                        typeof prevSelectionEnd === "number"
                    ) {
                        input.setSelectionRange(prevSelectionStart, prevSelectionEnd);
                    }
                }
            } catch (e) {
                console.error("❌ restore input error:", e);
            }
        }, 30);

        console.log("✅ sendChatMessageViaDom sent:", message);
        return true;
    } catch (e) {
        console.error("❌ sendChatMessageViaDom error:", e);
        return false;
    }
}

/* ------------------------------------------------------------------
 *  좋아요 자동응답 관련 상태값
 * ------------------------------------------------------------------ */

// 이미 처리한 좋아요 이벤트 ID들 (중복 방지)
const processedLikeIds = new Set();

// 좋아요 응답 큐
const likeReplyQueue = [];

// 현재 좋아요 응답 전송 중인지 여부 (동시 전송 방지)
let isProcessingLikeQueue = false;

// 좋아요 응답 간 최소 간격 (ms)
const LIKE_REPLY_INTERVAL = 2000;

/**
 * 간단한 sleep 유틸
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 좋아요 자동응답 큐에 쌓기
 */
function enqueueLikeReply(likeEvent) {
    const { likeId } = likeEvent;
    if (!likeId) {
        console.warn("⚠️ likeEvent without likeId, skip:", likeEvent);
        return;
    }

    if (processedLikeIds.has(likeId)) {
        console.log("↪️ already processed likeId, skip:", likeId);
        return;
    }

    processedLikeIds.add(likeId);
    likeReplyQueue.push(likeEvent);
    console.log("📥 enqueue like reply:", likeEvent);

    processLikeQueue(); // 비동기로 큐 처리 시작
}

/**
 * 좋아요 자동응답 큐 처리
 * - 유저가 타이핑 중이면 잠시 대기했다가, 타이핑이 멈춘 뒤에 전송
 */
async function processLikeQueue() {
    if (isProcessingLikeQueue) return;
    isProcessingLikeQueue = true;

    try {
        while (likeReplyQueue.length > 0) {
            const event = likeReplyQueue.shift();
            console.log("📤 send like reply:", event);

            // 🔒 유저가 타이핑 중이면, 다시 큐 맨 앞으로 넣고 1초 뒤에 재시도
            if (isUserTyping) {
                console.log("⏱ user is typing, postpone like reply");
                likeReplyQueue.unshift(event);
                await sleep(1000);
                continue;
            }

            const text = event.replyText || "좋아요 고마워요 💖";

            const sent = sendChatMessageViaDom(text);
            if (!sent) {
                console.warn("⚠️ sendChatMessageViaDom failed, keep processedLikeIds to avoid duplicates");
            }

            await sleep(LIKE_REPLY_INTERVAL);
        }
    } catch (e) {
        console.error("❌ processLikeQueue error:", e);
    } finally {
        isProcessingLikeQueue = false;
    }
}

/* ------------------------------------------------------------------
 *  DOM에서 좋아요 이벤트 감지
 * ------------------------------------------------------------------ */

/**
 * 이 노드가 내가 보낸 채팅/시스템 메시지인지 판별
 */
function isFromSelf(node) {
    try {
        const nameEl = node.querySelector(".comment-name .text-box");
        const name = (nameEl?.textContent || "").trim();
        if (!name) return false;

        // 너 닉네임 기준
        if (name === "일하는 담담" || name.includes("담담봇")) {
            return true;
        }
    } catch {
        // ignore
    }
    return false;
}

/**
 * 이 노드가 "좋아요" 시스템 메시지인지 판별
 * 예: "개악질담당님이 좋아요를 누르셨어요."
 */
function parseLikeSystemMessage(node) {
    if (!node || !(node instanceof HTMLElement)) return null;

    const text = (node.innerText || "").trim();
    if (!text) return null;

    if (isFromSelf(node)) return null;

    const likeRegex =
        /(.+?)님이\s+좋아요(?:를)?(?:\s*(\d+)개)?(?:를)?\s*누르셨어요[.!]?/;
    const match = text.match(likeRegex);
    if (!match) return null;

    const userName = (match[1] || "").trim();
    const count = match[2] ? Number(match[2]) : 0;

    // likeId는 Virtuoso data-index를 우선 사용
    let likeId = null;
    const indexContainer = node.closest("[data-index]");
    if (indexContainer) {
        likeId = indexContainer.getAttribute("data-index");
    }
    if (!likeId) {
        likeId = text; // fallback
    }

    return {
        likeId,
        userName,
        count,
        rawText: text,
    };
}

/**
 * MutationObserver 콜백
 */
function handleMutations(mutations) {
    for (const mutation of mutations) {
        if (!mutation.addedNodes || mutation.addedNodes.length === 0) continue;

        mutation.addedNodes.forEach((node) => {
            if (!(node instanceof HTMLElement)) return;

            let targetNode = node;
            if (!targetNode.matches("li.sc-kcoZcm")) {
                const li = node.querySelector("li.sc-kcoZcm");
                if (li) targetNode = li;
            }

            const likeEvent = parseLikeSystemMessage(targetNode);
            if (likeEvent) {
                console.log("✨ detected like system message:", likeEvent);
                enqueueLikeReply({
                    ...likeEvent,
                    replyText: buildLikeReplyText(likeEvent),
                });
            }
        });
    }
}

/**
 * 좋아요에 대한 실제 자동응답 멘트 생성
 */
function buildLikeReplyText(likeEvent) {
    const { userName, count } = likeEvent;

    if (userName && count) {
        return `${userName}님, 좋아요 ${count}개 고마워요 💕`;
    } else if (userName) {
        return `${userName}님, 좋아요 고마워요 💕`;
    }
    return "좋아요 고마워요 💕";
}

/**
 * 채팅 영역에 MutationObserver 붙이기
 */
function initLikeObserver() {
    const chatContainer = document.querySelector(
        '.live-detail-comment-list [data-testid="virtuoso-item-list"]'
    );

    if (!chatContainer) {
        console.warn("⚠️ chat container not found. retry in 2s");
        setTimeout(initLikeObserver, 2000);
        return;
    }

    const observer = new MutationObserver(handleMutations);
    observer.observe(chatContainer, {
        childList: true,
        subtree: true,
    });

    console.log("👀 Like MutationObserver attached");
}

// 초기화
setTimeout(() => {
    initLikeObserver();
    attachTypingWatcher();
}, 2000);
