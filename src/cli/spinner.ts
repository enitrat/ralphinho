/**
 * Minimal CLI spinner — keeps terminal I/O in the CLI layer.
 */
export function createSpinner(message: string) {
  const frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
  let idx = 0;
  let interval: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      interval = setInterval(() => {
        process.stdout.write(`\r${frames[idx++ % frames.length]} ${message}`);
      }, 80);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      process.stdout.write("\r\x1b[K");
    },
  };
}
