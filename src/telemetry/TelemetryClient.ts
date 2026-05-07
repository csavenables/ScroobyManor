export type TelemetryCategory = 'viewer' | 'ui' | 'cta' | 'perf' | 'error' | 'annotation';

export interface SessionContext {
  viewer_version?: string | null;
  asset_id?: string | null;
  project?: string | null;
  anonymous_user_id?: string | null;
  entry_page?: string | null;
  referrer?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  language?: string | null;
  timezone?: string | null;
  os?: string | null;
  browser?: string | null;
  device_type?: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  touch_capable?: boolean | null;
  pixel_ratio?: number | null;
  screen_resolution?: string | null;
  viewport_size?: string | null;
  device_memory_gb?: number | null;
}

export interface TelemetrySendFailure {
  eventName: string;
  reason: string;
}

export interface TelemetryDebugState {
  enabled: boolean;
  endpoint: string;
  sessionId: string | null;
  queueLength: number;
  lastStatus: string;
  lastError: string;
  sendFailureCount: number;
}

export interface TelemetryClient {
  readonly isEnabled: boolean;
  startSession(context?: Partial<SessionContext>): Promise<string | null>;
  setSessionContext(partial: Partial<SessionContext>): void;
  setEndpoint(endpoint: string): void;
  setEnabled(enabled: boolean): void;
  track(name: string, payload?: Record<string, unknown>, category?: TelemetryCategory): void;
  endSession(reason?: string, extraPayload?: Record<string, unknown>): Promise<void>;
  getSessionId(): string | null;
  getDebugState(): TelemetryDebugState;
}

interface InternalEvent {
  action: 'start' | 'track' | 'end';
  name: string;
  category: TelemetryCategory;
  payload: Record<string, unknown>;
  ts: string;
}

interface CreateTelemetryClientOptions {
  endpoint: string;
  viewerVersion: string;
  enabled: boolean;
  honorDoNotTrack?: boolean;
  onSendFailure?: (failure: TelemetrySendFailure) => void;
}

const MAX_QUEUE = 500;
const RETRY_DELAY_MS = 3000;
const ANON_USER_ID_STORAGE_KEY = 'scrooby.anonymous_user_id.v1';

function nowIso(): string {
  return new Date().toISOString();
}

function createUuid(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `sid_${Date.now()}_${Math.floor(Math.random() * 1e8)}`;
}

function parseDeviceType(ua: string): 'mobile' | 'tablet' | 'desktop' | 'unknown' {
  if (!ua) {
    return 'unknown';
  }
  if (/Tablet|iPad/i.test(ua)) {
    return 'tablet';
  }
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) {
    return 'mobile';
  }
  return 'desktop';
}

function parseOs(ua: string): string {
  if (/Windows NT/i.test(ua)) {
    return 'Windows';
  }
  if (/Android/i.test(ua)) {
    return 'Android';
  }
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return 'iOS';
  }
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return 'macOS';
  }
  if (/Linux/i.test(ua)) {
    return 'Linux';
  }
  return 'Unknown';
}

function parseBrowser(ua: string): string {
  if (/Edg\//i.test(ua)) {
    return 'Edge';
  }
  if (/OPR\//i.test(ua)) {
    return 'Opera';
  }
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) {
    return 'Chrome';
  }
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
    return 'Safari';
  }
  if (/Firefox\//i.test(ua)) {
    return 'Firefox';
  }
  return 'Unknown';
}

function readDoNotTrackEnabled(): boolean {
  const value =
    navigator.doNotTrack ??
    (window as unknown as { doNotTrack?: string }).doNotTrack ??
    (navigator as unknown as { msDoNotTrack?: string }).msDoNotTrack ??
    null;
  if (!value) {
    return false;
  }
  const normalized = String(value).toLowerCase();
  return normalized === '1' || normalized === 'yes';
}

function getAnonymousUserId(): string {
  try {
    const existing = window.localStorage.getItem(ANON_USER_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const created = createUuid();
    window.localStorage.setItem(ANON_USER_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return createUuid();
  }
}

function readClientContext(): SessionContext {
  const query = new URLSearchParams(window.location.search);
  const userAgent = navigator.userAgent || '';
  const deviceMemory = Number((navigator as unknown as { deviceMemory?: number }).deviceMemory);
  return {
    entry_page: `${window.location.pathname}${window.location.search}`,
    referrer: document.referrer || null,
    utm_source: query.get('utm_source'),
    utm_medium: query.get('utm_medium'),
    utm_campaign: query.get('utm_campaign'),
    language: navigator.language || null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    os: parseOs(userAgent),
    browser: parseBrowser(userAgent),
    device_type: parseDeviceType(userAgent),
    touch_capable: navigator.maxTouchPoints > 0,
    pixel_ratio: Number(window.devicePixelRatio || 1),
    screen_resolution: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
    viewport_size: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
    device_memory_gb: Number.isFinite(deviceMemory) ? deviceMemory : null,
  };
}

class NoopTelemetryClient implements TelemetryClient {
  public readonly isEnabled = false;

  async startSession(): Promise<string | null> {
    return null;
  }

  setSessionContext(): void {
    // no-op
  }

  setEndpoint(): void {
    // no-op
  }

  setEnabled(): void {
    // no-op
  }

  track(): void {
    // no-op
  }

  async endSession(): Promise<void> {
    // no-op
  }

  getSessionId(): string | null {
    return null;
  }

  getDebugState(): TelemetryDebugState {
    return {
      enabled: false,
      endpoint: '',
      sessionId: null,
      queueLength: 0,
      lastStatus: 'noop',
      lastError: '',
      sendFailureCount: 0,
    };
  }
}

class EdgeFunctionTelemetryClient implements TelemetryClient {
  private enabled: boolean;
  private endpoint: string;
  private readonly viewerVersion: string;
  private readonly anonymousUserId: string;
  private readonly onSendFailure: ((failure: TelemetrySendFailure) => void) | null;
  private readonly queue: InternalEvent[] = [];
  private sessionId: string | null = null;
  private sessionStartedAtMs = 0;
  private sessionEnded = false;
  private baseContext: SessionContext = {};
  private flushing = false;
  private retryTimer = 0;
  private sendFailureCount = 0;
  private lastStatus = 'idle';
  private lastError = '';

  constructor(options: {
    endpoint: string;
    viewerVersion: string;
    enabled: boolean;
    onSendFailure?: (failure: TelemetrySendFailure) => void;
  }) {
    this.endpoint = options.endpoint;
    this.viewerVersion = options.viewerVersion;
    this.enabled = options.enabled;
    this.anonymousUserId = getAnonymousUserId();
    this.onSendFailure = typeof options.onSendFailure === 'function' ? options.onSendFailure : null;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async startSession(context: Partial<SessionContext> = {}): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }
    if (!this.sessionId) {
      this.sessionId = createUuid();
      this.sessionStartedAtMs = Date.now();
    }
    this.sessionEnded = false;
    this.baseContext = {
      viewer_version: this.viewerVersion,
      anonymous_user_id: this.anonymousUserId,
      ...readClientContext(),
      ...context,
    };
    this.enqueue({
      action: 'start',
      name: 'viewer_opened',
      category: 'viewer',
      payload: {
        asset_id: this.baseContext.asset_id ?? null,
        project: this.baseContext.project ?? null,
      },
      ts: nowIso(),
    });
    this.enqueue({
      action: 'track',
      name: 'session_context',
      category: 'viewer',
      payload: {
        entry_page: this.baseContext.entry_page ?? null,
        referrer: this.baseContext.referrer ?? null,
        utm_source: this.baseContext.utm_source ?? null,
        utm_medium: this.baseContext.utm_medium ?? null,
        utm_campaign: this.baseContext.utm_campaign ?? null,
        language: this.baseContext.language ?? null,
        timezone: this.baseContext.timezone ?? null,
        os: this.baseContext.os ?? null,
        browser: this.baseContext.browser ?? null,
        device_type: this.baseContext.device_type ?? 'unknown',
        touch_capable: this.baseContext.touch_capable ?? null,
        pixel_ratio: this.baseContext.pixel_ratio ?? null,
        screen_resolution: this.baseContext.screen_resolution ?? null,
        viewport_size: this.baseContext.viewport_size ?? null,
        device_memory_gb: this.baseContext.device_memory_gb ?? null,
        project: this.baseContext.project ?? null,
      },
      ts: nowIso(),
    });
    return this.sessionId;
  }

  setSessionContext(partial: Partial<SessionContext>): void {
    this.baseContext = {
      ...this.baseContext,
      ...partial,
    };
  }

  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint.trim();
    if (this.endpoint.length > 0) {
      void this.flush();
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearRetryTimer();
      return;
    }
    if (enabled) {
      void this.flush();
    }
  }

  track(
    name: string,
    payload: Record<string, unknown> = {},
    category: TelemetryCategory = 'viewer',
  ): void {
    if (!this.enabled || !this.sessionId || this.sessionEnded) {
      return;
    }
    this.enqueue({
      action: 'track',
      name,
      category,
      payload,
      ts: nowIso(),
    });
  }

  async endSession(reason = 'unload', extraPayload: Record<string, unknown> = {}): Promise<void> {
    if (!this.enabled || !this.sessionId || this.sessionEnded) {
      return;
    }
    this.sessionEnded = true;
    const durationMs = Math.max(0, Date.now() - this.sessionStartedAtMs);
    const payload = {
      reason,
      duration_ms: durationMs,
      exit_page: `${window.location.pathname}${window.location.search}`,
      ...extraPayload,
    };

    if (navigator.sendBeacon && this.endpoint) {
      try {
        const beaconBody = JSON.stringify(
          this.makeRequest({
            action: 'end',
            name: 'session_ended',
            category: 'viewer',
            payload,
            ts: nowIso(),
          }),
        );
        navigator.sendBeacon(this.endpoint, beaconBody);
        this.lastStatus = 'beacon_sent';
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    this.enqueue({
      action: 'end',
      name: 'session_ended',
      category: 'viewer',
      payload,
      ts: nowIso(),
    });
    await this.flush();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getDebugState(): TelemetryDebugState {
    return {
      enabled: this.enabled,
      endpoint: this.endpoint,
      sessionId: this.sessionId,
      queueLength: this.queue.length,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      sendFailureCount: this.sendFailureCount,
    };
  }

  private enqueue(event: InternalEvent): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
    }
    this.queue.push(event);
    void this.flush();
  }

  private makeRequest(event: InternalEvent): Record<string, unknown> {
    return {
      action: event.action,
      session: {
        id: this.sessionId,
        started_at: new Date(this.sessionStartedAtMs || Date.now()).toISOString(),
        ...this.baseContext,
      },
      event: {
        name: event.name,
        category: event.category,
        ts: event.ts,
        payload: event.payload,
      },
    };
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.enabled || !this.sessionId) {
      return;
    }
    if (this.queue.length === 0) {
      return;
    }
    if (!this.endpoint) {
      this.lastStatus = 'no_endpoint';
      return;
    }
    this.clearRetryTimer();
    this.flushing = true;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(this.makeRequest(next)),
        });
        if (!response.ok) {
          const message = await response.text();
          throw new Error(`HTTP ${response.status}: ${message}`);
        }
        this.queue.shift();
        this.lastStatus = 'sent';
        this.lastError = '';
      } catch (error) {
        this.lastStatus = 'error';
        this.lastError = error instanceof Error ? error.message : String(error);
        this.sendFailureCount += 1;
        if (this.onSendFailure && next.name !== 'telemetry_send_failed') {
          this.onSendFailure({
            eventName: next.name,
            reason: this.lastError,
          });
        }
        this.scheduleRetryFlush();
        break;
      }
    }
    this.flushing = false;
  }

  private scheduleRetryFlush(): void {
    if (this.retryTimer || !this.enabled || !this.endpoint) {
      return;
    }
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      void this.flush();
    }, RETRY_DELAY_MS);
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) {
      return;
    }
    window.clearTimeout(this.retryTimer);
    this.retryTimer = 0;
  }
}

export function createTelemetryClient(options: CreateTelemetryClientOptions): TelemetryClient {
  const honorDnt = options.honorDoNotTrack ?? true;
  if (!options.enabled || (honorDnt && readDoNotTrackEnabled())) {
    return new NoopTelemetryClient();
  }
  return new EdgeFunctionTelemetryClient({
    endpoint: options.endpoint,
    viewerVersion: options.viewerVersion,
    enabled: options.enabled,
    onSendFailure: options.onSendFailure,
  });
}
