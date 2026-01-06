let nativePort = null;

function connectToNativeHost() {
    const hostName = "com.spoon.connector";

    try {
        nativePort = chrome.runtime.connectNative(hostName);
        console.log("✅ connectNative 호출 성공:", hostName);
    } catch (e) {
        console.error("❌ connectNative 예외:", e);
        return;
    }

    nativePort.onMessage.addListener((msg) => {
        console.log("📥 Native host -> extension:", msg);
    });

    nativePort.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        if (err) {
            console.error("❌ Native host disconnect. lastError:", err.message);
        } else {
            console.warn("⚠️ Native host disconnect. (lastError 없음)");
        }
        nativePort = null;
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "FINAL_SYNC") {
        if (!nativePort) connectToNativeHost();

        // connectNative 실패한 경우 nativePort가 null일 수 있음
        if (!nativePort) {
            console.error("❌ nativePort가 null이라 postMessage 불가");
            return;
        }

        nativePort.postMessage(message.val);
        console.log("🚀 extension -> native host:", message.val);
    }
});
