import { BrandingLogoConfig, InteriorViewConfig, SceneConfig } from '../config/schema';
import { AnnotationEditorState, AnnotationUpdatePatch } from '../annotations/AnnotationManager';
import { createLoader, LoaderController } from '../ui/components/Loader';
import { createToolbar, ToolbarController } from '../ui/components/Toolbar';
import { SplatToggleItem } from '../viewer/SceneManager';
import { ViewerUi } from '../viewer/Viewer';

export interface AppShell extends ViewerUi {
  toolbar: ToolbarController;
  getThemeMode(): 'light' | 'dark';
}

export interface AppShellOptions {
  embedMode?: boolean;
  controlsVisible?: boolean;
  replayButtonVisible?: boolean;
  annotationAuthoring?: boolean;
  onReplay?: () => void;
}

const END_LIGHTBOX_DISMISS_MS = 260;
const ENTRY_LOAD_RING_HIDE_MS = 170;
const ENTRY_LOAD_REVEAL_LEAD_MS = 120;
const SCROOBY_WEBSITE_URL = 'https://csavenables.github.io/ScroobyManor/';
const CHRISTIAN_LINKTREE_URL = 'https://linktr.ee/Csavenables';
type ThemeMode = 'light' | 'dark';

function readStoredTheme(): ThemeMode {
  return 'dark';
}

type ShellActions = Parameters<typeof createToolbar>[1] & {
  onThemeChange?: (theme: ThemeMode) => void;
  onTelemetryEvent?: (
    name: string,
    payload?: Record<string, unknown>,
    category?: 'viewer' | 'ui' | 'cta' | 'perf' | 'error' | 'annotation',
  ) => void;
};

export function createAppShell(
  container: HTMLElement,
  actions: ShellActions,
  options: AppShellOptions = {},
): AppShell {
  const embedMode = options.embedMode ?? false;
  const controlsVisible = options.controlsVisible ?? !embedMode;
  const annotationAuthoring = options.annotationAuthoring ?? false;
  const replayButtonVisible = options.replayButtonVisible ?? embedMode;
  container.innerHTML = `
    <div class="app-shell${embedMode ? ' app-shell-embed' : ''}">
      <header class="app-header${controlsVisible ? '' : ' hidden'}">
        <h1 class="app-title">3DGSViewerV1</h1>
        <p class="scene-title">Scene</p>
      </header>
      <main class="viewer-root">
        <section class="viewer-host" id="viewer-host"></section>
        <div class="hero-wordmark" aria-hidden="true">
          <span class="hero-wordmark-kicker">welcome to:</span>
          <span class="hero-wordmark-title">Scrooby Manor</span>
        </div>
        <div class="brand-logo hidden" data-branding-logo>
          <img alt="" loading="eager" decoding="async" />
        </div>
        <div class="entry-overlay hidden" data-entry-overlay>
          <div class="entry-load-ring hidden" data-entry-load-ring aria-hidden="true">
            <span class="entry-load-ring-inner"></span>
          </div>
        </div>
        <div class="drag-instruction hidden" data-drag-instruction>Drag to explore</div>
        <div class="end-lightbox hidden" data-end-lightbox>
          <div class="end-lightbox-panel">
            <p class="end-lightbox-copy">
              <span class="end-lightbox-line">Imagine couples exploring the estate like this before booking a visit.</span>
              <span class="end-lightbox-line">A more immersive first impression for Scrooby Manor.</span>
              <span class="end-lightbox-line">
                Pilot concept by
                <a
                  class="end-lightbox-credit"
                  href="${CHRISTIAN_LINKTREE_URL}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Christian Venables
                </a>
              </span>
            </p>
            <div class="end-lightbox-actions">
              <a
                class="end-lightbox-link"
                data-end-lightbox-visit
                href="${SCROOBY_WEBSITE_URL}"
                target="_blank"
                rel="noopener noreferrer"
              >
                Visit Scrooby Manor
              </a>
              <button type="button" class="end-lightbox-close" data-end-lightbox-close>Continue exploring</button>
            </div>
          </div>
        </div>
        <button type="button" class="annotation-fab hidden" data-annotation-fab aria-label="Toggle annotation editor">
          Annotations
        </button>
        <div class="annotation-host" id="annotation-host"></div>
        <aside class="annotation-editor hidden" aria-label="Annotation editor">
          <h3 class="interior-title">Annotations</h3>
          <p class="annotation-editor-status" data-ann="status"></p>
          <label class="interior-row interior-check">
            <input data-ann="editMode" type="checkbox" />
            Edit Mode
          </label>
          <label class="interior-row">
            Pin
            <select data-ann="pinSelect"></select>
          </label>
          <div class="annotation-editor-actions annotation-editor-actions-primary">
            <button type="button" class="splat-toggle" data-ann="add">Add</button>
            <button type="button" class="splat-toggle" data-ann="delete">Delete</button>
            <button type="button" class="splat-toggle" data-ann="captureCamera">Capture Camera</button>
            <button type="button" class="splat-toggle" data-ann="save">Save</button>
          </div>
          <label class="interior-row">
            Asset
            <select data-ann="assetSelect"></select>
          </label>
          <label class="interior-row">
            X
            <input data-ann="x" type="number" step="0.01" />
          </label>
          <label class="interior-row">
            Y
            <input data-ann="y" type="number" step="0.01" />
          </label>
          <label class="interior-row">
            Z
            <input data-ann="z" type="number" step="0.01" />
          </label>
          <label class="interior-row">
            Nudge
            <input data-ann="step" type="number" step="0.005" value="0.01" />
          </label>
          <div class="annotation-editor-actions">
            <button type="button" class="splat-toggle" data-ann="x-">X-</button>
            <button type="button" class="splat-toggle" data-ann="x+">X+</button>
            <button type="button" class="splat-toggle" data-ann="y-">Y-</button>
            <button type="button" class="splat-toggle" data-ann="y+">Y+</button>
            <button type="button" class="splat-toggle" data-ann="z-">Z-</button>
            <button type="button" class="splat-toggle" data-ann="z+">Z+</button>
          </div>
          <label class="interior-row">
            Title
            <input data-ann="title" type="text" />
          </label>
          <label class="interior-row annotation-textarea-row">
            Body
            <textarea data-ann="body" rows="3"></textarea>
          </label>
        </aside>
        <div class="transition-overlay"></div>
        <button type="button" class="replay-button${replayButtonVisible ? '' : ' hidden'}" aria-label="Replay intro">
          Replay
        </button>
        <button type="button" class="fullscreen-fab hidden" data-fullscreen-fab aria-label="Toggle fullscreen">
          Fullscreen
        </button>
      </main>
      <div class="error-panel hidden" role="alert">
        <h2 class="error-title"></h2>
        <ul class="error-details"></ul>
      </div>
      <footer class="app-footer${controlsVisible ? '' : ' hidden'}">
        <p>R: Reset</p>
      </footer>
    </div>
  `;

  const appShell = container.querySelector<HTMLElement>('.app-shell');
  const viewerHost = container.querySelector<HTMLElement>('#viewer-host');
  const overlay = container.querySelector<HTMLElement>('.transition-overlay');
  const annotationHost = container.querySelector<HTMLElement>('#annotation-host');
  const entryOverlay = container.querySelector<HTMLElement>('[data-entry-overlay]');
  const entryLoadRing = container.querySelector<HTMLElement>('[data-entry-load-ring]');
  const dragInstruction = container.querySelector<HTMLElement>('[data-drag-instruction]');
  const endLightbox = container.querySelector<HTMLElement>('[data-end-lightbox]');
  const endLightboxClose = container.querySelector<HTMLButtonElement>('[data-end-lightbox-close]');
  const endLightboxVisit = container.querySelector<HTMLAnchorElement>('[data-end-lightbox-visit]');
  const annotationFab = container.querySelector<HTMLButtonElement>('[data-annotation-fab]');
  const fullscreenFab = container.querySelector<HTMLButtonElement>('[data-fullscreen-fab]');
  const brandingLogo = container.querySelector<HTMLElement>('[data-branding-logo]');
  const brandingLogoImage = brandingLogo?.querySelector<HTMLImageElement>('img') ?? null;
  const errorPanel = container.querySelector<HTMLElement>('.error-panel');
  const errorTitle = container.querySelector<HTMLElement>('.error-title');
  const errorDetails = container.querySelector<HTMLElement>('.error-details');
  const sceneTitle = container.querySelector<HTMLElement>('.scene-title');
  const footer = container.querySelector<HTMLElement>('.app-footer');
  const annotationEditor = container.querySelector<HTMLElement>('.annotation-editor');
  const replayButton = container.querySelector<HTMLButtonElement>('.replay-button');

  if (
    !appShell ||
    !viewerHost ||
    !overlay ||
    !annotationHost ||
    !entryOverlay ||
    !entryLoadRing ||
    !dragInstruction ||
    !endLightbox ||
    !endLightboxClose ||
    !endLightboxVisit ||
    !annotationFab ||
    !fullscreenFab ||
    !brandingLogo ||
    !brandingLogoImage ||
    !errorPanel ||
    !errorTitle ||
    !errorDetails ||
    !sceneTitle ||
    !footer ||
    !annotationEditor ||
    !replayButton
  ) {
    throw new Error('App shell failed to initialize.');
  }

  const loader: LoaderController = createLoader(viewerHost);
  const toolbar = createToolbar(footer, actions);
  const emitTelemetry = (
    name: string,
    payload: Record<string, unknown> = {},
    category: 'viewer' | 'ui' | 'cta' | 'perf' | 'error' | 'annotation' = 'ui',
  ): void => {
    actions.onTelemetryEvent?.(name, payload, category);
  };
  brandingLogo.classList.add('hidden');
  let themeMode: ThemeMode = readStoredTheme();
  const applyTheme = (nextTheme: ThemeMode): void => {
    themeMode = nextTheme;
    appShell.classList.toggle('theme-light', themeMode === 'light');
    appShell.classList.toggle('theme-dark', themeMode === 'dark');
  };
  applyTheme(themeMode);
  replayButton.onclick = () => {
    emitTelemetry('button_pressed', { button_id: 'replay', context: 'floating_controls' }, 'ui');
    emitTelemetry('replay_clicked', { context: 'floating_controls' }, 'ui');
    options.onReplay?.();
  };
  const syncFullscreenFab = (): void => {
    const enabled = actions.isFullscreen();
    fullscreenFab.classList.toggle('active', enabled);
    fullscreenFab.textContent = enabled ? '\uD83D\uDDD7' : '\u26F6';
    fullscreenFab.setAttribute(
      'aria-label',
      enabled ? 'Exit fullscreen' : 'Enter fullscreen',
    );
  };
  fullscreenFab.onclick = () => {
    emitTelemetry('button_pressed', { button_id: 'fullscreen_toggle', context: 'floating_controls' }, 'ui');
    const enable = !actions.isFullscreen();
    actions.onToggleFullscreen(enable);
    emitTelemetry('fullscreen_toggled', { enabled: enable, context: 'floating_controls' }, 'ui');
    syncFullscreenFab();
  };
  document.addEventListener('fullscreenchange', syncFullscreenFab);
  let activeToolbarConfig: SceneConfig | null = null;
  const isMobileViewport = (): boolean =>
    window.matchMedia('(max-width: 768px)').matches || window.matchMedia('(pointer: coarse)').matches;
  const syncFullscreenVisibility = (): void => {
    const enabled = Boolean(activeToolbarConfig?.ui.enableFullscreen) && !isMobileViewport();
    fullscreenFab.classList.toggle('hidden', !enabled);
  };
  window.addEventListener('resize', syncFullscreenVisibility);
  let annotationPanelOpen = false;
  let latestAnnotationState: AnnotationEditorState | null = null;
  let entryLoadProgress = 0;
  let entryLoadTarget = 0;
  let entryLoadRaf = 0;
  let entryLoadHideTimer = 0;
  let entryLoadReadyTimer = 0;
  let entryLoadCompleted = false;
  let entryLoadDismissed = false;
  let entryLoadReadyPromise = Promise.resolve();
  let resolveEntryLoadReady: (() => void) | null = null;
  let entryLoadReadySettled = true;
  const clearEntryLoadReadyTimer = (): void => {
    if (!entryLoadReadyTimer) {
      return;
    }
    window.clearTimeout(entryLoadReadyTimer);
    entryLoadReadyTimer = 0;
  };
  const startEntryLoadBarrier = (): void => {
    clearEntryLoadReadyTimer();
    entryLoadReadySettled = false;
    entryLoadReadyPromise = new Promise<void>((resolve) => {
      resolveEntryLoadReady = resolve;
    });
  };
  const resolveEntryLoadBarrier = (delayMs = 0): void => {
    if (entryLoadReadySettled) {
      return;
    }
    clearEntryLoadReadyTimer();
    if (delayMs > 0) {
      entryLoadReadyTimer = window.setTimeout(() => {
        if (entryLoadReadySettled) {
          return;
        }
        entryLoadReadySettled = true;
        const resolver = resolveEntryLoadReady;
        resolveEntryLoadReady = null;
        resolver?.();
      }, delayMs);
      return;
    }
    entryLoadReadySettled = true;
    const resolver = resolveEntryLoadReady;
    resolveEntryLoadReady = null;
    resolver?.();
  };
  const setEntryLoadProgress = (value: number): void => {
    entryLoadProgress = Math.max(0, Math.min(1, value));
    entryLoadRing.style.setProperty('--entry-load-progress', `${(entryLoadProgress * 360).toFixed(2)}deg`);
  };
  const stopEntryLoadAnimation = (): void => {
    if (!entryLoadRaf) {
      return;
    }
    window.cancelAnimationFrame(entryLoadRaf);
    entryLoadRaf = 0;
  };
  const clearEntryLoadHideTimer = (): void => {
    if (!entryLoadHideTimer) {
      return;
    }
    window.clearTimeout(entryLoadHideTimer);
    entryLoadHideTimer = 0;
  };
  const hideEntryLoadRing = (): void => {
    stopEntryLoadAnimation();
    clearEntryLoadHideTimer();
    if (entryLoadRing.classList.contains('hidden')) {
      return;
    }
    entryLoadRing.classList.remove('is-visible');
    entryLoadHideTimer = window.setTimeout(() => {
      entryLoadRing.classList.add('hidden');
    }, ENTRY_LOAD_RING_HIDE_MS);
  };
  const showEntryLoadRing = (): void => {
    if (entryLoadCompleted || entryLoadDismissed || !appShell.classList.contains('entry-active')) {
      return;
    }
    clearEntryLoadHideTimer();
    entryLoadRing.classList.remove('hidden');
    requestAnimationFrame(() => {
      entryLoadRing.classList.add('is-visible');
    });
  };
  const getStageTarget = (message: string | undefined): number => {
    const normalized = (message ?? '').toLowerCase();
    if (normalized.includes('scene configuration')) {
      return 0.18;
    }
    if (normalized.includes('dissolving')) {
      return 0.42;
    }
    if (normalized.includes('splat assets')) {
      return 0.9;
    }
    return 0.12;
  };
  const runEntryLoadAnimation = (): void => {
    entryLoadRaf = 0;
    const delta = entryLoadTarget - entryLoadProgress;
    if (Math.abs(delta) < 0.0005) {
      setEntryLoadProgress(entryLoadTarget);
      if (entryLoadCompleted && entryLoadProgress >= 1) {
        resolveEntryLoadBarrier(ENTRY_LOAD_REVEAL_LEAD_MS);
      }
      return;
    }
    const maxStep = entryLoadCompleted ? 0.08 : 0.022;
    const minStep = entryLoadCompleted ? 0.02 : 0.003;
    const easedStep = Math.max(minStep, Math.min(maxStep, Math.abs(delta) * 0.14));
    const next = entryLoadProgress + Math.sign(delta) * Math.min(Math.abs(delta), easedStep);
    setEntryLoadProgress(next);
    entryLoadRaf = window.requestAnimationFrame(runEntryLoadAnimation);
  };
  const animateEntryLoadTo = (target: number): void => {
    entryLoadTarget = Math.max(entryLoadTarget, Math.min(1, target));
    if (!entryLoadRaf) {
      entryLoadRaf = window.requestAnimationFrame(runEntryLoadAnimation);
    }
  };
  const syncAnnotationFab = (): void => {
    annotationFab.classList.toggle('active', annotationPanelOpen);
    annotationFab.textContent = annotationPanelOpen ? '\u2212' : '+';
    annotationFab.setAttribute(
      'aria-label',
      annotationPanelOpen ? 'Collapse annotations' : 'Expand annotations',
    );
  };
  const syncAnnotationEditorVisibility = (): void => {
    const available = latestAnnotationState?.available ?? false;
    annotationEditor.classList.toggle('hidden', !annotationAuthoring || !available || !annotationPanelOpen);
    syncAnnotationFab();
  };
  annotationFab.onclick = () => {
    emitTelemetry('button_pressed', { button_id: 'annotation_fab_toggle', context: 'floating_controls' }, 'annotation');
    annotationPanelOpen = !annotationPanelOpen;
    emitTelemetry(
      'annotation_panel_toggled',
      { open: annotationPanelOpen, context: 'floating_controls' },
      'annotation',
    );
    syncAnnotationEditorVisibility();
  };
  let dragInstructionHideTimer = 0;
  let dragInstructionShowTimer = 0;
  let hasEnteredExperience = false;
  let hasInteractionSinceEnter = false;
  const clearDragInstructionShowTimer = (): void => {
    if (!dragInstructionShowTimer) {
      return;
    }
    window.clearTimeout(dragInstructionShowTimer);
    dragInstructionShowTimer = 0;
  };
  const clearDragInstructionHideTimer = (): void => {
    if (!dragInstructionHideTimer) {
      return;
    }
    window.clearTimeout(dragInstructionHideTimer);
    dragInstructionHideTimer = 0;
  };
  const hideDragInstruction = (): void => {
    clearDragInstructionHideTimer();
    if (dragInstruction.classList.contains('hidden')) {
      return;
    }
    dragInstruction.classList.remove('is-visible');
    dragInstructionHideTimer = window.setTimeout(() => {
      dragInstruction.classList.add('hidden');
    }, 180);
  };
  const showDragInstruction = (): void => {
    if (!hasEnteredExperience || hasInteractionSinceEnter) {
      return;
    }
    dragInstruction.classList.remove('hidden');
    requestAnimationFrame(() => {
      dragInstruction.classList.add('is-visible');
    });
  };
  const dismissEndLightbox = (): void => {
    if (endLightbox.classList.contains('hidden')) {
      return;
    }
    endLightbox.classList.remove('is-visible');
    endLightbox.classList.add('is-dismissed');
    window.setTimeout(() => {
      endLightbox.classList.add('hidden');
      endLightbox.classList.remove('is-dismissed');
    }, END_LIGHTBOX_DISMISS_MS);
  };
  const markInteraction = (): void => {
    if (!hasEnteredExperience || hasInteractionSinceEnter) {
      return;
    }
    hasInteractionSinceEnter = true;
    hideDragInstruction();
  };
  const bindPostEnterInteraction = (): void => {
    viewerHost.addEventListener('pointerdown', markInteraction, { passive: true });
    viewerHost.addEventListener('wheel', markInteraction, { passive: true });
    viewerHost.addEventListener('touchstart', markInteraction, { passive: true });
  };
  bindPostEnterInteraction();
  endLightboxClose.onclick = () => {
    emitTelemetry('button_pressed', { button_id: 'continue_exploring', context: 'end_lightbox' }, 'cta');
    emitTelemetry('continue_exploring_clicked', { context: 'end_lightbox' }, 'cta');
    dismissEndLightbox();
  };
  endLightboxVisit.onclick = () => {
    emitTelemetry('button_pressed', { button_id: 'visit_scrooby_manor', context: 'end_lightbox' }, 'cta');
    emitTelemetry(
      'website_cta_clicked',
      { cta_id: 'visit_scrooby_manor', destination: SCROOBY_WEBSITE_URL, context: 'end_lightbox' },
      'cta',
    );
    dismissEndLightbox();
  };
  const setBrandingLogo = (logo: BrandingLogoConfig | null): void => {
    if (!logo || !logo.enabled || !logo.src) {
      brandingLogo.classList.add('hidden');
      brandingLogoImage.src = '';
      brandingLogoImage.alt = '';
      return;
    }
    brandingLogo.dataset.position = logo.position;
    brandingLogoImage.alt = logo.alt || 'Brand logo';
    brandingLogoImage.src = logo.src;
    brandingLogo.classList.remove('hidden');
  };
  const getAnnInput = (key: string): HTMLInputElement | null =>
    annotationEditor.querySelector<HTMLInputElement>(`[data-ann="${key}"]`);
  const getAnnSelect = (key: string): HTMLSelectElement | null =>
    annotationEditor.querySelector<HTMLSelectElement>(`[data-ann="${key}"]`);
  const getAnnButton = (key: string): HTMLButtonElement | null =>
    annotationEditor.querySelector<HTMLButtonElement>(`button[data-ann="${key}"]`);
  const annEditMode = getAnnInput('editMode');
  const annPinSelect = getAnnSelect('pinSelect');
  const annAssetSelect = getAnnSelect('assetSelect');
  const annStatus = annotationEditor.querySelector<HTMLElement>('[data-ann="status"]');
  const annX = getAnnInput('x');
  const annY = getAnnInput('y');
  const annZ = getAnnInput('z');
  const annStep = getAnnInput('step');
  const annTitle = getAnnInput('title');
  const annBody = annotationEditor.querySelector<HTMLTextAreaElement>('textarea[data-ann="body"]');
  const annAdd = getAnnButton('add');
  const annDelete = getAnnButton('delete');
  const annCaptureCamera = getAnnButton('captureCamera');
  const annSave = getAnnButton('save');
  const annXMinus = getAnnButton('x-');
  const annXPlus = getAnnButton('x+');
  const annYMinus = getAnnButton('y-');
  const annYPlus = getAnnButton('y+');
  const annZMinus = getAnnButton('z-');
  const annZPlus = getAnnButton('z+');
  let annotationHandlers: {
    onToggleEdit(enabled: boolean): void;
    onSelectPin(id: string): void;
    onAddPin(): void;
    onDeleteSelected(): void;
    onCaptureCamera(): boolean;
    onUpdateSelected(patch: AnnotationUpdatePatch): void;
    onNudge(axis: 'x' | 'y' | 'z', delta: number): void;
    onSave(): void;
  } | null = null;
  return {
    toolbar,
    getThemeMode(): ThemeMode {
      return themeMode;
    },
    setLoading(loading: boolean, message?: string): void {
      loader.hide();
      if (!appShell.classList.contains('entry-active')) {
        resolveEntryLoadBarrier();
        hideEntryLoadRing();
        return;
      }
      if (loading) {
        if (entryLoadReadySettled) {
          startEntryLoadBarrier();
        }
        if (entryLoadCompleted) {
          entryLoadCompleted = false;
          entryLoadDismissed = false;
          entryLoadTarget = 0;
          setEntryLoadProgress(0);
        }
        showEntryLoadRing();
        animateEntryLoadTo(getStageTarget(message));
        return;
      }
      entryLoadCompleted = true;
      if (entryLoadDismissed) {
        resolveEntryLoadBarrier();
        hideEntryLoadRing();
        return;
      }
      if (entryLoadReadySettled) {
        startEntryLoadBarrier();
      }
      showEntryLoadRing();
      animateEntryLoadTo(1);
    },
    setError(title: string, details: string[]): void {
      entryLoadDismissed = true;
      entryLoadCompleted = false;
      resolveEntryLoadBarrier();
      hideEntryLoadRing();
      errorTitle.textContent = title;
      errorDetails.innerHTML = '';
      for (const detail of details) {
        const li = document.createElement('li');
        li.textContent = detail;
        errorDetails.appendChild(li);
      }
      errorPanel.classList.remove('hidden');
    },
    clearError(): void {
      errorPanel.classList.add('hidden');
      errorTitle.textContent = '';
      errorDetails.innerHTML = '';
    },
    configureToolbar(config: SceneConfig): void {
      activeToolbarConfig = config;
      if (controlsVisible) {
        toolbar.setConfig(config);
      }
      annotationFab.classList.toggle('hidden', !annotationAuthoring || !config.annotations.enabled);
      syncFullscreenVisibility();
      if (!config.annotations.enabled) {
        annotationPanelOpen = false;
      }
      syncAnnotationEditorVisibility();
      syncFullscreenFab();
      actions.onThemeChange?.(themeMode);
    },
    configureInteriorDebug(
      config: InteriorViewConfig,
      onChange: (patch: Partial<InteriorViewConfig>) => void,
    ): void {
      void config;
      void onChange;
    },
    setSceneTitle(title: string): void {
      sceneTitle.textContent = title;
    },
    setSplatOptions(
      items: SplatToggleItem[],
      onSelect: (id: string) => void,
    ): void {
      void items;
      void onSelect;
    },
    configureAnnotationEditor(handlers): void {
      annotationHandlers = handlers;
      if (
        !annEditMode ||
        !annPinSelect ||
        !annAssetSelect ||
        !annStatus ||
        !annX ||
        !annY ||
        !annZ ||
        !annStep ||
        !annTitle ||
        !annBody ||
        !annAdd ||
        !annDelete ||
        !annCaptureCamera ||
        !annSave ||
        !annXMinus ||
        !annXPlus ||
        !annYMinus ||
        !annYPlus ||
        !annZMinus ||
        !annZPlus
      ) {
        return;
      }
      const annStatusEl = annStatus!;
      annEditMode.onchange = () => annotationHandlers?.onToggleEdit(annEditMode.checked);
      annPinSelect.onchange = () => annotationHandlers?.onSelectPin(annPinSelect.value);
      annAdd.onclick = () => annotationHandlers?.onAddPin();
      annDelete.onclick = () => annotationHandlers?.onDeleteSelected();
      annCaptureCamera.onclick = () => {
        const captured = annotationHandlers?.onCaptureCamera() ?? false;
        if (captured) {
          annStatusEl.textContent = 'Captured camera (not saved yet)';
        }
      };
      annSave.onclick = () => {
        annotationHandlers?.onSave();
        annStatusEl.textContent = 'Saved annotations';
      };
      const emitPos = (): void => {
        annotationHandlers?.onUpdateSelected({
          pos: [Number(annX.value), Number(annY.value), Number(annZ.value)],
        });
      };
      annX.onchange = emitPos;
      annY.onchange = emitPos;
      annZ.onchange = emitPos;
      annTitle.onchange = () => annotationHandlers?.onUpdateSelected({ title: annTitle.value });
      annBody.onchange = () => annotationHandlers?.onUpdateSelected({ body: annBody.value });
      annAssetSelect.onchange = () =>
        annotationHandlers?.onUpdateSelected({
          assetId: annAssetSelect.value === '__all__' ? null : annAssetSelect.value,
        });
      const nudgeValue = (): number => Math.max(0.001, Number(annStep.value) || 0.01);
      annXMinus.onclick = () => annotationHandlers?.onNudge('x', -nudgeValue());
      annXPlus.onclick = () => annotationHandlers?.onNudge('x', nudgeValue());
      annYMinus.onclick = () => annotationHandlers?.onNudge('y', -nudgeValue());
      annYPlus.onclick = () => annotationHandlers?.onNudge('y', nudgeValue());
      annZMinus.onclick = () => annotationHandlers?.onNudge('z', -nudgeValue());
      annZPlus.onclick = () => annotationHandlers?.onNudge('z', nudgeValue());
    },
    setAnnotationEditorState(state: AnnotationEditorState): void {
      latestAnnotationState = state;
      if (!annotationAuthoring) {
        annotationPanelOpen = false;
      }
      syncAnnotationEditorVisibility();
      if (
        !annEditMode ||
        !annPinSelect ||
        !annAssetSelect ||
        !annX ||
        !annY ||
        !annZ ||
        !annTitle ||
        !annBody ||
        !annDelete
      ) {
        return;
      }
      const annStatusEl = annStatus!;
      annEditMode.checked = state.editMode;
      annStatusEl.textContent = state.available ? 'Ready to edit annotations' : '';
      annPinSelect.innerHTML = '';
      for (const pin of state.pins) {
        const option = document.createElement('option');
        option.value = pin.id;
        option.textContent = `${pin.order}. ${pin.title || pin.id}`;
        annPinSelect.appendChild(option);
      }
      if (state.selectedId) {
        annPinSelect.value = state.selectedId;
      }
      annAssetSelect.innerHTML = '';
      const allOption = document.createElement('option');
      allOption.value = '__all__';
      allOption.textContent = 'All splats';
      annAssetSelect.appendChild(allOption);
      for (const assetId of state.assetIds) {
        const option = document.createElement('option');
        option.value = assetId;
        option.textContent = assetId;
        annAssetSelect.appendChild(option);
      }
      const selected = state.pins.find((pin) => pin.id === state.selectedId) ?? null;
      if (selected) {
        annX.value = selected.pos[0].toFixed(4);
        annY.value = selected.pos[1].toFixed(4);
        annZ.value = selected.pos[2].toFixed(4);
        annTitle.value = selected.title;
        annBody.value = selected.body;
        annAssetSelect.value = selected.assetId ?? '__all__';
      }
      annDelete.disabled = !selected;
      const readonly = !state.editMode || !selected;
      annX.disabled = readonly;
      annY.disabled = readonly;
      annZ.disabled = readonly;
      annTitle.disabled = readonly;
      annBody.disabled = readonly;
      annAssetSelect.disabled = readonly;
    },
    waitForEntryLoadReadyBeforeReveal(): Promise<void> {
      return entryLoadReadyPromise;
    },
    notifyRevealStarting(): void {
      entryLoadDismissed = true;
      resolveEntryLoadBarrier();
      hideEntryLoadRing();
      hasEnteredExperience = true;
      if (!hasInteractionSinceEnter) {
        clearDragInstructionShowTimer();
        dragInstructionShowTimer = window.setTimeout(() => {
          showDragInstruction();
        }, 420);
      }
    },
    setBrandingLogo(logo: BrandingLogoConfig | null): void {
      setBrandingLogo(logo);
    },
    getOverlayElement(): HTMLElement {
      return overlay;
    },
    getCanvasHostElement(): HTMLElement {
      return viewerHost;
    },
    getAnnotationHostElement(): HTMLElement {
      return annotationHost;
    },
  };
}
