import { describe, expect, it } from 'vitest';
import { validateSceneConfig } from '../src/config/schema';

describe('validateSceneConfig', () => {
  it('accepts a valid config', () => {
    const valid = {
      id: 'demo',
      title: 'Demo',
      assets: [
        {
          id: 'a',
          src: '/scenes/demo/splats/a.ply',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visibleDefault: true,
        },
      ],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: {
        sceneFadeMs: 300,
      },
    };

    const result = validateSceneConfig(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.reveal.enabled).toBe(true);
      expect(result.data.reveal.mode).toBe('yRamp');
      expect(result.data.reveal.durationMs).toBe(2800);
      expect(result.data.reveal.particleIntro.particleCount).toBe(9000);
      expect(result.data.reveal.bottomSphere.durationMs).toBe(1900);
      expect(result.data.reveal.bottomSphere.originAnchor).toBe('bottom');
      expect(result.data.reveal.bottomSphere.originHeightScale).toBe(0);
      expect(result.data.reveal.bottomClip.enabled).toBe(false);
      expect(result.data.reveal.bottomClip.offset).toBe(0);
      expect(result.data.presentation.mode).toBe('standard');
      expect(result.data.presentation.introSpinDegrees).toBe(0);
      expect(result.data.cinematicReveal.enabled).toBe(false);
      expect(result.data.cinematicReveal.originMode).toBe('modelCenter');
      expect(result.data.cinematicReveal.staticPointCloud).toBe(false);
      expect(result.data.cinematicReveal.particleLeadMs).toBe(2200);
      expect(result.data.cinematicReveal.pointCloudFadeOutMs).toBe(1100);
      expect(result.data.cinematicReveal.zoomOutFactor).toBe(1);
      expect(result.data.cinematicReveal.zoomStartYOffset).toBe(0);
      expect(result.data.interiorView.enabled).toBe(false);
      expect(result.data.interiorView.radius).toBe(0.45);
      expect(result.data.annotations.enabled).toBe(false);
      expect(result.data.annotations.pins).toHaveLength(0);
    }
  });

  it('rejects configs with more than 5 assets', () => {
    const baseAsset = {
      id: 'a',
      src: '/x.ply',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visibleDefault: true,
    };

    const invalid = {
      id: 'demo',
      title: 'Demo',
      assets: [baseAsset, baseAsset, baseAsset, baseAsset, baseAsset, baseAsset],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: {
        sceneFadeMs: 300,
      },
    };

    const result = validateSceneConfig(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('up to 5 splats');
    }
  });

  it('rejects invalid reveal parameters', () => {
    const invalid = {
      id: 'demo',
      title: 'Demo',
      assets: [
        {
          id: 'a',
          src: '/x.ply',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visibleDefault: true,
        },
      ],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: {
        sceneFadeMs: 300,
      },
      reveal: {
        enabled: true,
        mode: 'yRamp',
        durationMs: 0,
        band: -1,
        particleIntro: {
          durationMs: 0,
          particleCount: 0,
          spread: -1,
          size: 0,
          color: '#fff',
          blend: 'normal',
        },
        bottomSphere: {
          durationMs: 0,
          feather: 0,
          originYOffset: 0,
          maxRadiusScale: 0,
        },
      },
      presentation: {
        mode: 'embedHero',
        introAutoRotateDelayMs: -1,
        idleRotateSpeed: 0,
      },
    };

    const result = validateSceneConfig(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('reveal.durationMs');
      expect(result.errors.join(' ')).toContain('reveal.band');
      expect(result.errors.join(' ')).toContain('particleIntro.durationMs');
      expect(result.errors.join(' ')).toContain('particleIntro.particleCount');
      expect(result.errors.join(' ')).toContain('particleIntro.spread');
      expect(result.errors.join(' ')).toContain('particleIntro.size');
      expect(result.errors.join(' ')).toContain('bottomSphere.durationMs');
      expect(result.errors.join(' ')).toContain('bottomSphere.feather');
      expect(result.errors.join(' ')).toContain('bottomSphere.maxRadiusScale');
      expect(result.errors.join(' ')).toContain('presentation.introAutoRotateDelayMs');
      expect(result.errors.join(' ')).toContain('presentation.idleRotateSpeed');
    }
  });

  it('accepts particleIntro reveal and embedHero presentation mode', () => {
    const valid = {
      id: 'cake',
      title: 'Cake',
      assets: [
        {
          id: 'cake_main',
          src: '/x.splat',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visibleDefault: true,
        },
      ],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: { sceneFadeMs: 300 },
      reveal: {
        enabled: true,
        mode: 'bottomSphere',
        durationMs: 1500,
        band: 0.1,
        ease: 'easeInOut',
        affectAlpha: true,
        affectSize: true,
        startPadding: 0,
        endPadding: 0,
        particleIntro: {
          durationMs: 1200,
          particleCount: 1200,
          spread: 0.4,
          size: 0.02,
          color: '#ffd9a4',
          blend: 'additive',
        },
        bottomSphere: {
          durationMs: 1600,
          feather: 0.2,
          originAnchor: 'top',
          originYOffset: -0.05,
          originHeightScale: 0.6,
          maxRadiusScale: 1.1,
        },
        bottomClip: {
          enabled: true,
          offset: 0.03,
        },
      },
      presentation: {
        mode: 'embedHero',
        introAutoRotateDelayMs: 250,
        idleRotateSpeed: 0.25,
      },
    };

    const result = validateSceneConfig(valid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.reveal.mode).toBe('bottomSphere');
        expect(result.data.presentation.mode).toBe('embedHero');
        expect(result.data.reveal.particleIntro.blend).toBe('additive');
        expect(result.data.reveal.bottomSphere.originAnchor).toBe('top');
        expect(result.data.reveal.bottomSphere.originHeightScale).toBe(0.6);
        expect(result.data.reveal.bottomSphere.maxRadiusScale).toBe(1.1);
      expect(result.data.reveal.bottomClip.enabled).toBe(true);
      expect(result.data.reveal.bottomClip.offset).toBe(0.03);
    }
  });

  it('rejects invalid cinematic reveal timing relationships', () => {
    const invalid = {
      id: 'gatehouse',
      title: 'Gatehouse',
      assets: [
        {
          id: 'main',
          src: '/x.splat',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visibleDefault: true,
        },
      ],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: { sceneFadeMs: 300 },
      cinematicReveal: {
        enabled: true,
        originMode: 'topCenter',
        particleLeadMs: 1000,
        splatDelayMs: 1200,
        sphereExpandMs: 0,
        overlapMs: 200,
        pointCloudFadeOutMs: 0,
        zoomOutFactor: 0.8,
        ease: 'easeInOut',
      },
    };

    const result = validateSceneConfig(invalid);
      expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('cinematicReveal.sphereExpandMs');
      expect(result.errors.join(' ')).toContain('cinematicReveal.pointCloudFadeOutMs');
      expect(result.errors.join(' ')).toContain('cinematicReveal.zoomOutFactor');
    }
  });

  it('rejects invalid interior view hard limits and clamps soft limits', () => {
    const invalid = {
      id: 'demo',
      title: 'Demo',
      assets: [
        {
          id: 'a',
          src: '/x.ply',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visibleDefault: true,
        },
      ],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: {
        sceneFadeMs: 300,
      },
      interiorView: {
        enabled: true,
        target: [0, 1, 0],
        radius: 0,
        softness: 0.9,
        fadeAlpha: -1,
        maxDistance: 0,
        affectSize: false,
      },
    };

    const result = validateSceneConfig(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('interiorView.radius');
      expect(result.errors.join(' ')).toContain('interiorView.maxDistance');
    }
  });

  it('accepts valid annotations and derives missing order', () => {
    const valid = {
      id: 'demo',
      title: 'Demo',
      assets: [
        {
          id: 'a',
          src: '/x.ply',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visibleDefault: true,
        },
      ],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: {
        sceneFadeMs: 300,
      },
      annotations: {
        enabled: true,
        defaultSelectedId: 'p1',
        pins: [
          {
            id: 'p2',
            order: 2,
            pos: [1, 1, 1],
            title: 'Two',
            body: 'Body',
            camera: {
              position: [1, 1, 2],
              target: [0, 0, 0],
              fov: 45,
              transitionMs: 700,
              lockControls: true,
            },
          },
          {
            id: 'p1',
            order: 1,
            pos: [0, 1, 1],
            title: 'One',
            body: 'Body',
            camera: {
              position: [0, 1, 2],
              target: [0, 0, 0],
              fov: 45,
              transitionMs: 700,
              lockControls: false,
            },
          },
        ],
      },
    };

    const result = validateSceneConfig(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.annotations.pins[0].id).toBe('p1');
      expect(result.data.annotations.pins[1].order).toBe(2);
      expect(result.data.annotations.ui.occlusion.mode).toBe('depth');
    }
  });

  it('rejects duplicate annotation orders', () => {
    const invalid = {
      id: 'demo',
      title: 'Demo',
      assets: [
        {
          id: 'a',
          src: '/x.ply',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visibleDefault: true,
        },
      ],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: {
        sceneFadeMs: 300,
      },
      annotations: {
        enabled: true,
        defaultSelectedId: 'p1',
        pins: [
          {
            id: 'p1',
            order: 1,
            pos: [0, 1, 1],
            title: 'One',
            body: 'Body',
            camera: {
              position: [0, 1, 2],
              target: [0, 0, 0],
              fov: 45,
              transitionMs: 700,
              lockControls: false,
            },
          },
          {
            id: 'p2',
            order: 1,
            pos: [1, 1, 1],
            title: 'Two',
            body: 'Body',
            camera: {
              position: [1, 1, 2],
              target: [0, 0, 0],
              fov: 45,
              transitionMs: 700,
              lockControls: false,
            },
          },
        ],
      },
    };

    const result = validateSceneConfig(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('order must be unique');
    }
  });

  it('rejects invalid annotations.defaultSelectedId', () => {
    const invalid = {
      id: 'demo',
      title: 'Demo',
      assets: [
        {
          id: 'a',
          src: '/x.ply',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visibleDefault: true,
        },
      ],
      camera: {
        home: { position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        limits: { minDistance: 0.4, maxDistance: 4, minPolarAngle: 0.1, maxPolarAngle: 2.9 },
        transitionMs: 500,
      },
      ui: {
        enableFullscreen: true,
        enableAutorotate: true,
        enableReset: true,
        enablePan: true,
        autorotateDefaultOn: false,
      },
      transitions: {
        sceneFadeMs: 300,
      },
      annotations: {
        enabled: true,
        defaultSelectedId: 'missing',
        pins: [
          {
            id: 'p1',
            order: 1,
            pos: [0, 1, 1],
            title: 'One',
            body: 'Body',
            camera: {
              position: [0, 1, 2],
              target: [0, 0, 0],
              fov: 45,
              transitionMs: 700,
              lockControls: false,
            },
          },
        ],
      },
    };

    const result = validateSceneConfig(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('defaultSelectedId');
    }
  });
});
