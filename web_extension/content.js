// content.js (디버그용 - 1회 전송)
(function() {
    console.log("🥢 [V3] content loaded");

    try {
        chrome.runtime.sendMessage({
            action: "FINAL_SYNC",
            val: { ping: Date.now() }  // ✅ 더미 데이터
        });
    } catch (e) {
        console.error(e);
    }
})();
