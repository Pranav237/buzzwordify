// Saved between getSelection and applyResult messages (see captureSelection below).
let pending = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "getSelection") {
    pending = null;
    const capture = captureSelection();
    if (capture) {
      pending = capture;
      sendResponse({ text: capture.text });
    } else {
      sendResponse({ text: null });
    }
    // Return false = synchronous response; channel closes immediately.
    return false;
  }

  if (message.action === "applyResult") {
    if (pending) applyResult(message.result);
    pending = null;
    return false;
  }

  if (message.action === "showError") {
    showOverlay(message.message, null, true);
    return false;
  }
});

// ---------------------------------------------------------------------------
// Selection detection
// ---------------------------------------------------------------------------
//
// There are two completely separate selection models in the browser:
//
// 1. Native form controls (<input>, <textarea>)
//    The browser tracks their selected text internally, exposed only through
//    element.selectionStart / element.selectionEnd on the element's .value
//    string. window.getSelection() is EMPTY when the caret is inside one of
//    these — the Selection API simply doesn't see them.
//
// 2. Everything else (read-only page content AND contenteditable nodes)
//    window.getSelection() returns a Selection object that describes what the
//    user has highlighted. We then ask it for a Range, which is a
//    pointer into the live DOM tree: it knows its start node/offset and end
//    node/offset.
//
// We check the native case first, then fall through to getSelection().

function captureSelection() {
  // --- Path 1: native input / textarea ---
  // document.activeElement is the element that currently has keyboard focus.
  // If it's an INPUT or TEXTAREA, the user's highlight lives in
  // element.selectionStart..selectionEnd on element.value.
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
    !active.readOnly &&
    !active.disabled
  ) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start === end) return null; // cursor, not a selection
    return {
      mode: "input",
      text: active.value.slice(start, end),
      element: active,
      selectionStart: start,
      selectionEnd: end,
    };
  }

  // --- Path 2: Selection API ---
  // window.getSelection() always exists but rangeCount is 0 when nothing is
  // highlighted. toString() on the Selection gives the plain text of whatever
  // the user dragged over.
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const text = sel.toString().trim();
  if (!text) return null;

  // getRangeAt(0) returns the first (and almost always only) Range. A Range
  // is a live reference into the DOM: it has startContainer/startOffset
  // (where the selection begins) and endContainer/endOffset (where it ends).
  // Critically, it does NOT copy the content — it's a pointer. If the DOM
  // changes under it, the Range updates. That's what we want: when
  // applyResult fires later, the Range still points at the right spot.
  const range = sel.getRangeAt(0);

  // Is the selection inside a contenteditable element?
  // anchorNode is the DOM node where the user started the drag. It might be a
  // text node (#text), so we walk up to find the nearest Element ancestor,
  // then continue climbing until we either find isContentEditable === true or
  // run out of ancestors.
  //
  // isContentEditable is a COMPUTED property: if a <div contenteditable> wraps
  // a <p> that wraps a <span>, then all three nodes report isContentEditable
  // true. We don't need to check for the attribute specifically — we just walk
  // up and test the flag.
  const ceAncestor = findContentEditable(sel.anchorNode);
  if (ceAncestor) {
    return {
      mode: "contenteditable",
      text,
      range,           // live Range — reused in applyResult
    };
  }

  // Read-only page content. We need the bounding rect now, while the selection
  // still exists, because the user might dismiss it before the LLM responds.
  // getBoundingClientRect() on a Range returns the tightest rect around all
  // the highlighted content, relative to the viewport (not the document).
  return {
    mode: "readonly",
    text,
    rect: range.getBoundingClientRect(),
  };
}

// Walk up the DOM from a node, looking for a contenteditable ancestor.
// We stop at <html> to avoid checking the document root.
function findContentEditable(node) {
  let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (el && el !== document.documentElement) {
    if (el.isContentEditable) return el;
    el = el.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apply result
// ---------------------------------------------------------------------------

function applyResult(result) {
  const { mode } = pending;

  if (mode === "input") {
    // Splice the new text into element.value using the saved start/end offsets.
    // This is safe even if the user clicked away: we write to the saved element
    // reference and the saved offsets, so we never touch text outside the
    // original selection.
    const { element, selectionStart, selectionEnd } = pending;
    element.value =
      element.value.slice(0, selectionStart) +
      result +
      element.value.slice(selectionEnd);
    // Move the caret to just after the inserted text.
    element.selectionStart = element.selectionEnd = selectionStart + result.length;
    // Fire an input event so React/Vue/etc. controlled inputs pick up the change.
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (mode === "contenteditable") {
    // The saved Range still points into the live DOM. Two steps:
    //
    // 1. range.deleteContents() removes every node and character inside the
    //    Range from the DOM. After this, the Range is "collapsed" — its start
    //    and end point are at the same position (the gap left by the deletion).
    //
    // 2. range.insertNode(textNode) inserts a new text node at that collapsed
    //    position. The Range then surrounds the new node.
    //
    // We create a plain text node (not innerHTML) to avoid XSS — the LLM
    // output is treated as data, never as markup.
    const { range } = pending;
    range.deleteContents();
    const textNode = document.createTextNode(result);
    range.insertNode(textNode);

    // Move the browser's visible cursor to just after the inserted text, so
    // the user can keep typing. setStartAfter/collapse reuse the same Range
    // object rather than creating a new one.
    range.setStartAfter(textNode);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }

  // mode === "readonly": show result in overlay near the selection.
  showOverlay(result, pending.rect, false);
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

function showOverlay(text, anchorRect, isError) {
  removeOverlay();

  const overlay = document.createElement("div");
  overlay.id = "buzzwordify-overlay";
  if (isError) overlay.classList.add("buzzwordify-error");
  overlay.textContent = text;
  document.body.appendChild(overlay);

  if (anchorRect) {
    // anchorRect is viewport-relative (from getBoundingClientRect).
    // Add scroll offsets to convert to document-relative coordinates, which
    // is what position:absolute on body uses.
    const top = anchorRect.bottom + window.scrollY + 8;
    // Clamp left so the overlay doesn't run off the right edge of the viewport.
    // 340 matches the max-width in overlay.css.
    const maxLeft = document.documentElement.clientWidth - 340 + window.scrollX;
    const left = Math.min(anchorRect.left + window.scrollX, Math.max(0, maxLeft));
    overlay.style.top = `${top}px`;
    overlay.style.left = `${left}px`;
  }

  // Dismiss on any click outside the overlay.
  const onMousedown = (e) => {
    if (!overlay.contains(e.target)) dismiss();
  };
  // Dismiss on Esc.
  const onKeydown = (e) => {
    if (e.key === "Escape") dismiss();
  };

  function dismiss() {
    removeOverlay();
    document.removeEventListener("mousedown", onMousedown);
    document.removeEventListener("keydown", onKeydown);
  }

  document.addEventListener("mousedown", onMousedown);
  document.addEventListener("keydown", onKeydown);
}

function removeOverlay() {
  document.getElementById("buzzwordify-overlay")?.remove();
}
