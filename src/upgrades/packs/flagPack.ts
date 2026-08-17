export function makeFlagPack(
  id: string,
  onMessage: string
): { enable: () => void; disable: () => void } {
  let on = false;
  return {
    enable() {
      on = true;
      console.log(`[upgrades] ${id} ON — ${onMessage}`);
    },
    disable() {
      if (on) console.log(`[upgrades] ${id} OFF`);
      on = false;
    },
  };
}
