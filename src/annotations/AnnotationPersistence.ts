import { AnnotationsConfig } from '../config/schema';

const DB_NAME = 'annotation-file-handles';
const DB_VERSION = 1;
const STORE_NAME = 'sceneHandles';

type FileHandleRecord = {
  sceneId: string;
  handle: FileSystemFileHandle;
};

type PermissionStateValue = 'granted' | 'denied' | 'prompt';

interface PermissionCapableHandle extends FileSystemFileHandle {
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionStateValue>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionStateValue>;
}

function supportsFileAccessApi(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in (window as unknown as Record<string, unknown>);
}

export class AnnotationPersistence {
  async load(sceneId: string): Promise<AnnotationsConfig | null> {
    if (supportsFileAccessApi()) {
      const handleAnnotations = await this.loadFromHandle(sceneId);
      if (handleAnnotations) {
        return handleAnnotations;
      }
    }
    return this.loadBundled(sceneId);
  }

  private async loadFromHandle(sceneId: string): Promise<AnnotationsConfig | null> {
    const handle = await this.getHandle(sceneId);
    if (!handle) {
      return null;
    }
    const capableHandle = handle as PermissionCapableHandle;
    const permission = capableHandle.queryPermission
      ? await capableHandle.queryPermission({ mode: 'read' })
      : 'granted';
    if (permission !== 'granted') {
      return null;
    }
    try {
      const file = await handle.getFile();
      const text = await file.text();
      return this.parseAnnotationsPayload(text);
    } catch {
      return null;
    }
  }

  private async loadBundled(sceneId: string): Promise<AnnotationsConfig | null> {
    const candidates = [
      `scenes/${sceneId}/annotations.json`,
      `${sceneId}.annotations.json`,
    ];
    for (const relativePath of candidates) {
      try {
        const response = await fetch(relativePath, { cache: 'no-store' });
        if (!response.ok) {
          continue;
        }
        const payload = await response.text();
        const parsed = this.parseAnnotationsPayload(payload);
        if (parsed) {
          return parsed;
        }
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  private parseAnnotationsPayload(payload: string): AnnotationsConfig | null {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!isObject(parsed)) {
        return null;
      }
      if (isObject(parsed.annotations)) {
        return parsed.annotations as unknown as AnnotationsConfig;
      }
      if (isObject(parsed) && Array.isArray(parsed.pins) && isObject(parsed.ui)) {
        return parsed as unknown as AnnotationsConfig;
      }
      return null;
    } catch {
      return null;
    }
  }

  async save(sceneId: string, annotations: AnnotationsConfig): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!supportsFileAccessApi()) {
      return { ok: false, reason: 'File System Access API is not available in this browser.' };
    }
    let handle = await this.getHandle(sceneId);
    if (!handle) {
      try {
        const savePicker = (window as unknown as {
          showSaveFilePicker?: (options?: Record<string, unknown>) => Promise<FileSystemFileHandle>;
        }).showSaveFilePicker;
        if (!savePicker) {
          return { ok: false, reason: 'File save picker is unavailable.' };
        }
        handle = await savePicker({
          suggestedName: `${sceneId}.annotations.json`,
          types: [
            {
              description: 'JSON',
              accept: { 'application/json': ['.json'] },
            },
          ],
        });
      } catch {
        return { ok: false, reason: 'Save cancelled.' };
      }
      if (!handle) {
        return { ok: false, reason: 'No file handle was selected.' };
      }
      await this.putHandle(sceneId, handle);
    }

    const capableHandle = handle as PermissionCapableHandle;
    const permission = capableHandle.requestPermission
      ? await capableHandle.requestPermission({ mode: 'readwrite' })
      : 'granted';
    if (permission !== 'granted') {
      return { ok: false, reason: 'File permission denied.' };
    }

    try {
      const writable = await handle.createWritable();
      const payload = JSON.stringify({ annotations }, null, 2);
      await writable.write(payload);
      await writable.close();
      return { ok: true };
    } catch {
      return { ok: false, reason: 'Unable to write file.' };
    }
  }

  private async getHandle(sceneId: string): Promise<FileSystemFileHandle | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(sceneId);
      request.onsuccess = () => {
        const value = request.result as FileHandleRecord | undefined;
        resolve(value?.handle ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  private async putHandle(sceneId: string, handle: FileSystemFileHandle): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put({ sceneId, handle } satisfies FileHandleRecord);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'sceneId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
