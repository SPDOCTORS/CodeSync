// codechef adapter foundation. Phase 3/4 will add verified accepted-verdict detection.
// Do not scrape credentials or submit code to any external endpoint here.
chrome.runtime.sendMessage({ type: 'CODESYNC_PING', platform: 'codechef' }).catch(() => {
  // The service worker may be restarting; no action is needed in Phase 1.
});
