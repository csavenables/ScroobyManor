import * as THREE from 'three';
import { AnnotationPinConfig, CameraLimitsConfig, SceneConfig, Vec3 } from '../config/schema';
import { CameraController } from '../viewer/CameraController';
import { AnnotationOverlay } from './AnnotationOverlay';
import { AnnotationOverlayModel, OcclusionSamplePoint, ProjectedAnnotationPin } from './AnnotationTypes';
import { OcclusionResolver } from './OcclusionResolver';

const ANNOTATION_CAMERA_TRANSITION_MULTIPLIER = 3;

interface AnnotationManagerOptions {
  host: HTMLElement;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  cameraController: CameraController;
}

export interface AnnotationEditorPin {
  id: string;
  assetId?: string;
  order: number;
  pos: Vec3;
  title: string;
  body: string;
}

export interface AnnotationEditorState {
  available: boolean;
  editMode: boolean;
  selectedId: string | null;
  pins: AnnotationEditorPin[];
  assetIds: string[];
  activeAssetId: string | null;
}

export interface AnnotationUpdatePatch {
  title?: string;
  body?: string;
  pos?: Vec3;
  assetId?: string | null;
}

export class AnnotationManager {
  private readonly overlay: AnnotationOverlay;
  private readonly occlusionResolver: OcclusionResolver;
  private config: SceneConfig['annotations'] | null = null;
  private readonly assetIds: string[] = [];
  private pins: AnnotationPinConfig[] = [];
  private selectedId: string | null = null;
  private activeAssetId: string | null = null;
  private baseLimits: CameraLimitsConfig | null = null;
  private baseEnablePan = true;
  private controlProfileActive = false;
  private editMode = false;
  private editorListener: ((state: AnnotationEditorState) => void) | null = null;

  constructor(private readonly options: AnnotationManagerOptions) {
    this.overlay = new AnnotationOverlay(options.host, {
      onSelect: (id) => this.selectAnnotation(id),
      onPrev: () => this.selectPrev(),
      onNext: () => this.selectNext(),
      onClose: () => this.close(),
    });
    this.occlusionResolver = new OcclusionResolver(options.renderer, options.scene, options.camera);
  }

  configure(sceneConfig: SceneConfig): void {
    this.baseLimits = sceneConfig.camera.limits;
    this.baseEnablePan = sceneConfig.ui.enablePan;
    this.config = sceneConfig.annotations.enabled ? sceneConfig.annotations : null;
    this.pins = this.config?.pins.slice(0, 20) ?? [];
    this.assetIds.splice(0, this.assetIds.length, ...sceneConfig.assets.map((asset) => asset.id));
    if ((this.config?.pins.length ?? 0) > 20) {
      console.warn('AnnotationManager: limiting annotations to 20 pins for performance.');
    }
    this.selectedId = null;
    this.activeAssetId = sceneConfig.assets[0]?.id ?? null;
    this.editMode = false;
    this.overlay.setVisible(Boolean(this.config && this.pins.length > 0));
    this.resetControlProfile();
    if (this.config?.defaultSelectedId) {
      this.selectAnnotation(this.config.defaultSelectedId);
    }
    this.emitEditorState();
  }

  clear(): void {
    this.config = null;
    this.assetIds.length = 0;
    this.pins = [];
    this.selectedId = null;
    this.activeAssetId = null;
    this.editMode = false;
    this.overlay.setVisible(false);
    this.resetControlProfile();
    this.emitEditorState();
  }

  update(nowMs: number, width: number, height: number): void {
    if (!this.config || this.pins.length === 0 || width <= 0 || height <= 0) {
      return;
    }

    const projectedPins = this.projectPins(width, height, nowMs);
    const orderedVisiblePins = this.pins.filter(
      (pin) => !pin.assetId || pin.assetId === this.activeAssetId,
    );
    const selectedIndex = this.selectedId
      ? orderedVisiblePins.findIndex((pin) => pin.id === this.selectedId)
      : -1;
    const wrapNavigation = this.config.ui.wrapNavigation ?? true;
    const hasAny = orderedVisiblePins.length > 0;
    const hasMany = orderedVisiblePins.length > 1;
    const canNavigateFromNone = selectedIndex < 0 && hasAny;
    const model: AnnotationOverlayModel = {
      pins: projectedPins,
      selectedId: this.selectedId,
      showTooltip: this.config.ui.showTooltip,
      showNav: this.config.ui.showNav,
      canPrev: canNavigateFromNone ? hasAny : wrapNavigation ? hasMany : selectedIndex > 0,
      canNext:
        canNavigateFromNone
          ? hasAny
          : wrapNavigation
            ? hasMany
            : selectedIndex >= 0 && selectedIndex < orderedVisiblePins.length - 1,
    };
    this.overlay.render(model);
  }

  setActiveAssetId(assetId: string | null): void {
    this.activeAssetId = assetId;
    if (!this.selectedId) {
      this.emitEditorState();
      return;
    }
    const selectedPin = this.pins.find((pin) => pin.id === this.selectedId);
    if (selectedPin?.assetId && selectedPin.assetId !== assetId) {
      this.close();
      return;
    }
    this.emitEditorState();
  }

  setEditMode(enabled: boolean): void {
    this.editMode = enabled;
    this.emitEditorState();
  }

  onEditorStateChange(listener: (state: AnnotationEditorState) => void): void {
    this.editorListener = listener;
    this.emitEditorState();
  }

  selectAnnotation(id: string): void {
    const pin = this.pins.find((entry) => entry.id === id);
    if (!pin) {
      return;
    }
    this.selectedId = id;
    const nextLimits = pin.camera.orbitLimits ?? this.baseLimits ?? undefined;
    this.applyControlProfile(Boolean(pin.camera.lockControls), nextLimits, this.baseEnablePan);
    this.options.cameraController.animateTo({
      position: pin.camera.position,
      target: pin.camera.target,
      fov: pin.camera.fov,
      durationMs: pin.camera.transitionMs * ANNOTATION_CAMERA_TRANSITION_MULTIPLIER,
    });
    this.emitEditorState();
  }

  updateSelected(patch: AnnotationUpdatePatch): void {
    if (!this.config || !this.selectedId) {
      return;
    }
    const index = this.pins.findIndex((pin) => pin.id === this.selectedId);
    if (index < 0) {
      return;
    }
    const existing = this.pins[index];
    const cameraTarget = new THREE.Vector3();
    this.options.cameraController.getTarget(cameraTarget);
    const nextTarget: Vec3 = patch.pos
      ? [...patch.pos]
      : [cameraTarget.x, cameraTarget.y, cameraTarget.z];
    const nextPosition: Vec3 = [
      this.options.camera.position.x,
      this.options.camera.position.y,
      this.options.camera.position.z,
    ];
    this.pins[index] = {
      ...existing,
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      pos: patch.pos ? [...patch.pos] : existing.pos,
      assetId:
        patch.assetId === undefined
          ? existing.assetId
          : patch.assetId === null || patch.assetId === '__all__'
            ? undefined
            : patch.assetId,
      camera: {
        ...existing.camera,
        position: nextPosition,
        target: nextTarget,
        fov: this.options.camera.fov,
      },
    };
    this.syncConfigPins();
    this.emitEditorState();
  }

  captureSelectedCameraFromLivePose(): boolean {
    if (!this.config || !this.selectedId) {
      return false;
    }
    const index = this.pins.findIndex((pin) => pin.id === this.selectedId);
    if (index < 0) {
      return false;
    }
    const existing = this.pins[index];
    const cameraTarget = new THREE.Vector3();
    this.options.cameraController.getTarget(cameraTarget);
    this.pins[index] = {
      ...existing,
      camera: {
        ...existing.camera,
        position: [
          this.options.camera.position.x,
          this.options.camera.position.y,
          this.options.camera.position.z,
        ],
        target: [cameraTarget.x, cameraTarget.y, cameraTarget.z],
        fov: this.options.camera.fov,
      },
    };
    this.syncConfigPins();
    this.emitEditorState();
    return true;
  }

  nudgeSelected(axis: 'x' | 'y' | 'z', delta: number): void {
    if (!this.selectedId) {
      return;
    }
    const pin = this.pins.find((entry) => entry.id === this.selectedId);
    if (!pin) {
      return;
    }
    const next: Vec3 = [...pin.pos];
    if (axis === 'x') {
      next[0] += delta;
    }
    if (axis === 'y') {
      next[1] += delta;
    }
    if (axis === 'z') {
      next[2] += delta;
    }
    this.updateSelected({ pos: next });
  }

  addPin(): void {
    if (!this.config) {
      return;
    }
    if (this.pins.length >= 20) {
      console.warn('AnnotationManager: max 20 pins reached.');
      return;
    }
    const nextOrder = this.pins.reduce((max, pin) => Math.max(max, pin.order), 0) + 1;
    const id = `pin_${nextOrder}`;
    const target = new THREE.Vector3();
    this.options.cameraController.getTarget(target);
    const direction = this.options.camera.position.clone().sub(target).normalize();
    const pinPos = target.clone().add(direction.multiplyScalar(0.2));
    const cameraPosition: Vec3 = [
      this.options.camera.position.x,
      this.options.camera.position.y,
      this.options.camera.position.z,
    ];
    const cameraTarget: Vec3 = [target.x, target.y, target.z];

    const pin: AnnotationPinConfig = {
      id,
      order: nextOrder,
      pos: [pinPos.x, pinPos.y, pinPos.z],
      title: `Annotation ${nextOrder}`,
      body: 'Edit this description.',
      assetId: this.activeAssetId ?? undefined,
      camera: {
        position: cameraPosition,
        target: cameraTarget,
        fov: this.options.camera.fov,
        transitionMs: 700,
        lockControls: true,
        orbitLimits: this.baseLimits ? { ...this.baseLimits } : undefined,
      },
    };
    this.pins.push(pin);
    this.pins.sort((a, b) => a.order - b.order);
    this.selectedId = pin.id;
    this.overlay.setVisible(true);
    this.syncConfigPins();
    this.emitEditorState();
  }

  deleteSelected(): void {
    if (!this.selectedId) {
      return;
    }
    const nextPins = this.pins.filter((pin) => pin.id !== this.selectedId);
    this.pins = nextPins;
    this.selectedId = nextPins[0]?.id ?? null;
    if (!this.selectedId) {
      this.resetControlProfile();
    }
    this.syncConfigPins();
    this.emitEditorState();
  }

  exportAnnotations(): SceneConfig['annotations'] | null {
    if (!this.config) {
      return null;
    }
    return {
      ...this.config,
      pins: this.pins.map((pin) => ({
        ...pin,
        pos: [...pin.pos],
        camera: {
          ...pin.camera,
          position: [...pin.camera.position],
          target: [...pin.camera.target],
          orbitLimits: pin.camera.orbitLimits ? { ...pin.camera.orbitLimits } : undefined,
        },
      })),
    };
  }

  dispose(): void {
    this.resetControlProfile();
    this.overlay.dispose();
    this.occlusionResolver.dispose();
  }

  private projectPins(width: number, height: number, nowMs: number): ProjectedAnnotationPin[] {
    const world = new THREE.Vector3();
    const ndc = new THREE.Vector3();
    const cameraSpace = new THREE.Vector3();
    const samples: OcclusionSamplePoint[] = [];
    const projected: ProjectedAnnotationPin[] = [];
    const occlusionConfig = this.config!.ui.occlusion;
    const declutterConfig = this.config!.ui.declutter ?? {
      selectedOnlyStrong: true,
      unselectedAlpha: 0.18,
      maxVisibleUnselected: 6,
    };

    for (const pin of this.pins) {
      if (pin.assetId && pin.assetId !== this.activeAssetId) {
        continue;
      }
      world.set(pin.pos[0], pin.pos[1], pin.pos[2]);
      ndc.copy(world).project(this.options.camera);
      cameraSpace.copy(world).applyMatrix4(this.options.camera.matrixWorldInverse);
      const inFront = cameraSpace.z < 0;
      const inDepthRange = ndc.z >= -1 && ndc.z <= 1;
      const inViewport = ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
      const visible = inFront && inDepthRange && inViewport;
      const screenX = (ndc.x * 0.5 + 0.5) * width;
      const screenY = (-ndc.y * 0.5 + 0.5) * height;
      const sample: OcclusionSamplePoint = {
        id: pin.id,
        visible,
        x: ndc.x * 0.5 + 0.5,
        y: -ndc.y * 0.5 + 0.5,
        ndcDepth: ndc.z * 0.5 + 0.5,
      };
      samples.push(sample);
      projected.push({
        pin,
        world: world.clone(),
        screenX,
        screenY,
        ndcDepth: sample.ndcDepth,
        visible,
        occluded: false,
        alpha: 1,
        clickable: true,
      });
    }

    const occludedById = occlusionConfig.enabled
      ? this.occlusionResolver.resolve(samples, width, height, occlusionConfig.epsilon, nowMs)
      : new Map<string, boolean>();

    return projected.map((pin) => {
      const occluded = pin.visible && Boolean(occludedById.get(pin.pin.id));
      const clickable = !occluded || !occlusionConfig.disableClickWhenOccluded;
      const isSelected = pin.pin.id === this.selectedId;
      let alpha = 1;
      if (declutterConfig.selectedOnlyStrong && !isSelected) {
        alpha = declutterConfig.unselectedAlpha;
      }
      if (occluded && !isSelected) {
        alpha = Math.min(alpha, occlusionConfig.fadeAlpha);
      }
      return {
        ...pin,
        occluded,
        clickable,
        alpha,
      };
    });
  }

  private selectPrev(): void {
    const visiblePins = this.pins.filter((pin) => !pin.assetId || pin.assetId === this.activeAssetId);
    if (visiblePins.length === 0) {
      return;
    }
    if (!this.selectedId) {
      this.selectAnnotation(visiblePins[0].id);
      return;
    }
    const index = visiblePins.findIndex((pin) => pin.id === this.selectedId);
    if (index < 0) {
      this.selectAnnotation(visiblePins[0].id);
      return;
    }
    const nextIndex = index <= 0
      ? (this.config?.ui.wrapNavigation ?? true)
        ? visiblePins.length - 1
        : 0
      : index - 1;
    if (nextIndex === index && !(this.config?.ui.wrapNavigation ?? true)) {
      return;
    }
    this.selectAnnotation(visiblePins[nextIndex].id);
  }

  private selectNext(): void {
    const visiblePins = this.pins.filter((pin) => !pin.assetId || pin.assetId === this.activeAssetId);
    if (visiblePins.length === 0) {
      return;
    }
    if (!this.selectedId) {
      this.selectAnnotation(visiblePins[0].id);
      return;
    }
    const index = visiblePins.findIndex((pin) => pin.id === this.selectedId);
    if (index < 0) {
      this.selectAnnotation(visiblePins[0].id);
      return;
    }
    const nextIndex = index >= visiblePins.length - 1
      ? (this.config?.ui.wrapNavigation ?? true)
        ? 0
        : index
      : index + 1;
    if (nextIndex === index && !(this.config?.ui.wrapNavigation ?? true)) {
      return;
    }
    this.selectAnnotation(visiblePins[nextIndex].id);
  }

  private close(): void {
    this.selectedId = null;
    this.resetControlProfile();
    this.emitEditorState();
  }

  private applyControlProfile(lockControls: boolean, limits: CameraLimitsConfig | undefined, enablePan: boolean): void {
    if (this.controlProfileActive) {
      this.options.cameraController.popControlProfile();
      this.controlProfileActive = false;
    }
    this.options.cameraController.pushControlProfile({
      lockControls,
      limits,
      enablePan,
    });
    this.controlProfileActive = true;
  }

  private resetControlProfile(): void {
    if (!this.controlProfileActive) {
      return;
    }
    this.options.cameraController.popControlProfile();
    this.controlProfileActive = false;
  }

  private emitEditorState(): void {
    if (!this.editorListener) {
      return;
    }
    this.editorListener({
      available: Boolean(this.config),
      editMode: this.editMode,
      selectedId: this.selectedId,
      activeAssetId: this.activeAssetId,
      assetIds: [...this.assetIds],
      pins: this.pins.map((pin) => ({
        id: pin.id,
        assetId: pin.assetId,
        order: pin.order,
        pos: [...pin.pos],
        title: pin.title,
        body: pin.body,
      })),
    });
  }

  private syncConfigPins(): void {
    if (!this.config) {
      return;
    }
    this.config = {
      ...this.config,
      pins: this.pins.map((pin) => ({
        ...pin,
        pos: [...pin.pos],
        camera: {
          ...pin.camera,
          position: [...pin.camera.position],
          target: [...pin.camera.target],
          orbitLimits: pin.camera.orbitLimits ? { ...pin.camera.orbitLimits } : undefined,
        },
      })),
    };
  }
}
