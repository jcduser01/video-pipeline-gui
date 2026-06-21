// src/previewer.ts — the single-<video> layer previewer (SADD §6).
// Single responsibility: present ONE <video> element whose src swaps between
// previewable artifacts that also exist on disk, while preserving the viewer's
// sense of place. Key behaviours mandated by the SADD:
//   (a) Playhead/play-state preservation: capture currentTime + paused BEFORE a
//       src swap and restore on 'loadeddata' (re-seek; resume if it was playing).
//   (b) A global 0.0–1.0 volume coefficient slider that sets video.volume.
//   (c) A checkerboard/black backdrop behind the <video> so a transparent (alpha)
//       layer reads unambiguously.
// Layers are sorted by z_order. The ALPHA case (caption overlay, HEVC-alpha) is
// gated on a WKWebView spike — until that lands, transparent playback in the
// Tauri webview is unverified; the checkerboard makes any alpha support visible.
//
// NOTE (WKWebView alpha spike): macOS WKWebView's HEVC-with-alpha support in the
// Tauri webview is unproven. This module renders the alpha layer the same way;
// if the webview composites alpha, the checkerboard shows through. If not, the
// spike's outcome will dictate a fallback (e.g. backend pre-composite preview).

import { ipc } from "./ipc";
import type { Artifact, Schema } from "./types";
import { store } from "./state";
import { artifactPathsFor } from "./command";
import { bindLabelHelp, helpMarkup, type HelpPanel } from "./help";
import { tauriAvailable } from "./dialog";

// In the Tauri webview a <video> can't load a raw filesystem path — it needs an
// asset-protocol URL. `convertFileSrc` produces one (identity in browser/mock).
// Without this the element never loads, so transport never enables and the
// duration stays 0:00. The asset scope + CSP already allow $HOME media.
let toAssetUrl: (p: string) => string = (p) => p;
const assetReady: Promise<void> = tauriAvailable()
  ? import("@tauri-apps/api/core").then((m) => {
      toAssetUrl = m.convertFileSrc;
    })
  : Promise.resolve();

const PLAY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>';

/** mm:ss for the transport readout (NaN/∞ render as 0:00 during load). */
function clock(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Friendly layer name from an artifact id: "caption.preview" -> "Caption (preview)". */
function layerName(a: Artifact): string {
  const isPreview = a.id.endsWith(".preview");
  const stem = a.id.replace(/\.preview$/, "").replace(/[._]/g, " ");
  const title = stem.replace(/\b\w/g, (c) => c.toUpperCase());
  return isPreview ? `${title} (preview)` : title;
}

export interface Previewer {
  /** Recompute which layers are available (present ∩ previewable) and rebuild. */
  refresh(projectRoot: string | undefined): Promise<void>;
  /** Lock the stage aspect ratio to the output profile (e.g. "feed-square-1x1"). */
  setProfile(profile: string): void;
}

export function mountPreviewer(
  host: HTMLElement,
  schema: Schema,
  help: HelpPanel,
): Previewer {
  host.classList.add("previewer");
  host.innerHTML = `
    <div class="previewer__stagewrap">
      <div class="previewer__stage">
        <div class="previewer__backdrop" aria-hidden="true"></div>
        <video class="previewer__video" playsinline preload="auto"></video>
        <div class="previewer__empty empty-state"><span></span></div>
      </div>
    </div>
    <div class="previewer__transport">
      <button class="previewer__play" type="button" title="Play / pause" disabled>${PLAY_ICON}</button>
      <input class="previewer__seek" type="range" min="0" max="0" step="0.01" value="0" disabled />
      <span class="previewer__time">0:00&nbsp;/&nbsp;0:00</span>
    </div>
    <div class="previewer__controls">
      <label class="previewer__layerlabel"><span data-help="layer">Layer</span>
        <select class="previewer__layers"></select>
      </label>
      <label class="previewer__vollabel"><span data-help="vol">Vol</span>
        <input class="previewer__vol" type="range" min="0" max="1" step="0.01" value="1" />
        <output class="previewer__volval">1.00</output>
      </label>
      <span class="previewer__status"></span>
    </div>
  `;

  // Help triggers on the control labels (reachable even when the select is
  // disabled because nothing is on disk yet).
  bindLabelHelp(
    host.querySelector<HTMLElement>('[data-help="layer"]')!,
    () =>
      helpMarkup(
        "Preview layer",
        "Choose which produced layer to preview — base video, caption overlay, etc. A layer becomes selectable once a run has written it to disk; absent layers are disabled.",
      ),
    help,
  );
  bindLabelHelp(
    host.querySelector<HTMLElement>('[data-help="vol"]')!,
    () =>
      helpMarkup(
        "Preview volume",
        "Playback volume for the preview only (0.00–1.00). It does not affect the rendered output.",
      ),
    help,
  );

  const stageWrap = host.querySelector<HTMLElement>(".previewer__stagewrap")!;
  const stage = host.querySelector<HTMLElement>(".previewer__stage")!;
  const video = host.querySelector<HTMLVideoElement>(".previewer__video")!;
  const select = host.querySelector<HTMLSelectElement>(".previewer__layers")!;
  const vol = host.querySelector<HTMLInputElement>(".previewer__vol")!;
  const volVal = host.querySelector<HTMLOutputElement>(".previewer__volval")!;
  const status = host.querySelector<HTMLElement>(".previewer__status")!;
  const playBtn = host.querySelector<HTMLButtonElement>(".previewer__play")!;
  const seek = host.querySelector<HTMLInputElement>(".previewer__seek")!;
  const timeEl = host.querySelector<HTMLElement>(".previewer__time")!;
  const emptyEl = host.querySelector<HTMLElement>(".previewer__empty > span")!;
  const emptyBox = host.querySelector<HTMLElement>(".previewer__empty")!;

  const showEmpty = (text: string) => {
    emptyEl.textContent = text;
    emptyBox.hidden = false;
  };
  const hideEmpty = () => {
    emptyBox.hidden = true;
  };

  // Stage sizing: the aspect ratio is locked to the output profile; the size is
  // free — fit the largest box of that ratio inside the available area.
  let aspect = 9 / 16; // default (reels) until setProfile runs
  function fitStage(): void {
    const availW = stageWrap.clientWidth;
    const availH = stageWrap.clientHeight;
    if (availW <= 0 || availH <= 0) return;
    let w = availW;
    let h = availW / aspect;
    if (h > availH) {
      h = availH;
      w = availH * aspect;
    }
    stage.style.width = `${Math.floor(w)}px`;
    stage.style.height = `${Math.floor(h)}px`;
  }
  new ResizeObserver(() => fitStage()).observe(stageWrap);

  function setProfile(profile: string): void {
    const m = /(\d+)x(\d+)/.exec(profile);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w > 0 && h > 0) aspect = w / h;
    }
    fitStage();
  }

  // --- global volume coefficient (b) ---
  const applyVolume = () => {
    const v = Number(vol.value);
    video.volume = Math.max(0, Math.min(1, v));
    volVal.textContent = video.volume.toFixed(2);
  };
  vol.addEventListener("input", applyVolume);
  applyVolume();

  // --- transport: play/pause + scrub + clock ---
  let scrubbing = false;
  const setPlayIcon = () => {
    playBtn.innerHTML = video.paused || video.ended ? PLAY_ICON : PAUSE_ICON;
  };
  const enableTransport = (on: boolean) => {
    playBtn.disabled = !on;
    seek.disabled = !on;
    if (!on) {
      seek.value = "0";
      timeEl.innerHTML = "0:00&nbsp;/&nbsp;0:00";
      setPlayIcon();
    }
  };
  const renderTime = () => {
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    timeEl.innerHTML = `${clock(video.currentTime)}&nbsp;/&nbsp;${clock(dur)}`;
  };

  playBtn.addEventListener("click", () => {
    if (video.paused || video.ended) void video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener("play", setPlayIcon);
  video.addEventListener("pause", setPlayIcon);
  video.addEventListener("ended", setPlayIcon);
  video.addEventListener("loadedmetadata", () => {
    seek.max = String(Number.isFinite(video.duration) ? video.duration : 0);
    renderTime();
  });
  video.addEventListener("timeupdate", () => {
    if (!scrubbing) seek.value = String(video.currentTime);
    renderTime();
  });
  // Scrub: seek live while dragging; timeupdate stops fighting the thumb.
  seek.addEventListener("input", () => {
    scrubbing = true;
    video.currentTime = Number(seek.value);
    renderTime();
  });
  seek.addEventListener("change", () => {
    scrubbing = false;
  });

  // Previewable layers from the schema, sorted by z_order (low → high).
  const previewable = (schema.artifacts as Artifact[])
    .filter((a) => a.previewable)
    .sort((a, b) => (a.z_order ?? 0) - (b.z_order ?? 0));

  /**
   * Swap the video src while preserving playhead + play-state (a).
   * Captures BEFORE the swap; restores after 'loadeddata'.
   */
  function swapSource(src: string, artifact: Artifact): void {
    hideEmpty();
    const wasTime = video.currentTime;
    const wasPlaying = !video.paused && !video.ended;

    const onLoaded = () => {
      video.removeEventListener("loadeddata", onLoaded);
      // Re-seek to the captured playhead (clamp to the new duration).
      const target = Number.isFinite(video.duration)
        ? Math.min(wasTime, video.duration)
        : wasTime;
      try {
        video.currentTime = target;
      } catch {
        /* some sources disallow seeking before play; ignore */
      }
      if (wasPlaying) {
        void video.play().catch(() => {
          /* autoplay policy may block resume; leave paused */
        });
      }
      enableTransport(true);
      setPlayIcon();
      status.textContent = layerName(artifact);
    };

    video.addEventListener("loadeddata", onLoaded);
    video.src = toAssetUrl(src);
    // Mark alpha layers so the backdrop reads through (checkerboard).
    host.classList.toggle(
      "previewer--alpha",
      Boolean(artifact.codec_hint?.includes("alpha")),
    );
    video.load();
  }

  function selectLayer(id: string, presentIds: Set<string>): void {
    const artifact = previewable.find((a) => a.id === id);
    if (!artifact) return;
    const paths = artifactPathsFor(schema, store.projectRoot());
    const src = paths[artifact.id];
    store.setPreviewLayer(id);
    if (!presentIds.has(id) || !src) {
      enableTransport(false);
      video.removeAttribute("src");
      video.load();
      status.textContent = `${layerName(artifact)} · not on disk yet`;
      showEmpty(`The “${layerName(artifact)}” layer hasn't been rendered yet — run the step that produces it to preview it here.`);
      return;
    }
    swapSource(src, artifact);
  }

  return {
    async refresh(projectRoot: string | undefined): Promise<void> {
      await assetReady; // ensure convertFileSrc is loaded before any src swap
      const root = projectRoot ?? store.activeProjectRoot() ?? "";
      let present: string[] = [];
      try {
        present = await ipc.listPresentArtifacts(root);
      } catch {
        present = [];
      }
      const presentIds = new Set(present);

      // Rebuild the layer selector: all previewable layers, marking absent ones.
      select.innerHTML = "";
      for (const a of previewable) {
        const opt = document.createElement("option");
        opt.value = a.id;
        const here = presentIds.has(a.id);
        opt.textContent = here ? layerName(a) : `${layerName(a)} (absent)`;
        opt.disabled = !here;
        select.appendChild(opt);
      }

      // Restore persisted layer if still valid+present, else first present.
      const persisted = store.getPreviewLayer();
      const firstPresent = previewable.find((a) => presentIds.has(a.id))?.id;
      const chosen =
        persisted && presentIds.has(persisted) ? persisted : firstPresent;

      select.onchange = () => selectLayer(select.value, presentIds);

      if (chosen) {
        select.value = chosen;
        selectLayer(chosen, presentIds);
      } else {
        enableTransport(false);
        status.textContent = "";
        showEmpty(
          "Layer preview. Once a step renders a layer (base video, caption overlay…), pick it here to play it back.",
        );
      }
    },
    setProfile,
  };
}
