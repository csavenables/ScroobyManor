import * as THREE from 'three';
import { InteriorViewConfig, RevealConfig, SplatAssetConfig } from '../config/schema';

export interface SplatFitData {
  center: THREE.Vector3;
  size: THREE.Vector3;
  radius: number;
}

export interface SplatRevealBounds {
  minY: number;
  maxY: number;
}

export interface SplatRevealParams {
  enabled: boolean;
  mode: 'yRamp' | 'bottomSphere';
  revealY: number;
  band: number;
  sphereOrigin: THREE.Vector3;
  sphereRadius: number;
  sphereFeather: number;
  clipBottomEnabled: boolean;
  clipBottomY: number;
  affectAlpha: boolean;
  affectSize: boolean;
}

export interface SplatHandle {
  id: string;
  object3D: THREE.Object3D;
  boundsY: SplatRevealBounds;
  sampledBounds?: {
    min: THREE.Vector3;
    max: THREE.Vector3;
  };
  setRevealParams(params: SplatRevealParams): void;
  setRevealBounds(bounds: SplatRevealBounds): void;
  dispose(): void;
}

export const REVEAL_CONFIG_DEFAULTS: RevealConfig = {
  enabled: true,
  mode: 'yRamp',
  durationMs: 2800,
  band: 0.12,
  ease: 'easeInOut',
  affectAlpha: true,
  affectSize: true,
  startPadding: 0,
  endPadding: 0,
  particleIntro: {
    durationMs: 1400,
    particleCount: 9000,
    spread: 0.45,
    size: 0.018,
    color: '#ffdda8',
    blend: 'additive',
  },
  bottomSphere: {
    durationMs: 1900,
    feather: 0.18,
    originAnchor: 'bottom',
    originYOffset: 0,
    originHeightScale: 0,
    maxRadiusScale: 1.08,
  },
  bottomClip: {
    enabled: false,
    offset: 0,
  },
};

export interface SplatSampleOptions {
  maxSamples: number;
  randomize?: boolean;
  space?: 'world' | 'local';
  includeColors?: boolean;
}

export interface SplatSampleCloud {
  points: THREE.Vector3[];
  colors?: Float32Array;
}

export interface RendererContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  rootElement: HTMLElement;
}

export interface SplatRenderer {
  initialize(context: RendererContext): Promise<void>;
  loadSplats(assets: SplatAssetConfig[]): Promise<SplatHandle[]>;
  loadSplat(asset: SplatAssetConfig): Promise<SplatHandle>;
  setVisible(id: string, visible: boolean): void;
  getSplatSampleCloud(id: string, options: SplatSampleOptions): SplatSampleCloud;
  getSplatSamplePoints(id: string, options: SplatSampleOptions): THREE.Vector3[];
  setInteriorView(config: InteriorViewConfig): void;
  setInteriorCameraPosition(position: THREE.Vector3): void;
  clear(): Promise<void>;
  getFitData(): SplatFitData | null;
  update(): void;
  render(): void;
  dispose(): Promise<void>;
}
