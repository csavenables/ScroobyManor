import { createAppShell } from './bootstrap';
import { readRuntimeOptions } from './runtimeOptions';
import { Viewer } from '../viewer/Viewer';
import { createTelemetryClient } from '../telemetry/TelemetryClient';

export function startApp(): void {
  const appRoot = document.querySelector<HTMLElement>('#app');
  if (!appRoot) {
    throw new Error('Missing #app root element.');
  }
  const runtime = readRuntimeOptions(window.location.search);
  let telemetrySendFailCount = 0;
  const telemetry = createTelemetryClient({
    endpoint: '',
    viewerVersion: 'scrooby-manor-v1',
    enabled: runtime.analyticsOverride !== false,
    honorDoNotTrack: true,
    onSendFailure: ({ eventName, reason }) => {
      telemetrySendFailCount += 1;
      if (eventName !== 'telemetry_send_failed') {
        telemetry.track(
          'telemetry_send_failed',
          { event_name: eventName, reason },
          'error',
        );
      }
      console.warn(`[telemetry] failed for "${eventName}": ${reason}`);
    },
  });
  void telemetry.startSession({
    asset_id: runtime.sceneId,
    project: runtime.sceneId,
    device_type: window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
  });

  let viewer: Viewer;
  const ui = createAppShell(appRoot, {
    onReset: () => viewer.resetView(),
    onToggleAutorotate: () => viewer.toggleAutorotate(),
    onToggleFullscreen: (enable) => viewer.setFullscreen(enable),
    isFullscreen: () => viewer.isFullscreen(),
    onThemeChange: (theme) => viewer.setThemeMode(theme),
    onTelemetryEvent: (name, payload, category) => {
      telemetry.track(name, payload ?? {}, category ?? 'ui');
    },
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
    pivotDebug: runtime.pivotDebug,
    autorotateOverride: runtime.autorotateOverride,
    mobileProfile: runtime.mobileProfileOverride,
    telemetry,
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
  const onWindowError = (event: ErrorEvent): void => {
    telemetry.track(
      'viewer_error',
      {
        message: event.message || 'window error',
        stack: event.error?.stack || null,
        filename: event.filename || null,
        lineno: event.lineno || null,
        colno: event.colno || null,
      },
      'error',
    );
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason as { message?: string; stack?: string } | string | null;
    const message =
      typeof reason === 'string'
        ? reason
        : reason?.message || 'unhandled rejection';
    telemetry.track(
      'viewer_error',
      {
        message,
        stack: typeof reason === 'string' ? null : reason?.stack || null,
        context: 'unhandledrejection',
      },
      'error',
    );
  };
  const onBeforeUnload = (): void => {
    void viewer.endTelemetrySession('beforeunload');
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      void viewer.endTelemetrySession('hidden');
    }
  };
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('visibilitychange', onVisibilityChange);

  void (async () => {
    await viewer.init(initialSceneId);
    viewer.trackTelemetryEvent('viewer_ready', {
      scene_id: viewer.getActiveSceneId(),
      telemetry_send_fail_count: telemetrySendFailCount,
    });
    postToParent({
      type: 'viewer:ready',
      sceneId: viewer.getActiveSceneId(),
    });
  })();
}
