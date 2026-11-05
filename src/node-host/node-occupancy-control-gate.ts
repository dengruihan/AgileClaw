/** Exclusive FIFO admission for interactive control commands under one lease. */

/**
 * Serializes control-tool invocations (browser, computer, desktop) that mutate
 * one shared device resource. Exec and file commands bypass the gate entirely,
 * so they stay parallel with each other and with one active control call.
 */
export class NodeOccupancyControlGate {
  private active = false;
  private readonly queue: Array<() => void> = [];

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.enter();
    try {
      return await operation();
    } finally {
      this.leave();
    }
  }

  private enter(): Promise<void> {
    if (!this.active && this.queue.length === 0) {
      this.active = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private leave(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active = false;
  }
}
