import * as THREE from 'three';
import * as pc from 'playcanvas';
import {
  InteriorViewConfig,
  SceneConfig,
  SogRuntimeConfig,
  SplatAssetConfig,
} from '../config/schema';
import {
  RendererContext,
  RuntimeLoadMetrics,
  SplatFitData,
  SplatHandle,
  SplatRenderer,
  SplatRevealBounds,
  SplatRevealParams,
  SplatSampleCloud,
  SplatSampleOptions,
} from './types';

const RUNTIME_SUPPORTED_EXTENSIONS = ['.sog', 'lod-meta.json'] as const;
const EPSILON = 0.00001;

const DEFAULT_SOG_RUNTIME: SogRuntimeConfig = {
  unified: true,
  highQualitySH: false,
  splatBudget: 0,
  lodBaseDistance: 5,
  lodMultiplier: 3,
  lodRangeMin: 0,
  lodRangeMax: 10,
  lodUpdateDistance: 0.8,
  lodUpdateAngle: 0,
  lodUnderfillLimit: 1,
  colorUpdateDistance: 0.3,
  colorUpdateAngle: 2,
  cooldownTicks: 100,
};

const DEFAULT_REVEAL_PARAMS = {
  enabled: false,
  mode: 'yRamp' as const,
  revealY: 0,
  band: 0.12,
  sphereRadius: 0.0001,
  sphereFeather: 0.12,
  clipBottomEnabled: false,
  clipBottomY: 0,
  affectAlpha: true,
};

const REVEAL_WORKBUFFER_MODIFIER_GLSL = `
uniform float uRevealEnabled;
uniform float uRevealMode;
uniform float uRevealY;
uniform float uRevealBand;
uniform vec3 uSphereOrigin;
uniform float uSphereRadius;
uniform float uSphereFeather;
uniform float uClipBottomEnabled;
uniform float uClipBottomY;
uniform float uRevealAffectAlpha;
uniform vec3 uScaleMul;

float computeRevealAlpha(vec3 center) {
  if (uRevealEnabled < 0.5) {
    return 1.0;
  }
  if (uRevealMode < 0.5) {
    float band = max(0.0001, uRevealBand);
    return smoothstep(uRevealY - band, uRevealY + band, center.y);
  }
  float distToOrigin = distance(center, uSphereOrigin);
  float feather = max(0.0001, uSphereFeather);
  float edge = smoothstep(uSphereRadius - feather, uSphereRadius + feather, distToOrigin);
  return 1.0 - edge;
}

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
  scale *= max(uScaleMul, vec3(0.0001));
}

void modifySplatColor(vec3 center, inout vec4 color) {
  if (uClipBottomEnabled > 0.5 && center.y < uClipBottomY) {
    color.a = 0.0;
    return;
  }
  float revealAlpha = computeRevealAlpha(center);
  if (uRevealAffectAlpha > 0.5) {
    color.a *= revealAlpha;
  }
}
`;

interface InternalSplatHandle extends SplatHandle {
  entity: pc.Entity;
  component: pc.GSplatComponent;
  asset: pc.Asset;
  baseScale: THREE.Vector3;
  revealParams: SplatRevealParams;
}

function cloneRuntimeConfig(config: SogRuntimeConfig | undefined): SogRuntimeConfig {
  if (!config) {
    return { ...DEFAULT_SOG_RUNTIME };
  }
  return {
    unified: config.unified,
    highQualitySH: config.highQualitySH,
    splatBudget: config.splatBudget,
    lodBaseDistance: config.lodBaseDistance,
    lodMultiplier: config.lodMultiplier,
    lodRangeMin: config.lodRangeMin,
    lodRangeMax: config.lodRangeMax,
    lodUpdateDistance: config.lodUpdateDistance,
    lodUpdateAngle: config.lodUpdateAngle,
    lodUnderfillLimit: config.lodUnderfillLimit,
    colorUpdateDistance: config.colorUpdateDistance,
    colorUpdateAngle: config.colorUpdateAngle,
    cooldownTicks: config.cooldownTicks,
  };
}

function getAssetExtension(source: string): string | null {
  const clean = source.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('lod-meta.json')) {
    return 'lod-meta.json';
  }
  const dotIndex = clean.lastIndexOf('.');
  if (dotIndex < 0) {
    return null;
  }
  return clean.slice(dotIndex);
}

function toThreeMatrix(source: pc.Mat4): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(source.data as unknown as number[]);
}

function computeAabbCorners(aabb: pc.BoundingBox): THREE.Vector3[] {
  const c = aabb.center;
  const e = aabb.halfExtents;
  const minX = c.x - e.x;
  const minY = c.y - e.y;
  const minZ = c.z - e.z;
  const maxX = c.x + e.x;
  const maxY = c.y + e.y;
  const maxZ = c.z + e.z;
  return [
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(minX, minY, maxZ),
    new THREE.Vector3(minX, maxY, minZ),
    new THREE.Vector3(minX, maxY, maxZ),
    new THREE.Vector3(maxX, minY, minZ),
    new THREE.Vector3(maxX, minY, maxZ),
    new THREE.Vector3(maxX, maxY, minZ),
    new THREE.Vector3(maxX, maxY, maxZ),
  ];
}

function cloneRevealParams(params: SplatRevealParams): SplatRevealParams {
  return {
    enabled: params.enabled,
    mode: params.mode,
    revealY: params.revealY,
    band: params.band,
    sphereOrigin: params.sphereOrigin.clone(),
    sphereRadius: params.sphereRadius,
    sphereFeather: params.sphereFeather,
    clipBottomEnabled: params.clipBottomEnabled,
    clipBottomY: params.clipBottomY,
    affectAlpha: params.affectAlpha,
    affectSize: params.affectSize,
  };
}

export class GaussianSplatRenderer implements SplatRenderer {
  private context: RendererContext | null = null;
  private app: pc.Application | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private cameraEntity: pc.Entity | null = null;
  private sceneRoot: pc.Entity | null = null;
  private handles: InternalSplatHandle[] = [];
  private handleById = new Map<string, InternalSplatHandle>();
  private fitData: SplatFitData | null = null;
  private currentFetchMs = 0;
  private lastLoadMetrics: RuntimeLoadMetrics = {
    assetFetchMs: 0,
    decodeInitMs: 0,
  };
  private runtimeConfig: SogRuntimeConfig = { ...DEFAULT_SOG_RUNTIME };
  private maxDevicePixelRatio = 1.25;
  private lastViewportWidth = 0;
  private lastViewportHeight = 0;

  async initialize(context: RendererContext): Promise<void> {
    this.context = context;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pc-splat-canvas';
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.backgroundColor = '#000000';
    this.canvas.style.zIndex = '2';

    context.rootElement.style.position = 'relative';
    context.rootElement.appendChild(this.canvas);

    context.renderer.domElement.style.position = 'absolute';
    context.renderer.domElement.style.inset = '0';
    context.renderer.domElement.style.zIndex = '1';

    const app = new pc.Application(this.canvas, {
      graphicsDeviceOptions: {
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      },
    });

    app.scene.ambientLight = new pc.Color(0, 0, 0);
    app.autoRender = false;

    const cameraEntity = new pc.Entity('pc-camera');
    cameraEntity.addComponent('camera', {
      clearColor: new pc.Color(0, 0, 0, 1),
      fov: context.camera.fov,
      nearClip: context.camera.near,
      farClip: context.camera.far,
    });
    app.root.addChild(cameraEntity);

    const sceneRoot = new pc.Entity('pc-splat-root');
    app.root.addChild(sceneRoot);

    this.app = app;
    this.cameraEntity = cameraEntity;
    this.sceneRoot = sceneRoot;

    this.applyRuntimeConfigToScene();
    this.applyPixelRatio();
    app.setCanvasFillMode(pc.FILLMODE_NONE, context.rootElement.clientWidth, context.rootElement.clientHeight);
    app.setCanvasResolution(pc.RESOLUTION_AUTO, context.rootElement.clientWidth, context.rootElement.clientHeight);
    this.syncViewportAndCamera();

    app.start();
    app.renderNextFrame = true;
  }

  configureScene(config: SceneConfig): void {
    this.runtimeConfig = cloneRuntimeConfig(config.sogRuntime);
    this.maxDevicePixelRatio = Math.max(0.75, config.performanceProfile.maxDevicePixelRatio);
    this.applyRuntimeConfigToScene();
    this.applyPixelRatio();
    for (const handle of this.handles) {
      this.applyRuntimeConfigToComponent(handle.component);
      this.applyRevealParams(handle);
    }
    this.app?.renderNextFrame && (this.app.renderNextFrame = true);
  }

  async loadSplat(asset: SplatAssetConfig): Promise<SplatHandle> {
    const handles = await this.loadSplats([asset]);
    return handles[0];
  }

  async loadSplats(assets: SplatAssetConfig[]): Promise<SplatHandle[]> {
    if (!this.app || !this.sceneRoot) {
      throw new Error('Renderer not initialized.');
    }
    if (assets.length === 0) {
      return [];
    }
    this.ensureSupportedAssetFormats(assets);

    this.currentFetchMs = 0;
    const loadStart = performance.now();
    const loaded: InternalSplatHandle[] = [];

    for (const assetConfig of assets) {
      const handle = await this.loadSingleAsset(assetConfig);
      loaded.push(handle);
      this.handles.push(handle);
      this.handleById.set(handle.id, handle);
    }

    this.fitData = null;
    this.lastLoadMetrics = {
      assetFetchMs: this.currentFetchMs,
      decodeInitMs: Math.max(0, performance.now() - loadStart),
    };
    if (this.app) {
      this.app.renderNextFrame = true;
    }
    return loaded;
  }

  setVisible(id: string, visible: boolean): void {
    const handle = this.handleById.get(id);
    if (!handle) {
      return;
    }
    if (handle.object3D.visible === visible) {
      return;
    }
    handle.object3D.visible = visible;
    if (visible) {
      handle.component.show();
    } else {
      handle.component.hide();
    }
    this.fitData = null;
    if (this.app) {
      this.app.renderNextFrame = true;
    }
  }

  getSplatSampleCloud(id: string, options: SplatSampleOptions): SplatSampleCloud {
    const handle = this.handleById.get(id);
    if (!handle) {
      return { points: [] };
    }

    const resource = handle.asset.resource as pc.GSplatResourceBase | null;
    const centers = resource?.centers;
    if (!centers || centers.length < 3) {
      return { points: [] };
    }

    const count = Math.floor(centers.length / 3);
    const maxSamples = Math.max(1, Math.floor(options.maxSamples));
    const step = Math.max(1, Math.floor(count / maxSamples));
    const randomize = options.randomize ?? false;
    const includeColors = options.includeColors ?? false;

    const transform = toThreeMatrix(handle.entity.getWorldTransform());
    const points: THREE.Vector3[] = [];
    const sampledColors: number[] = [];
    const startOffset = randomize && step > 1 ? Math.floor(Math.random() * step) : 0;

    for (let sampleIndex = startOffset; sampleIndex < count && points.length < maxSamples; sampleIndex += step) {
      const baseIndex = sampleIndex * 3;
      const point = new THREE.Vector3(
        centers[baseIndex],
        centers[baseIndex + 1],
        centers[baseIndex + 2],
      );
      if (options.space !== 'local') {
        point.applyMatrix4(transform);
      }
      points.push(point);
      if (includeColors) {
        sampledColors.push(1, 1, 1);
      }
    }

    if (!includeColors) {
      return { points };
    }
    return {
      points,
      colors: new Float32Array(sampledColors),
    };
  }

  getSplatSamplePoints(id: string, options: SplatSampleOptions): THREE.Vector3[] {
    return this.getSplatSampleCloud(id, options).points;
  }

  getAndResetLoadMetrics(): RuntimeLoadMetrics {
    const metrics = { ...this.lastLoadMetrics };
    this.lastLoadMetrics = { assetFetchMs: 0, decodeInitMs: 0 };
    return metrics;
  }

  setInteriorView(_config: InteriorViewConfig): void {
    // Intentionally unsupported in this migration phase.
  }

  setInteriorCameraPosition(_position: THREE.Vector3): void {
    // Intentionally unsupported in this migration phase.
  }

  async clear(): Promise<void> {
    const existing = [...this.handles];
    for (const handle of existing) {
      this.destroyHandle(handle);
    }
    this.handles = [];
    this.handleById.clear();
    this.fitData = null;
    if (this.app) {
      this.app.renderNextFrame = true;
    }
  }

  getFitData(): SplatFitData | null {
    if (this.fitData) {
      return {
        center: this.fitData.center.clone(),
        size: this.fitData.size.clone(),
        radius: this.fitData.radius,
      };
    }
    if (this.handles.length === 0) {
      return null;
    }

    const worldBounds = new THREE.Box3();
    let hasAny = false;
    for (const handle of this.handles) {
      if (!handle.object3D.visible) {
        continue;
      }
      if (!handle.sampledBounds) {
        continue;
      }
      worldBounds.expandByPoint(handle.sampledBounds.min);
      worldBounds.expandByPoint(handle.sampledBounds.max);
      hasAny = true;
    }

    if (!hasAny || worldBounds.isEmpty()) {
      return null;
    }

    const center = worldBounds.getCenter(new THREE.Vector3());
    const size = worldBounds.getSize(new THREE.Vector3());
    const radius = Math.max(0.6, center.distanceTo(worldBounds.max) * 1.1);
    this.fitData = {
      center: center.clone(),
      size: size.clone(),
      radius,
    };
    return {
      center,
      size,
      radius,
    };
  }

  update(): void {
    this.syncViewportAndCamera();
    if (this.app) {
      this.app.renderNextFrame = true;
    }
  }

  render(): void {
    if (this.app) {
      this.app.renderNextFrame = true;
    }
  }

  async dispose(): Promise<void> {
    await this.clear();
    this.fitData = null;

    if (this.app) {
      this.app.destroy();
      this.app = null;
    }
    this.cameraEntity = null;
    this.sceneRoot = null;

    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    this.context = null;
  }

  private async loadSingleAsset(assetConfig: SplatAssetConfig): Promise<InternalSplatHandle> {
    if (!this.app || !this.sceneRoot) {
      throw new Error('Renderer not initialized.');
    }

    const loadStart = performance.now();
    const playCanvasAsset = new pc.Asset(assetConfig.id, 'gsplat', {
      url: assetConfig.src,
    });
    await this.loadAssetResource(playCanvasAsset);
    this.currentFetchMs += Math.max(0, performance.now() - loadStart);

    const entity = new pc.Entity(`splat-${assetConfig.id}`);
    entity.setLocalPosition(...assetConfig.transform.position);
    entity.setLocalEulerAngles(...assetConfig.transform.rotation);
    entity.setLocalScale(...assetConfig.transform.scale);

    entity.addComponent('gsplat', {
      asset: playCanvasAsset.id,
      unified: this.runtimeConfig.unified,
      layers: [pc.LAYERID_WORLD],
    });

    const component = entity.gsplat as pc.GSplatComponent | undefined;
    if (!component) {
      throw new Error(`Failed to create gsplat component for asset "${assetConfig.id}".`);
    }

    this.applyRuntimeConfigToComponent(component);
    component.setWorkBufferModifier({ glsl: REVEAL_WORKBUFFER_MODIFIER_GLSL });
    component.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE;

    this.sceneRoot.addChild(entity);

    const proxyObject = new THREE.Object3D();
    proxyObject.visible = assetConfig.visibleDefault;
    proxyObject.scale.set(...assetConfig.transform.scale);

    if (assetConfig.visibleDefault) {
      component.show();
    } else {
      component.hide();
    }

    const sampledBounds = this.computeSampledBounds(entity, playCanvasAsset);
    const boundsY: SplatRevealBounds = sampledBounds
      ? { minY: sampledBounds.min.y, maxY: sampledBounds.max.y }
      : { minY: -1, maxY: 1 };

    const sphereOrigin = sampledBounds
      ? sampledBounds.min.clone().add(sampledBounds.max).multiplyScalar(0.5)
      : new THREE.Vector3(0, 0, 0);

    const revealParams: SplatRevealParams = {
      enabled: DEFAULT_REVEAL_PARAMS.enabled,
      mode: DEFAULT_REVEAL_PARAMS.mode,
      revealY: boundsY.maxY,
      band: DEFAULT_REVEAL_PARAMS.band,
      sphereOrigin,
      sphereRadius: DEFAULT_REVEAL_PARAMS.sphereRadius,
      sphereFeather: DEFAULT_REVEAL_PARAMS.sphereFeather,
      clipBottomEnabled: DEFAULT_REVEAL_PARAMS.clipBottomEnabled,
      clipBottomY: boundsY.minY,
      affectAlpha: DEFAULT_REVEAL_PARAMS.affectAlpha,
      affectSize: true,
    };

    const baseScale = proxyObject.scale.clone();

    const handle = {
      id: assetConfig.id,
      entity,
      component,
      asset: playCanvasAsset,
      object3D: proxyObject,
      baseScale,
      boundsY,
      sampledBounds,
      revealParams,
      setRevealParams: (params: SplatRevealParams): void => {
        handle.revealParams = cloneRevealParams(params);
        this.applyRevealParams(handle);
      },
      setRevealBounds: (nextBounds: SplatRevealBounds): void => {
        handle.boundsY = { ...nextBounds };
        this.applyRevealParams(handle);
      },
      dispose: (): void => {
        this.destroyHandle(handle);
      },
    } satisfies InternalSplatHandle;

    this.applyRevealParams(handle);
    return handle;
  }

  private applyRevealParams(handle: InternalSplatHandle): void {
    const params = handle.revealParams;
    const scaleMulX = handle.object3D.scale.x / Math.max(EPSILON, handle.baseScale.x);
    const scaleMulY = handle.object3D.scale.y / Math.max(EPSILON, handle.baseScale.y);
    const scaleMulZ = handle.object3D.scale.z / Math.max(EPSILON, handle.baseScale.z);

    handle.component.setParameter('uRevealEnabled', params.enabled ? 1 : 0);
    handle.component.setParameter('uRevealMode', params.mode === 'bottomSphere' ? 1 : 0);
    handle.component.setParameter('uRevealY', params.revealY);
    handle.component.setParameter('uRevealBand', Math.max(EPSILON, params.band));
    handle.component.setParameter('uSphereOrigin', [
      params.sphereOrigin.x,
      params.sphereOrigin.y,
      params.sphereOrigin.z,
    ]);
    handle.component.setParameter('uSphereRadius', Math.max(EPSILON, params.sphereRadius));
    handle.component.setParameter('uSphereFeather', Math.max(EPSILON, params.sphereFeather));
    handle.component.setParameter('uClipBottomEnabled', params.clipBottomEnabled ? 1 : 0);
    handle.component.setParameter('uClipBottomY', params.clipBottomY);
    handle.component.setParameter('uRevealAffectAlpha', params.affectAlpha ? 1 : 0);
    handle.component.setParameter('uScaleMul', [scaleMulX, scaleMulY, scaleMulZ]);

    handle.component.workBufferUpdate = params.enabled
      ? pc.WORKBUFFER_UPDATE_ALWAYS
      : pc.WORKBUFFER_UPDATE_ONCE;

    if (handle.object3D.visible) {
      handle.component.show();
    } else {
      handle.component.hide();
    }

    if (this.app) {
      this.app.renderNextFrame = true;
    }
  }

  private applyRuntimeConfigToScene(): void {
    if (!this.app) {
      return;
    }
    const gsplat = this.app.scene.gsplat;
    gsplat.splatBudget = this.runtimeConfig.splatBudget;
    gsplat.lodRangeMin = this.runtimeConfig.lodRangeMin;
    gsplat.lodRangeMax = this.runtimeConfig.lodRangeMax;
    gsplat.lodUpdateDistance = this.runtimeConfig.lodUpdateDistance;
    gsplat.lodUpdateAngle = this.runtimeConfig.lodUpdateAngle;
    gsplat.lodUnderfillLimit = this.runtimeConfig.lodUnderfillLimit;
    gsplat.colorUpdateDistance = this.runtimeConfig.colorUpdateDistance;
    gsplat.colorUpdateAngle = this.runtimeConfig.colorUpdateAngle;
    gsplat.cooldownTicks = this.runtimeConfig.cooldownTicks;
  }

  private applyRuntimeConfigToComponent(component: pc.GSplatComponent): void {
    component.unified = this.runtimeConfig.unified;
    component.highQualitySH = this.runtimeConfig.highQualitySH;
    component.lodBaseDistance = this.runtimeConfig.lodBaseDistance;
    component.lodMultiplier = this.runtimeConfig.lodMultiplier;
  }

  private syncViewportAndCamera(): void {
    if (!this.context || !this.app || !this.cameraEntity) {
      return;
    }
    const width = Math.max(1, this.context.rootElement.clientWidth);
    const height = Math.max(1, this.context.rootElement.clientHeight);
    this.applyPixelRatio();
    if (width !== this.lastViewportWidth || height !== this.lastViewportHeight) {
      this.lastViewportWidth = width;
      this.lastViewportHeight = height;
      this.app.setCanvasFillMode(pc.FILLMODE_NONE, width, height);
      this.app.setCanvasResolution(pc.RESOLUTION_AUTO, width, height);
      this.app.resizeCanvas(width, height);
    }

    const sourceCamera = this.context.camera;
    this.cameraEntity.setPosition(sourceCamera.position.x, sourceCamera.position.y, sourceCamera.position.z);
    this.cameraEntity.setRotation(
      sourceCamera.quaternion.x,
      sourceCamera.quaternion.y,
      sourceCamera.quaternion.z,
      sourceCamera.quaternion.w,
    );

    const cameraComponent = this.cameraEntity.camera;
    if (cameraComponent) {
      cameraComponent.fov = sourceCamera.fov;
      cameraComponent.nearClip = sourceCamera.near;
      cameraComponent.farClip = sourceCamera.far;
    }
  }

  private applyPixelRatio(): void {
    if (!this.app) {
      return;
    }
    const targetDpr = Math.min(window.devicePixelRatio || 1, this.maxDevicePixelRatio);
    this.app.graphicsDevice.maxPixelRatio = Math.max(0.75, targetDpr);
  }

  private computeSampledBounds(
    entity: pc.Entity,
    asset: pc.Asset,
  ): { min: THREE.Vector3; max: THREE.Vector3 } | undefined {
    const resource = asset.resource as pc.GSplatResourceBase | null;
    if (!resource) {
      return undefined;
    }

    const transform = toThreeMatrix(entity.getWorldTransform());
    if (resource.aabb) {
      const corners = computeAabbCorners(resource.aabb);
      const worldBounds = new THREE.Box3();
      for (const corner of corners) {
        worldBounds.expandByPoint(corner.applyMatrix4(transform));
      }
      if (!worldBounds.isEmpty()) {
        return {
          min: worldBounds.min.clone(),
          max: worldBounds.max.clone(),
        };
      }
    }

    const centers = resource.centers;
    if (!centers || centers.length < 3) {
      return undefined;
    }

    const worldBounds = new THREE.Box3();
    const count = Math.floor(centers.length / 3);
    const maxSamples = 40000;
    const step = Math.max(1, Math.floor(count / maxSamples));
    for (let index = 0; index < count; index += step) {
      const i3 = index * 3;
      const worldPoint = new THREE.Vector3(centers[i3], centers[i3 + 1], centers[i3 + 2]).applyMatrix4(transform);
      worldBounds.expandByPoint(worldPoint);
    }

    if (worldBounds.isEmpty()) {
      return undefined;
    }
    return {
      min: worldBounds.min.clone(),
      max: worldBounds.max.clone(),
    };
  }

  private async loadAssetResource(asset: pc.Asset): Promise<void> {
    if (!this.app) {
      throw new Error('Renderer not initialized.');
    }
    const app = this.app;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: string, failedAsset: pc.Asset): void => {
        if (failedAsset !== asset) {
          return;
        }
        cleanup();
        reject(new Error(`Failed to load "${asset.getFileUrl() || asset.name}": ${error}`));
      };

      const onReady = (): void => {
        cleanup();
        resolve();
      };

      const cleanup = (): void => {
        app.assets.off('error', onError);
      };

      asset.ready(onReady);
      app.assets.on('error', onError);
      app.assets.add(asset);
      app.assets.load(asset);
    });
  }

  private destroyHandle(handle: InternalSplatHandle): void {
    if (this.handleById.get(handle.id) !== handle) {
      return;
    }

    try {
      handle.component.setWorkBufferModifier(null);
      handle.component.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE;
    } catch {
      // no-op
    }

    if (handle.entity.parent) {
      handle.entity.parent.removeChild(handle.entity);
    }
    handle.entity.destroy();

    if (this.app) {
      this.app.assets.remove(handle.asset);
    }
    handle.asset.unload();

    this.handleById.delete(handle.id);
    this.handles = this.handles.filter((entry) => entry !== handle);
    this.fitData = null;
  }

  private ensureSupportedAssetFormats(assets: SplatAssetConfig[]): void {
    for (const asset of assets) {
      const extension = getAssetExtension(asset.src);
      if (!extension) {
        throw new Error(
          `Unsupported asset format for "${asset.src}". Supported runtime formats: ${RUNTIME_SUPPORTED_EXTENSIONS.join(', ')}.`,
        );
      }
      if (!RUNTIME_SUPPORTED_EXTENSIONS.includes(extension as (typeof RUNTIME_SUPPORTED_EXTENSIONS)[number])) {
        throw new Error(
          `Unsupported asset format for "${asset.src}". Supported runtime formats: ${RUNTIME_SUPPORTED_EXTENSIONS.join(', ')}.`,
        );
      }
    }
  }
}
