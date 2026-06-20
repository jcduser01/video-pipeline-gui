// src/log.ts — virtualized monospace log view (SADD §5).
// Single responsibility: ingest log-line events into a bounded ring buffer
// (~5000 lines), render only the visible window (virtualization) for cheap
// scrolling, autoscroll when pinned to the bottom, and coalesce bursts so a
// flood of lines causes at most one repaint per frame. It prints the resolved
// argv at task start (the runner emits that as a stdout line). "Open full log"
// is a stub affordance (full log lives backend-side).

import type { LogLineEvent } from "./types";

const MAX_LINES = 5000;
const LINE_HEIGHT = 18; // px; must match .log__line in styles.css
const OVERSCAN = 12; // lines rendered above/below the viewport

interface LogEntry {
  taskId: string;
  stream: "stdout" | "stderr";
  line: string;
}

export interface LogView {
  push(e: LogLineEvent): void;
  clear(): void;
}

export function mountLog(host: HTMLElement): LogView {
  host.classList.add("log");
  host.innerHTML = `
    <div class="log__toolbar">
      <span class="log__count">0 lines</span>
      <span class="log__spacer"></span>
      <button class="log__full" type="button" title="Open the full log (backend)">Open full log…</button>
      <button class="log__clear" type="button" title="Clear the view">Clear</button>
    </div>
    <div class="log__scroll" tabindex="0">
      <div class="log__spacer-top"></div>
      <div class="log__window"></div>
    </div>
  `;
  const scrollEl = host.querySelector<HTMLElement>(".log__scroll")!;
  const spacerTop = host.querySelector<HTMLElement>(".log__spacer-top")!;
  const windowEl = host.querySelector<HTMLElement>(".log__window")!;
  const countEl = host.querySelector<HTMLElement>(".log__count")!;
  const fullBtn = host.querySelector<HTMLButtonElement>(".log__full")!;
  const clearBtn = host.querySelector<HTMLButtonElement>(".log__clear")!;

  // Ring buffer.
  const buf: LogEntry[] = [];
  let dropped = 0;
  let pinnedToBottom = true;
  let rafScheduled = false;

  fullBtn.addEventListener("click", () => {
    // Stub: in Tauri this would invoke a "reveal full log file" command.
    fullBtn.textContent = "Full log → backend (stub)";
    setTimeout(() => (fullBtn.textContent = "Open full log…"), 1500);
  });
  clearBtn.addEventListener("click", () => {
    buf.length = 0;
    dropped = 0;
    scheduleRender();
  });

  scrollEl.addEventListener("scroll", () => {
    const atBottom =
      scrollEl.scrollTop + scrollEl.clientHeight >=
      scrollEl.scrollHeight - LINE_HEIGHT;
    pinnedToBottom = atBottom;
    scheduleRender();
  });

  function totalLines(): number {
    return buf.length;
  }

  function render(): void {
    rafScheduled = false;
    const total = totalLines();
    const totalHeight = total * LINE_HEIGHT;

    // Maintain total scroll height via the top spacer + window translate.
    const viewport = scrollEl.clientHeight || 1;
    let scrollTop = scrollEl.scrollTop;

    if (pinnedToBottom) {
      scrollTop = Math.max(0, totalHeight - viewport);
    }

    const first = Math.max(
      0,
      Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN,
    );
    const visibleCount =
      Math.ceil(viewport / LINE_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(total, first + visibleCount);

    spacerTop.style.height = `${first * LINE_HEIGHT}px`;
    // Bottom padding keeps the scrollbar length correct.
    windowEl.style.paddingBottom = `${Math.max(
      0,
      (total - last) * LINE_HEIGHT,
    )}px`;

    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const e = buf[i];
      const div = document.createElement("div");
      div.className = `log__line log__line--${e.stream}`;
      const tag = document.createElement("span");
      tag.className = "log__tag";
      tag.textContent = e.taskId;
      const txt = document.createElement("span");
      txt.className = "log__text";
      txt.textContent = e.line;
      div.append(tag, txt);
      frag.appendChild(div);
    }
    windowEl.replaceChildren(frag);

    const dropNote = dropped > 0 ? ` (+${dropped} dropped)` : "";
    countEl.textContent = `${total} lines${dropNote}`;

    if (pinnedToBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }

  function scheduleRender(): void {
    if (rafScheduled) return; // coalesce bursts to one paint per frame
    rafScheduled = true;
    requestAnimationFrame(render);
  }

  // Initial paint.
  scheduleRender();

  return {
    push(e: LogLineEvent): void {
      buf.push({ taskId: e.taskId, stream: e.stream, line: e.line });
      if (buf.length > MAX_LINES) {
        buf.shift();
        dropped += 1;
      }
      scheduleRender();
    },
    clear(): void {
      buf.length = 0;
      dropped = 0;
      scheduleRender();
    },
  };
}
