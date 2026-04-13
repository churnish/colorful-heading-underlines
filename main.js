const { Plugin } = require('obsidian');

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

class ColorfulHeadingUnderlinePlugin extends Plugin {
  onload() {
    /** @type {Map<Document, {observer: MutationObserver, removeSelection: () => void}>} */
    this.documentObservers = new Map();
    this.pendingProcess = false;

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.trigger('parse-style-settings');
      this.syncDocumentObservers();
      this.scheduleProcess();
    });

    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        this.scheduleProcess();
      }),
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.syncDocumentObservers();
        this.scheduleProcess();
      }),
    );
  }

  onunload() {
    this.teardownAllObservers();
    this.clearAllWidths();
  }

  getAllDocuments() {
    const docs = [document];
    const floating = this.app.workspace.floatingSplit?.children;
    if (floating) {
      for (const child of floating) {
        if (child.doc) docs.push(child.doc);
      }
    }
    return docs;
  }

  setupDocumentObserver(doc) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === 'attributes' &&
          mutation.target === doc.body
        ) {
          this.scheduleProcess();
          return;
        }

        const target = mutation.target;
        if (target.nodeType === Node.ELEMENT_NODE) {
          if (target.closest('.markdown-preview-view, .cm-editor')) {
            this.scheduleProcess();
            return;
          }
        } else if (target.nodeType === Node.TEXT_NODE) {
          const parent = target.parentElement;
          if (parent?.closest('.markdown-preview-view, .cm-editor')) {
            this.scheduleProcess();
            return;
          }
        }
      }
    });

    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    const selectionHandler = () => this.scheduleProcess();

    doc.addEventListener('selectionchange', selectionHandler);
    const removeSelection = () =>
      doc.removeEventListener('selectionchange', selectionHandler);

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

  scheduleProcess() {
    if (this.pendingProcess) return;
    this.pendingProcess = true;
    requestAnimationFrame(() => {
      this.pendingProcess = false;
      this.processAllHeadings();
    });
  }

  // Style Settings classes live on the main window's body — canonical source
  getWidthMode() {
    if (document.body.classList.contains('chu-width-last')) return 'last';
    if (document.body.classList.contains('chu-width-full')) return 'full';
    return 'widest';
  }

  processAllHeadings() {
    const mode = this.getWidthMode();
    for (const doc of this.getAllDocuments()) {
      doc
        .querySelectorAll(
          '.markdown-preview-view h1, .markdown-preview-view h2, .markdown-preview-view h3, .markdown-preview-view h4, .markdown-preview-view h5, .markdown-preview-view h6',
        )
        .forEach((heading) => this.processHeading(heading, mode));

      doc
        .querySelectorAll(
          '.cm-line.HyperMD-header-1, .cm-line.HyperMD-header-2, .cm-line.HyperMD-header-3, .cm-line.HyperMD-header-4, .cm-line.HyperMD-header-5, .cm-line.HyperMD-header-6',
        )
        .forEach((line) => this.processEditingLine(line, mode));
    }
  }

  processHeading(heading, mode) {
    if (mode === 'full') {
      heading.style.removeProperty('--underline-width');
      return;
    }

    const range = heading.ownerDocument.createRange();
    const textNodes = this.getTextNodes(heading);

    if (textNodes.length === 0) return;

    const firstNode = textNodes[0];
    const lastNode = textNodes[textNodes.length - 1];

    range.setStart(firstNode, 0);
    range.setEnd(lastNode, lastNode.textContent?.length ?? 0);

    const rects = range.getClientRects();
    if (rects.length === 0) return;

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

    if (width > 0) {
      heading.style.setProperty('--underline-width', `${width}px`);
    }
  }

  processEditingLine(line, mode) {
    if (mode === 'full') {
      line.style.removeProperty('--underline-width');
      return;
    }

    const headerSpans = line.querySelectorAll('.cm-header');
    if (headerSpans.length === 0) return;

    const range = line.ownerDocument.createRange();
    range.setStartBefore(headerSpans[0]);
    range.setEndAfter(headerSpans[headerSpans.length - 1]);

    const rects = range.getClientRects();
    if (rects.length === 0) return;

    const lineGroups = [];
    let currentLineGroup = null;

    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (rect.width === 0) continue;

      // 2px tolerance absorbs sub-pixel rounding between rects on the same visual line
      if (
        !currentLineGroup ||
        Math.abs(rect.top - currentLineGroup.top) > 2
      ) {
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

    if (lineGroups.length === 0) return;

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

    if (width > 0) {
      line.style.setProperty('--underline-width', `${width}px`);
    }
  }

  getTextNodes(element) {
    const textNodes = [];
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      TEXT_NODE_FILTER,
    );

    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    return textNodes;
  }
}

module.exports = ColorfulHeadingUnderlinePlugin;
