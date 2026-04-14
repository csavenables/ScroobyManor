import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { InteriorViewConfig, SplatAssetConfig } from '../config/schema';
import {
  RendererContext,
  SplatFitData,
  SplatHandle,
  SplatSampleCloud,
  RuntimeLoadMetrics,
  SplatRenderer,
  SplatRevealBounds,
  SplatRevealParams,
  SplatSampleOptions,
} from './types';

const SUPPORTED_EXTENSIONS = ['.ply', '.splat', '.ksplat', '.spz'] as const;
const MAX_REVEAL_SCENES = 32;
const REVEAL_PATCH_FLAG = '__splatRevealPatched';
const ENABLE_SHADER_REVEAL = true;
const INTERIOR_PATCH_FLAG = '__splatInteriorPatched';

interface RevealMaterialBinding {
  material: THREE.ShaderMaterial;
  uniforms: {
    uRevealEnabled: { value: number[] };
    uRevealY: { value: number[] };
    uRevealBand: { value: number[] };
    uRevealMinY: { value: number[] };
    uRevealMaxY: { value: number[] };
    uRevealMode: { value: number[] };
    uSphereEnabled: { value: number[] };
    uSphereOriginX: { value: number[] };
    uSphereOriginY: { value: number[] };
    uSphereOriginZ: { value: number[] };
    uSphereRadius: { value: number[] };
    uSphereFeather: { value: number[] };
    uClipBottomEnabled: { value: number[] };
    uClipBottomY: { value: number[] };
    uRevealAffectAlpha: { value: number[] };
    uRevealAffectSize: { value: number[] };
  };
}

interface InternalViewer {
  splatMesh?: {
    material?: THREE.ShaderMaterial;
  };
}

interface RevealSceneObject extends THREE.Object3D {
  opacity?: number;
}

interface ResolvedAssetSource {
  path: string;
  format?: number;
}

function toQuaternionArray(rotationDegrees: [number, number, number]): [number, number, number, number] {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDegrees[0]),
    THREE.MathUtils.degToRad(rotationDegrees[1]),
    THREE.MathUtils.degToRad(rotationDegrees[2]),
  );
  const q = new THREE.Quaternion().setFromEuler(euler);
  return [q.x, q.y, q.z, q.w];
}

function makeRevealUniformArrays(defaultValue: number): number[] {
  return new Array(MAX_REVEAL_SCENES).fill(defaultValue);
}

interface InteriorMaterialBinding {
  material: THREE.ShaderMaterial;
  uniforms: {
    uInteriorEnabled: { value: number };
    uInteriorTarget: { value: THREE.Vector3 };
    uInteriorRadius: { value: number };
    uInteriorSoftness: { value: number };
    uInteriorFadeAlpha: { value: number };
    uInteriorMaxDist: { value: number };
    uInteriorAffectSize: { value: number };
    uInteriorCameraPos: { value: THREE.Vector3 };
  };
}

const INTERIOR_DEFAULTS: InteriorViewConfig = {
  enabled: false,
  target: [0, 0, 0],
  radius: 0.45,
  softness: 0.2,
  fadeAlpha: 0.15,
  maxDistance: 20,
  affectSize: false,
};

export class GaussianSplatRenderer implements SplatRenderer {
  private viewer: GaussianSplats3D.Viewer | null = null;
  private sceneIdOrder: string[] = [];
  private handles: SplatHandle[] = [];
  private fitData: SplatFitData | null = null;
  private warnedRevealFallback = false;
  private revealBinding: RevealMaterialBinding | null = null;
  private interiorBinding: InteriorMaterialBinding | null = null;
  private interiorConfig: InteriorViewConfig = { ...INTERIOR_DEFAULTS };
  private warnedInteriorFallback = false;
  private sceneGraphMutating = false;
  private sceneMutationQueue: Promise<void> = Promise.resolve();
  private readonly splatBlobUrlCache = new Map<string, Promise<string>>();
  private readonly transientBlobUrls = new Set<string>();
  private currentFetchMs = 0;
  private lastLoadMetrics: RuntimeLoadMetrics = {
    assetFetchMs: 0,
    decodeInitMs: 0,
  };

  async initialize(context: RendererContext): Promise<void> {
    this.viewer = this.createViewer(context);
  }

  async loadSplat(asset: SplatAssetConfig): Promise<SplatHandle> {
    const handles = await this.loadSplats([asset]);
    return handles[0];
  }

  async loadSplats(assets: SplatAssetConfig[]): Promise<SplatHandle[]> {
    if (!this.viewer) {
      throw new Error('Renderer not initialized.');
    }
    if (assets.length === 0) {
      return [];
    }
    if (this.sceneIdOrder.length + assets.length > MAX_REVEAL_SCENES) {
      throw new Error(`Reveal system supports up to ${MAX_REVEAL_SCENES} loaded splat handles.`);
    }
    this.ensureSupportedAssetFormats(assets);

    return this.withSceneMutation(async () => {
      const sceneIndexStart = this.sceneIdOrder.length;
      await this.loadAssetsWithViewer(assets);

      const newHandles: SplatHandle[] = [];
      for (let i = 0; i < assets.length; i += 1) {
        const sceneIndex = sceneIndexStart + i;
        const scene = this.viewer!.getSplatScene(sceneIndex);
        const handle = this.createSplatHandle(assets[i], scene, sceneIndex);
        newHandles.push(handle);
      }

      this.sceneIdOrder.push(...assets.map((asset) => asset.id));
      this.handles.push(...newHandles);
      this.fitData = null;
      this.viewer!.forceRenderNextFrame();
      return newHandles;
    });
  }

  setVisible(id: string, visible: boolean): void {
    const handle = this.handles.find((entry) => entry.id === id);
    if (!handle) {
      return;
    }
    if (handle.object3D.visible === visible) {
      return;
    }
    handle.object3D.visible = visible;
    this.fitData = null;
    this.viewer?.forceRenderNextFrame();
  }

  getSplatSampleCloud(id: string, options: SplatSampleOptions): SplatSampleCloud {
    if (!this.viewer || this.sceneGraphMutating) {
      return { points: [] };
    }
    const sceneIndex = this.handles.findIndex((handle) => handle.id === id);
    if (sceneIndex < 0) {
      return { points: [] };
    }
    const scene = this.viewer.getSplatScene(sceneIndex);
    const count = scene.splatBuffer.getSplatCount();
    if (count <= 0) {
      return { points: [] };
    }

    const maxSamples = Math.max(1, Math.floor(options.maxSamples));
    const includeColors = options.includeColors ?? false;
    const step = options.randomize
      ? Math.max(1, Math.floor(count / maxSamples))
      : Math.max(1, Math.floor(count / maxSamples));
    const useWorldSpace = options.space !== 'local';
    const transform = useWorldSpace
      ? new THREE.Matrix4().compose(scene.position, scene.quaternion, scene.scale)
      : undefined;
    const sample = new THREE.Vector3();
    const sampleColor = new THREE.Vector4();
    const points: THREE.Vector3[] = [];
    const sampledColors: number[] = [];
    const appendSample = (splatIndex: number): void => {
      scene.splatBuffer.getSplatCenter(splatIndex, sample, transform);
      points.push(sample.clone());
      if (includeColors) {
        scene.splatBuffer.getSplatColor(splatIndex, sampleColor);
        sampledColors.push(
          THREE.MathUtils.clamp(sampleColor.x / 255, 0, 1),
          THREE.MathUtils.clamp(sampleColor.y / 255, 0, 1),
          THREE.MathUtils.clamp(sampleColor.z / 255, 0, 1),
        );
      }
    };
    if (options.randomize) {
      const jitter = step > 1 ? Math.floor(Math.random() * step) : 0;
      for (let splatIndex = jitter; splatIndex < count && points.length < maxSamples; splatIndex += step) {
        appendSample(splatIndex);
      }
      return includeColors
        ? { points, colors: new Float32Array(sampledColors) }
        : { points };
    }
    for (let splatIndex = 0; splatIndex < count && points.length < maxSamples; splatIndex += step) {
      appendSample(splatIndex);
    }
    return includeColors
      ? { points, colors: new Float32Array(sampledColors) }
      : { points };
  }

  getSplatSamplePoints(id: string, options: SplatSampleOptions): THREE.Vector3[] {
    return this.getSplatSampleCloud(id, options).points;
  }

  getAndResetLoadMetrics(): RuntimeLoadMetrics {
    const metrics = { ...this.lastLoadMetrics };
    this.lastLoadMetrics = { assetFetchMs: 0, decodeInitMs: 0 };
    return metrics;
  }

  setInteriorView(config: InteriorViewConfig): void {
    this.interiorConfig = {
      enabled: config.enabled,
      target: [...config.target],
      radius: config.radius,
      softness: config.softness,
      fadeAlpha: config.fadeAlpha,
      maxDistance: config.maxDistance,
      affectSize: config.affectSize,
    };
    const binding = this.ensureInteriorPatch();
    if (!binding) {
      if (this.interiorConfig.enabled && !this.warnedInteriorFallback) {
        console.warn('Interior view shader injection unavailable. Effect disabled.');
        this.warnedInteriorFallback = true;
      }
      return;
    }
    this.applyInteriorConfig(binding, this.interiorConfig);
    this.viewer?.forceRenderNextFrame();
  }

  setInteriorCameraPosition(position: THREE.Vector3): void {
    const binding = this.ensureInteriorPatch();
    if (!binding) {
      return;
    }
    binding.uniforms.uInteriorCameraPos.value.copy(position);
  }

  async clear(): Promise<void> {
    if (!this.viewer) {
      return;
    }
    await this.withSceneMutation(async () => {
      for (let sceneIndex = this.sceneIdOrder.length - 1; sceneIndex >= 0; sceneIndex -= 1) {
        await this.viewer!.removeSplatScene(sceneIndex, false);
      }
      for (const handle of this.handles) {
        handle.dispose();
      }
      this.sceneIdOrder.length = 0;
      this.handles.length = 0;
      this.fitData = null;
      this.revealBinding = null;
      this.interiorBinding = null;
      this.viewer!.forceRenderNextFrame();
    });
  }

  getFitData(): SplatFitData | null {
    if (this.fitData) {
      return {
        center: this.fitData.center.clone(),
        size: this.fitData.size.clone(),
        radius: this.fitData.radius,
      };
    }
    if (!this.viewer || this.handles.length === 0 || this.sceneGraphMutating) {
      return null;
    }

    const box = new THREE.Box3();
    const sample = new THREE.Vector3();
    const transform = new THREE.Matrix4();
    let sampledPoints = 0;

    for (let sceneIndex = 0; sceneIndex < this.handles.length; sceneIndex += 1) {
      const scene = this.viewer.getSplatScene(sceneIndex);
      if (!scene.visible) {
        continue;
      }
      transform.compose(scene.position, scene.quaternion, scene.scale);
      const count = scene.splatBuffer.getSplatCount();
      const maxSamplesPerScene = 15000;
      const step = Math.max(1, Math.floor(count / maxSamplesPerScene));
      for (let splatIndex = 0; splatIndex < count; splatIndex += step) {
        scene.splatBuffer.getSplatCenter(splatIndex, sample, transform);
        box.expandByPoint(sample);
        sampledPoints += 1;
      }
    }

    if (sampledPoints === 0 || box.isEmpty()) {
      return null;
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(0.6, center.distanceTo(box.max) * 1.1);
    this.fitData = { center: center.clone(), size: size.clone(), radius };
    return { center, size, radius };
  }

  update(): void {
    if (this.sceneGraphMutating) {
      return;
    }
    this.viewer?.update();
  }

  render(): void {
    if (this.sceneGraphMutating) {
      return;
    }
    this.viewer?.render();
  }

  async dispose(): Promise<void> {
    for (const handle of this.handles) {
      handle.dispose();
    }
    this.handles.length = 0;
    if (!this.viewer) {
      this.releaseTransientBlobUrls();
      return;
    }
    await this.withSceneMutation(async () => {
      await this.viewer!.dispose();
    });
    this.viewer = null;
    this.sceneIdOrder = [];
    this.fitData = null;
    this.revealBinding = null;
    this.interiorBinding = null;
    this.releaseTransientBlobUrls();
  }

  private async withSceneMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.sceneMutationQueue.then(async () => {
      this.sceneGraphMutating = true;
      try {
        return await work();
      } finally {
        this.sceneGraphMutating = false;
      }
    });
    this.sceneMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadAssetsWithViewer(assets: SplatAssetConfig[]): Promise<void> {
    if (!this.viewer) {
      throw new Error('Renderer not initialized.');
    }
    this.currentFetchMs = 0;
    const loadStart = performance.now();
    if (assets.length === 1) {
      const asset = assets[0];
      const source = await this.resolveAssetSource(asset);
      try {
        await this.viewer.addSplatScene(source.path, {
          format: source.format,
          showLoadingUI: false,
          position: asset.transform.position,
          rotation: toQuaternionArray(asset.transform.rotation),
          scale: asset.transform.scale,
          opacity: 0,
          visible: asset.visibleDefault,
          splatAlphaRemovalThreshold: 1,
        });
      } catch (error) {
        throw new Error(this.buildAssetLoadErrorMessage([asset], error));
      }
      this.lastLoadMetrics = {
        assetFetchMs: this.currentFetchMs,
        decodeInitMs: Math.max(0, performance.now() - loadStart),
      };
      return;
    }

    try {
      const resolved = await Promise.all(
        assets.map(async (asset) => ({
          asset,
          source: await this.resolveAssetSource(asset),
        })),
      );
      await this.viewer.addSplatScenes(
        resolved.map(({ asset, source }) => ({
          path: source.path,
          format: source.format,
          position: asset.transform.position,
          rotation: toQuaternionArray(asset.transform.rotation),
          scale: asset.transform.scale,
          opacity: 0,
          visible: asset.visibleDefault,
          splatAlphaRemovalThreshold: 1,
          showLoadingUI: false,
        })),
        false,
      );
    } catch (error) {
      throw new Error(this.buildAssetLoadErrorMessage(assets, error));
    }
    this.lastLoadMetrics = {
      assetFetchMs: this.currentFetchMs,
      decodeInitMs: Math.max(0, performance.now() - loadStart),
    };
  }

  private async resolveAssetSource(asset: SplatAssetConfig): Promise<ResolvedAssetSource> {
    const extension = getAssetExtension(asset.src);
    const format = this.resolveSceneFormat(extension);

    if (extension !== '.splat') {
      return { path: asset.src, format };
    }

    const blobUrl = await this.getSplatBlobUrl(asset.src);
    return {
      path: blobUrl,
      format,
    };
  }

  private resolveSceneFormat(extension: string | null): number | undefined {
    switch (extension) {
      case '.splat':
        return GaussianSplats3D.SceneFormat.Splat;
      case '.ksplat':
        return GaussianSplats3D.SceneFormat.KSplat;
      case '.ply':
        return GaussianSplats3D.SceneFormat.Ply;
      case '.spz':
        return GaussianSplats3D.SceneFormat.Spz;
      default:
        return undefined;
    }
  }

  private async getSplatBlobUrl(sourceUrl: string): Promise<string> {
    const cached = this.splatBlobUrlCache.get(sourceUrl);
    if (cached) {
      return cached;
    }

    const fetchPromise = (async () => {
      const start = performance.now();
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch splat source "${sourceUrl}" (${response.status} ${response.statusText}).`);
      }
      const fileData = await response.arrayBuffer();
      this.currentFetchMs += Math.max(0, performance.now() - start);
      const blobUrl = URL.createObjectURL(new Blob([fileData], { type: 'application/octet-stream' }));
      this.transientBlobUrls.add(blobUrl);
      return blobUrl;
    })();

    this.splatBlobUrlCache.set(sourceUrl, fetchPromise);
    try {
      return await fetchPromise;
    } catch (error) {
      this.splatBlobUrlCache.delete(sourceUrl);
      throw error;
    }
  }

  private releaseTransientBlobUrls(): void {
    for (const blobUrl of this.transientBlobUrls) {
      URL.revokeObjectURL(blobUrl);
    }
    this.transientBlobUrls.clear();
    this.splatBlobUrlCache.clear();
  }

  private createSplatHandle(asset: SplatAssetConfig, object3D: THREE.Object3D, sceneIndex: number): SplatHandle {
    const scene = this.viewer?.getSplatScene(sceneIndex);
    const sampledBounds = scene ? this.computeBoundsFromScene(scene) : null;
    const bounds = sampledBounds
      ? { minY: sampledBounds.min.y, maxY: sampledBounds.max.y }
      : this.computeBoundsFromObject(object3D);
    const revealBinding = this.ensureRevealPatch();

    const handle: SplatHandle = {
      id: asset.id,
      object3D,
      boundsY: { ...bounds },
      sampledBounds: sampledBounds
        ? {
            min: sampledBounds.min.clone(),
            max: sampledBounds.max.clone(),
          }
        : undefined,
      setRevealBounds: (nextBounds: SplatRevealBounds): void => {
        handle.boundsY = { ...nextBounds };
        if (revealBinding) {
          revealBinding.uniforms.uRevealMinY.value[sceneIndex] = nextBounds.minY;
          revealBinding.uniforms.uRevealMaxY.value[sceneIndex] = nextBounds.maxY;
        }
      },
      setRevealParams: (params: SplatRevealParams): void => {
        if (revealBinding) {
          revealBinding.uniforms.uRevealEnabled.value[sceneIndex] = params.enabled ? 1 : 0;
          revealBinding.uniforms.uRevealMode.value[sceneIndex] = params.mode === 'bottomSphere' ? 1 : 0;
          revealBinding.uniforms.uRevealY.value[sceneIndex] = params.revealY;
          revealBinding.uniforms.uRevealBand.value[sceneIndex] = Math.max(0.0001, params.band);
          revealBinding.uniforms.uSphereEnabled.value[sceneIndex] =
            params.enabled && params.mode === 'bottomSphere' ? 1 : 0;
          revealBinding.uniforms.uSphereOriginX.value[sceneIndex] = params.sphereOrigin.x;
          revealBinding.uniforms.uSphereOriginY.value[sceneIndex] = params.sphereOrigin.y;
          revealBinding.uniforms.uSphereOriginZ.value[sceneIndex] = params.sphereOrigin.z;
          revealBinding.uniforms.uSphereRadius.value[sceneIndex] = Math.max(0.0001, params.sphereRadius);
          revealBinding.uniforms.uSphereFeather.value[sceneIndex] = Math.max(0.0001, params.sphereFeather);
          revealBinding.uniforms.uClipBottomEnabled.value[sceneIndex] = params.clipBottomEnabled ? 1 : 0;
          revealBinding.uniforms.uClipBottomY.value[sceneIndex] = params.clipBottomY;
          revealBinding.uniforms.uRevealAffectAlpha.value[sceneIndex] = params.affectAlpha ? 1 : 0;
          revealBinding.uniforms.uRevealAffectSize.value[sceneIndex] = params.affectSize ? 1 : 0;
        } else if (!this.warnedRevealFallback) {
          console.warn('Shader reveal unavailable. Using scene opacity dissolve fallback.');
          this.warnedRevealFallback = true;
          this.applySceneOpacityReveal(object3D, params, handle.boundsY);
        } else {
          this.applySceneOpacityReveal(object3D, params, handle.boundsY);
        }
        this.viewer?.forceRenderNextFrame();
      },
      dispose: (): void => {
        if (revealBinding) {
          revealBinding.uniforms.uRevealEnabled.value[sceneIndex] = 0;
          revealBinding.uniforms.uSphereEnabled.value[sceneIndex] = 0;
          revealBinding.uniforms.uClipBottomEnabled.value[sceneIndex] = 0;
        }
      },
    };

    handle.setRevealBounds(bounds);
    return handle;
  }

  private computeBoundsFromObject(root: THREE.Object3D): SplatRevealBounds {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) {
      return { minY: -1, maxY: 1 };
    }
    return { minY: box.min.y, maxY: box.max.y };
  }

  private computeBoundsFromScene(scene: {
    splatBuffer: { getSplatCount(): number; getSplatCenter(index: number, out: THREE.Vector3, transform?: THREE.Matrix4): void };
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  }): THREE.Box3 | null {
    const count = scene.splatBuffer.getSplatCount();
    if (count <= 0) {
      return null;
    }
    const box = new THREE.Box3();
    const sample = new THREE.Vector3();
    const transform = new THREE.Matrix4().compose(scene.position, scene.quaternion, scene.scale);
    const maxSamples = 180000;
    const step = Math.max(1, Math.floor(count / maxSamples));
    let sampled = 0;
    for (let splatIndex = 0; splatIndex < count; splatIndex += step) {
      scene.splatBuffer.getSplatCenter(splatIndex, sample, transform);
      box.expandByPoint(sample);
      sampled += 1;
    }
    if (sampled === 0 || box.isEmpty()) {
      return null;
    }
    return box;
  }

  private ensureRevealPatch(): RevealMaterialBinding | null {
    if (!ENABLE_SHADER_REVEAL) {
      return null;
    }
    if (this.revealBinding) {
      return this.revealBinding;
    }
    const anyViewer = this.viewer as unknown as InternalViewer | null;
    const material = anyViewer?.splatMesh?.material;
    if (!material) {
      return null;
    }
    this.revealBinding = this.patchRevealMaterial(material);
    return this.revealBinding;
  }

  private ensureInteriorPatch(): InteriorMaterialBinding | null {
    if (this.interiorBinding) {
      return this.interiorBinding;
    }
    const anyViewer = this.viewer as unknown as InternalViewer | null;
    const material = anyViewer?.splatMesh?.material;
    if (!material) {
      return null;
    }
    if (!('uniforms' in material) || typeof material.uniforms !== 'object' || material.uniforms === null) {
      return null;
    }
    this.interiorBinding = this.patchInteriorMaterial(material);
    this.applyInteriorConfig(this.interiorBinding, this.interiorConfig);
    return this.interiorBinding;
  }

  private patchRevealMaterial(material: THREE.ShaderMaterial): RevealMaterialBinding {
    const tagged = material as unknown as Record<string, unknown>;
    if (tagged[REVEAL_PATCH_FLAG] === true) {
      const existing = tagged.__splatRevealBinding as RevealMaterialBinding | undefined;
      if (existing) {
        return existing;
      }
    }

    const uniforms = {
      uRevealEnabled: { value: makeRevealUniformArrays(0) },
      uRevealY: { value: makeRevealUniformArrays(0) },
      uRevealBand: { value: makeRevealUniformArrays(0.12) },
      uRevealMinY: { value: makeRevealUniformArrays(-1) },
      uRevealMaxY: { value: makeRevealUniformArrays(1) },
      uRevealMode: { value: makeRevealUniformArrays(0) },
      uSphereEnabled: { value: makeRevealUniformArrays(0) },
      uSphereOriginX: { value: makeRevealUniformArrays(0) },
      uSphereOriginY: { value: makeRevealUniformArrays(0) },
      uSphereOriginZ: { value: makeRevealUniformArrays(0) },
      uSphereRadius: { value: makeRevealUniformArrays(0.0001) },
      uSphereFeather: { value: makeRevealUniformArrays(0.12) },
      uClipBottomEnabled: { value: makeRevealUniformArrays(0) },
      uClipBottomY: { value: makeRevealUniformArrays(0) },
      uRevealAffectAlpha: { value: makeRevealUniformArrays(1) },
      uRevealAffectSize: { value: makeRevealUniformArrays(1) },
    };

    material.uniforms.uRevealEnabled = uniforms.uRevealEnabled;
    material.uniforms.uRevealY = uniforms.uRevealY;
    material.uniforms.uRevealBand = uniforms.uRevealBand;
    material.uniforms.uRevealMinY = uniforms.uRevealMinY;
    material.uniforms.uRevealMaxY = uniforms.uRevealMaxY;
    material.uniforms.uRevealMode = uniforms.uRevealMode;
    material.uniforms.uSphereEnabled = uniforms.uSphereEnabled;
    material.uniforms.uSphereOriginX = uniforms.uSphereOriginX;
    material.uniforms.uSphereOriginY = uniforms.uSphereOriginY;
    material.uniforms.uSphereOriginZ = uniforms.uSphereOriginZ;
    material.uniforms.uSphereRadius = uniforms.uSphereRadius;
    material.uniforms.uSphereFeather = uniforms.uSphereFeather;
    material.uniforms.uClipBottomEnabled = uniforms.uClipBottomEnabled;
    material.uniforms.uClipBottomY = uniforms.uClipBottomY;
    material.uniforms.uRevealAffectAlpha = uniforms.uRevealAffectAlpha;
    material.uniforms.uRevealAffectSize = uniforms.uRevealAffectSize;

    material.vertexShader = injectRevealIntoVertexShader(material.vertexShader).shader;
    material.fragmentShader = injectRevealIntoFragmentShader(material.fragmentShader).shader;
    material.needsUpdate = true;

    const binding: RevealMaterialBinding = { material, uniforms };
    tagged[REVEAL_PATCH_FLAG] = true;
    tagged.__splatRevealBinding = binding;
    return binding;
  }

  private patchInteriorMaterial(material: THREE.ShaderMaterial): InteriorMaterialBinding {
    if (!material.uniforms) {
      material.uniforms = {};
    }
    const tagged = material as unknown as Record<string, unknown>;
    if (tagged[INTERIOR_PATCH_FLAG] === true) {
      const existing = tagged.__splatInteriorBinding as InteriorMaterialBinding | undefined;
      if (existing) {
        return existing;
      }
    }

    const uniforms = {
      uInteriorEnabled: { value: 0 },
      uInteriorTarget: { value: new THREE.Vector3(0, 0, 0) },
      uInteriorRadius: { value: 0.45 },
      uInteriorSoftness: { value: 0.2 },
      uInteriorFadeAlpha: { value: 0.15 },
      uInteriorMaxDist: { value: 20 },
      uInteriorAffectSize: { value: 0 },
      uInteriorCameraPos: { value: new THREE.Vector3(0, 0, 0) },
    };

    material.uniforms.uInteriorEnabled = uniforms.uInteriorEnabled;
    material.uniforms.uInteriorTarget = uniforms.uInteriorTarget;
    material.uniforms.uInteriorRadius = uniforms.uInteriorRadius;
    material.uniforms.uInteriorSoftness = uniforms.uInteriorSoftness;
    material.uniforms.uInteriorFadeAlpha = uniforms.uInteriorFadeAlpha;
    material.uniforms.uInteriorMaxDist = uniforms.uInteriorMaxDist;
    material.uniforms.uInteriorAffectSize = uniforms.uInteriorAffectSize;
    material.uniforms.uInteriorCameraPos = uniforms.uInteriorCameraPos;

    material.vertexShader = injectInteriorIntoVertexShader(material.vertexShader).shader;
    material.fragmentShader = injectInteriorIntoFragmentShader(material.fragmentShader).shader;
    material.needsUpdate = true;

    const binding: InteriorMaterialBinding = { material, uniforms };
    tagged[INTERIOR_PATCH_FLAG] = true;
    tagged.__splatInteriorBinding = binding;
    return binding;
  }

  private applyInteriorConfig(binding: InteriorMaterialBinding, config: InteriorViewConfig): void {
    binding.uniforms.uInteriorEnabled.value = config.enabled ? 1 : 0;
    binding.uniforms.uInteriorTarget.value.set(...config.target);
    binding.uniforms.uInteriorRadius.value = Math.max(0.0001, config.radius);
    binding.uniforms.uInteriorSoftness.value = Math.min(0.6, Math.max(0.05, config.softness));
    binding.uniforms.uInteriorFadeAlpha.value = Math.min(1, Math.max(0, config.fadeAlpha));
    binding.uniforms.uInteriorMaxDist.value = Math.max(0.0001, config.maxDistance);
    binding.uniforms.uInteriorAffectSize.value = config.affectSize ? 1 : 0;
  }

  private applySceneOpacityReveal(
    root: THREE.Object3D,
    params: SplatRevealParams,
    bounds: SplatRevealBounds,
  ): void {
    let revealProgress = 1;
    if (params.mode === 'bottomSphere') {
      const box = new THREE.Box3().setFromObject(root);
      if (!box.isEmpty()) {
        const maxRadius = Math.max(
          params.sphereOrigin.distanceTo(box.max),
          params.sphereOrigin.distanceTo(box.min),
        );
        revealProgress = Math.min(1, Math.max(0, params.sphereRadius / Math.max(0.0001, maxRadius)));
      }
    } else {
      const range = Math.max(0.0001, bounds.maxY - bounds.minY);
      revealProgress = Math.min(1, Math.max(0, (params.revealY - bounds.minY) / range));
    }
    const sceneRoot = root as RevealSceneObject;
    if (typeof sceneRoot.opacity === 'number') {
      sceneRoot.opacity = params.enabled && params.affectAlpha ? revealProgress : 1;
      return;
    }

    root.traverse((node) => {
      const withMaterial = node as THREE.Object3D & { material?: THREE.Material | THREE.Material[] };
      if (!withMaterial.material) {
        return;
      }
      const materials = Array.isArray(withMaterial.material)
        ? withMaterial.material
        : [withMaterial.material];
      for (const material of materials) {
        const mat = material as THREE.Material & { opacity?: number; transparent?: boolean };
        if (typeof mat.opacity === 'number') {
          mat.transparent = true;
          mat.opacity = params.enabled && params.affectAlpha ? revealProgress : 1;
          mat.needsUpdate = true;
        }
      }
    });
  }

  private createViewer(context: RendererContext): GaussianSplats3D.Viewer {
    return new GaussianSplats3D.Viewer({
      selfDrivenMode: false,
      useBuiltInControls: false,
      dynamicScene: true,
      renderer: context.renderer,
      camera: context.camera,
      threeScene: context.scene,
      rootElement: context.rootElement,
      renderMode: GaussianSplats3D.RenderMode.Always,
      sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
      enableOptionalEffects: false,
      sharedMemoryForWorkers: false,
      gpuAcceleratedSort: false,
      optimizeSplatData: false,
      logLevel: GaussianSplats3D.LogLevel.None,
    });
  }

  private ensureSupportedAssetFormats(assets: SplatAssetConfig[]): void {
    for (const asset of assets) {
      const extension = getAssetExtension(asset.src);
      if (!extension || !SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
        throw new Error(
          `Unsupported asset format for "${asset.src}". Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
        );
      }
    }
  }

  private buildAssetLoadErrorMessage(assets: SplatAssetConfig[], error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown renderer load error.';
    if (assets.length === 1) {
      return `Failed to load splat asset "${assets[0].src}". ${message}`;
    }
    const assetList = assets.map((asset) => asset.src).join(', ');
    return `Failed to load one or more splat assets [${assetList}]. ${message}`;
  }
}

function injectRevealIntoVertexShader(source: string): { shader: string } {
  let shader = source;
  if (!shader.includes('varying float vRevealWorldY;')) {
    shader = `varying float vRevealWorldY;\nvarying vec3 vRevealWorldPos;\nvarying float vRevealSceneIndex;\n${shader}`;
  }

  if (shader.includes('uint sceneIndex = uint(0);')) {
    shader = shader.replace(
      'uint sceneIndex = uint(0);',
      'uint sceneIndex = uint(0);\n            vRevealSceneIndex = 0.0;',
    );
  }
  if (shader.includes('sceneIndex = texture(sceneIndexesTexture, getDataUV(1, 0, sceneIndexesTextureSize)).r;')) {
    shader = shader.replace(
      'sceneIndex = texture(sceneIndexesTexture, getDataUV(1, 0, sceneIndexesTextureSize)).r;',
      'sceneIndex = texture(sceneIndexesTexture, getDataUV(1, 0, sceneIndexesTextureSize)).r;\n                vRevealSceneIndex = float(sceneIndex);',
    );
  }
  if (shader.includes('vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));')) {
    shader = shader.replace(
      'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));',
      'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));\n            vRevealWorldY = splatCenter.y;\n            vRevealWorldPos = splatCenter;',
    );
  }
  if (shader.includes('mat4 transformModelViewMatrix = viewMatrix * transform;')) {
    shader = shader.replace(
      'mat4 transformModelViewMatrix = viewMatrix * transform;',
      'mat4 transformModelViewMatrix = viewMatrix * transform;\n                vec3 revealWorldCenter = (transform * vec4(splatCenter, 1.0)).xyz;\n                vRevealWorldPos = revealWorldCenter;\n                vRevealWorldY = revealWorldCenter.y;',
    );
  }
  if (shader.includes('mat4 transformModelViewMatrix = modelViewMatrix;')) {
    shader = shader.replace(
      'mat4 transformModelViewMatrix = modelViewMatrix;',
      'mat4 transformModelViewMatrix = modelViewMatrix;\n                vec3 revealWorldCenter = (modelMatrix * vec4(splatCenter, 1.0)).xyz;\n                vRevealWorldPos = revealWorldCenter;\n                vRevealWorldY = revealWorldCenter.y;',
    );
  }

  return { shader };
}

function injectInteriorIntoVertexShader(source: string): { shader: string } {
  let shader = source;
  if (!shader.includes('varying vec3 vInteriorSplatPos;')) {
    shader = `varying vec3 vInteriorSplatPos;\n${shader}`;
  }
  if (!shader.includes('varying float vInteriorSceneIndex;')) {
    shader = `varying float vInteriorSceneIndex;\n${shader}`;
  }
  if (shader.includes('uint sceneIndex = uint(0);')) {
    shader = shader.replace(
      'uint sceneIndex = uint(0);',
      'uint sceneIndex = uint(0);\n            vInteriorSceneIndex = 0.0;',
    );
  }
  if (shader.includes('sceneIndex = texture(sceneIndexesTexture, getDataUV(1, 0, sceneIndexesTextureSize)).r;')) {
    shader = shader.replace(
      'sceneIndex = texture(sceneIndexesTexture, getDataUV(1, 0, sceneIndexesTextureSize)).r;',
      'sceneIndex = texture(sceneIndexesTexture, getDataUV(1, 0, sceneIndexesTextureSize)).r;\n                vInteriorSceneIndex = float(sceneIndex);',
    );
  }
  if (shader.includes('vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));')) {
    shader = shader.replace(
      'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));',
      'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));\n            vInteriorSplatPos = splatCenter;',
    );
  }
  return { shader };
}

function injectRevealIntoFragmentShader(source: string): { shader: string } {
  let shader = source;
  if (!shader.includes('varying float vRevealWorldY;')) {
    shader = `varying float vRevealWorldY;\nvarying vec3 vRevealWorldPos;\nvarying float vRevealSceneIndex;\n${shader}`;
  }
  if (!shader.includes('uniform float uRevealEnabled[32];')) {
    shader =
      `uniform float uRevealEnabled[32];\n` +
      `uniform float uRevealY[32];\n` +
      `uniform float uRevealBand[32];\n` +
      `uniform float uRevealMinY[32];\n` +
      `uniform float uRevealMaxY[32];\n` +
      `uniform float uRevealMode[32];\n` +
      `uniform float uSphereEnabled[32];\n` +
      `uniform float uSphereOriginX[32];\n` +
      `uniform float uSphereOriginY[32];\n` +
      `uniform float uSphereOriginZ[32];\n` +
      `uniform float uSphereRadius[32];\n` +
      `uniform float uSphereFeather[32];\n` +
      `uniform float uClipBottomEnabled[32];\n` +
      `uniform float uClipBottomY[32];\n` +
      `uniform float uRevealAffectAlpha[32];\n` +
      `uniform float uRevealAffectSize[32];\n` +
      shader;
  }

  const revealSnippet =
    '\n  int revealScene = int(vRevealSceneIndex + 0.5);\n' +
    '  revealScene = clamp(revealScene, 0, 31);\n' +
    '  if (uClipBottomEnabled[revealScene] > 0.5 && vRevealWorldY < uClipBottomY[revealScene]) {\n' +
    '    discard;\n' +
    '  }\n' +
    '  float revealAlpha = 1.0;\n' +
    '  if (uRevealEnabled[revealScene] > 0.5) {\n' +
    '    if (uRevealMode[revealScene] < 0.5) {\n' +
    '      float revealBand = max(0.0001, uRevealBand[revealScene]);\n' +
    '      revealAlpha = smoothstep(uRevealY[revealScene] - revealBand, uRevealY[revealScene] + revealBand, vRevealWorldY);\n' +
    '    } else if (uSphereEnabled[revealScene] > 0.5) {\n' +
    '      vec3 sphereOrigin = vec3(uSphereOriginX[revealScene], uSphereOriginY[revealScene], uSphereOriginZ[revealScene]);\n' +
    '      float sphereDist = distance(vRevealWorldPos, sphereOrigin);\n' +
    '      float feather = max(0.0001, uSphereFeather[revealScene]);\n' +
      '      revealAlpha = smoothstep(uSphereRadius[revealScene] - feather, uSphereRadius[revealScene] + feather, sphereDist);\n' +
      '      revealAlpha = 1.0 - revealAlpha;\n' +
    '    }\n' +
    '  }\n' +
    '  if (uRevealAffectAlpha[revealScene] > 0.5) {\n' +
    '    gl_FragColor.a *= revealAlpha;\n' +
    '  }\n';

  if (shader.includes('#include <dithering_fragment>')) {
    shader = shader.replace(
      '#include <dithering_fragment>',
      `${revealSnippet}\n  #include <dithering_fragment>`,
    );
  } else {
    shader = shader.replace(/\}\s*$/, `${revealSnippet}\n}`);
  }

  return { shader };
}

function injectInteriorIntoFragmentShader(source: string): { shader: string } {
  let shader = source;
  if (!shader.includes('varying vec3 vInteriorSplatPos;')) {
    shader = `varying vec3 vInteriorSplatPos;\n${shader}`;
  }
  if (!shader.includes('varying float vInteriorSceneIndex;')) {
    shader = `varying float vInteriorSceneIndex;\n${shader}`;
  }
  if (!shader.includes('uniform float uInteriorEnabled;')) {
    shader =
      `uniform float uInteriorEnabled;\n` +
      `uniform vec3 uInteriorTarget;\n` +
      `uniform float uInteriorRadius;\n` +
      `uniform float uInteriorSoftness;\n` +
      `uniform float uInteriorFadeAlpha;\n` +
      `uniform float uInteriorMaxDist;\n` +
      `uniform float uInteriorAffectSize;\n` +
      `uniform vec3 uInteriorCameraPos;\n` +
      shader;
  }

  const snippet =
    '\n  if (uInteriorEnabled > 0.5) {\n' +
    '    vec3 A = uInteriorCameraPos;\n' +
    '    vec3 B = uInteriorTarget;\n' +
    '    vec3 AB = B - A;\n' +
    '    float abLen = length(AB);\n' +
    '    if (abLen > 0.0001 && abLen <= uInteriorMaxDist) {\n' +
    '      float abLenSq = dot(AB, AB);\n' +
    '      vec3 AP = vInteriorSplatPos - A;\n' +
    '      float t = clamp(dot(AP, AB) / abLenSq, 0.0, 1.0);\n' +
    '      if (t > 0.0 && t < 1.0) {\n' +
    '        vec3 closest = A + t * AB;\n' +
    '        float d = length(vInteriorSplatPos - closest);\n' +
    '        float soft = max(0.0001, uInteriorSoftness * uInteriorRadius);\n' +
    '        float m = smoothstep(uInteriorRadius, uInteriorRadius - soft, d);\n' +
    '        gl_FragColor.a = mix(gl_FragColor.a, gl_FragColor.a * uInteriorFadeAlpha, m);\n' +
    '        if (uInteriorAffectSize > 0.5) {\n' +
    '          gl_FragColor.a *= mix(1.0, 0.7, m);\n' +
    '        }\n' +
    '      }\n' +
    '    }\n' +
    '  }\n';

  if (shader.includes('#include <dithering_fragment>')) {
    shader = shader.replace('#include <dithering_fragment>', `${snippet}\n  #include <dithering_fragment>`);
  } else {
    shader = shader.replace(/\}\s*$/, `${snippet}\n}`);
  }

  return { shader };
}

function getAssetExtension(path: string): string | null {
  const clean = path.split('?')[0].split('#')[0];
  const dotIndex = clean.lastIndexOf('.');
  if (dotIndex < 0) {
    return null;
  }
  return clean.slice(dotIndex).toLowerCase();
}
