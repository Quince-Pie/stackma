/** Create the popup test tab without changing window focus; await its navigation.
 * This function is also serialized into the extension's background context.
 * Keep it self-contained and use only the supplied browser API and web globals.
 */
export async function createLoadedPopup(browser, windowId, timeoutMs = 5_000) {
  const url = browser.runtime.getURL("popup.html");
  const created = Promise.withResolvers();
  const loaded = Promise.withResolvers();
  // A load error may arrive before the tabs.create response is delivered.
  // The original promise still rejects when awaited below.
  loaded.promise.catch(() => {});
  const matching = details => details.frameId === 0 && details.url === url;
  const onCompleted = details => {
    if (matching(details)) void created.promise.then(tab => {
      if (details.tabId === tab.id) loaded.resolve();
    }, loaded.reject);
  };
  const onError = details => {
    if (matching(details)) void created.promise.then(tab => {
      if (details.tabId === tab.id) loaded.reject(new Error(`Popup navigation failed: ${details.error}`));
    }, loaded.reject);
  };
  const filter = { url: [{ urlEquals: url }] };
  let timer;
  try {
    // Subscribe before creation: onCompleted can precede the creation response.
    browser.webNavigation.onCompleted.addListener(onCompleted, filter);
    browser.webNavigation.onErrorOccurred.addListener(onError, filter);
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Popup navigation did not complete")), timeoutMs);
    });
    browser.tabs.create({ windowId, active: true, url }).then(created.resolve, created.reject);
    return await Promise.race([
      created.promise.then(tab => loaded.promise.then(() => tab)),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    browser.webNavigation.onCompleted.removeListener(onCompleted);
    browser.webNavigation.onErrorOccurred.removeListener(onError);
  }
}
