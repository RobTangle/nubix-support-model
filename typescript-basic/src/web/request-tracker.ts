/** Cerrar un socket no significa que terminó la conciliación asíncrona de su ticket. */
export class RequestTracker {
  private readonly pending = new Map<AbortController, Promise<void>>();
  private closing = false;

  track(controller: AbortController): () => void {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pending.set(controller, done);
    if (this.closing) controller.abort();
    return () => {
      this.pending.delete(controller);
      finish();
    };
  }

  async drain(): Promise<void> {
    this.closing = true;
    for (const controller of this.pending.keys()) controller.abort();
    await Promise.all(this.pending.values());
  }
}
