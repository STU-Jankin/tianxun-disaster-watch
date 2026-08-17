export type IngestionHealth = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  onlineSources: number;
  producingSources: number;
  persistenceAvailable: boolean;
};

const state = globalThis as typeof globalThis & { __tianxunIngestionHealth?: IngestionHealth };

export function updateIngestionHealth(update: IngestionHealth) {
  state.__tianxunIngestionHealth = update;
}

export function getIngestionHealth(): IngestionHealth {
  return state.__tianxunIngestionHealth ?? {
    lastAttemptAt: null,
    lastSuccessAt: null,
    onlineSources: 0,
    producingSources: 0,
    persistenceAvailable: true,
  };
}
