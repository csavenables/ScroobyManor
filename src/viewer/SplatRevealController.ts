import { RevealConfig } from '../config/schema';
import { SplatHandle, SplatRevealBounds } from '../renderers/types';
import { easeInOutCubic } from '../utils/easing';
import * as THREE from 'three';

function applyEase(t: number, ease: RevealConfig['ease']): number {
  if (ease === 'linear') {
    return t;
  }
  return easeInOutCubic(t);
}

export class SplatRevealController {
  private readonly baseScaleByHandle = new WeakMap<SplatHandle, THREE.Vector3>();

  primeRevealInStart(handle: SplatHandle, config: RevealConfig): void {
    if (!config.enabled) {
      this.applyRevealScale(handle, 1, false);
      return;
    }
    this.applyRevealScale(handle, 0, config.affectSize);
  }

  async revealIn(
    handle: SplatHandle,
    boundsY: SplatRevealBounds,
    config: RevealConfig,
  ): Promise<void> {
    if (!config.enabled) {
      this.applyRevealScale(handle, 1, false);
      handle.setRevealParams({
        enabled: false,
        mode: config.mode === 'bottomSphere' ? 'bottomSphere' : 'yRamp',
        revealY: boundsY.maxY,
        band: config.band,
        sphereOrigin: this.computeBottomSphereOrigin(handle, config),
        sphereRadius: this.computeBottomSphereMaxRadius(handle, config),
        sphereFeather: config.bottomSphere.feather,
        clipBottomEnabled: config.bottomClip.enabled,
        clipBottomY: handle.boundsY.minY + config.bottomClip.offset,
        affectAlpha: config.affectAlpha,
        affectSize: config.affectSize,
      });
      return;
    }

    if (config.mode === 'bottomSphere') {
      await this.animateSphere(handle, config, 1);
      return;
    }

    const minY = boundsY.minY + config.startPadding;
    const maxY = boundsY.maxY + config.endPadding;
    await this.animateY(handle, minY, maxY, config, 1);
  }

  async revealOut(
    handle: SplatHandle,
    boundsY: SplatRevealBounds,
    config: RevealConfig,
  ): Promise<void> {
    if (!config.enabled) {
      return;
    }

    if (config.mode === 'bottomSphere') {
      await this.animateSphere(handle, config, 0.5, true);
      return;
    }

    const minY = boundsY.minY + config.startPadding;
    const maxY = boundsY.maxY + config.endPadding;
    await this.animateY(handle, maxY, minY, config, 0.5);
  }

  private async animateY(
    handle: SplatHandle,
    fromY: number,
    toY: number,
    config: RevealConfig,
    durationScale: number,
  ): Promise<void> {
    const start = performance.now();
    const duration = Math.max(100, config.durationMs * durationScale);

    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = applyEase(t, config.ease);
        const revealY = fromY + (toY - fromY) * eased;
        this.applyRevealScale(handle, eased, config.affectSize);
        handle.setRevealParams({
          enabled: true,
          mode: 'yRamp',
          revealY,
          band: config.band,
          sphereOrigin: this.computeBottomSphereOrigin(handle, config),
          sphereRadius: 0,
          sphereFeather: config.bottomSphere.feather,
          clipBottomEnabled: config.bottomClip.enabled,
          clipBottomY: handle.boundsY.minY + config.bottomClip.offset,
          affectAlpha: config.affectAlpha,
          affectSize: config.affectSize,
        });

        if (t >= 1) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    this.applyRevealScale(handle, 1, config.affectSize);
  }

  private async animateSphere(
    handle: SplatHandle,
    config: RevealConfig,
    durationScale: number,
    reverse = false,
  ): Promise<void> {
    const start = performance.now();
    const duration = Math.max(100, config.bottomSphere.durationMs * durationScale);
    const origin = this.computeBottomSphereOrigin(handle, config);
    const maxRadius = this.computeBottomSphereMaxRadius(handle, config);
    const coverageRadius = this.computeBottomSphereCoverageRadius(handle, config, origin);
    const minRadius = Math.max(0.0001, config.bottomSphere.feather * 0.02);
    const revealRadius = Math.min(
      maxRadius,
      Math.max(minRadius * 1.2, coverageRadius + Math.max(0.0001, config.bottomSphere.feather) * 1.15),
    );
    const initialProgress = reverse ? 1 : 0;
    const initialRadius = minRadius + (revealRadius - minRadius) * initialProgress;
    this.applyRevealScale(handle, initialProgress, config.affectSize);
    handle.setRevealParams({
      enabled: true,
      mode: 'bottomSphere',
      revealY: handle.boundsY.maxY,
      band: config.band,
      sphereOrigin: origin,
      sphereRadius: initialRadius,
      sphereFeather: config.bottomSphere.feather,
      clipBottomEnabled: config.bottomClip.enabled,
      clipBottomY: handle.boundsY.minY + config.bottomClip.offset,
      affectAlpha: config.affectAlpha,
      affectSize: config.affectSize,
    });

    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = applyEase(t, config.ease);
        const progress = reverse ? 1 - eased : eased;
        this.applyRevealScale(handle, progress, config.affectSize);
        const radius = minRadius + (revealRadius - minRadius) * progress;
        handle.setRevealParams({
          enabled: true,
          mode: 'bottomSphere',
          revealY: handle.boundsY.maxY,
          band: config.band,
          sphereOrigin: origin,
          sphereRadius: radius,
          sphereFeather: config.bottomSphere.feather,
          clipBottomEnabled: config.bottomClip.enabled,
          clipBottomY: handle.boundsY.minY + config.bottomClip.offset,
          affectAlpha: config.affectAlpha,
          affectSize: config.affectSize,
        });

        if (t >= 1) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    if (!reverse) {
      this.applyRevealScale(handle, 1, config.affectSize);
      // Safety release: push radius beyond extents, then disable masking.
      handle.setRevealParams({
        enabled: true,
        mode: 'bottomSphere',
        revealY: handle.boundsY.maxY,
        band: config.band,
        sphereOrigin: origin,
        sphereRadius: maxRadius * 1.2,
        sphereFeather: config.bottomSphere.feather,
        clipBottomEnabled: config.bottomClip.enabled,
        clipBottomY: handle.boundsY.minY + config.bottomClip.offset,
        affectAlpha: config.affectAlpha,
        affectSize: config.affectSize,
      });
      handle.setRevealParams({
        enabled: false,
        mode: 'bottomSphere',
        revealY: handle.boundsY.maxY,
        band: config.band,
        sphereOrigin: origin,
        sphereRadius: maxRadius * 1.2,
        sphereFeather: config.bottomSphere.feather,
        clipBottomEnabled: config.bottomClip.enabled,
        clipBottomY: handle.boundsY.minY + config.bottomClip.offset,
        affectAlpha: config.affectAlpha,
        affectSize: config.affectSize,
      });
    }
  }

  private computeBottomSphereOrigin(handle: SplatHandle, config: RevealConfig): THREE.Vector3 {
    const box = handle.sampledBounds
      ? new THREE.Box3(handle.sampledBounds.min.clone(), handle.sampledBounds.max.clone())
      : new THREE.Box3().setFromObject(handle.object3D);
    if (box.isEmpty()) {
      return new THREE.Vector3(0, config.bottomSphere.originYOffset, 0);
    }
    const sizeY = Math.max(0.001, box.max.y - box.min.y);
    const y =
      config.bottomSphere.originAnchor === 'top'
        ? box.max.y + config.bottomSphere.originYOffset + sizeY * config.bottomSphere.originHeightScale
        : box.min.y + config.bottomSphere.originYOffset;
    return new THREE.Vector3(
      (box.min.x + box.max.x) * 0.5,
      y,
      (box.min.z + box.max.z) * 0.5,
    );
  }

  private computeBottomSphereMaxRadius(handle: SplatHandle, config: RevealConfig): number {
    const box = handle.sampledBounds
      ? new THREE.Box3(handle.sampledBounds.min.clone(), handle.sampledBounds.max.clone())
      : new THREE.Box3().setFromObject(handle.object3D);
    const origin = this.computeBottomSphereOrigin(handle, config);
    if (box.isEmpty()) {
      return 1;
    }

    let maxDistance = 0;
    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];
    for (const corner of corners) {
      maxDistance = Math.max(maxDistance, origin.distanceTo(corner));
    }
    const size = box.getSize(new THREE.Vector3());
    const diagonal = Math.max(0.001, size.length());
    const requiredScale = Math.max(2.2, config.bottomSphere.maxRadiusScale);
    const overscan = diagonal * 0.45;
    return Math.max(0.01, maxDistance * requiredScale + overscan);
  }

  private computeBottomSphereCoverageRadius(
    handle: SplatHandle,
    config: RevealConfig,
    origin: THREE.Vector3,
  ): number {
    const box = handle.sampledBounds
      ? new THREE.Box3(handle.sampledBounds.min.clone(), handle.sampledBounds.max.clone())
      : new THREE.Box3().setFromObject(handle.object3D);
    if (box.isEmpty()) {
      return 1;
    }

    let maxDistance = 0;
    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];
    for (const corner of corners) {
      maxDistance = Math.max(maxDistance, origin.distanceTo(corner));
    }
    return Math.max(0.01, maxDistance * Math.max(1, config.bottomSphere.maxRadiusScale));
  }

  private applyRevealScale(handle: SplatHandle, progress: number, enabled: boolean): void {
    const baseScale = this.getBaseScale(handle);
    if (!enabled) {
      handle.object3D.scale.copy(baseScale);
      return;
    }
    const p = Math.min(1, Math.max(0, progress));
    const factor = 0.86 + p * 0.14;
    handle.object3D.scale.set(baseScale.x * factor, baseScale.y * factor, baseScale.z * factor);
  }

  private getBaseScale(handle: SplatHandle): THREE.Vector3 {
    const cached = this.baseScaleByHandle.get(handle);
    if (cached) {
      return cached;
    }
    const stored = handle.object3D.scale.clone();
    this.baseScaleByHandle.set(handle, stored);
    return stored;
  }
}
