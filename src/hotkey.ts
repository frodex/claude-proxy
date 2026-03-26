// src/hotkey.ts

const CTRL_B = 0x02;

interface HotkeyCallbacks {
  onPassthrough: (data: Buffer) => void;
  onDetach: () => void;
  onClaimSize: () => void;
  onScrollback: () => void;
  timeoutMs?: number;
}

export class HotkeyHandler {
  private prefixActive = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private callbacks: HotkeyCallbacks;
  private timeoutMs: number;

  constructor(callbacks: HotkeyCallbacks) {
    this.callbacks = callbacks;
    this.timeoutMs = callbacks.timeoutMs ?? 1000;
  }

  feed(data: Buffer): void {
    if (this.prefixActive) {
      this.clearTimeout();
      this.prefixActive = false;

      if (data.length === 1) {
        const byte = data[0];
        if (byte === 0x64) {  // 'd'
          this.callbacks.onDetach();
          return;
        }
        if (byte === 0x73) {  // 's'
          this.callbacks.onClaimSize();
          return;
        }
        if (byte === 0x68) {  // 'h'
          this.callbacks.onScrollback();
          return;
        }
        if (byte === CTRL_B) {  // Ctrl+B again — pass single Ctrl+B
          this.callbacks.onPassthrough(Buffer.from([CTRL_B]));
          return;
        }
      }

      // Unknown command — pass prefix + data through
      this.callbacks.onPassthrough(Buffer.concat([Buffer.from([CTRL_B]), data]));
      return;
    }

    // Check if this data starts with Ctrl+B
    if (data.length === 1 && data[0] === CTRL_B) {
      this.prefixActive = true;
      this.timeout = setTimeout(() => {
        this.prefixActive = false;
        this.callbacks.onPassthrough(Buffer.from([CTRL_B]));
      }, this.timeoutMs);
      return;
    }

    this.callbacks.onPassthrough(data);
  }

  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  destroy(): void {
    this.clearTimeout();
  }
}
