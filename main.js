const { Plugin } = require('obsidian');

// Exclude collapse chevrons — Obsidian renders them inside heading elements
// and their text content would skew the range width measurement.
const TEXT_NODE_FILTER = {
  acceptNode(node) {
    if (node.parentElement?.closest('.heading-collapse-indicator')) {
      return NodeFilter.FILTER_REJECT;
    }
    if ((node.textContent?.trim().length ?? 0) > 0) {
      return NodeFilter.FILTER_ACCEPT;
    }
    return NodeFilter.FILTER_REJECT;
  },
};

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

const HEADING_SELECTOR =
  '.markdown-preview-view :is(h1, h2, h3, h4, h5, h6), .cm-line:is(.HyperMD-header-1, .HyperMD-header-2, .HyperMD-header-3, .HyperMD-header-4, .HyperMD-header-5, .HyperMD-header-6)';

class ColorfulHeadingUnderlinePlugin extends Plugin {
  onload() {
    /** @type {Map<Document, {observer: MutationObserver, removeSelection: () => void}>} */
    this.documentObservers = new Map();
    this._rafId = null;
    this._rafWin = null;
    this._isProcessing = false;

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.trigger('parse-style-settings');
      this.syncDocumentObservers();
      this.scheduleProcess();
    });

    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        this.scheduleProcess();
      })
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.syncDocumentObservers();
        this.scheduleProcess();
      })
    );
  }

  onunload() {
    if (this._rafId) {
      (this._rafWin ?? window).cancelAnimationFrame(this._rafId);
    }
    this.teardownAllObservers();
    this.clearAllWidths();
  }

  getAllDocuments() {
    const docs = [document];
    const floating = this.app.workspace.floatingSplit?.children;
    if (floating) {
      for (const child of floating) {
        if (child.doc?.defaultView) docs.push(child.doc);
      }
    }
    return docs;
  }

  setupDocumentObserver(doc) {
    const win = doc.defaultView ?? window;
    // Process synchronously in MO callback — MO batches mutations internally,
    // and deferring to RAF causes flicker in popout windows because the main
    // window's RAF doesn't run before the popout's paint (separate V8 isolate).
    const observer = new win.MutationObserver((mutations) => {
      const containers = new Set();
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target === doc.body) {
          this.processAllHeadings();
          return;
        }

        const target = mutation.target;
        const el =
          target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
        const container = el?.closest('.markdown-preview-view, .cm-editor');
        if (container) containers.add(container);
      }
      for (const container of containers) {
        this.processContainer(container);
      }
    });

    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    // Manual registration — target doc isn't known at plugin load time,
    // so registerDomEvent can't be used. Cleanup in teardown/sync.
    let selectionTimer = null;
    const selectionHandler = () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const sel = doc.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const el =
          sel.anchorNode?.nodeType === Node.TEXT_NODE
            ? sel.anchorNode.parentElement
            : sel.anchorNode;
        if (!el?.closest('.markdown-preview-view, .cm-editor')) return;
        this.scheduleProcess(doc);
      }, 150);
    };

    doc.addEventListener('selectionchange', selectionHandler);
    const removeSelection = () => {
      clearTimeout(selectionTimer);
      doc.removeEventListener('selectionchange', selectionHandler);
    };

    this.documentObservers.set(doc, { observer, removeSelection });
  }

  teardownAllObservers() {
    for (const entry of this.documentObservers.values()) {
      entry.observer.disconnect();
      entry.removeSelection();
    }
    this.documentObservers.clear();
  }

  syncDocumentObservers() {
    const currentDocs = new Set(this.getAllDocuments());

    // Remove stale entries (window closed or doc no longer in workspace)
    for (const [doc, entry] of this.documentObservers) {
      if (!currentDocs.has(doc) || doc.defaultView === null) {
        entry.observer.disconnect();
        entry.removeSelection();
        // Safe: deleting from a Map during for...of iteration per ES spec
        this.documentObservers.delete(doc);
      }
    }

    // Add observers for new documents
    for (const doc of currentDocs) {
      if (!this.documentObservers.has(doc)) {
        this.setupDocumentObserver(doc);
      }
    }
  }

  clearAllWidths() {
    for (const doc of this.getAllDocuments()) {
      doc.querySelectorAll('[style*="--underline-width"]').forEach((el) => {
        el.style.removeProperty('--underline-width');
      });
    }
  }

  // Coalesces all pending triggers into one RAF — subsequent calls while a frame is queued are dropped
  scheduleProcess(doc) {
    if (this._rafId) return;
    this._rafWin = doc?.defaultView ?? window;
    this._rafId = this._rafWin.requestAnimationFrame(() => {
      this._rafId = null;
      this._rafWin = null;
      this.processAllHeadings();
    });
  }

  // Style Settings classes live on the main window's body — canonical source
  getWidthMode() {
    if (document.body.classList.contains('chu-width-last')) return 'last';
    if (document.body.classList.contains('chu-width-full')) return 'full';
    return 'widest'; // default when no chu-width-* class is set
  }

  processAllHeadings() {
    if (this._isProcessing) return;
    this._isProcessing = true;
    try {
      const mode = this.getWidthMode();
      if (mode === 'full') return; // CSS handles width: 100%
      for (const doc of this.getAllDocuments()) {
        const headings = doc.querySelectorAll(HEADING_SELECTOR);
        this.processHeadings(headings, mode);
      }
    } finally {
      this._isProcessing = false;
    }
  }

  processContainer(container) {
    const mode = this.getWidthMode();
    if (mode === 'full') return;
    const headings = container.querySelectorAll(HEADING_SELECTOR);
    this.processHeadings(headings, mode);
  }

  processHeadings(elements, mode) {
    const updates = [];
    for (const el of elements) {
      try {
        const width = HEADING_TAGS.has(el.tagName)
          ? this.measureHeading(el, mode)
          : this.measureEditingLine(el, mode);
        updates.push({ el, width });
      } catch {
        updates.push({ el, width: 0 });
      }
    }
    for (const { el, width } of updates) {
      this.applyWidth(el, width);
    }
  }

  measureHeading(heading, mode) {
    const textNodes = this.getTextNodes(heading);
    if (textNodes.length === 0) return 0;

    const range = heading.ownerDocument.createRange();

    const firstNode = textNodes[0];
    const lastNode = textNodes[textNodes.length - 1];

    range.setStart(firstNode, 0);
    range.setEnd(lastNode, lastNode.textContent?.length ?? 0);

    const rects = range.getClientRects();
    if (rects.length === 0) return 0;

    let width = 0;
    if (mode === 'last') {
      width = rects[rects.length - 1].width;
    } else {
      for (let i = 0; i < rects.length; i++) {
        if (rects[i].width > width) {
          width = rects[i].width;
        }
      }
    }

    return width;
  }

  measureEditingLine(line, mode) {
    const headerSpans = line.querySelectorAll('.cm-header');
    if (headerSpans.length === 0) return 0;

    const range = line.ownerDocument.createRange();
    range.setStartBefore(headerSpans[0]);
    range.setEndAfter(headerSpans[headerSpans.length - 1]);

    const rects = range.getClientRects();
    if (rects.length === 0) return 0;

    // Group rects by visual line: merge left/right extents for rects whose
    // tops are within 2px, yielding one bounding box per wrapped line.
    const lineGroups = [];
    let currentLineGroup = null;

    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (rect.width === 0) continue;

      // 2px tolerance absorbs sub-pixel rounding between rects on the same visual line
      if (!currentLineGroup || Math.abs(rect.top - currentLineGroup.top) > 2) {
        currentLineGroup = {
          top: rect.top,
          left: rect.left,
          right: rect.right,
        };
        lineGroups.push(currentLineGroup);
      } else {
        currentLineGroup.left = Math.min(currentLineGroup.left, rect.left);
        currentLineGroup.right = Math.max(currentLineGroup.right, rect.right);
      }
    }

    if (lineGroups.length === 0) return 0;

    let width = 0;
    if (mode === 'last') {
      const lastLineGroup = lineGroups[lineGroups.length - 1];
      width = lastLineGroup.right - lastLineGroup.left;
    } else {
      for (const lineGroup of lineGroups) {
        const lineWidth = lineGroup.right - lineGroup.left;
        if (lineWidth > width) {
          width = lineWidth;
        }
      }
    }

    return width;
  }

  applyWidth(el, width) {
    if (width > 0) {
      const newVal = `${width}px`;
      if (el.style.getPropertyValue('--underline-width') !== newVal) {
        el.style.setProperty('--underline-width', newVal);
      }
    } else {
      if (el.style.getPropertyValue('--underline-width')) {
        el.style.removeProperty('--underline-width');
      }
    }
  }

  getTextNodes(element) {
    const textNodes = [];
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      TEXT_NODE_FILTER
    );

    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    return textNodes;
  }
}

module.exports = ColorfulHeadingUnderlinePlugin;
