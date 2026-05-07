export interface RuntimeOptions {
  sceneId: string;
  embed: boolean;
  pivotDebug: boolean;
  autorotateOverride: boolean | null;
  mobileProfileOverride: boolean | null;
  analyticsOverride: boolean | null;
  controlsVisible: boolean;
  replayButtonVisible: boolean;
  annotate: boolean;
  parentOrigin: string | null;
}

function parseBooleanFlag(value: string | null): boolean | null {
  if (value === null) {
    return null;
  }
  if (value === '1' || value.toLowerCase() === 'true') {
    return true;
  }
  if (value === '0' || value.toLowerCase() === 'false') {
    return false;
  }
  return null;
}

function parseOrigin(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return null;
  }
}

export function readRuntimeOptions(search: string, defaultSceneId = 'sm-orbit-1-trimmed'): RuntimeOptions {
  const params = new URLSearchParams(search);
  void params;
  const sceneId = defaultSceneId;
  const embedDefault = sceneId === defaultSceneId;
  const embed = parseBooleanFlag(params.get('embed')) ?? embedDefault;
  const controlsVisible = parseBooleanFlag(params.get('controls')) ?? !embed;
  const replayButtonVisible = parseBooleanFlag(params.get('replayButton')) ?? false;
  return {
    sceneId,
    embed,
    pivotDebug: parseBooleanFlag(params.get('pivot')) ?? false,
    autorotateOverride: parseBooleanFlag(params.get('autorotate')),
    mobileProfileOverride: parseBooleanFlag(params.get('mobileProfile')),
    analyticsOverride: parseBooleanFlag(params.get('analytics')),
    controlsVisible,
    replayButtonVisible,
    annotate: parseBooleanFlag(params.get('annotate')) ?? false,
    parentOrigin: parseOrigin(params.get('parentOrigin')),
  };
}
