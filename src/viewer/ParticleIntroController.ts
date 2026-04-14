import * as THREE from 'three';
import { ParticleIntroConfig } from '../config/schema';
import { SplatRevealBounds } from '../renderers/types';
import { easeInOutCubic } from '../utils/easing';

type IntroEase = 'linear' | 'easeInOut';
type IntroOriginMode = 'topCenter' | 'modelCenter' | 'customOffset';

function hexToColor(value: string): THREE.Color {
  const color = new THREE.Color();
  try {
    color.set(value);
    return color;
  } catch {
    color.set('#ffdda8');
    return color;
  }
}

export class ParticleIntroController {
  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.PointsMaterial | null = null;
  private rafId = 0;

  constructor(private readonly scene: THREE.Scene) {}

  async play(
    sourcePoints: THREE.Vector3[],
    bounds: SplatRevealBounds,
    config: ParticleIntroConfig,
    reducedMotion: boolean,
    options: {
      anchor?: THREE.Object3D | null;
      sourceColors?: Float32Array | null;
      originMode?: IntroOriginMode;
      ease?: IntroEase;
      lockToSource?: boolean;
    } = {},
  ): Promise<void> {
    this.disposeCurrent();
    if (reducedMotion || sourcePoints.length === 0) {
      return;
    }

    const count = Math.min(config.particleCount, sourcePoints.length);
    if (count <= 0) {
      return;
    }

    let sourceOrder: number[] | null = null;
    if (options.lockToSource) {
      sourceOrder = Array.from({ length: sourcePoints.length }, (_, index) => index);
      const worldY = new Float32Array(sourcePoints.length);
      const anchor = options.anchor ?? null;
      if (anchor) {
        anchor.updateWorldMatrix(true, false);
        const e = anchor.matrixWorld.elements;
        for (let i = 0; i < sourcePoints.length; i += 1) {
          const p = sourcePoints[i];
          worldY[i] = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
        }
      } else {
        for (let i = 0; i < sourcePoints.length; i += 1) {
          worldY[i] = sourcePoints[i].y;
        }
      }
      sourceOrder.sort((a, b) => worldY[b] - worldY[a]);
    }
    const from = new Float32Array(count * 3);
    const to = new Float32Array(count * 3);
    const current = new Float32Array(count * 3);
    const boundsHeight = Math.max(0.001, bounds.maxY - bounds.minY);
    const spreadRadius = Math.max(0.01, boundsHeight * config.spread);
    const sourceBounds = new THREE.Box3().setFromPoints(sourcePoints);
    const center = sourceBounds.getCenter(new THREE.Vector3());
    const topCenter = new THREE.Vector3(center.x, sourceBounds.max.y + spreadRadius * 0.2, center.z);
    const color = hexToColor(config.color);
    const sourceColors = options.sourceColors ?? null;
    const hasPerPointColors = Boolean(sourceColors && sourceColors.length >= sourcePoints.length * 3);
    const originMode: IntroOriginMode = options.originMode ?? 'modelCenter';
    const ease: IntroEase = options.ease ?? 'easeInOut';
    const lockToSource = options.lockToSource ?? false;

    for (let i = 0; i < count; i += 1) {
      const srcIndex = sourceOrder ? sourceOrder[i] : i;
      const source = sourcePoints[srcIndex];
      const azimuth = Math.random() * Math.PI * 2;
      const radial = spreadRadius * (0.15 + Math.random() * 0.5);
      const jitter = new THREE.Vector3(
        Math.cos(azimuth) * radial,
        -Math.random() * spreadRadius * 0.2,
        Math.sin(azimuth) * radial,
      );
      let spawn = source.clone();
      if (!lockToSource) {
        if (originMode === 'topCenter') {
          spawn = topCenter.clone().add(jitter);
        } else if (originMode === 'modelCenter') {
          spawn = center.clone().add(jitter);
        } else {
          spawn = source.clone().add(jitter);
        }
      }

      const base = i * 3;
      from[base] = spawn.x;
      from[base + 1] = spawn.y;
      from[base + 2] = spawn.z;
      to[base] = source.x;
      to[base + 1] = source.y;
      to[base + 2] = source.z;
      current[base] = from[base];
      current[base + 1] = from[base + 1];
      current[base + 2] = from[base + 2];
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(current, 3));
    if (hasPerPointColors && sourceColors) {
      const pointColors = new Float32Array(count * 3);
      if (sourceOrder) {
        for (let i = 0; i < count; i += 1) {
          const srcIndex = sourceOrder[i];
          const srcBase = srcIndex * 3;
          const dstBase = i * 3;
          pointColors[dstBase] = sourceColors[srcBase];
          pointColors[dstBase + 1] = sourceColors[srcBase + 1];
          pointColors[dstBase + 2] = sourceColors[srcBase + 2];
        }
      } else {
        pointColors.set(sourceColors.subarray(0, count * 3));
      }
      this.geometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3));
    }
    this.material = new THREE.PointsMaterial({
      color,
      vertexColors: hasPerPointColors,
      size: Math.max(0.001, config.size),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: config.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.renderOrder = -1;
    const anchor = options.anchor ?? null;
    if (anchor) {
      anchor.add(this.points);
    } else {
      this.scene.add(this.points);
    }
    if (options.lockToSource) {
      this.geometry.setDrawRange(0, 0);
    }

    const start = performance.now();
    const duration = Math.max(120, config.durationMs);
    const targetOpacity = 0.98;
    await new Promise<void>((resolve) => {
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / duration);
        const eased = ease === 'linear' ? t : easeInOutCubic(t);
        if (!options.lockToSource) {
          const outAttr = this.geometry?.getAttribute('position');
          if (outAttr instanceof THREE.BufferAttribute) {
            for (let i = 0; i < count; i += 1) {
              const base = i * 3;
              outAttr.array[base] = from[base] + (to[base] - from[base]) * eased;
              outAttr.array[base + 1] = from[base + 1] + (to[base + 1] - from[base + 1]) * eased;
              outAttr.array[base + 2] = from[base + 2] + (to[base + 2] - from[base + 2]) * eased;
            }
            outAttr.needsUpdate = true;
          }
        } else if (this.geometry) {
          const visibleCount = Math.max(1, Math.min(count, Math.floor(count * eased)));
          this.geometry.setDrawRange(0, visibleCount);
        }
        if (this.material) {
          this.material.opacity = targetOpacity * eased;
        }

        if (t >= 1) {
          resolve();
          return;
        }
        this.rafId = requestAnimationFrame(step);
      };
      this.rafId = requestAnimationFrame(step);
    });
    if (this.geometry && options.lockToSource) {
      this.geometry.setDrawRange(0, count);
    }
  }

  async cover(durationMs: number): Promise<void> {
    if (!this.material || !this.points) {
      return;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    const start = performance.now();
    const duration = Math.max(140, durationMs);
    const holdPhase = 0.25;
    const startOpacity = this.material.opacity;
    await new Promise<void>((resolve) => {
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / duration);
        const fadeT = t <= holdPhase ? 0 : (t - holdPhase) / (1 - holdPhase);
        const eased = easeInOutCubic(fadeT);
        if (this.material) {
          this.material.opacity = startOpacity * (1 - eased);
        }
        if (t >= 1) {
          resolve();
          return;
        }
        this.rafId = requestAnimationFrame(step);
      };
      this.rafId = requestAnimationFrame(step);
    });
    this.disposeCurrent();
  }

  dispose(): void {
    this.disposeCurrent();
  }

  private disposeCurrent(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.points) {
      this.points.parent?.remove(this.points);
      this.points = null;
    }
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
