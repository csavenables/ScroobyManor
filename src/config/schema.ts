export type Vec3 = [number, number, number];

export interface SplatTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface SplatAssetConfig {
  id: string;
  src: string;
  transform: SplatTransform;
  visibleDefault: boolean;
}

export interface CameraHomeConfig {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface CameraLimitsConfig {
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
}

export interface UiConfig {
  enableFullscreen: boolean;
  enableAutorotate: boolean;
  enableReset: boolean;
  enablePan: boolean;
  autorotateDefaultOn: boolean;
}

export interface TransitionConfig {
  sceneFadeMs: number;
  fadeColour?: string;
}

export type RevealMode = 'yRamp' | 'particleIntro' | 'bottomSphere';
export type RevealEase = 'easeInOut' | 'linear';
export type ParticleBlendMode = 'additive' | 'normal';

export interface ParticleIntroConfig {
  durationMs: number;
  particleCount: number;
  spread: number;
  size: number;
  color: string;
  blend: ParticleBlendMode;
}

export interface BottomSphereRevealConfig {
  durationMs: number;
  feather: number;
  originAnchor: 'bottom' | 'top';
  originYOffset: number;
  originHeightScale: number;
  maxRadiusScale: number;
}

export interface BottomClipConfig {
  enabled: boolean;
  offset: number;
}

export interface RevealConfig {
  enabled: boolean;
  mode: RevealMode;
  durationMs: number;
  band: number;
  ease: RevealEase;
  affectAlpha: boolean;
  affectSize: boolean;
  startPadding: number;
  endPadding: number;
  particleIntro: ParticleIntroConfig;
  bottomSphere: BottomSphereRevealConfig;
  bottomClip: BottomClipConfig;
}

export interface InteriorViewConfig {
  enabled: boolean;
  target: Vec3;
  radius: number;
  softness: number;
  fadeAlpha: number;
  maxDistance: number;
  affectSize: boolean;
}

export interface AnnotationCameraConfig {
  position: Vec3;
  target: Vec3;
  fov: number;
  transitionMs: number;
  lockControls: boolean;
  orbitLimits?: CameraLimitsConfig;
}

export interface AnnotationPinConfig {
  id: string;
  assetId?: string;
  order: number;
  pos: Vec3;
  title: string;
  body: string;
  camera: AnnotationCameraConfig;
}

export type AnnotationOcclusionMode = 'depth';

export interface AnnotationOcclusionConfig {
  enabled: boolean;
  mode: AnnotationOcclusionMode;
  fadeAlpha: number;
  disableClickWhenOccluded: boolean;
  epsilon: number;
}

export interface AnnotationUiConfig {
  showTooltip: boolean;
  showNav: boolean;
  pinStyle: 'numbered';
  occlusion: AnnotationOcclusionConfig;
}

export interface AnnotationsConfig {
  enabled: boolean;
  defaultSelectedId: string | null;
  pins: AnnotationPinConfig[];
  ui: AnnotationUiConfig;
}

export interface PresentationConfig {
  mode: 'standard' | 'embedHero';
  introAutoRotateDelayMs: number;
  idleRotateSpeed: number;
  introSpinDegrees: number;
}

export interface CinematicRevealConfig {
  enabled: boolean;
  originMode: 'topCenter' | 'modelCenter' | 'customOffset';
  staticPointCloud: boolean;
  particleLeadMs: number;
  splatDelayMs: number;
  sphereExpandMs: number;
  overlapMs: number;
  pointCloudFadeOutMs: number;
  zoomOutFactor: number;
  zoomStartYOffset: number;
  ease: RevealEase;
}

export interface SceneConfig {
  id: string;
  title: string;
  assets: SplatAssetConfig[];
  camera: {
    home: CameraHomeConfig;
    limits: CameraLimitsConfig;
    transitionMs: number;
  };
  ui: UiConfig;
  transitions: TransitionConfig;
  reveal: RevealConfig;
  presentation: PresentationConfig;
  cinematicReveal: CinematicRevealConfig;
  interiorView: InteriorViewConfig;
  annotations: AnnotationsConfig;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(isNumber);
}

function readString(obj: Record<string, unknown>, key: string, errors: string[]): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`"${key}" must be a non-empty string.`);
    return '';
  }
  return value;
}

function readNullableString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
): string | null {
  const value = obj[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    errors.push(`"${key}" must be a string or null.`);
    return null;
  }
  return value;
}

function readBoolean(obj: Record<string, unknown>, key: string, errors: string[]): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    errors.push(`"${key}" must be a boolean.`);
    return false;
  }
  return value;
}

function readNumber(obj: Record<string, unknown>, key: string, errors: string[]): number {
  const value = obj[key];
  if (!isNumber(value)) {
    errors.push(`"${key}" must be a number.`);
    return 0;
  }
  return value;
}

function readVec3(obj: Record<string, unknown>, key: string, errors: string[]): Vec3 {
  const value = obj[key];
  if (!isVec3(value)) {
    errors.push(`"${key}" must be a numeric 3-tuple.`);
    return [0, 0, 0];
  }
  return value;
}

export function validateSceneConfig(raw: unknown): { ok: true; data: SceneConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ['Scene config must be a JSON object.'] };
  }

  const id = readString(raw, 'id', errors);
  const title = readString(raw, 'title', errors);

  const assetsValue = raw.assets;
  const assets: SplatAssetConfig[] = [];
  if (!Array.isArray(assetsValue)) {
    errors.push('"assets" must be an array.');
  } else {
    if (assetsValue.length > 5) {
      errors.push('MVP limit exceeded: "assets" supports up to 5 splats.');
    }
    for (let index = 0; index < assetsValue.length; index += 1) {
      const item = assetsValue[index];
      if (!isObject(item)) {
        errors.push(`assets[${index}] must be an object.`);
        continue;
      }

      const transformValue = item.transform;
      if (!isObject(transformValue)) {
        errors.push(`assets[${index}].transform must be an object.`);
        continue;
      }

      assets.push({
        id: readString(item, 'id', errors),
        src: readString(item, 'src', errors),
        transform: {
          position: readVec3(transformValue, 'position', errors),
          rotation: readVec3(transformValue, 'rotation', errors),
          scale: readVec3(transformValue, 'scale', errors),
        },
        visibleDefault: readBoolean(item, 'visibleDefault', errors),
      });
    }
  }

  const cameraValue = raw.camera;
  if (!isObject(cameraValue)) {
    errors.push('"camera" must be an object.');
  }

  const cameraObject = isObject(cameraValue) ? cameraValue : {};
  const cameraHomeValue = isObject(cameraObject.home) ? cameraObject.home : null;
  const cameraLimitsValue = isObject(cameraObject.limits) ? cameraObject.limits : null;
  if (!isObject(cameraHomeValue)) {
    errors.push('"camera.home" must be an object.');
  }
  if (!isObject(cameraLimitsValue)) {
    errors.push('"camera.limits" must be an object.');
  }

  const uiValue = raw.ui;
  if (!isObject(uiValue)) {
    errors.push('"ui" must be an object.');
  }
  const uiObject = isObject(uiValue) ? uiValue : {};

  const transitionsValue = raw.transitions;
  if (!isObject(transitionsValue)) {
    errors.push('"transitions" must be an object.');
  }
  const revealValue = raw.reveal;
  if (revealValue !== undefined && !isObject(revealValue)) {
    errors.push('"reveal" must be an object when provided.');
  }
  const presentationValue = raw.presentation;
  if (presentationValue !== undefined && !isObject(presentationValue)) {
    errors.push('"presentation" must be an object when provided.');
  }
  const cinematicRevealValue = raw.cinematicReveal;
  if (cinematicRevealValue !== undefined && !isObject(cinematicRevealValue)) {
    errors.push('"cinematicReveal" must be an object when provided.');
  }
  const interiorValue = raw.interiorView;
  if (interiorValue !== undefined && !isObject(interiorValue)) {
    errors.push('"interiorView" must be an object when provided.');
  }
  const annotationsValue = raw.annotations;
  if (annotationsValue !== undefined && !isObject(annotationsValue)) {
    errors.push('"annotations" must be an object when provided.');
  }
  const transitionsObject = isObject(transitionsValue) ? transitionsValue : {};
  const revealObject = isObject(revealValue) ? revealValue : {};
  const presentationObject = isObject(presentationValue) ? presentationValue : {};
  const cinematicRevealObject = isObject(cinematicRevealValue) ? cinematicRevealValue : {};
  const particleIntroValue = revealObject.particleIntro;
  if (particleIntroValue !== undefined && !isObject(particleIntroValue)) {
    errors.push('"reveal.particleIntro" must be an object when provided.');
  }
  const bottomSphereValue = revealObject.bottomSphere;
  if (bottomSphereValue !== undefined && !isObject(bottomSphereValue)) {
    errors.push('"reveal.bottomSphere" must be an object when provided.');
  }
  const bottomClipValue = revealObject.bottomClip;
  if (bottomClipValue !== undefined && !isObject(bottomClipValue)) {
    errors.push('"reveal.bottomClip" must be an object when provided.');
  }
  const particleIntroObject = isObject(particleIntroValue) ? particleIntroValue : {};
  const bottomSphereObject = isObject(bottomSphereValue) ? bottomSphereValue : {};
  const bottomClipObject = isObject(bottomClipValue) ? bottomClipValue : {};
  const interiorObject = isObject(interiorValue) ? interiorValue : {};
  const annotationsObject = isObject(annotationsValue) ? annotationsValue : {};
  if (annotationsObject.ui !== undefined && !isObject(annotationsObject.ui)) {
    errors.push('"annotations.ui" must be an object when provided.');
  }
  if (isObject(annotationsObject.ui) && annotationsObject.ui.occlusion !== undefined && !isObject(annotationsObject.ui.occlusion)) {
    errors.push('"annotations.ui.occlusion" must be an object when provided.');
  }
  const annotationsUiObject = isObject(annotationsObject.ui) ? annotationsObject.ui : {};
  const annotationsOcclusionObject = isObject(annotationsUiObject.occlusion)
    ? annotationsUiObject.occlusion
    : {};
  const cameraHomeObject = isObject(cameraHomeValue) ? cameraHomeValue : {};
  const cameraLimitsObject = isObject(cameraLimitsValue) ? cameraLimitsValue : {};

  const pins: AnnotationPinConfig[] = [];
  const providedOrders = new Set<number>();
  const providedIds = new Set<string>();
  const pinsValue = annotationsObject.pins;
  if (pinsValue !== undefined && !Array.isArray(pinsValue)) {
    errors.push('"annotations.pins" must be an array when provided.');
  } else if (Array.isArray(pinsValue)) {
    for (let index = 0; index < pinsValue.length; index += 1) {
      const pinValue = pinsValue[index];
      if (!isObject(pinValue)) {
        errors.push(`annotations.pins[${index}] must be an object.`);
        continue;
      }
      const cameraValue = pinValue.camera;
      if (!isObject(cameraValue)) {
        errors.push(`annotations.pins[${index}].camera must be an object.`);
        continue;
      }
      const orbitLimitsValue = cameraValue.orbitLimits;
      if (orbitLimitsValue !== undefined && !isObject(orbitLimitsValue)) {
        errors.push(`annotations.pins[${index}].camera.orbitLimits must be an object when provided.`);
      }

      const orderRaw = pinValue.order;
      const order = isNumber(orderRaw) ? orderRaw : index + 1;
      if (providedOrders.has(order)) {
        errors.push(`annotations.pins[${index}].order must be unique.`);
      } else {
        providedOrders.add(order);
      }

      const pinId = readString(pinValue, 'id', errors);
      if (pinId && providedIds.has(pinId)) {
        errors.push(`annotations.pins[${index}].id must be unique.`);
      } else if (pinId) {
        providedIds.add(pinId);
      }

      let orbitLimits: CameraLimitsConfig | undefined;
      if (isObject(orbitLimitsValue)) {
        orbitLimits = {
          minDistance: readNumber(orbitLimitsValue, 'minDistance', errors),
          maxDistance: readNumber(orbitLimitsValue, 'maxDistance', errors),
          minPolarAngle: readNumber(orbitLimitsValue, 'minPolarAngle', errors),
          maxPolarAngle: readNumber(orbitLimitsValue, 'maxPolarAngle', errors),
        };
      }

      pins.push({
        id: pinId,
        assetId:
          typeof pinValue.assetId === 'string' && pinValue.assetId.trim().length > 0
            ? pinValue.assetId
            : undefined,
        order,
        pos: readVec3(pinValue, 'pos', errors),
        title: readString(pinValue, 'title', errors),
        body: readString(pinValue, 'body', errors),
        camera: {
          position: readVec3(cameraValue, 'position', errors),
          target: readVec3(cameraValue, 'target', errors),
          fov: readNumber(cameraValue, 'fov', errors),
          transitionMs: readNumber(cameraValue, 'transitionMs', errors),
          lockControls: readBoolean(cameraValue, 'lockControls', errors),
          orbitLimits,
        },
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const config: SceneConfig = {
    id,
    title,
    assets,
    camera: {
      home: {
        position: readVec3(cameraHomeObject, 'position', errors),
        target: readVec3(cameraHomeObject, 'target', errors),
        fov: readNumber(cameraHomeObject, 'fov', errors),
      },
      limits: {
        minDistance: readNumber(cameraLimitsObject, 'minDistance', errors),
        maxDistance: readNumber(cameraLimitsObject, 'maxDistance', errors),
        minPolarAngle: readNumber(cameraLimitsObject, 'minPolarAngle', errors),
        maxPolarAngle: readNumber(cameraLimitsObject, 'maxPolarAngle', errors),
      },
      transitionMs: readNumber(cameraObject, 'transitionMs', errors),
    },
    ui: {
      enableFullscreen: readBoolean(uiObject, 'enableFullscreen', errors),
      enableAutorotate: readBoolean(uiObject, 'enableAutorotate', errors),
      enableReset: readBoolean(uiObject, 'enableReset', errors),
      enablePan: readBoolean(uiObject, 'enablePan', errors),
      autorotateDefaultOn: readBoolean(uiObject, 'autorotateDefaultOn', errors),
    },
    transitions: {
      sceneFadeMs: readNumber(transitionsObject, 'sceneFadeMs', errors),
      fadeColour:
        typeof transitionsObject.fadeColour === 'string' ? transitionsObject.fadeColour : undefined,
    },
    reveal: {
      enabled: typeof revealObject.enabled === 'boolean' ? revealObject.enabled : true,
      mode:
        revealObject.mode === 'yRamp' ||
        revealObject.mode === 'particleIntro' ||
        revealObject.mode === 'bottomSphere'
          ? revealObject.mode
          : 'yRamp',
      durationMs: isNumber(revealObject.durationMs) ? revealObject.durationMs : 2800,
      band: isNumber(revealObject.band) ? revealObject.band : 0.12,
      ease:
        revealObject.ease === 'linear' || revealObject.ease === 'easeInOut'
          ? revealObject.ease
          : 'easeInOut',
      affectAlpha: typeof revealObject.affectAlpha === 'boolean' ? revealObject.affectAlpha : true,
      affectSize: typeof revealObject.affectSize === 'boolean' ? revealObject.affectSize : true,
      startPadding: isNumber(revealObject.startPadding) ? revealObject.startPadding : 0,
      endPadding: isNumber(revealObject.endPadding) ? revealObject.endPadding : 0,
      particleIntro: {
        durationMs: isNumber(particleIntroObject.durationMs) ? particleIntroObject.durationMs : 1400,
        particleCount: isNumber(particleIntroObject.particleCount) ? particleIntroObject.particleCount : 9000,
        spread: isNumber(particleIntroObject.spread) ? particleIntroObject.spread : 0.45,
        size: isNumber(particleIntroObject.size) ? particleIntroObject.size : 0.018,
        color: typeof particleIntroObject.color === 'string' ? particleIntroObject.color : '#ffdda8',
        blend:
          particleIntroObject.blend === 'additive' || particleIntroObject.blend === 'normal'
            ? particleIntroObject.blend
            : 'additive',
      },
      bottomSphere: {
        durationMs: isNumber(bottomSphereObject.durationMs) ? bottomSphereObject.durationMs : 1900,
        feather: isNumber(bottomSphereObject.feather) ? bottomSphereObject.feather : 0.18,
        originAnchor:
          bottomSphereObject.originAnchor === 'top' || bottomSphereObject.originAnchor === 'bottom'
            ? bottomSphereObject.originAnchor
            : 'bottom',
        originYOffset: isNumber(bottomSphereObject.originYOffset) ? bottomSphereObject.originYOffset : 0,
        originHeightScale: isNumber(bottomSphereObject.originHeightScale)
          ? bottomSphereObject.originHeightScale
          : 0,
        maxRadiusScale: isNumber(bottomSphereObject.maxRadiusScale) ? bottomSphereObject.maxRadiusScale : 1.08,
      },
      bottomClip: {
        enabled: typeof bottomClipObject.enabled === 'boolean' ? bottomClipObject.enabled : false,
        offset: isNumber(bottomClipObject.offset) ? bottomClipObject.offset : 0,
      },
    },
    presentation: {
      mode: presentationObject.mode === 'embedHero' ? 'embedHero' : 'standard',
      introAutoRotateDelayMs: isNumber(presentationObject.introAutoRotateDelayMs)
        ? presentationObject.introAutoRotateDelayMs
        : 400,
      idleRotateSpeed: isNumber(presentationObject.idleRotateSpeed)
        ? presentationObject.idleRotateSpeed
        : 0.32,
      introSpinDegrees: isNumber(presentationObject.introSpinDegrees)
        ? presentationObject.introSpinDegrees
        : 0,
    },
    cinematicReveal: {
      enabled:
        typeof cinematicRevealObject.enabled === 'boolean' ? cinematicRevealObject.enabled : false,
      originMode:
        cinematicRevealObject.originMode === 'topCenter' ||
        cinematicRevealObject.originMode === 'modelCenter' ||
        cinematicRevealObject.originMode === 'customOffset'
          ? cinematicRevealObject.originMode
          : 'modelCenter',
      staticPointCloud:
        typeof cinematicRevealObject.staticPointCloud === 'boolean'
          ? cinematicRevealObject.staticPointCloud
          : false,
      particleLeadMs: isNumber(cinematicRevealObject.particleLeadMs)
        ? cinematicRevealObject.particleLeadMs
        : 2200,
      splatDelayMs: isNumber(cinematicRevealObject.splatDelayMs)
        ? cinematicRevealObject.splatDelayMs
        : 900,
      sphereExpandMs: isNumber(cinematicRevealObject.sphereExpandMs)
        ? cinematicRevealObject.sphereExpandMs
        : 1800,
      overlapMs: isNumber(cinematicRevealObject.overlapMs)
        ? cinematicRevealObject.overlapMs
        : 900,
      pointCloudFadeOutMs: isNumber(cinematicRevealObject.pointCloudFadeOutMs)
        ? cinematicRevealObject.pointCloudFadeOutMs
        : 1100,
      zoomOutFactor: isNumber(cinematicRevealObject.zoomOutFactor)
        ? cinematicRevealObject.zoomOutFactor
        : 1,
      zoomStartYOffset: isNumber(cinematicRevealObject.zoomStartYOffset)
        ? cinematicRevealObject.zoomStartYOffset
        : 0,
      ease:
        cinematicRevealObject.ease === 'linear' || cinematicRevealObject.ease === 'easeInOut'
          ? cinematicRevealObject.ease
          : 'easeInOut',
    },
    interiorView: {
      enabled: typeof interiorObject.enabled === 'boolean' ? interiorObject.enabled : false,
      target: isVec3(interiorObject.target) ? interiorObject.target : [0, 0, 0],
      radius: isNumber(interiorObject.radius) ? interiorObject.radius : 0.45,
      softness: isNumber(interiorObject.softness) ? interiorObject.softness : 0.2,
      fadeAlpha: isNumber(interiorObject.fadeAlpha) ? interiorObject.fadeAlpha : 0.15,
      maxDistance: isNumber(interiorObject.maxDistance) ? interiorObject.maxDistance : 20,
      affectSize: typeof interiorObject.affectSize === 'boolean' ? interiorObject.affectSize : false,
    },
    annotations: {
      enabled: typeof annotationsObject.enabled === 'boolean' ? annotationsObject.enabled : false,
      defaultSelectedId: readNullableString(annotationsObject, 'defaultSelectedId', errors),
      pins,
      ui: {
        showTooltip: typeof annotationsUiObject.showTooltip === 'boolean' ? annotationsUiObject.showTooltip : true,
        showNav: typeof annotationsUiObject.showNav === 'boolean' ? annotationsUiObject.showNav : true,
        pinStyle: annotationsUiObject.pinStyle === 'numbered' ? 'numbered' : 'numbered',
        occlusion: {
          enabled:
            typeof annotationsOcclusionObject.enabled === 'boolean'
              ? annotationsOcclusionObject.enabled
              : true,
          mode: annotationsOcclusionObject.mode === 'depth' ? 'depth' : 'depth',
          fadeAlpha: isNumber(annotationsOcclusionObject.fadeAlpha) ? annotationsOcclusionObject.fadeAlpha : 0.18,
          disableClickWhenOccluded:
            typeof annotationsOcclusionObject.disableClickWhenOccluded === 'boolean'
              ? annotationsOcclusionObject.disableClickWhenOccluded
              : true,
          epsilon: isNumber(annotationsOcclusionObject.epsilon) ? annotationsOcclusionObject.epsilon : 0.01,
        },
      },
    },
  };

  if (config.camera.limits.maxDistance < config.camera.limits.minDistance) {
    errors.push('"camera.limits.maxDistance" must be >= "camera.limits.minDistance".');
  }

  if (config.camera.limits.maxPolarAngle < config.camera.limits.minPolarAngle) {
    errors.push('"camera.limits.maxPolarAngle" must be >= "camera.limits.minPolarAngle".');
  }

  if (config.reveal.durationMs <= 0) {
    errors.push('"reveal.durationMs" must be > 0.');
  }
  if (config.reveal.band <= 0) {
    errors.push('"reveal.band" must be > 0.');
  }
  if (config.reveal.particleIntro.durationMs <= 0) {
    errors.push('"reveal.particleIntro.durationMs" must be > 0.');
  }
  if (config.reveal.particleIntro.particleCount <= 0) {
    errors.push('"reveal.particleIntro.particleCount" must be > 0.');
  }
  if (config.reveal.particleIntro.spread < 0) {
    errors.push('"reveal.particleIntro.spread" must be >= 0.');
  }
  if (config.reveal.particleIntro.size <= 0) {
    errors.push('"reveal.particleIntro.size" must be > 0.');
  }
  if (config.reveal.bottomSphere.durationMs <= 0) {
    errors.push('"reveal.bottomSphere.durationMs" must be > 0.');
  }
  if (config.reveal.bottomSphere.feather <= 0) {
    errors.push('"reveal.bottomSphere.feather" must be > 0.');
  }
  if (config.reveal.bottomSphere.maxRadiusScale <= 0) {
    errors.push('"reveal.bottomSphere.maxRadiusScale" must be > 0.');
  }
  if (config.reveal.bottomSphere.originHeightScale < 0) {
    errors.push('"reveal.bottomSphere.originHeightScale" must be >= 0.');
  }

  if (config.presentation.introAutoRotateDelayMs < 0) {
    errors.push('"presentation.introAutoRotateDelayMs" must be >= 0.');
  }
  if (config.presentation.idleRotateSpeed <= 0) {
    errors.push('"presentation.idleRotateSpeed" must be > 0.');
  }
  if (config.cinematicReveal.particleLeadMs <= 0) {
    errors.push('"cinematicReveal.particleLeadMs" must be > 0.');
  }
  if (config.cinematicReveal.splatDelayMs < 0) {
    errors.push('"cinematicReveal.splatDelayMs" must be >= 0.');
  }
  if (config.cinematicReveal.sphereExpandMs <= 0) {
    errors.push('"cinematicReveal.sphereExpandMs" must be > 0.');
  }
  if (config.cinematicReveal.overlapMs < 0) {
    errors.push('"cinematicReveal.overlapMs" must be >= 0.');
  }
  if (config.cinematicReveal.pointCloudFadeOutMs <= 0) {
    errors.push('"cinematicReveal.pointCloudFadeOutMs" must be > 0.');
  }
  if (config.cinematicReveal.zoomOutFactor < 1) {
    errors.push('"cinematicReveal.zoomOutFactor" must be >= 1.');
  }
  if (config.interiorView.radius <= 0) {
    errors.push('"interiorView.radius" must be > 0.');
  }
  if (config.interiorView.maxDistance <= 0) {
    errors.push('"interiorView.maxDistance" must be > 0.');
  }

  for (const pin of config.annotations.pins) {
    if (pin.assetId && !config.assets.some((asset) => asset.id === pin.assetId)) {
      errors.push(`annotations pin "${pin.id}" assetId "${pin.assetId}" must match an existing asset id.`);
    }
    if (pin.camera.transitionMs <= 0) {
      errors.push(`annotations pin "${pin.id}" camera.transitionMs must be > 0.`);
    }
    if (pin.camera.fov <= 0) {
      errors.push(`annotations pin "${pin.id}" camera.fov must be > 0.`);
    }
    if (pin.camera.orbitLimits) {
      if (pin.camera.orbitLimits.maxDistance < pin.camera.orbitLimits.minDistance) {
        errors.push(`annotations pin "${pin.id}" camera.orbitLimits.maxDistance must be >= minDistance.`);
      }
      if (pin.camera.orbitLimits.maxPolarAngle < pin.camera.orbitLimits.minPolarAngle) {
        errors.push(`annotations pin "${pin.id}" camera.orbitLimits.maxPolarAngle must be >= minPolarAngle.`);
      }
    }
  }
  if (
    config.annotations.defaultSelectedId &&
    !config.annotations.pins.some((pin) => pin.id === config.annotations.defaultSelectedId)
  ) {
    errors.push('"annotations.defaultSelectedId" must match an existing pin id.');
  }
  if (config.annotations.ui.occlusion.epsilon < 0) {
    errors.push('"annotations.ui.occlusion.epsilon" must be >= 0.');
  }

  config.interiorView.softness = Math.min(0.6, Math.max(0.05, config.interiorView.softness));
  config.interiorView.fadeAlpha = Math.min(1, Math.max(0, config.interiorView.fadeAlpha));
  config.annotations.ui.occlusion.fadeAlpha = Math.min(1, Math.max(0, config.annotations.ui.occlusion.fadeAlpha));
  config.annotations.pins.sort((a, b) => a.order - b.order);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, data: config };
}
