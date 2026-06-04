/** Per-agent R2 file storage client. */
export interface StorageClient {
  put(key: string, data: ReadableStream | ArrayBuffer | string): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; size: number; uploaded: string }[]>;
}
