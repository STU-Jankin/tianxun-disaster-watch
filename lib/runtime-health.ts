export type IngestionHealth = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  configuredSources: number;
  totalSources: number;
  onlineSources: number;
  producingSources: number;
  eventCapableSources: number;
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
    configuredSources: 0,
    totalSources: 0,
    onlineSources: 0,
    producingSources: 0,
    eventCapableSources: 0,
    persistenceAvailable: true,
  };
}
