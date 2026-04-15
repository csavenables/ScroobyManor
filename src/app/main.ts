import { createAppShell } from './bootstrap';
import { readRuntimeOptions } from './runtimeOptions';
import { Viewer } from '../viewer/Viewer';

export function startApp(): void {
  const appRoot = document.querySelector<HTMLElement>('#app');
  if (!appRoot) {
    throw new Error('Missing #app root element.');
  }
  const runtime = readRuntimeOptions(window.location.search);

  let viewer: Viewer;
  const ui = createAppShell(appRoot, {
    onReset: () => viewer.resetView(),
    onToggleAutorotate: () => viewer.toggleAutorotate(),
    onToggleFullscreen: (enable) => viewer.setFullscreen(enable),
    isFullscreen: () => viewer.isFullscreen(),
    onThemeChange: (theme) => viewer.setThemeMode(theme),
  }, {
    embedMode: runtime.embed,
    controlsVisible: runtime.controlsVisible,
    replayButtonVisible: runtime.replayButtonVisible,
    annotationAuthoring: false,
    onReplay: () => {
      void viewer.playIntro();
    },
  });

  viewer = new Viewer(ui.getCanvasHostElement(), ui, {
    embedMode: runtime.embed,
    autorotateOverride: runtime.autorotateOverride,
    mobileProfile: runtime.mobileProfileOverride,
  });
  viewer.setThemeMode(ui.getThemeMode());
  const initialSceneId = runtime.sceneId;
  const referrerOrigin = (() => {
    if (!document.referrer) {
      return null;
    }
    try {
      return new URL(document.referrer).origin;
    } catch {
      return null;
    }
  })();
  const parentOrigin = runtime.parentOrigin ?? referrerOrigin;
  const allowedIncomingOrigin = parentOrigin;

  const postToParent = (message: unknown): void => {
    if (window.parent === window) {
      return;
    }
    if (!parentOrigin) {
      return;
    }
    const targetOrigin = parentOrigin;
    window.parent.postMessage(message, targetOrigin);
  };

  const onMessage = (event: MessageEvent): void => {
    if (!event.data || typeof event.data !== 'object') {
      return;
    }
    if (window.parent !== window && !allowedIncomingOrigin) {
      return;
    }
    if (allowedIncomingOrigin && event.origin !== allowedIncomingOrigin) {
      return;
    }
    const payload = event.data as { type?: string; value?: unknown };
    switch (payload.type) {
      case 'viewer:playIntro':
        void viewer.playIntro();
        break;
      case 'viewer:setAutoRotate':
        if (typeof payload.value === 'boolean') {
          viewer.setAutoRotateExplicit(payload.value);
        }
        break;
      case 'viewer:reset':
        viewer.resetView();
        break;
      default:
        break;
    }
  };
  window.addEventListener('message', onMessage);

  void (async () => {
    await viewer.init(initialSceneId);
    postToParent({
      type: 'viewer:ready',
      sceneId: viewer.getActiveSceneId(),
    });
  })();
}
