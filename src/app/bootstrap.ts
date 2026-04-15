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

const THEME_STORAGE_KEY = 'hodsock.viewer.theme';
const FORCE_LOGO_ALT = 'Hodsock Priory';
const FORCE_LOGO_SOURCES = ['./main-logo.svg', 'main-logo.svg', 'branding/main-logo.svg', './branding/main-logo.svg'] as const;
type ThemeMode = 'light' | 'dark';

function readStoredTheme(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function persistTheme(theme: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // no-op
  }
}

type ShellActions = Parameters<typeof createToolbar>[1] & {
  onThemeChange?: (theme: ThemeMode) => void;
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
    <div class="app-shell${embedMode ? ' app-shell-embed' : ''} entry-active">
      <header class="app-header${controlsVisible ? '' : ' hidden'}">
        <h1 class="app-title">3DGSViewerV1</h1>
        <p class="scene-title">Scene</p>
      </header>
      <main class="viewer-root">
        <section class="viewer-host" id="viewer-host"></section>
        <div class="brand-logo hidden" data-branding-logo>
          <img alt="" loading="eager" decoding="async" />
        </div>
        <div class="entry-overlay" data-entry-overlay>
          <div class="entry-overlay-content">
            <h2 class="entry-title">
              <span class="entry-title-desktop">Explore Hodsock<br />Priory Before<br />You Visit</span>
              <span class="entry-title-mobile">Explore Hodsock Priory before you visit</span>
            </h2>
            <p class="entry-subline">An interactive preview designed to give couples a true sense of the space</p>
            <button type="button" class="entry-button" data-enter-experience>Enter Experience</button>
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
        <button type="button" class="theme-fab" data-theme-fab aria-label="Toggle theme"></button>
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
  const enterExperienceButton = container.querySelector<HTMLButtonElement>('[data-enter-experience]');
  const annotationFab = container.querySelector<HTMLButtonElement>('[data-annotation-fab]');
  const fullscreenFab = container.querySelector<HTMLButtonElement>('[data-fullscreen-fab]');
  const themeFab = container.querySelector<HTMLButtonElement>('[data-theme-fab]');
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
    !enterExperienceButton ||
    !annotationFab ||
    !fullscreenFab ||
    !themeFab ||
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
  let currentLogoCandidates: string[] = [];
  let currentLogoCandidateIndex = 0;
  const applyLogoSource = (source: string, alt: string): void => {
    brandingLogoImage.alt = alt || FORCE_LOGO_ALT;
    brandingLogoImage.src = source;
    brandingLogo.classList.remove('hidden');
  };
  const setLogoWithFallbacks = (sources: readonly string[], alt: string): void => {
    currentLogoCandidates = Array.from(new Set(sources.filter((source) => source.trim().length > 0)));
    currentLogoCandidateIndex = 0;
    if (currentLogoCandidates.length === 0) {
      return;
    }
    applyLogoSource(currentLogoCandidates[0], alt);
  };
  brandingLogoImage.onerror = () => {
    const failedSource = currentLogoCandidates[currentLogoCandidateIndex] ?? brandingLogoImage.src;
    console.warn(`[branding] logo source failed: ${failedSource}`);
    if (currentLogoCandidateIndex >= currentLogoCandidates.length - 1) {
      return;
    }
    currentLogoCandidateIndex += 1;
    applyLogoSource(currentLogoCandidates[currentLogoCandidateIndex], brandingLogoImage.alt || FORCE_LOGO_ALT);
  };
  brandingLogoImage.onload = () => {
    brandingLogo.classList.remove('hidden');
  };
  // Force an immediate logo on boot, then allow scene branding config to override if present.
  brandingLogo.classList.remove('hidden');
  brandingLogo.dataset.position = 'top-left';
  setLogoWithFallbacks(FORCE_LOGO_SOURCES, FORCE_LOGO_ALT);
  let themeMode: ThemeMode = readStoredTheme();
  const applyTheme = (nextTheme: ThemeMode): void => {
    themeMode = nextTheme;
    appShell.classList.toggle('theme-light', themeMode === 'light');
    appShell.classList.toggle('theme-dark', themeMode === 'dark');
    themeFab.textContent = themeMode === 'dark' ? '\u2600' : '\u263E';
    themeFab.setAttribute(
      'aria-label',
      themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
    );
  };
  const setTheme = (nextTheme: ThemeMode): void => {
    applyTheme(nextTheme);
    persistTheme(nextTheme);
    actions.onThemeChange?.(nextTheme);
  };
  applyTheme(themeMode);
  replayButton.onclick = () => options.onReplay?.();
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
    const enable = !actions.isFullscreen();
    actions.onToggleFullscreen(enable);
    syncFullscreenFab();
  };
  themeFab.onclick = () => {
    setTheme(themeMode === 'light' ? 'dark' : 'light');
  };
  document.addEventListener('fullscreenchange', syncFullscreenFab);
  let annotationPanelOpen = false;
  let latestAnnotationState: AnnotationEditorState | null = null;
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
    annotationPanelOpen = !annotationPanelOpen;
    syncAnnotationEditorVisibility();
  };
  enterExperienceButton.onclick = () => {
    if (!appShell.classList.contains('entry-active')) {
      return;
    }
    entryOverlay.classList.add('is-dismissed');
    window.setTimeout(() => {
      appShell.classList.remove('entry-active');
      entryOverlay.classList.add('hidden');
    }, 520);
  };
  const setBrandingLogo = (logo: BrandingLogoConfig | null): void => {
    if (!logo || !logo.enabled || !logo.src) {
      brandingLogo.dataset.position = 'top-left';
      setLogoWithFallbacks(FORCE_LOGO_SOURCES, FORCE_LOGO_ALT);
      return;
    }
    brandingLogo.dataset.position = logo.position;
    setLogoWithFallbacks([logo.src, ...FORCE_LOGO_SOURCES], logo.alt || FORCE_LOGO_ALT);
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
      void loading;
      void message;
      loader.hide();
    },
    setError(title: string, details: string[]): void {
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
      if (controlsVisible) {
        toolbar.setConfig(config);
      }
      annotationFab.classList.toggle('hidden', !annotationAuthoring || !config.annotations.enabled);
      fullscreenFab.classList.toggle('hidden', !config.ui.enableFullscreen);
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
