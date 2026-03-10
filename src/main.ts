import { Plugin } from 'obsidian';

type WidthMode = 'widest' | 'last' | 'full';

interface LineGroup {
  top: number;
  left: number;
  right: number;
}

export default class ColorfulHeadingUnderlinePlugin extends Plugin {
  private observer: MutationObserver | null = null;
  private pendingProcess = false;

  onload(): void {
    this.setupObserver();

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.trigger('parse-style-settings');
      this.processAllHeadings();
    });

    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        this.processAllHeadings();
      })
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.processAllHeadings();
      })
    );

    this.registerDomEvent(document, 'selectionchange', () => {
      if (this.pendingProcess) return;
      this.pendingProcess = true;
      requestAnimationFrame(() => {
        this.pendingProcess = false;
        this.processAllHeadings();
      });
    });
  }

  onunload(): void {
    if (this.observer) {
      this.observer.disconnect();
    }
    this.clearAllWidths();
  }

  private clearAllWidths(): void {
    document.querySelectorAll('[style*="--underline-width"]').forEach((el) => {
      (el as HTMLElement).style.removeProperty('--underline-width');
    });
  }

  private getWidthMode(): WidthMode {
    if (document.body.classList.contains('chu-width-last')) return 'last';
    if (document.body.classList.contains('chu-width-full')) return 'full';
    return 'widest';
  }

  private setupObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === 'attributes' &&
          mutation.target === document.body
        ) {
          this.processAllHeadings();
          return;
        }

        const target = mutation.target;
        if (target.nodeType === Node.ELEMENT_NODE) {
          if (
            (target as Element).closest('.markdown-preview-view, .cm-editor')
          ) {
            this.processAllHeadings();
            return;
          }
        } else if (target.nodeType === Node.TEXT_NODE) {
          const parent = (target as Text).parentElement;
          if (parent?.closest('.markdown-preview-view, .cm-editor')) {
            this.processAllHeadings();
            return;
          }
        }
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private processAllHeadings(): void {
    const readingHeadings = document.querySelectorAll(
      '.markdown-preview-view h1, .markdown-preview-view h2, .markdown-preview-view h3, .markdown-preview-view h4, .markdown-preview-view h5, .markdown-preview-view h6'
    );
    readingHeadings.forEach((heading) =>
      this.processHeading(heading as HTMLElement)
    );

    const editingLines = document.querySelectorAll(
      '.cm-line.HyperMD-header-1, .cm-line.HyperMD-header-2, .cm-line.HyperMD-header-3, .cm-line.HyperMD-header-4, .cm-line.HyperMD-header-5, .cm-line.HyperMD-header-6'
    );
    editingLines.forEach((line) =>
      this.processEditingLine(line as HTMLElement)
    );
  }

  private processHeading(heading: HTMLElement): void {
    const mode = this.getWidthMode();

    if (mode === 'full') {
      heading.style.removeProperty('--underline-width');
      return;
    }

    const range = document.createRange();
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

  private processEditingLine(line: HTMLElement): void {
    const mode = this.getWidthMode();

    if (mode === 'full') {
      line.style.removeProperty('--underline-width');
      return;
    }

    const headerSpans = line.querySelectorAll('.cm-header');
    if (headerSpans.length === 0) return;

    const range = document.createRange();
    range.setStartBefore(headerSpans[0]);
    range.setEndAfter(headerSpans[headerSpans.length - 1]);

    const rects = range.getClientRects();
    if (rects.length === 0) return;

    const lineGroups: LineGroup[] = [];
    let currentLineGroup: LineGroup | null = null;

    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (rect.width === 0) continue;

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

  private getTextNodes(element: HTMLElement): Text[] {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Text) => {
        if (node.parentElement?.closest('.heading-collapse-indicator')) {
          return NodeFilter.FILTER_REJECT;
        }
        if ((node.textContent?.trim().length ?? 0) > 0) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      },
    });

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      textNodes.push(node);
    }
    return textNodes;
  }
}
