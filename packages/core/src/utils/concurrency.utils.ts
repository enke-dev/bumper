/**
 * `Promise.all(items.map(fn))` with at most `limit` calls in flight: each call is gated on the one
 * `limit` slots earlier finishing, so a freed slot is reused immediately (no batch barrier).
 */
export function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const slots: Promise<R>[] = [];
  items.forEach((item, index) => {
    const gate = index < limit ? Promise.resolve() : slots[index - limit];
    slots[index] = (gate ?? Promise.resolve()).then(
      () => fn(item, index),
      () => fn(item, index)
    );
  });
  return Promise.all(slots);
}
