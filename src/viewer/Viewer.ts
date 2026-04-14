import * as THREE from 'three';
import {
  AnnotationEditorState,
  AnnotationManager,
  AnnotationUpdatePatch,
} from '../annotations/AnnotationManager';
import { AnnotationPersistence } from '../annotations/AnnotationPersistence';
import { InteriorViewConfig, RevealConfig, SceneConfig } from '../config/schema';
import { GaussianSplatRenderer } from '../renderers/GaussianSplatRenderer';
import { SplatHandle } from '../renderers/types';
import { InputBindings } from './InputBindings';
import { CameraController } from './CameraController';
import { SceneManager, SplatToggleItem } from './SceneManager';
import { ParticleIntroController } from './ParticleIntroController';
import { easeInOutCubic } from '../utils/easing';

export interface ViewerUi {
  setLoading(loading: boolean, message?: string): void;
  setError(title: string, details: string[]): void;
  clearError(): void;
  configureToolbar(config: SceneConfig): void;
  configureInteriorDebug(
    config: InteriorViewConfig,
    onChange: (patch: Partial<InteriorViewConfig>) => void,
  ): void;
  setSceneTitle(title: string): void;
  setSplatOptions(items: SplatToggleItem[], onSelect: (id: string) => void): void;
  configureAnnotationEditor(handlers: {
    onToggleEdit(enabled: boolean): void;
    onSelectPin(id: string): void;
    onAddPin(): void;
    onDeleteSelected(): void;
    onUpdateSelected(patch: AnnotationUpdatePatch): void;
    onNudge(axis: 'x' | 'y' | 'z', delta: number): void;
    onSave(): void;
  }): void;
  setAnnotationEditorState(state: AnnotationEditorState): void;
  getOverlayElement(): HTMLElement;
  getCanvasHostElement(): HTMLElement;
  getAnnotationHostElement(): HTMLElement;
}

export class Viewer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
  private readonly webglRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly cameraController: CameraController;
  private readonly splatRenderer = new GaussianSplatRenderer();
  private readonly sceneManager: SceneManager;
  private readonly inputBindings: InputBindings;
  private readonly annotationManager: AnnotationManager;
  private readonly annotationPersistence = new AnnotationPersistence();
  private readonly particleIntroController = new ParticleIntroController(this.scene);
  private readonly resizeObserver: ResizeObserver;

  private activeSceneId = '';
  private activeConfig: SceneConfig | null = null;
  private fittedHome: SceneConfig['camera']['home'] | null = null;
  private autoRotate = false;
  private disposed = false;
  private pendingResizeSync = false;
  private queuedSelectionId: string | null = null;
  private processingSelection = false;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private autorotateOverride: boolean | null = null;
  private idleRotateResumeTimer = 0;
  private currentIdleRotateSpeed = 0.35;
  private introInProgress: Promise<void> | null = null;
  private readonly onUserInteraction = (): void => {
    this.cameraController.cancelAnimation();
    if (!this.autoRotate) {
      return;
    }
    this.cameraController.setAutoRotate(false, this.currentIdleRotateSpeed);
    this.scheduleIdleResume(1200);
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly ui: ViewerUi,
    options: { embedMode?: boolean; autorotateOverride?: boolean | null } = {},
  ) {
    this.autorotateOverride = options.autorotateOverride ?? null;
    this.webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.webglRenderer.setSize(container.clientWidth, container.clientHeight);
    this.webglRenderer.setAnimationLoop(this.onFrame);
    this.webglRenderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.webglRenderer.domElement);

    this.cameraController = new CameraController(this.camera, this.webglRenderer.domElement);
    this.sceneManager = new SceneManager(this.splatRenderer, {
      onLoading: (message) => {
        this.ui.setLoading(true, message);
      },
      onReady: (config) => {
        this.ui.configureToolbar(config);
        this.ui.setSceneTitle(config.title);
      },
      onItemsChanged: (items) => {
        const activeItem = items.find((item) => item.active);
        this.annotationManager.setActiveAssetId(activeItem?.id ?? null);
        this.ui.setSplatOptions(items, (id) => {
          this.enqueueSplatSelection(id);
        });
      },
    });

    this.inputBindings = new InputBindings({
      onReset: () => this.resetView(),
      onToggleAutorotate: () => this.toggleAutorotate(),
    });
    this.annotationManager = new AnnotationManager({
      host: this.ui.getAnnotationHostElement(),
      camera: this.camera,
      renderer: this.webglRenderer,
      scene: this.scene,
      cameraController: this.cameraController,
    });
    this.annotationManager.onEditorStateChange((state) => {
      this.ui.setAnnotationEditorState(state);
    });
    this.ui.configureAnnotationEditor({
      onToggleEdit: (enabled) => this.annotationManager.setEditMode(enabled),
      onSelectPin: (id) => this.annotationManager.selectAnnotation(id),
      onAddPin: () => this.annotationManager.addPin(),
      onDeleteSelected: () => this.annotationManager.deleteSelected(),
      onUpdateSelected: (patch) => this.annotationManager.updateSelected(patch),
      onNudge: (axis, delta) => this.annotationManager.nudgeSelected(axis, delta),
      onSave: () => {
        void this.saveAnnotations();
      },
    });

    this.scene.background = new THREE.Color('#000000');
    const ambient = new THREE.AmbientLight('#ffffff', 0.8);
    this.scene.add(ambient);

    this.resizeObserver = new ResizeObserver(() => this.scheduleResizeSync());
    this.resizeObserver.observe(this.container);
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('scroll', this.onResize);
    this.bindIdleInteraction();
  }

  async init(sceneId: string): Promise<void> {
    await this.splatRenderer.initialize({
      scene: this.scene,
      camera: this.camera,
      renderer: this.webglRenderer,
      rootElement: this.container,
    });
    this.inputBindings.bind();
    await this.loadScene(sceneId);
  }

  async loadScene(sceneId: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      this.annotationManager.clear();
      this.ui.clearError();
      const config = await this.sceneManager.loadScene(sceneId);
      const savedAnnotations = await this.annotationPersistence.load(sceneId);
      const mergedConfig: SceneConfig = savedAnnotations
        ? { ...config, annotations: savedAnnotations }
        : config;
      this.activeConfig = mergedConfig;
      this.applySceneConfig(mergedConfig);
      this.activeSceneId = sceneId;
      const interior = this.sceneManager.getInteriorViewConfig();
      if (interior) {
        this.ui.configureInteriorDebug(interior, (patch) => {
          this.sceneManager.updateInteriorViewConfig(patch);
        });
      }
      this.ui.setLoading(false);
      await this.playIntro();
      this.annotationManager.configure(mergedConfig);
    } catch (error) {
      this.ui.setLoading(false);
      const message = error instanceof Error ? error.message : 'Unknown error while loading scene.';
      const details: string[] =
        typeof error === 'object' &&
        error !== null &&
        'details' in error &&
        Array.isArray((error as { details?: unknown }).details)
          ? ((error as { details: string[] }).details ?? [])
          : [];
      this.ui.setError(message, details);
    }
  }

  resetView(): void {
    const config = this.sceneManager.config;
    if (!config) {
      return;
    }
    this.cameraController.setHomeImmediately(this.fittedHome ?? config.camera.home);
  }

  toggleAutorotate(): boolean {
    const config = this.sceneManager.config;
    if (!config || !config.ui.enableAutorotate) {
      return this.autoRotate;
    }
    this.autoRotate = !this.autoRotate;
    this.cameraController.setAutoRotate(this.autoRotate, this.currentIdleRotateSpeed);
    return this.autoRotate;
  }

  setAutoRotateExplicit(enabled: boolean): void {
    this.autoRotate = enabled;
    this.cameraController.setAutoRotate(enabled, this.currentIdleRotateSpeed);
  }

  setFullscreen(enabled: boolean): void {
    const target = this.container.parentElement ?? this.container;
    if (enabled) {
      void target.requestFullscreen?.();
      return;
    }
    void document.exitFullscreen();
  }

  isFullscreen(): boolean {
    return document.fullscreenElement !== null;
  }

  getActiveSceneId(): string {
    return this.activeSceneId;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeConfig = null;
    this.fittedHome = null;
    this.inputBindings.dispose();
    this.clearIdleResumeTimer();
    const node = this.webglRenderer.domElement;
    node.removeEventListener('pointerdown', this.onUserInteraction);
    node.removeEventListener('wheel', this.onUserInteraction);
    node.removeEventListener('touchstart', this.onUserInteraction);
    this.particleIntroController.dispose();
    this.annotationManager.dispose();
    void this.sceneManager.dispose();
    this.cameraController.dispose();
    this.webglRenderer.dispose();
    this.webglRenderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('scroll', this.onResize);
  }

  private applySceneConfig(config: SceneConfig): void {
    this.cameraController.applyLimits(config.camera.limits, config.ui.enablePan);
    this.fitCameraToContent(config);
    this.currentIdleRotateSpeed = config.presentation.idleRotateSpeed;
    const defaultAutoRotate = this.autorotateOverride ?? (config.ui.autorotateDefaultOn && config.ui.enableAutorotate);
    this.autoRotate = defaultAutoRotate;
    this.cameraController.setAutoRotate(false, this.currentIdleRotateSpeed);
  }

  private enqueueSplatSelection(id: string): void {
    this.queuedSelectionId = id;
    if (this.processingSelection) {
      return;
    }
    this.processingSelection = true;
    void this.processQueuedSelections();
  }

  private async processQueuedSelections(): Promise<void> {
    while (this.queuedSelectionId) {
      const targetId = this.queuedSelectionId;
      this.queuedSelectionId = null;
      try {
        await this.sceneManager.activateSplat(targetId, () => {
          if (this.activeConfig) {
            this.fitCameraToContent(this.activeConfig);
          }
        });
      } catch {
        // no-op: SceneManager emits authoritative item state
      }
    }
    this.processingSelection = false;
  }

  private fitCameraToContent(config: SceneConfig): void {
    const fit = this.splatRenderer.getFitData();
    if (!fit) {
      this.cameraController.setHomeImmediately(config.camera.home);
      this.fittedHome = config.camera.home;
      return;
    }

    const expandedLimits = {
      ...config.camera.limits,
      maxDistance: Math.max(config.camera.limits.maxDistance, fit.radius * 8),
    };
    this.cameraController.applyLimits(expandedLimits, config.ui.enablePan);

    const direction = new THREE.Vector3(...config.camera.home.position).sub(
      new THREE.Vector3(...config.camera.home.target),
    );
    const usedDistance = this.cameraController.frameTarget(
      fit.center,
      fit.size,
      fit.radius,
      config.camera.home.fov,
      expandedLimits,
      direction,
    );

    // Keep enough zoom-out headroom after fitting.
    this.cameraController.applyLimits(
      {
        ...expandedLimits,
        maxDistance: Math.max(expandedLimits.maxDistance, usedDistance * 2.5),
      },
      config.ui.enablePan,
    );
    this.fittedHome = this.cameraController.getCurrentHome();
  }

  private onFrame = (): void => {
    const now = performance.now();
    this.cameraController.update(now);
    this.splatRenderer.setInteriorCameraPosition(this.camera.position);
    this.splatRenderer.update();
    this.annotationManager.update(now, this.container.clientWidth, this.container.clientHeight);
    this.splatRenderer.render();
  };

  async playIntro(): Promise<void> {
    if (this.introInProgress) {
      return this.introInProgress;
    }
    this.introInProgress = this.runIntroSequence();
    try {
      await this.introInProgress;
    } finally {
      this.introInProgress = null;
    }
  }

  private async runIntroSequence(): Promise<void> {
    if (!this.activeConfig) {
      return;
    }
    this.cameraController.setAutoRotate(false, this.currentIdleRotateSpeed);
    const reveal = this.getIntroRevealConfig(this.activeConfig);
    await this.sceneManager.resetActiveRevealStart();
    const activeHandle = this.sceneManager.getActiveHandle();
    const revealDurationMs = this.getRevealDurationMs(reveal);
    let particleSource: THREE.Vector3[] = [];
    let particleColors: Float32Array | null = null;
    let particleDurationMs = 0;
    let splatDelayMs = 0;
    let overlapMs = Math.max(280, Math.floor(revealDurationMs * 0.45));
    let originMode: 'topCenter' | 'modelCenter' | 'customOffset' = 'modelCenter';
    let introEase: 'linear' | 'easeInOut' = reveal.ease;
    let staticPointCloud = false;
    let pointCloudFadeOutMs = Math.max(280, Math.floor(revealDurationMs * 0.45));
    let zoomOutFactor = 1;
    if (this.activeConfig.cinematicReveal.enabled) {
      particleDurationMs = this.activeConfig.cinematicReveal.particleLeadMs;
      splatDelayMs = this.activeConfig.cinematicReveal.splatDelayMs;
      overlapMs = this.activeConfig.cinematicReveal.overlapMs;
      originMode = this.activeConfig.cinematicReveal.originMode;
      introEase = this.activeConfig.cinematicReveal.ease;
      staticPointCloud = this.activeConfig.cinematicReveal.staticPointCloud;
      pointCloudFadeOutMs = this.activeConfig.cinematicReveal.pointCloudFadeOutMs;
      zoomOutFactor = this.activeConfig.cinematicReveal.zoomOutFactor;
    }
    if (
      !this.reducedMotion &&
      (zoomOutFactor > 1.001 || Math.abs(this.activeConfig.cinematicReveal.zoomStartYOffset) > 0.001)
    ) {
      this.startIntroZoom(
        this.activeConfig,
        this.getIntroSpinDurationMs(revealDurationMs, particleDurationMs, splatDelayMs),
        zoomOutFactor,
        this.activeConfig.cinematicReveal.zoomStartYOffset,
      );
    }
    if (
      activeHandle &&
      !this.reducedMotion &&
      reveal.particleIntro.durationMs > 0 &&
      reveal.particleIntro.particleCount > 0
    ) {
      const sampleCloud = this.splatRenderer.getSplatSampleCloud(activeHandle.id, {
        maxSamples: reveal.particleIntro.particleCount,
        randomize: true,
        space: 'local',
        includeColors: true,
      });
      particleSource = sampleCloud.points;
      particleColors = sampleCloud.colors ?? null;
      if (particleSource.length > 0) {
        if (!this.activeConfig.cinematicReveal.enabled) {
          particleDurationMs = Math.max(120, reveal.particleIntro.durationMs);
        }
      }
    }

    const spinPromises: Promise<void>[] = [];
    const spinStartedIds = new Set<string>();
    const activeOrientation =
      activeHandle && this.activeConfig ? this.computeIntroOrientation(activeHandle, this.activeConfig) : null;
    if (activeHandle && activeOrientation) {
      activeHandle.object3D.quaternion.copy(activeOrientation.start);
      spinPromises.push(
        this.animateIntroSpin(
          activeHandle,
          activeOrientation.end,
              activeOrientation.spinDegrees,
              this.getIntroSpinDurationMs(revealDurationMs, particleDurationMs, splatDelayMs),
            ),
      );
      spinStartedIds.add(activeHandle.id);
    }
    const particlePromise =
      activeHandle && particleDurationMs > 0
        ? this.particleIntroController.play(
            particleSource,
            activeHandle.boundsY,
            {
              ...reveal.particleIntro,
              durationMs: Math.max(120, particleDurationMs),
            },
            this.reducedMotion,
            {
              anchor: activeHandle.object3D,
              sourceColors: particleColors,
              originMode,
              ease: introEase,
              lockToSource: staticPointCloud,
            },
          )
        : Promise.resolve();

    if (splatDelayMs > 0) {
      await this.sleep(splatDelayMs);
    }

    const revealPromise = this.sceneManager.revealActiveScene({
      reducedMotion: this.reducedMotion,
      revealOverride: reveal,
      beforeRevealIn: ({ handle, reveal: revealConfig }) => {
        const spinDuration = this.getRevealDurationMs(revealConfig);
        if (!spinStartedIds.has(handle.id)) {
          const orientation = this.computeIntroOrientation(handle, this.activeConfig!);
          if (orientation) {
            handle.object3D.quaternion.copy(orientation.start);
            spinPromises.push(
              this.animateIntroSpin(
                handle,
                orientation.end,
                orientation.spinDegrees,
                this.getIntroSpinDurationMs(spinDuration, particleDurationMs, splatDelayMs),
              ),
            );
            spinStartedIds.add(handle.id);
          }
        }
        if (!staticPointCloud) {
          void this.particleIntroController.cover(
            this.reducedMotion ? Math.max(220, Math.floor(overlapMs * 0.75)) : Math.max(220, overlapMs),
          );
        }
      },
    });
    await Promise.allSettled([particlePromise, revealPromise]);
    if (staticPointCloud && particleDurationMs > 0) {
      await this.particleIntroController.cover(
        this.reducedMotion
          ? Math.max(220, Math.floor(pointCloudFadeOutMs * 0.75))
          : Math.max(220, pointCloudFadeOutMs),
      );
    }
    if (spinPromises.length > 0) {
      await Promise.allSettled(spinPromises);
    }
    const shouldAutoRotate = this.shouldEnableAutoRotateAfterIntro(this.activeConfig);
    this.autoRotate = shouldAutoRotate;
    if (shouldAutoRotate) {
      const delay = this.activeConfig.presentation.introAutoRotateDelayMs;
      if (delay <= 0) {
        this.cameraController.setAutoRotate(true, this.currentIdleRotateSpeed);
      } else {
        this.scheduleIdleResume(delay);
      }
      return;
    }
    this.cameraController.setAutoRotate(false, this.currentIdleRotateSpeed);
  }

  private getIntroRevealConfig(config: SceneConfig): RevealConfig {
    if (!config.cinematicReveal.enabled) {
      return config.reveal;
    }
    const sphereDuration = Math.max(100, config.cinematicReveal.sphereExpandMs);
    return {
      ...config.reveal,
      bottomSphere: {
        ...config.reveal.bottomSphere,
        durationMs: sphereDuration,
      },
      ease: config.cinematicReveal.ease,
    };
  }

  private sleep(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, Math.max(0, durationMs));
    });
  }

  private getIntroSpinDurationMs(
    revealDurationMs: number,
    particleLeadMs: number,
    splatDelayMs: number,
  ): number {
    const timelineDuration =
      particleLeadMs > 0 ? Math.max(particleLeadMs, splatDelayMs + revealDurationMs) : revealDurationMs;
    return Math.max(300, timelineDuration);
  }

  private startIntroZoom(
    config: SceneConfig,
    durationMs: number,
    zoomOutFactor: number,
    zoomStartYOffset: number,
  ): void {
    const home = this.fittedHome ?? config.camera.home;
    const target = new THREE.Vector3(...home.target);
    const end = new THREE.Vector3(...home.position);
    const direction = end.clone().sub(target);
    const distance = direction.length();
    if (distance <= 0.0001) {
      return;
    }
    direction.normalize();
    const start = target.clone().add(direction.multiplyScalar(distance * zoomOutFactor));
    start.y += zoomStartYOffset;
    this.cameraController.setHomeImmediately({
      position: [start.x, start.y, start.z],
      target: home.target,
      fov: home.fov,
    });
    this.cameraController.animateTo({
      position: home.position,
      target: home.target,
      fov: home.fov,
      durationMs,
    });
  }

  private async animateIntroSpin(
    handle: SplatHandle,
    endQ: THREE.Quaternion,
    spinDegrees: number,
    durationMs: number,
  ): Promise<void> {
    const duration = Math.max(200, durationMs);
    const upAxis = new THREE.Vector3(0, 1, 0);
    const yaw = new THREE.Quaternion();
    const compose = (degrees: number): void => {
      yaw.setFromAxisAngle(upAxis, THREE.MathUtils.degToRad(degrees));
      handle.object3D.quaternion.copy(endQ).multiply(yaw);
    };
    compose(spinDegrees);

    const start = performance.now();
    await new Promise<void>((resolve) => {
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / duration);
        const eased = easeInOutCubic(t);
        compose(spinDegrees * (1 - eased));
        if (t >= 1) {
          handle.object3D.quaternion.copy(endQ);
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  private computeIntroOrientation(
    handle: SplatHandle,
    config: SceneConfig,
  ): { start: THREE.Quaternion; end: THREE.Quaternion; spinDegrees: number } | null {
    const spinDegrees = config.presentation.introSpinDegrees;
    if (Math.abs(spinDegrees) < 0.001) {
      return null;
    }
    const asset = config.assets.find((entry) => entry.id === handle.id);
    if (!asset) {
      return null;
    }
    const end = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(asset.transform.rotation[0]),
        THREE.MathUtils.degToRad(asset.transform.rotation[1]),
        THREE.MathUtils.degToRad(asset.transform.rotation[2]),
      ),
    );
    const yaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(spinDegrees),
    );
    const start = end.clone().multiply(yaw);
    return { start, end, spinDegrees };
  }

  private getRevealDurationMs(reveal: SceneConfig['reveal']): number {
    return reveal.mode === 'bottomSphere' ? reveal.bottomSphere.durationMs : reveal.durationMs;
  }

  private shouldEnableAutoRotateAfterIntro(config: SceneConfig): boolean {
    if (!config.ui.enableAutorotate) {
      return false;
    }
    if (this.autorotateOverride !== null) {
      return this.autorotateOverride;
    }
    if (config.presentation.mode === 'embedHero') {
      return true;
    }
    return config.ui.autorotateDefaultOn;
  }

  private onResize = (): void => {
    this.scheduleResizeSync();
  };

  private scheduleResizeSync(): void {
    if (this.pendingResizeSync || this.disposed) {
      return;
    }
    this.pendingResizeSync = true;
    requestAnimationFrame(() => {
      this.pendingResizeSync = false;
      this.syncViewport();
    });
  }

  private syncViewport(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width <= 0 || height <= 0) {
      return;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.webglRenderer.setSize(width, height);

    if (this.activeConfig) {
      this.fitCameraToContent(this.activeConfig);
    }
  }

  private bindIdleInteraction(): void {
    const node = this.webglRenderer.domElement;
    node.addEventListener('pointerdown', this.onUserInteraction, { passive: true });
    node.addEventListener('wheel', this.onUserInteraction, { passive: true });
    node.addEventListener('touchstart', this.onUserInteraction, { passive: true });
  }

  private scheduleIdleResume(delayMs: number): void {
    this.clearIdleResumeTimer();
    if (!this.autoRotate) {
      return;
    }
    this.idleRotateResumeTimer = window.setTimeout(() => {
      this.cameraController.setAutoRotate(true, this.currentIdleRotateSpeed);
    }, Math.max(0, delayMs));
  }

  private clearIdleResumeTimer(): void {
    if (!this.idleRotateResumeTimer) {
      return;
    }
    window.clearTimeout(this.idleRotateResumeTimer);
    this.idleRotateResumeTimer = 0;
  }

  private async saveAnnotations(): Promise<void> {
    if (!this.activeConfig) {
      return;
    }
    const annotations = this.annotationManager.exportAnnotations();
    if (!annotations) {
      return;
    }
    const result = await this.annotationPersistence.save(this.activeSceneId || 'scene', annotations);
    if (result.ok) {
      this.activeConfig = { ...this.activeConfig, annotations };
      return;
    }

    const payload = JSON.stringify({ annotations }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.activeSceneId || 'scene'}-annotations.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    console.warn(`Annotation save fallback used: ${result.reason}`);
  }
}
