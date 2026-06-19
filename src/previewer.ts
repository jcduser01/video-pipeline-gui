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

export interface Previewer {
  /** Recompute which layers are available (present ∩ previewable) and rebuild. */
  refresh(projectRoot: string | undefined): Promise<void>;
}

export function mountPreviewer(host: HTMLElement, schema: Schema): Previewer {
  host.classList.add("previewer");
  host.innerHTML = `
    <div class="previewer__stage">
      <div class="previewer__backdrop" aria-hidden="true"></div>
      <video class="previewer__video" playsinline preload="auto"></video>
    </div>
    <div class="previewer__controls">
      <label class="previewer__layerlabel">Layer
        <select class="previewer__layers"></select>
      </label>
      <label class="previewer__vollabel">Vol
        <input class="previewer__vol" type="range" min="0" max="1" step="0.01" value="1" />
        <output class="previewer__volval">1.00</output>
      </label>
      <span class="previewer__status"></span>
    </div>
  `;

  const video = host.querySelector<HTMLVideoElement>(".previewer__video")!;
  const select = host.querySelector<HTMLSelectElement>(".previewer__layers")!;
  const vol = host.querySelector<HTMLInputElement>(".previewer__vol")!;
  const volVal = host.querySelector<HTMLOutputElement>(".previewer__volval")!;
  const status = host.querySelector<HTMLElement>(".previewer__status")!;

  // --- global volume coefficient (b) ---
  const applyVolume = () => {
    const v = Number(vol.value);
    video.volume = Math.max(0, Math.min(1, v));
    volVal.textContent = video.volume.toFixed(2);
  };
  vol.addEventListener("input", applyVolume);
  applyVolume();

  // Previewable layers from the schema, sorted by z_order (low → high).
  const previewable = (schema.artifacts as Artifact[])
    .filter((a) => a.previewable)
    .sort((a, b) => (a.z_order ?? 0) - (b.z_order ?? 0));

  /**
   * Swap the video src while preserving playhead + play-state (a).
   * Captures BEFORE the swap; restores after 'loadeddata'.
   */
  function swapSource(src: string, artifact: Artifact): void {
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
      const alpha = artifact.codec_hint?.includes("alpha");
      status.textContent = alpha
        ? `${artifact.id} · alpha (WKWebView spike)`
        : artifact.id;
    };

    video.addEventListener("loadeddata", onLoaded);
    video.src = src;
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
    const paths = artifactPathsFor(schema, store.activeProjectRoot());
    const src = paths[artifact.id];
    store.setPreviewLayer(id);
    if (!presentIds.has(id) || !src) {
      status.textContent = `${id} · not on disk yet`;
      return;
    }
    swapSource(src, artifact);
  }

  return {
    async refresh(projectRoot: string | undefined): Promise<void> {
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
        opt.textContent = here ? a.id : `${a.id} (absent)`;
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
        status.textContent = "No previewable layers on disk yet";
      }
    },
  };
}
