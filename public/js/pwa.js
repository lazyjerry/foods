// 註冊 service worker（public/sw.js），讓「吃過筆記」可安裝成 App、離線時顯示離線頁。
// 公開分享頁（/s/<token>）不載入這支，匿名訪客不會被裝上 service worker。
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => console.warn("service worker 註冊失敗", err));
  });
}
