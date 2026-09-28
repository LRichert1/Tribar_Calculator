/* Runs the tribar measurement off the page's main thread so the screen
   stays responsive while a photo is measured (a few seconds on a phone). */
importScripts("./tribar.js");

self.onmessage = (e) => {
  const { id, gray, w, h } = e.data;
  try {
    const result = Tribar.measure(gray, w, h, {
      onProgress: (progress, msg) => self.postMessage({ id, progress, msg }),
    });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
