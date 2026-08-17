let installed = false;
const originalError = console.error.bind(console);

function isSoftRpc(args: unknown[]): boolean {
  const text = args
    .map((a) => (typeof a === 'string' ? a : ''))
    .join(' ')
    .toLowerCase();
  return (
    text.includes('429') ||
    text.includes('too many requests') ||
    text.includes('compute units per second') ||
    text.includes('request blocked') ||
    text.includes('403')
  );
}

export function enableQuietRpcLogs(): void {
  if (installed) return;
  installed = true;
  console.error = (...args: unknown[]) => {
    if (isSoftRpc(args)) {
      console.warn('[rpc-soft]', ...args);
      return;
    }
    originalError(...(args as []));
  };
  console.log('[upgrades] render_rpc_quiet_logs ON');
}

export function disableQuietRpcLogs(): void {
  if (!installed) return;
  console.error = originalError;
  installed = false;
  console.log('[upgrades] render_rpc_quiet_logs OFF');
}
