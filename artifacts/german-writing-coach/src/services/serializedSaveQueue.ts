/**
 * Runs optimistic-lock saves strictly in invocation order. A rejected save does
 * not poison later explicit recovery attempts, while every caller still sees
 * its own failure.
 */
export class SerializedSaveQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }
}
