// content.js
console.log("✅ content script loaded");

let EXT_INVALIDATED = false;

/**
 * background로 안전하게 메시지 보내기 (fallback 용)
 */
function safeSendMessage(payload) {
    if (EXT_INVALIDATED) return;

    try {
        chrome.runtime.sendMessage(payload);
    } catch (e) {
        const msg = String(e?.message || e || "");
        // 확장 종료/리로드 시 에러 처리
        if (msg.includes("Extension context invalidated")) {
            EXT_INVALIDATED = true;
            console.warn("⚠️ Extension context invalidated. Stop sending messages.");
        } else {
            console.error("❌ safeSendMessage error:", e);
        }
    }
}

/* ------------------------------------------------------------------
 *  채팅창에 직접 메시지 보내기 (DOM 조작)
 * ------------------------------------------------------------------ */

/**
 * 스푼 웹 UI에 직접 채팅을 입력하고 전송
 * - true  : DOM으로 전송 성공
 * - false : 입력창/전송버튼을 못 찾음 → background fallback 사용
 */
function sendChatMessageViaDom(message) {
    try {
        if (!message || !message.trim()) {
            console.warn("⚠️ empty message, skip sendChatMessageViaDom");
            return false;
        }

        // 1) 입력창 찾기
        let input =
            document.querySelector('textarea[placeholder="대화를 입력하세요."]') ||
            document.querySelector('input[placeholder="대화를 입력하세요."]');

        // 입력창이 버튼/박스 뒤에 숨어 있으면 열어주기
        if (!input) {
            const openBox = Array.from(
                document.querySelectorAll("button, div, span")
            ).find((el) => (el.textContent || "").includes("대화를 입력하세요."));
            if (openBox) {
                openBox.click();
            }

            input =
                document.querySelector('textarea[placeholder="대화를 입력하세요."]') ||
                document.querySelector('input[placeholder="대화를 입력하세요."]');
        }

        if (!input) {
            console.warn("⚠️ chat input not found");
            return false;
        }

        // 2) 현재 네가 치고 있던 내용 백업
        const wasFocused = document.activeElement === input;
        const prevValue = input.value;
        const prevSelectionStart = input.selectionStart;
        const prevSelectionEnd = input.selectionEnd;

        // 3) 자동응답 내용으로 잠깐 교체 + input 이벤트
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && typeof desc.set === "function") {
            desc.set.call(input, message);
        } else {
            input.value = message;
        }
        input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));

        // 4) 전송 버튼 클릭 or 엔터 전송
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

        // 5) 아주 짧은 딜레이 후에 네가 치던 내용 원래대로 복구
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
        // 이미 처리한 좋아요 이벤트는 무시
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
 */
async function processLikeQueue() {
    if (isProcessingLikeQueue) return;
    isProcessingLikeQueue = true;

    try {
        while (likeReplyQueue.length > 0) {
            const event = likeReplyQueue.shift(); // ✅ 큐에서 제거
            console.log("📤 send like reply:", event);

            const text = event.replyText || "좋아요 고마워요 💖";

            // 1순위: DOM으로 바로 보내기 (입력값 보존)
            const sent = sendChatMessageViaDom(text);

            // 혹시 DOM 구조 바뀌어서 실패하면, 예전처럼 background로 던지기
            if (!sent) {
                safeSendMessage({
                    type: "SP_AUTO_REPLY",
                    payload: {
                        kind: "LIKE",
                        likeId: event.likeId,
                        userName: event.userName,
                        message: text,
                    },
                });
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
 * 이 노드가 내가 보낸 채팅인지 대략 판별
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
        // 실패하면 그냥 false
    }
    return false;
}

/**
 * 이 노드가 "좋아요" 시스템 메시지인지 판별
 * 예: "🧣우기님이 좋아요를 누르셨어요."
 *     "OOO님이 좋아요 10개를 누르셨어요."
 */
function parseLikeSystemMessage(node) {
    if (!node || !(node instanceof HTMLElement)) return null;

    const text = (node.innerText || "").trim();
    if (!text) return null;

    // 내가 보낸 메시지는 무시
    if (isFromSelf(node)) return null;

    const likeRegex =
        /(.+?)님이\s+좋아요(?:를)?(?:\s*(\d+)개)?(?:를)?\s*누르셨어요[.!]?/;
    const match = text.match(likeRegex);
    if (!match) return null;

    const userName = (match[1] || "").trim();
    const count = match[2] ? Number(match[2]) : 0;

    // likeId는 data-index를 우선 사용
    let likeId = null;
    const indexContainer = node.closest("[data-index]");
    if (indexContainer) {
        likeId = indexContainer.getAttribute("data-index");
    }
    if (!likeId) {
        likeId = text; // 그래도 없으면 텍스트 기반
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

            // wrapper div 밑에 li.sc-kcoZcm 이 있을 수 있으니 한 번 더 내려가기
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

// 페이지 로드 후 약간 딜레이 두고 초기화
setTimeout(initLikeObserver, 2000);
