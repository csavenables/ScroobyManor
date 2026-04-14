import * as THREE from 'three';
import { loadSceneConfig } from '../config/loadSceneConfig';
import { InteriorViewConfig, RevealConfig, SceneConfig } from '../config/schema';
import { REVEAL_CONFIG_DEFAULTS, SplatHandle, SplatRenderer } from '../renderers/types';
import { SplatRevealController } from './SplatRevealController';

export interface SplatToggleItem {
  id: string;
  label: string;
  active: boolean;
  loaded: boolean;
  failed: boolean;
}

export interface SceneManagerEvents {
  onLoading(message: string): void;
  onReady(config: SceneConfig): void;
  onItemsChanged(items: SplatToggleItem[]): void;
}

export interface RevealHookOptions {
  reducedMotion?: boolean;
  revealOverride?: RevealConfig;
  beforeRevealIn?: (ctx: {
    handle: SplatHandle;
    config: SceneConfig;
    reveal: RevealConfig;
  }) => Promise<void> | void;
}

export class SceneLoadError extends Error {
  constructor(message: string, public readonly details: string[] = []) {
    super(message);
    this.name = 'SceneLoadError';
  }
}

export class SceneManager {
  private activeConfig: SceneConfig | null = null;
  private activeHandles: SplatHandle[] = [];
  private activeItems: SplatToggleItem[] = [];
  private readonly handleById = new Map<string, SplatHandle>();
  private readonly revealController = new SplatRevealController();
  private currentActiveId: string | null = null;
  private interiorBaseConfig: SceneConfig['interiorView'] | null = null;
  private opVersion = 0;

  constructor(
    private readonly renderer: SplatRenderer,
    private readonly events: SceneManagerEvents,
  ) {}

  get config(): SceneConfig | null {
    return this.activeConfig;
  }

  getActiveSplatId(): string | null {
    return this.currentActiveId;
  }

  getActiveHandle(): SplatHandle | null {
    if (!this.currentActiveId) {
      return null;
    }
    return this.handleById.get(this.currentActiveId) ?? null;
  }

  async loadScene(sceneId: string): Promise<SceneConfig> {
    this.opVersion += 1;
    const loadVersion = this.opVersion;
    this.events.onLoading('Loading scene configuration...');
    let config: SceneConfig;
    try {
      config = await loadSceneConfig(sceneId);
    } catch (error) {
      if (error instanceof Error) {
        throw new SceneLoadError(error.message);
      }
      throw new SceneLoadError('Unknown error while loading scene configuration.');
    }

    if (this.activeHandles.length > 0) {
      this.events.onLoading('Dissolving current scene...');
      const previousReveal = this.activeConfig?.reveal ?? REVEAL_CONFIG_DEFAULTS;
      await Promise.all(
        this.activeHandles.map((handle) =>
          this.revealController.revealOut(handle, handle.boundsY, previousReveal),
        ),
      );
    }

    this.events.onLoading('Loading splat assets...');
    try {
      await this.renderer.clear();
      if (loadVersion !== this.opVersion) {
        return this.activeConfig ?? config;
      }
      this.interiorBaseConfig = config.interiorView;
      this.handleById.clear();
      this.activeHandles = await this.renderer.loadSplats(config.assets);
      this.currentActiveId = config.assets[0]?.id ?? null;
      this.applyInteriorForActive(this.currentActiveId);
      this.activeItems = config.assets.map((asset, index) => ({
        id: asset.id,
        label: asset.id.replaceAll('_', ' '),
        active: index === 0,
        loaded: true,
        failed: false,
      }));
      for (const handle of this.activeHandles) {
        this.handleById.set(handle.id, handle);
      }
      this.events.onItemsChanged(this.getSplatItems());

      const firstAsset = config.assets[0];
      if (firstAsset) {
        const firstHandle = this.handleById.get(firstAsset.id);
        if (firstHandle) {
          this.renderer.setVisible(firstAsset.id, true);
          await this.prepareRevealStart([firstHandle], config.reveal);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error while loading splat assets.';
      throw new SceneLoadError('Unable to load scene assets.', [message]);
    }

    this.activeConfig = config;
    this.events.onReady(config);
    return config;
  }

  async revealActiveScene(options: RevealHookOptions = {}): Promise<void> {
    if (!this.activeConfig) {
      return;
    }
    const reveal = options.revealOverride ?? this.activeConfig.reveal;
    await Promise.all(
      this.activeHandles.map(async (handle) => {
        const item = this.activeItems.find((entry) => entry.id === handle.id);
        if (!item?.active) {
          this.renderer.setVisible(handle.id, false);
          return;
        }
        this.renderer.setVisible(handle.id, true);
        if (options.beforeRevealIn) {
          await options.beforeRevealIn({
            handle,
            config: this.activeConfig!,
            reveal,
          });
        }
        await this.revealController.revealIn(handle, handle.boundsY, reveal);
      }),
    );
  }

  async resetActiveRevealStart(): Promise<void> {
    if (!this.activeConfig) {
      return;
    }
    const reveal = this.activeConfig.reveal;
    const activeHandles: SplatHandle[] = [];
    for (const handle of this.activeHandles) {
      const item = this.activeItems.find((entry) => entry.id === handle.id);
      if (!item?.active) {
        continue;
      }
      this.renderer.setVisible(handle.id, true);
      activeHandles.push(handle);
    }
    await this.prepareRevealStart(activeHandles, reveal);
  }

  getSplatItems(): SplatToggleItem[] {
    return this.activeItems.map((item) => ({ ...item }));
  }

  getInteriorViewConfig(): InteriorViewConfig | null {
    if (!this.interiorBaseConfig) {
      return null;
    }
    return {
      ...this.interiorBaseConfig,
      target: [...this.interiorBaseConfig.target],
    };
  }

  updateInteriorViewConfig(next: Partial<InteriorViewConfig>): void {
    if (!this.interiorBaseConfig) {
      return;
    }
    const merged: InteriorViewConfig = {
      ...this.interiorBaseConfig,
      ...next,
      target: next.target ? [...next.target] : [...this.interiorBaseConfig.target],
    };
    this.interiorBaseConfig = merged;
    this.applyInteriorForActive(this.currentActiveId);
  }

  async activateSplat(id: string, onBeforeReveal?: () => void | Promise<void>): Promise<boolean> {
    if (!this.activeConfig) {
      return false;
    }
    const targetHandle = this.handleById.get(id);
    const targetItem = this.activeItems.find((entry) => entry.id === id);
    if (!targetHandle || !targetItem || targetItem.failed) {
      return false;
    }
    if (this.currentActiveId === id) {
      return true;
    }

    this.opVersion += 1;
    const localVersion = this.opVersion;
    const reveal = this.activeConfig.reveal;
    const previousId = this.currentActiveId;
    if (previousId && previousId !== id) {
      const previousHandle = this.handleById.get(previousId);
      if (previousHandle) {
        await this.revealController.revealOut(previousHandle, previousHandle.boundsY, reveal);
        if (localVersion !== this.opVersion) {
          return false;
        }
      }
    }

    // Enforce exclusivity even if UI state drifted.
    for (const item of this.activeItems) {
      if (item.id === id) {
        continue;
      }
      this.renderer.setVisible(item.id, false);
      item.active = false;
    }

    this.renderer.setVisible(id, true);
    targetItem.active = true;
    this.currentActiveId = id;
    this.events.onItemsChanged(this.getSplatItems());
    this.applyInteriorForActive(this.currentActiveId);
    await this.prepareRevealStart([targetHandle], reveal);
    if (onBeforeReveal) {
      await onBeforeReveal();
    }
    await this.revealController.revealIn(targetHandle, targetHandle.boundsY, reveal);
    if (localVersion !== this.opVersion) {
      return false;
    }
    this.events.onItemsChanged(this.getSplatItems());
    return true;
  }

  async dispose(): Promise<void> {
    this.activeHandles = [];
    this.activeItems = [];
    this.handleById.clear();
    this.currentActiveId = null;
    this.interiorBaseConfig = null;
    await this.renderer.dispose();
  }

  private async prepareRevealStart(handles: SplatHandle[], reveal: RevealConfig): Promise<void> {
    for (const handle of handles) {
      const minY = handle.boundsY.minY + reveal.startPadding;
      const box = handle.sampledBounds
        ? new THREE.Box3(handle.sampledBounds.min.clone(), handle.sampledBounds.max.clone())
        : new THREE.Box3().setFromObject(handle.object3D);
      const sphereOrigin = box.isEmpty()
        ? new THREE.Vector3(0, minY + reveal.bottomSphere.originYOffset, 0)
        : new THREE.Vector3(
            (box.min.x + box.max.x) * 0.5,
            reveal.bottomSphere.originAnchor === 'top'
              ? box.max.y +
                reveal.bottomSphere.originYOffset +
                Math.max(0.001, box.max.y - box.min.y) * reveal.bottomSphere.originHeightScale
              : box.min.y + reveal.bottomSphere.originYOffset,
            (box.min.z + box.max.z) * 0.5,
          );
      handle.setRevealBounds(handle.boundsY);
      handle.setRevealParams({
        enabled: reveal.enabled,
        mode: reveal.mode === 'bottomSphere' ? 'bottomSphere' : 'yRamp',
        revealY: minY,
        band: reveal.band,
        sphereOrigin,
        sphereRadius: 0.0001,
        sphereFeather: reveal.bottomSphere.feather,
        clipBottomEnabled: reveal.bottomClip.enabled,
        clipBottomY: handle.boundsY.minY + reveal.bottomClip.offset,
        affectAlpha: reveal.affectAlpha,
        affectSize: reveal.affectSize,
      });
      this.revealController.primeRevealInStart(handle, reveal);
    }
  }

  private applyInteriorForActive(activeId: string | null): void {
    const base = this.interiorBaseConfig;
    if (!base) {
      return;
    }
    this.renderer.setInteriorView({
      ...base,
      enabled: base.enabled && activeId === 'staircase',
    });
  }

}
