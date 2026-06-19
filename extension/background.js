const BACKEND_URL = "http://localhost:3000/buzzwordify";

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "buzzwordify") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  let selectionResponse;
  try {
    selectionResponse = await chrome.tabs.sendMessage(tab.id, { action: "getSelection" });
  } catch {
    // Content script not reachable (chrome:// pages, new tab, etc.)
    return;
  }

  if (!selectionResponse?.text) return;

  let result;
  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: selectionResponse.text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    result = data.result;
  } catch {
    chrome.tabs.sendMessage(tab.id, {
      action: "showError",
      message: "Couldn't reach the buzzword engine.",
    });
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: "applyResult", result });
});
