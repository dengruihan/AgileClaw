let providerTransportDispatcherPoolActive = false;

export function setProviderTransportDispatcherPoolActive(active: boolean): void {
  providerTransportDispatcherPoolActive = active;
}

export function hasProviderTransportDispatcherPool(): boolean {
  return providerTransportDispatcherPoolActive;
}
