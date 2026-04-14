import { InteriorViewConfig, SceneConfig } from '../config/schema';
import { AnnotationEditorState, AnnotationUpdatePatch } from '../annotations/AnnotationManager';
import { createLoader, LoaderController } from '../ui/components/Loader';
import { createToolbar, ToolbarController } from '../ui/components/Toolbar';
import { SplatToggleItem } from '../viewer/SceneManager';
import { ViewerUi } from '../viewer/Viewer';

export interface AppShell extends ViewerUi {
  toolbar: ToolbarController;
}

export interface AppShellOptions {
  embedMode?: boolean;
  controlsVisible?: boolean;
  replayButtonVisible?: boolean;
  onReplay?: () => void;
}

export function createAppShell(
  container: HTMLElement,
  actions: Parameters<typeof createToolbar>[1],
  options: AppShellOptions = {},
): AppShell {
  const embedMode = options.embedMode ?? false;
  const controlsVisible = options.controlsVisible ?? !embedMode;
  const replayButtonVisible = options.replayButtonVisible ?? embedMode;
  container.innerHTML = `
    <div class="app-shell${embedMode ? ' app-shell-embed' : ''}">
      <header class="app-header${controlsVisible ? '' : ' hidden'}">
        <h1 class="app-title">3DGSViewerV1</h1>
        <p class="scene-title">Scene</p>
      </header>
      <main class="viewer-root">
        <section class="viewer-host" id="viewer-host"></section>
        <div class="annotation-host" id="annotation-host"></div>
        <aside class="splat-panel${controlsVisible ? '' : ' hidden'}" aria-label="Splat visibility controls">
          <h2 class="splat-panel-title">Splats</h2>
          <div class="splat-controls"></div>
          <div class="annotation-editor hidden">
            <h3 class="interior-title">Annotations</h3>
            <label class="interior-row interior-check">
              <input data-ann="editMode" type="checkbox" />
              Edit Mode
            </label>
            <label class="interior-row">
              Pin
              <select data-ann="pinSelect"></select>
            </label>
            <div class="annotation-editor-actions">
              <button type="button" class="splat-toggle" data-ann="add">Add</button>
              <button type="button" class="splat-toggle" data-ann="delete">Delete</button>
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
          </div>
          <div class="interior-debug">
            <h3 class="interior-title">Interior Debug</h3>
            <label class="interior-row">Radius <input data-key="radius" type="range" min="0.2" max="20" step="0.05" /></label>
            <label class="interior-row">Softness <input data-key="softness" type="range" min="0.05" max="0.6" step="0.01" /></label>
            <label class="interior-row">Fade Alpha <input data-key="fadeAlpha" type="range" min="0" max="1" step="0.01" /></label>
            <label class="interior-row">Max Dist <input data-key="maxDistance" type="range" min="1" max="100" step="1" /></label>
            <label class="interior-row">Target X <input data-key="targetX" type="range" min="-10" max="10" step="0.05" /></label>
            <label class="interior-row">Target Y <input data-key="targetY" type="range" min="-10" max="10" step="0.05" /></label>
            <label class="interior-row">Target Z <input data-key="targetZ" type="range" min="-10" max="10" step="0.05" /></label>
            <label class="interior-row interior-check">
              <input data-key="enabled" type="checkbox" />
              Enabled
            </label>
          </div>
        </aside>
        <div class="transition-overlay"></div>
        <button type="button" class="replay-button${replayButtonVisible ? '' : ' hidden'}" aria-label="Replay intro">
          Replay
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

  const viewerHost = container.querySelector<HTMLElement>('#viewer-host');
  const overlay = container.querySelector<HTMLElement>('.transition-overlay');
  const annotationHost = container.querySelector<HTMLElement>('#annotation-host');
  const errorPanel = container.querySelector<HTMLElement>('.error-panel');
  const errorTitle = container.querySelector<HTMLElement>('.error-title');
  const errorDetails = container.querySelector<HTMLElement>('.error-details');
  const sceneTitle = container.querySelector<HTMLElement>('.scene-title');
  const footer = container.querySelector<HTMLElement>('.app-footer');
  const splatControls = container.querySelector<HTMLElement>('.splat-controls');
  const interiorDebug = container.querySelector<HTMLElement>('.interior-debug');
  const annotationEditor = container.querySelector<HTMLElement>('.annotation-editor');
  const replayButton = container.querySelector<HTMLButtonElement>('.replay-button');

  if (
    !viewerHost ||
    !overlay ||
    !annotationHost ||
    !errorPanel ||
    !errorTitle ||
    !errorDetails ||
    !sceneTitle ||
    !footer ||
    !splatControls ||
    !interiorDebug ||
    !annotationEditor ||
    !replayButton
  ) {
    throw new Error('App shell failed to initialize.');
  }

  const loader: LoaderController = createLoader(viewerHost);
  const toolbar = createToolbar(footer, actions);
  replayButton.onclick = () => options.onReplay?.();
  const getAnnInput = (key: string): HTMLInputElement | null =>
    annotationEditor.querySelector<HTMLInputElement>(`[data-ann="${key}"]`);
  const getAnnSelect = (key: string): HTMLSelectElement | null =>
    annotationEditor.querySelector<HTMLSelectElement>(`[data-ann="${key}"]`);
  const getAnnButton = (key: string): HTMLButtonElement | null =>
    annotationEditor.querySelector<HTMLButtonElement>(`button[data-ann="${key}"]`);
  const annEditMode = getAnnInput('editMode');
  const annPinSelect = getAnnSelect('pinSelect');
  const annAssetSelect = getAnnSelect('assetSelect');
  const annX = getAnnInput('x');
  const annY = getAnnInput('y');
  const annZ = getAnnInput('z');
  const annStep = getAnnInput('step');
  const annTitle = getAnnInput('title');
  const annBody = annotationEditor.querySelector<HTMLTextAreaElement>('textarea[data-ann="body"]');
  const annAdd = getAnnButton('add');
  const annDelete = getAnnButton('delete');
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
    onUpdateSelected(patch: AnnotationUpdatePatch): void;
    onNudge(axis: 'x' | 'y' | 'z', delta: number): void;
    onSave(): void;
  } | null = null;
  return {
    toolbar,
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
    },
    configureInteriorDebug(
      config: InteriorViewConfig,
      onChange: (patch: Partial<InteriorViewConfig>) => void,
    ): void {
      const getInput = (key: string): HTMLInputElement | null =>
        interiorDebug.querySelector<HTMLInputElement>(`input[data-key="${key}"]`);
      const radius = getInput('radius');
      const softness = getInput('softness');
      const fadeAlpha = getInput('fadeAlpha');
      const maxDistance = getInput('maxDistance');
      const targetX = getInput('targetX');
      const targetY = getInput('targetY');
      const targetZ = getInput('targetZ');
      const enabled = getInput('enabled');
      if (!radius || !softness || !fadeAlpha || !maxDistance || !targetX || !targetY || !targetZ || !enabled) {
        return;
      }
      radius.value = String(config.radius);
      softness.value = String(config.softness);
      fadeAlpha.value = String(config.fadeAlpha);
      maxDistance.value = String(config.maxDistance);
      targetX.value = String(config.target[0]);
      targetY.value = String(config.target[1]);
      targetZ.value = String(config.target[2]);
      enabled.checked = config.enabled;

      const emitTarget = (): void => {
        onChange({
          target: [Number(targetX.value), Number(targetY.value), Number(targetZ.value)],
        });
      };
      radius.oninput = () => onChange({ radius: Number(radius.value) });
      softness.oninput = () => onChange({ softness: Number(softness.value) });
      fadeAlpha.oninput = () => onChange({ fadeAlpha: Number(fadeAlpha.value) });
      maxDistance.oninput = () => onChange({ maxDistance: Number(maxDistance.value) });
      targetX.oninput = emitTarget;
      targetY.oninput = emitTarget;
      targetZ.oninput = emitTarget;
      enabled.onchange = () => onChange({ enabled: enabled.checked });
    },
    setSceneTitle(title: string): void {
      sceneTitle.textContent = title;
    },
    setSplatOptions(
      items: SplatToggleItem[],
      onSelect: (id: string) => void,
    ): void {
      if (!controlsVisible) {
        splatControls.innerHTML = '';
        return;
      }
      const staircaseActive = items.some((item) => item.id === 'staircase' && item.active);
      interiorDebug.classList.toggle('hidden', !staircaseActive);
      splatControls.innerHTML = '';
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'splat-toggle';
        button.dataset.splatId = item.id;
        button.dataset.active = item.active ? 'true' : 'false';
        button.dataset.loaded = item.loaded ? 'true' : 'false';
        button.textContent = item.label;
        button.classList.toggle('active', item.active);
        button.classList.toggle('failed', item.failed);
        button.disabled = !item.loaded || item.failed;
        button.onclick = () => {
          if (button.disabled) {
            return;
          }
          for (const other of splatControls.querySelectorAll<HTMLButtonElement>('button.splat-toggle')) {
            other.classList.remove('active');
          }
          button.classList.add('active');
          onSelect(item.id);
        };
        splatControls.appendChild(button);
      }
    },
    configureAnnotationEditor(handlers): void {
      annotationHandlers = handlers;
      if (
        !annEditMode ||
        !annPinSelect ||
        !annAssetSelect ||
        !annX ||
        !annY ||
        !annZ ||
        !annStep ||
        !annTitle ||
        !annBody ||
        !annAdd ||
        !annDelete ||
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
      annEditMode.onchange = () => annotationHandlers?.onToggleEdit(annEditMode.checked);
      annPinSelect.onchange = () => annotationHandlers?.onSelectPin(annPinSelect.value);
      annAdd.onclick = () => annotationHandlers?.onAddPin();
      annDelete.onclick = () => annotationHandlers?.onDeleteSelected();
      annSave.onclick = () => annotationHandlers?.onSave();
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
      if (!controlsVisible) {
        annotationEditor.classList.add('hidden');
        return;
      }
      annotationEditor.classList.toggle('hidden', !state.available);
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
      annEditMode.checked = state.editMode;
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
