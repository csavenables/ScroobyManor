import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraHomeConfig, CameraLimitsConfig } from '../config/schema';
import { clamp } from '../utils/clamp';
import { easeInOutCubic } from '../utils/easing';

// Lower values frame tighter (camera moves closer to content after auto-fit).
const FIT_DISTANCE_SCALE = 0.84;

interface CameraAnimation {
  startTime: number;
  durationMs: number;
  fromPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  fromFov: number;
  toPosition: THREE.Vector3;
  toTarget: THREE.Vector3;
  toFov: number;
}

export interface CameraControlProfile {
  lockControls?: boolean;
  limits?: CameraLimitsConfig;
  enablePan?: boolean;
}

export interface CameraAnimateOptions {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  durationMs: number;
}

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export class CameraController {
  private readonly controls: OrbitControls;
  private cameraAnimation: CameraAnimation | null = null;
  private baseLimits: CameraLimitsConfig = {
    minDistance: 0.1,
    maxDistance: 100,
    minPolarAngle: 0,
    maxPolarAngle: Math.PI,
  };
  private baseEnablePan = true;
  private readonly controlProfiles: CameraControlProfile[] = [];

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
  }

  applyLimits(limits: CameraLimitsConfig, enablePan: boolean): void {
    this.baseLimits = { ...limits };
    this.baseEnablePan = enablePan;
    this.applyEffectiveControls();
  }

  pushControlProfile(profile: CameraControlProfile): void {
    this.controlProfiles.push(profile);
    this.applyEffectiveControls();
  }

  popControlProfile(): void {
    if (this.controlProfiles.length === 0) {
      return;
    }
    this.controlProfiles.pop();
    this.applyEffectiveControls();
  }

  setAutoRotate(enabled: boolean, speed = 1): void {
    this.controls.autoRotate = enabled;
    this.controls.autoRotateSpeed = speed;
  }

  resetToHome(home: CameraHomeConfig, durationMs: number): void {
    this.animateTo({
      position: home.position,
      target: home.target,
      fov: home.fov,
      durationMs,
    });
  }

  setHomeImmediately(home: CameraHomeConfig): void {
    this.camera.position.set(...home.position);
    this.controls.target.set(...home.target);
    this.camera.fov = home.fov;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  getCurrentHome(): CameraHomeConfig {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      fov: this.camera.fov,
    };
  }

  getCurrentPose(): CameraPose {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      fov: this.camera.fov,
    };
  }

  nudgePivotWorld(delta: THREE.Vector3): void {
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.controls.update();
  }

  getTarget(out: THREE.Vector3): void {
    out.copy(this.controls.target);
  }

  frameTarget(
    target: THREE.Vector3,
    size: THREE.Vector3,
    radius: number,
    fovDegrees: number,
    limits: CameraLimitsConfig,
    referenceDirection: THREE.Vector3,
  ): number {
    const direction = referenceDirection.clone().normalize();
    if (direction.lengthSq() === 0) {
      direction.set(0, 0, 1);
    }

    const halfVerticalFov = Math.max(0.01, THREE.MathUtils.degToRad(fovDegrees * 0.5));
    const halfHorizontalFov = Math.max(0.01, Math.atan(Math.tan(halfVerticalFov) * this.camera.aspect));
    const halfWidth = Math.max(0.001, size.x * 0.5);
    const halfHeight = Math.max(0.001, size.y * 0.5);

    // Fit by projected box dimensions first, then fall back to sphere fit for depth safety.
    const distanceForHeight = halfHeight / Math.tan(halfVerticalFov);
    const distanceForWidth = halfWidth / Math.tan(halfHorizontalFov);
    const distanceForSphere = radius / Math.sin(Math.min(halfVerticalFov, halfHorizontalFov));
    const desiredDistance = Math.max(distanceForHeight, distanceForWidth, distanceForSphere) * FIT_DISTANCE_SCALE;
    const distance = clamp(desiredDistance, limits.minDistance, limits.maxDistance);

    this.controls.target.copy(target);
    this.camera.position.copy(target.clone().add(direction.multiplyScalar(distance)));
    this.camera.fov = fovDegrees;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    return distance;
  }

  update(nowMs: number): void {
    if (this.cameraAnimation) {
      const elapsed = nowMs - this.cameraAnimation.startTime;
      const t = Math.min(1, elapsed / this.cameraAnimation.durationMs);
      const eased = easeInOutCubic(t);

      this.camera.position.lerpVectors(
        this.cameraAnimation.fromPosition,
        this.cameraAnimation.toPosition,
        eased,
      );
      this.controls.target.lerpVectors(
        this.cameraAnimation.fromTarget,
        this.cameraAnimation.toTarget,
        eased,
      );
      this.camera.fov = THREE.MathUtils.lerp(this.cameraAnimation.fromFov, this.cameraAnimation.toFov, eased);
      this.camera.updateProjectionMatrix();

      if (t >= 1) {
        this.cameraAnimation = null;
      }
    }

    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }

  animateTo(options: CameraAnimateOptions): void {
    this.cameraAnimation = {
      startTime: performance.now(),
      durationMs: Math.max(1, options.durationMs),
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      fromFov: this.camera.fov,
      toPosition: new THREE.Vector3(...options.position),
      toTarget: new THREE.Vector3(...options.target),
      toFov: options.fov,
    };
  }

  cancelAnimation(): void {
    this.cameraAnimation = null;
  }

  private applyEffectiveControls(): void {
    const topProfile = this.controlProfiles[this.controlProfiles.length - 1];
    const limits = topProfile?.limits ?? this.baseLimits;
    const enablePan = topProfile?.enablePan ?? this.baseEnablePan;
    const lockControls = Boolean(topProfile?.lockControls);

    this.controls.minDistance = limits.minDistance;
    this.controls.maxDistance = limits.maxDistance;
    this.controls.minPolarAngle = limits.minPolarAngle;
    this.controls.maxPolarAngle = limits.maxPolarAngle;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = !lockControls && enablePan;
  }
}
