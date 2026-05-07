import * as THREE from 'three';
import {
  AnnotationEditorState,
  AnnotationManager,
  AnnotationUpdatePatch,
} from '../annotations/AnnotationManager';
import { AnnotationPersistence } from '../annotations/AnnotationPersistence';
import { BrandingLogoConfig, InteriorViewConfig, RevealConfig, SceneConfig } from '../config/schema';
import { GaussianSplatRenderer } from '../renderers/GaussianSplatRenderer';
import { InputBindings } from './InputBindings';
import { CameraController } from './CameraController';
import { SceneManager, SplatToggleItem } from './SceneManager';
import { TelemetryCategory, TelemetryClient } from '../telemetry/TelemetryClient';

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
  setBrandingLogo(logo: BrandingLogoConfig | null): void;
  configureAnnotationEditor(handlers: {
    onToggleEdit(enabled: boolean): void;
    onSelectPin(id: string): void;
    onAddPin(): void;
    onDeleteSelected(): void;
    onCaptureCamera(): boolean;
    onUpdateSelected(patch: AnnotationUpdatePatch): void;
    onNudge(axis: 'x' | 'y' | 'z', delta: number): void;
    onSave(): void;
  }): void;
  setAnnotationEditorState(state: AnnotationEditorState): void;
  waitForEntryLoadReadyBeforeReveal(): Promise<void>;
  notifyRevealStarting(): void;
  getOverlayElement(): HTMLElement;
  getCanvasHostElement(): HTMLElement;
  getAnnotationHostElement(): HTMLElement;
}

type ThemeMode = 'light' | 'dark';

function detectMobileProfile(): boolean {
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const narrowViewport = window.matchMedia('(max-width: 900px)').matches;
  const userAgent = navigator.userAgent.toLowerCase();
  const touchDevice = /android|iphone|ipad|ipod|mobile/.test(userAgent);
  return coarsePointer || narrowViewport || touchDevice;
}

export class Viewer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
  private readonly webglRenderer: THREE.WebGLRenderer;
  private readonly cameraController: CameraController;
  private readonly splatRenderer = new GaussianSplatRenderer();
  private readonly sceneManager: SceneManager;
  private readonly inputBindings: InputBindings;
  private readonly annotationManager: AnnotationManager;
  private readonly annotationPersistence = new AnnotationPersistence();
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
  private readonly useMobileProfile: boolean;
  private autorotateOverride: boolean | null = null;
  private idleRotateResumeTimer = 0;
  private currentIdleRotateSpeed = 0.35;
  private introInProgress: Promise<void> | null = null;
  private loadStartedAtMs = 0;
  private firstFrameLogged = false;
  private introStartedAtMs = 0;
  private telemetrySessionStarted = false;
  private telemetrySessionEnded = false;
  private readonly viewerBootAtMs = performance.now();
  private readonly interactionCounts: Record<InteractionType, number> = {
    rotate: 0,
    zoom: 0,
    pan: 0,
  };
  private readonly interactionDurationsMs: Record<InteractionType, number> = {
    rotate: 0,
    zoom: 0,
    pan: 0,
  };
  private readonly interactionStartedAtMs: Record<InteractionType, number | null> = {
    rotate: null,
    zoom: null,
    pan: null,
  };
  private readonly activePointerInteractionById = new Map<number, InteractionType>();
  private readonly activeTouchPointerIds = new Set<number>();
  private firstInteractionMs: number | null = null;
  private zoomEndTimer = 0;
  private sessionFrameCount = 0;
  private sessionFrameElapsedMs = 0;
  private sessionLongFrameCount = 0;
  private lastFrameTimestampMs = 0;
  private lastLoadMetrics = {
    assetFetchMs: 0,
    decodeInitMs: 0,
  };
  private readonly telemetry: TelemetryClient | null;
  private readonly pivotDebugEnabled: boolean;
  private pivotDebugPanel: HTMLElement | null = null;
  private pivotDebugReadout: HTMLElement | null = null;
  private pivotDebugMode: 'pivot' | 'scene' = 'pivot';
  private readonly onUserInteraction = (): void => {
    this.cameraController.cancelAnimation();
    if (!this.autoRotate) {
      return;
    }
    this.cameraController.setAutoRotate(false, this.currentIdleRotateSpeed);
    this.scheduleIdleResume(1200);
  };
  private readonly onPointerDownForTelemetry = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      this.activeTouchPointerIds.add(event.pointerId);
      if (this.activeTouchPointerIds.size === 1) {
        this.beginInteraction('rotate', 'touch');
        this.activePointerInteractionById.set(event.pointerId, 'rotate');
        return;
      }
      this.endInteraction('rotate');
      this.beginInteraction('zoom', 'touch');
      this.activePointerInteractionById.set(event.pointerId, 'zoom');
      return;
    }

    if (event.button === 0) {
      this.beginInteraction('rotate', event.pointerType || 'mouse');
      this.activePointerInteractionById.set(event.pointerId, 'rotate');
      return;
    }
    if (event.button === 2) {
      this.beginInteraction('pan', event.pointerType || 'mouse');
      this.activePointerInteractionById.set(event.pointerId, 'pan');
    }
  };
  private readonly onPointerUpForTelemetry = (event: PointerEvent): void => {
    const interactionType = this.activePointerInteractionById.get(event.pointerId);
    if (interactionType) {
      this.endInteraction(interactionType);
      this.activePointerInteractionById.delete(event.pointerId);
    }
    if (event.pointerType === 'touch') {
      this.activeTouchPointerIds.delete(event.pointerId);
      if (this.activeTouchPointerIds.size < 2) {
        this.endInteraction('zoom');
      }
      if (this.activeTouchPointerIds.size === 0) {
        this.endInteraction('rotate');
      }
    }
  };
  private readonly onWheelForTelemetry = (): void => {
    this.beginInteraction('zoom', 'wheel');
    this.clearZoomEndTimer();
    this.zoomEndTimer = window.setTimeout(() => {
      this.endInteraction('zoom');
    }, 140);
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly ui: ViewerUi,
    options: {
      embedMode?: boolean;
      pivotDebug?: boolean;
      autorotateOverride?: boolean | null;
      mobileProfile?: boolean | null;
      telemetry?: TelemetryClient | null;
    } = {},
  ) {
    this.telemetry = options.telemetry ?? null;
    this.useMobileProfile = options.mobileProfile ?? detectMobileProfile();
    this.webglRenderer = new THREE.WebGLRenderer({
      antialias: !this.useMobileProfile,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.autorotateOverride = options.autorotateOverride ?? null;
    this.pivotDebugEnabled = options.pivotDebug ?? false;
    this.webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, this.useMobileProfile ? 1.25 : 2));
    this.webglRenderer.setSize(container.clientWidth, container.clientHeight);
    this.webglRenderer.setAnimationLoop(this.onFrame);
    this.webglRenderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.webglRenderer.domElement);
    console.info(
      `[perf] mobile_profile=${this.useMobileProfile ? 1 : 0} three_antialias=${this.useMobileProfile ? 0 : 1}`,
    );

    this.cameraController = new CameraController(this.camera, this.webglRenderer.domElement);
    this.sceneManager = new SceneManager(
      this.splatRenderer,
      {
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
      },
      {
        useMobileProfile: this.useMobileProfile,
      },
    );

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
      onCloseSelection: () => this.restoreDefaultViewFromAnnotationClose(),
      onTelemetryEvent: (name, payload, category) => this.emitTelemetry(name, payload, category),
    });
    this.annotationManager.onEditorStateChange((state) => {
      this.ui.setAnnotationEditorState(state);
    });
    this.ui.configureAnnotationEditor({
      onToggleEdit: (enabled) => this.annotationManager.setEditMode(enabled),
      onSelectPin: (id) => this.annotationManager.selectAnnotation(id),
      onAddPin: () => this.annotationManager.addPin(),
      onDeleteSelected: () => this.annotationManager.deleteSelected(),
      onCaptureCamera: () => this.annotationManager.captureSelectedCameraFromLivePose(),
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
    if (this.pivotDebugEnabled) {
      window.addEventListener('keydown', this.onPivotDebugKeyDown);
      this.createPivotDebugPanel();
      console.info('[pivot] Debug enabled. Use Alt+Shift+Arrow/PageUp/PageDown to move pivot. Press "P" to print camera.home values.');
    }
  }

  async init(sceneId: string): Promise<void> {
    if (this.telemetry && !this.telemetrySessionStarted) {
      await this.telemetry.startSession({
        asset_id: sceneId,
        project: sceneId,
        device_type: this.useMobileProfile ? 'mobile' : 'desktop',
      });
      this.telemetrySessionStarted = this.telemetry.getSessionId() !== null;
    }
    await this.splatRenderer.initialize({
      scene: this.scene,
      camera: this.camera,
      renderer: this.webglRenderer,
      rootElement: this.container,
      disableAntialias: this.useMobileProfile,
    });
    this.inputBindings.bind();
    await this.loadScene(sceneId);
  }

  async loadScene(sceneId: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      this.loadStartedAtMs = performance.now();
      this.lastFrameTimestampMs = this.loadStartedAtMs;
      this.firstFrameLogged = false;
      this.activeConfig = null;
      this.annotationManager.clear();
      this.ui.clearError();
      this.emitTelemetry('scene_load_started', { scene_id: sceneId }, 'viewer');
      const config = await this.sceneManager.loadScene(sceneId);
      this.configureTelemetryForScene(config);
      this.lastLoadMetrics = this.splatRenderer.getAndResetLoadMetrics();
      const savedAnnotations = await this.annotationPersistence.load(sceneId);
      const mergedConfig: SceneConfig = savedAnnotations
        ? { ...config, annotations: savedAnnotations }
        : config;
      this.activeConfig = mergedConfig;
      this.applySceneConfig(mergedConfig);
      this.activeSceneId = sceneId;
      this.emitTelemetry(
        'asset_loaded',
        {
          scene_id: sceneId,
          asset_id: this.sceneManager.getActiveSplatId(),
          asset_count: mergedConfig.assets.length,
        },
        'viewer',
      );
      const interior = this.sceneManager.getInteriorViewConfig();
      if (interior) {
      this.ui.configureInteriorDebug(interior, (patch) => {
          this.sceneManager.updateInteriorViewConfig(patch);
        });
      }
      this.ui.setLoading(false);
      await this.ui.waitForEntryLoadReadyBeforeReveal();
      await this.playIntro();
      this.annotationManager.configure(mergedConfig);
    } catch (error) {
      this.ui.setLoading(false);
      const message = error instanceof Error ? error.message : 'Unknown error while loading scene.';
      this.emitTelemetry(
        'failed_asset_load',
        {
          scene_id: sceneId,
          message,
        },
        'error',
      );
      this.emitTelemetry(
        'viewer_error',
        {
          message,
          context: 'loadScene',
        },
        'error',
      );
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

  trackTelemetryEvent(
    name: string,
    payload: Record<string, unknown> = {},
    category: TelemetryCategory = 'viewer',
  ): void {
    this.emitTelemetry(name, payload, category);
  }

  async endTelemetrySession(reason = 'manual'): Promise<void> {
    if (!this.telemetry || this.telemetrySessionEnded) {
      return;
    }
    this.telemetrySessionEnded = true;
    this.finalizeOpenInteractions();
    const telemetryState = this.telemetry.getDebugState();
    await this.telemetry.endSession(reason, {
      interaction_counts: this.interactionCounts,
      interaction_durations_ms: this.interactionDurationsMs,
      first_interaction_ms: this.firstInteractionMs,
      fps_bucket: this.getFpsBucket(),
      long_frame_count: this.sessionLongFrameCount,
      telemetry_send_fail_count: telemetryState.sendFailureCount,
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeConfig = null;
    this.fittedHome = null;
    this.clearZoomEndTimer();
    this.finalizeOpenInteractions();
    void this.endTelemetrySession('dispose');
    this.inputBindings.dispose();
    this.clearIdleResumeTimer();
    const node = this.webglRenderer.domElement;
    node.removeEventListener('pointerdown', this.onUserInteraction);
    node.removeEventListener('wheel', this.onUserInteraction);
    node.removeEventListener('touchstart', this.onUserInteraction);
    node.removeEventListener('pointerdown', this.onPointerDownForTelemetry);
    node.removeEventListener('pointerup', this.onPointerUpForTelemetry);
    node.removeEventListener('pointercancel', this.onPointerUpForTelemetry);
    node.removeEventListener('wheel', this.onWheelForTelemetry);
    this.annotationManager.dispose();
    void this.sceneManager.dispose();
    this.cameraController.dispose();
    this.webglRenderer.dispose();
    this.webglRenderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('scroll', this.onResize);
    window.removeEventListener('keydown', this.onPivotDebugKeyDown);
    this.pivotDebugPanel?.remove();
    this.pivotDebugPanel = null;
    this.pivotDebugReadout = null;
  }

  private applySceneConfig(config: SceneConfig): void {
    this.cameraController.applyLimits(config.camera.limits, config.ui.enablePan);
    this.fitCameraToContent(config);
    const maxDpr = Math.max(0.75, config.performanceProfile.maxDevicePixelRatio);
    this.webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDpr));
    this.syncViewport();
    this.currentIdleRotateSpeed = config.presentation.idleRotateSpeed;
    this.ui.setBrandingLogo(config.branding.logo.enabled ? config.branding.logo : null);
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
    if (config.id === 'sm-orbit-1-trimmed') {
      const target = new THREE.Vector3(...config.camera.home.target);
      const position = new THREE.Vector3(...config.camera.home.position);
      const zoomOutMultiplier = this.getScroobyZoomOutMultiplier();
      const adjustedPosition = target
        .clone()
        .add(position.clone().sub(target).multiplyScalar(zoomOutMultiplier));
      const adjustedHome: SceneConfig['camera']['home'] = {
        ...config.camera.home,
        position: [adjustedPosition.x, adjustedPosition.y, adjustedPosition.z],
      };
      this.cameraController.setHomeImmediately(adjustedHome);
      this.fittedHome = adjustedHome;
      return;
    }
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
    if (this.lastFrameTimestampMs > 0) {
      const deltaMs = Math.max(0, now - this.lastFrameTimestampMs);
      this.sessionFrameCount += 1;
      this.sessionFrameElapsedMs += deltaMs;
      if (deltaMs > 50) {
        this.sessionLongFrameCount += 1;
      }
    }
    this.lastFrameTimestampMs = now;
    if (!this.firstFrameLogged && this.loadStartedAtMs > 0 && this.activeConfig) {
      this.firstFrameLogged = true;
      const firstFrameMs = Math.max(0, now - this.loadStartedAtMs);
      console.info(
        `[perf] asset_fetch_ms=${this.lastLoadMetrics.assetFetchMs.toFixed(1)} decode_init_ms=${this.lastLoadMetrics.decodeInitMs.toFixed(1)} first_frame_ms=${firstFrameMs.toFixed(1)}`,
      );
      this.emitTelemetry(
        'asset_load_timing',
        {
          scene_id: this.activeConfig.id,
          asset_id: this.sceneManager.getActiveSplatId(),
          fetch_ms: this.lastLoadMetrics.assetFetchMs,
          decode_ms: this.lastLoadMetrics.decodeInitMs,
          first_frame_ms: firstFrameMs,
          ready_ms: firstFrameMs,
        },
        'perf',
      );
    }
    this.cameraController.update(now);
    this.splatRenderer.setInteriorCameraPosition(this.camera.position);
    this.splatRenderer.update();
    this.annotationManager.update(now, this.container.clientWidth, this.container.clientHeight);
    this.updatePivotDebugReadout();
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
    this.emitTelemetry('intro_started', { scene_id: this.activeConfig.id }, 'viewer');
    this.cameraController.setAutoRotate(false, this.currentIdleRotateSpeed);
    this.introStartedAtMs = performance.now();
    const reveal = this.getIntroRevealConfig(this.activeConfig);
    await this.sceneManager.resetActiveRevealStart();
    const revealDurationMs = this.getRevealDurationMs(reveal);
    let introDurationMs = revealDurationMs;
    let zoomOutFactor = 1;
    let zoomStartYOffset = 0;
    if (this.activeConfig.cinematicReveal.enabled) {
      introDurationMs = Math.max(200, this.activeConfig.cinematicReveal.sphereExpandMs);
      zoomOutFactor = this.activeConfig.cinematicReveal.zoomOutFactor;
      zoomStartYOffset = this.activeConfig.cinematicReveal.zoomStartYOffset;
    }
    if (
      !this.reducedMotion &&
      (zoomOutFactor > 1.001 ||
        Math.abs(zoomStartYOffset) > 0.001 ||
        Math.abs(this.activeConfig.presentation.introSpinDegrees) > 0.001)
    ) {
      this.startIntroCameraMove(
        this.activeConfig,
        introDurationMs,
        zoomOutFactor,
        zoomStartYOffset,
        this.activeConfig.presentation.introSpinDegrees,
      );
    }

    let revealSignalSent = false;
    const revealPromise = this.sceneManager.revealActiveScene({
      reducedMotion: this.reducedMotion,
      revealOverride: reveal,
      beforeRevealIn: async () => {
        if (revealSignalSent) {
          return;
        }
        revealSignalSent = true;
        this.ui.notifyRevealStarting();
      },
    });
    await Promise.allSettled([revealPromise]);
    if (!revealSignalSent) {
      this.ui.notifyRevealStarting();
    }
    const introCompleteMs = Math.max(0, performance.now() - this.introStartedAtMs);
    console.info(`[perf] intro_complete_ms=${introCompleteMs.toFixed(1)}`);
    this.emitTelemetry(
      'intro_completed',
      {
        scene_id: this.activeConfig.id,
        duration_ms: Math.round(introCompleteMs),
      },
      'viewer',
    );
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

  setThemeMode(theme: ThemeMode): void {
    const backgroundHex = theme === 'dark' ? '#000000' : '#ffffff';
    this.scene.background = new THREE.Color(backgroundHex);
    this.splatRenderer.setBackgroundColor(backgroundHex);
  }

  private getScroobyZoomOutMultiplier(): number {
    const isMobile =
      window.matchMedia('(max-width: 768px)').matches ||
      window.matchMedia('(pointer: coarse)').matches;
    return isMobile ? 1.4 : 1.2;
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

  private startIntroCameraMove(
    config: SceneConfig,
    durationMs: number,
    zoomOutFactor: number,
    zoomStartYOffset: number,
    spinDegrees: number,
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
    const spunDirection = direction
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(spinDegrees));
    const start = target.clone().add(spunDirection.multiplyScalar(distance * zoomOutFactor));
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

  private readonly onPivotDebugKeyDown = (event: KeyboardEvent): void => {
    if (!this.pivotDebugEnabled || !this.activeConfig) {
      return;
    }
    if (event.key.toLowerCase() === 'p') {
      const pose = this.cameraController.getCurrentPose();
      const home = {
        position: pose.position.map((n) => Number(n.toFixed(4))) as [number, number, number],
        target: pose.target.map((n) => Number(n.toFixed(4))) as [number, number, number],
        fov: Number(pose.fov.toFixed(2)),
      };
      console.info('[pivot] Paste into scene.json camera.home:', JSON.stringify(home, null, 2));
      return;
    }
    if (!event.altKey || !event.shiftKey) {
      return;
    }
    const step = event.ctrlKey ? 0.02 : 0.08;
    const delta = this.deltaForPivotKey(event.key, step);
    if (!delta) {
      return;
    }
    event.preventDefault();
    this.applyDebugDelta(delta);
  };

  private deltaForPivotKey(key: string, step: number): THREE.Vector3 | null {
    const delta = new THREE.Vector3(0, 0, 0);
    switch (key) {
      case 'ArrowLeft':
        delta.x -= step;
        break;
      case 'ArrowRight':
        delta.x += step;
        break;
      case 'ArrowUp':
        delta.z -= step;
        break;
      case 'ArrowDown':
        delta.z += step;
        break;
      case 'PageUp':
        delta.y += step;
        break;
      case 'PageDown':
        delta.y -= step;
        break;
      default:
        return null;
    }
    return delta;
  }

  private applyDebugDelta(delta: THREE.Vector3): void {
    if (this.pivotDebugMode === 'scene') {
      this.sceneManager.nudgeActiveScenePosition(delta);
      this.fitCameraToContent(this.activeConfig!);
      return;
    }
    this.cameraController.nudgePivotWorld(delta);
  }

  private createPivotDebugPanel(): void {
    const panel = document.createElement('div');
    panel.style.position = 'absolute';
    panel.style.right = '12px';
    panel.style.top = '12px';
    panel.style.zIndex = '10001';
    panel.style.background = 'rgba(0,0,0,0.72)';
    panel.style.color = '#fff';
    panel.style.padding = '10px';
    panel.style.border = '1px solid rgba(255,255,255,0.28)';
    panel.style.borderRadius = '6px';
    panel.style.fontFamily = 'monospace';
    panel.style.fontSize = '12px';
    panel.style.width = '260px';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong>Debug Gizmo</strong>
        <button type="button" data-debug-copy style="font-size:11px;">Copy JSON</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <button type="button" data-debug-mode="pivot" style="flex:1;">Pivot</button>
        <button type="button" data-debug-mode="scene" style="flex:1;">Scene Shift</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:6px;">
        <button type="button" data-debug-dir="up">↑</button><button type="button" data-debug-dir="yup">Pg↑</button><button type="button" data-debug-dir="right">→</button>
        <button type="button" data-debug-dir="left">←</button><button type="button" data-debug-dir="down">↓</button><button type="button" data-debug-dir="ydown">Pg↓</button>
      </div>
      <div style="margin-bottom:6px;">Step: <input data-debug-step type="number" value="0.08" step="0.01" style="width:72px;" /></div>
      <pre data-debug-readout style="margin:0;white-space:pre-wrap;"></pre>
    `;
    const readout = panel.querySelector<HTMLElement>('[data-debug-readout]');
    const stepInput = panel.querySelector<HTMLInputElement>('[data-debug-step]');
    const copyButton = panel.querySelector<HTMLButtonElement>('[data-debug-copy]');
    panel.querySelectorAll<HTMLButtonElement>('[data-debug-mode]').forEach((button) => {
      button.onclick = () => {
        this.pivotDebugMode = (button.dataset.debugMode as 'pivot' | 'scene') ?? 'pivot';
      };
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-debug-dir]').forEach((button) => {
      button.onclick = () => {
        const step = Math.max(0.001, Number(stepInput?.value ?? 0.08));
        const delta = this.deltaForDebugDir(button.dataset.debugDir ?? '', step);
        if (!delta) {
          return;
        }
        this.applyDebugDelta(delta);
      };
    });
    copyButton?.addEventListener('click', async () => {
      const payload = this.getDebugPayload();
      const text = JSON.stringify(payload, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        console.info('[pivot] Copied debug payload.');
      } catch {
        console.info('[pivot] Copy failed, payload follows:', text);
      }
    });
    this.container.appendChild(panel);
    this.pivotDebugPanel = panel;
    this.pivotDebugReadout = readout;
  }

  private deltaForDebugDir(dir: string, step: number): THREE.Vector3 | null {
    switch (dir) {
      case 'left':
        return new THREE.Vector3(-step, 0, 0);
      case 'right':
        return new THREE.Vector3(step, 0, 0);
      case 'up':
        return new THREE.Vector3(0, 0, -step);
      case 'down':
        return new THREE.Vector3(0, 0, step);
      case 'yup':
        return new THREE.Vector3(0, step, 0);
      case 'ydown':
        return new THREE.Vector3(0, -step, 0);
      default:
        return null;
    }
  }

  private getDebugPayload(): Record<string, unknown> {
    const pose = this.cameraController.getCurrentPose();
    const primaryPosition = this.sceneManager.getPrimaryAssetPosition();
    return {
      mode: this.pivotDebugMode,
      cameraHome: {
        position: pose.position.map((n) => Number(n.toFixed(4))),
        target: pose.target.map((n) => Number(n.toFixed(4))),
        fov: Number(pose.fov.toFixed(2)),
      },
      primaryAssetTransformPosition: primaryPosition?.map((n) => Number(n.toFixed(4))) ?? null,
    };
  }

  private updatePivotDebugReadout(): void {
    if (!this.pivotDebugReadout || !this.pivotDebugEnabled) {
      return;
    }
    const payload = this.getDebugPayload();
    this.pivotDebugReadout.textContent = JSON.stringify(payload, null, 2);
  }

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
    node.addEventListener('pointerdown', this.onPointerDownForTelemetry, { passive: true });
    node.addEventListener('pointerup', this.onPointerUpForTelemetry, { passive: true });
    node.addEventListener('pointercancel', this.onPointerUpForTelemetry, { passive: true });
    node.addEventListener('wheel', this.onWheelForTelemetry, { passive: true });
  }

  private configureTelemetryForScene(config: SceneConfig): void {
    if (!this.telemetry) {
      return;
    }
    this.telemetry.setEnabled(config.analytics.enabled);
    this.telemetry.setEndpoint(config.analytics.endpoint);
    this.telemetry.setSessionContext({
      project: config.analytics.project,
      asset_id: config.assets[0]?.id ?? config.id,
      device_type: this.useMobileProfile ? 'mobile' : 'desktop',
    });
  }

  private emitTelemetry(
    name: string,
    payload: Record<string, unknown> = {},
    category: TelemetryCategory = 'viewer',
  ): void {
    this.telemetry?.track(name, payload, category);
  }

  private beginInteraction(type: InteractionType, pointer: string): void {
    if (this.interactionStartedAtMs[type] !== null) {
      return;
    }
    this.interactionCounts[type] += 1;
    this.interactionStartedAtMs[type] = performance.now();
    this.emitTelemetry('interaction_start', { type, pointer }, 'viewer');
    if (this.firstInteractionMs === null) {
      this.firstInteractionMs = Math.max(0, Math.round(performance.now() - this.viewerBootAtMs));
      this.emitTelemetry(
        'time_to_first_interaction',
        { type, ms: this.firstInteractionMs },
        'viewer',
      );
    }
  }

  private endInteraction(type: InteractionType): void {
    const startedAt = this.interactionStartedAtMs[type];
    if (startedAt === null) {
      return;
    }
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    this.interactionStartedAtMs[type] = null;
    this.interactionDurationsMs[type] += durationMs;
    this.emitTelemetry('interaction_end', { type, duration_ms: durationMs }, 'viewer');
  }

  private finalizeOpenInteractions(): void {
    this.endInteraction('rotate');
    this.endInteraction('zoom');
    this.endInteraction('pan');
  }

  private clearZoomEndTimer(): void {
    if (!this.zoomEndTimer) {
      return;
    }
    window.clearTimeout(this.zoomEndTimer);
    this.zoomEndTimer = 0;
  }

  private getFpsBucket(): string {
    const elapsedSec = this.sessionFrameElapsedMs / 1000;
    if (elapsedSec <= 0) {
      return 'unknown';
    }
    const fps = this.sessionFrameCount / elapsedSec;
    return inferFpsBucket(fps);
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

  private restoreDefaultViewFromAnnotationClose(): void {
    if (!this.activeConfig) {
      return;
    }
    this.cameraController.cancelAnimation();
    this.cameraController.setAutoRotate(false, this.currentIdleRotateSpeed);
    const home = this.fittedHome ?? this.activeConfig.camera.home;
    const closeReturnDurationMs = 1800;
    const closeReturnYawOffsetDeg = 30;
    const target = new THREE.Vector3(...home.target);
    const position = new THREE.Vector3(...home.position);
    const offset = position.sub(target).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(closeReturnYawOffsetDeg),
    );
    const adjustedHome = {
      position: [target.x + offset.x, target.y + offset.y, target.z + offset.z] as [number, number, number],
      target: home.target,
      fov: home.fov,
    };
    this.cameraController.resetToHome(adjustedHome, closeReturnDurationMs);
    if (this.autoRotate) {
      this.scheduleIdleResume(closeReturnDurationMs + 20);
    }
  }
}

type InteractionType = 'rotate' | 'zoom' | 'pan';

function inferFpsBucket(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) {
    return 'unknown';
  }
  if (fps < 20) {
    return 'lt20';
  }
  if (fps < 30) {
    return '20_30';
  }
  if (fps < 40) {
    return '30_40';
  }
  if (fps < 55) {
    return '40_55';
  }
  return 'gt55';
}
