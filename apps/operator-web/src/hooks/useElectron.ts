export function useElectron() {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

  return {
    api,
    isElectron: Boolean(api),
  };
}
