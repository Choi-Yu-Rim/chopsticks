// content.js
(() => {
    console.log("🥢 chopsticks injected (Spoon)");

    // 중복 observer 방지
    let observerAttached = false;
    let observerInstance = null;

    // 중복 이벤트 방지(같은 idx가 반복 처리되는 경우가 있어서 방어)
    const seenKeys = new Set();
    const SEEN_MAX = 500;

    function remember(key) {
        seenKeys.add(key);
        if (seenKeys.size > SEEN_MAX) {
            // 오래된 것부터 일부 제거 (간단히 앞에서부터)
            const it = seenKeys.values();
            for (let i = 0; i < 100; i++) {
                const n = it.next();
                if (n.done) break;
                seenKeys.delete(n.value);
            }
        }
    }

    function safeText(s) {
        return (s || "").replace(/\s+/g, " ").trim();
    }

    function getContainerIndex(li) {
        const box = li.closest("div[data-index], div[data-item-index], div[data-known-size]");
        if (!box) return null;
        return box.getAttribute("data-index") || box.getAttribute("data-item-index") || null;
    }

    function getUserNameFromItem(li) {
        // 네가 올린 HTML 기준: button.thumbnail title 에 닉네임이 있음
        const thumb = li.querySelector("button.thumbnail");
        const title = thumb?.getAttribute("title");
        if (title) return safeText(title);

        // fallback: 내부 텍스트에서 추정(없으면 null)
        return null;
    }

    function getMessageParts(li) {
        // 일반 채팅 텍스트는 .comment-text pre 에 있음 (너가 준 HTML 기준)
        const parts = [];

        // 1) 텍스트(pre)
        const pre = li.querySelector(".comment-text pre");
        if (pre) {
            const t = safeText(pre.textContent);
            if (t) parts.push({ type: "text", text: t });
        }

        // 2) 이미지(채팅 내부 이미지/스티커 등) - img 태그가 있으면 수집
        //    (스푼이 구조를 바꿀 수 있어서 broad하게 잡되, 너무 많으면 조절 가능)
        const imgs = Array.from(li.querySelectorAll(".comment img, .comment-text img, img"));
        for (const img of imgs) {
            const src = img.getAttribute("src");
            if (src && !src.startsWith("data:")) {
                parts.push({ type: "image", src });
            }
        }

        // 3) 이모지/접근성 라벨이 있는 요소
        const emojiCandidates = Array.from(li.querySelectorAll("[aria-label]"));
        for (const el of emojiCandidates) {
            const label = el.getAttribute("aria-label");
            if (label && label.length <= 20) {
                // 너무 일반적인 라벨은 제외하고 싶으면 여기 조건 추가
                parts.push({ type: "emoji", text: label });
            }
        }

        // parts 정리: 중복 제거(간단히 JSON string 기준)
        const uniq = [];
        const seen = new Set();
        for (const p of parts) {
            const k = JSON.stringify(p);
            if (seen.has(k)) continue;
            seen.add(k);
            uniq.push(p);
        }
        return uniq;
    }

    function classifyAndExtract(li) {
        // 1) 일반 채팅: .comment-text 존재
        if (li.querySelector(".comment-text")) {
            const user = getUserNameFromItem(li);
            const parts = getMessageParts(li);
            if (!parts || parts.length === 0) return null;

            const idx = getContainerIndex(li);
            return {
                kind: "chat",
                ts: Date.now(),
                user,
                parts,
                idx
            };
        }

        // 2) 시스템/공지/안내: chat 구조는 아니지만 li 자체에 텍스트가 있는 경우
        //    예: "건강한 방송 환경..." / "[안내] 방송에 입장하셨습니다." 등
        const text = safeText(li.textContent);
        if (!text) return null;

        // 안전장치: 너무 긴 텍스트는 페이지 전체를 잡은 걸 가능성이 있어 버림
        if (text.length > 200) return null;

        // 시스템 메시지 형태로 이벤트 생성
        const idx = getContainerIndex(li);
        return {
            kind: "system",
            ts: Date.now(),
            user: null,
            parts: [{ type: "text", text }],
            idx
        };
    }

    function emitChatEvent(evt) {
        // 중복 방지 키: kind + idx + text(앞부분)
        const textPreview = safeText(
            evt?.parts?.map(p => (p.type === "text" ? p.text : "")).join(" ")
        ).slice(0, 40);
        const key = `${evt.kind}|${evt.idx ?? "na"}|${textPreview}`;

        if (seenKeys.has(key)) return;
        remember(key);

        if (evt.kind === "system") {
            console.log("📢 SYSTEM:", evt);
        } else {
            console.log("💬 CHAT:", evt);
        }

        chrome.runtime
            .sendMessage({ action: "CHAT_EVENT", val: evt })
            .catch(() => {}); // background가 아직 없거나 죽어있을 때 콘솔 폭주 방지
    }

    function handleAddedNode(node) {
        if (!node) return;

        // node가 li일 수도 있고, li를 포함한 div일 수도 있음
        const liCandidates = [];

        if (node.nodeType === 1) {
            const el = /** @type {Element} */ (node);

            if (el.tagName?.toLowerCase() === "li") {
                liCandidates.push(el);
            } else {
                // 새로 추가된 subtree 안에 li들이 있을 수 있음
                liCandidates.push(...Array.from(el.querySelectorAll("li")));
            }
        }

        if (liCandidates.length === 0) return;

        liCandidates.forEach((li) => {
            const evt = classifyAndExtract(li);
            if (!evt) return;
            emitChatEvent(evt);
        });
    }

    function findChatListRoot() {
        // 현재 콘솔에 보이는 root: data-testid="virtuoso-item-list"
        // 이게 스푼 채팅 리스트의 핵심 루트로 보임
        const root =
            document.querySelector('[data-testid="virtuoso-item-list"]') ||
            document.querySelector('[data-testid*="virtuoso"]') ||
            null;

        return root;
    }

    function attachObserver() {
        if (observerAttached) return true;

        const root = findChatListRoot();
        if (!root) return false;

        console.log("👀 observing chat LIST root:", root);

        observerInstance = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type !== "childList") continue;
                m.addedNodes.forEach(handleAddedNode);
            }
        });

        observerInstance.observe(root, { childList: true, subtree: true });
        observerAttached = true;

        console.log("✅ observer attached");
        return true;
    }

    // 페이지가 SPA라서 DOM이 늦게 뜰 수 있음 → 재시도
    const timer = setInterval(() => {
        try {
            const ok = attachObserver();
            if (ok) clearInterval(timer);
        } catch (e) {
            // 조용히 재시도
        }
    }, 700);
})();
