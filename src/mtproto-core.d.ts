declare module "@mtproto/core/envs/browser" {
  interface MTProtoOptions {
    api_id: number;
    api_hash: string;
    test?: boolean;
    storageOptions?: {
      instance?: {
        get(key: string): Promise<string | null>;
        set(key: string, value: string): Promise<void>;
      };
    };
  }

  export default class MTProto {
    constructor(options: MTProtoOptions);
    call<T = unknown>(method: string, params: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>;
    setDefaultDc(dcId: number): Promise<void>;
  }
}
