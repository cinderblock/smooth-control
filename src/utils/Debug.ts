type DebugFunction = boolean | ((...args: any[]) => void);

export type DebugOptions =
  | DebugFunction
  | { warning?: DebugFunction; info?: DebugFunction; debug?: DebugFunction };

export default function DebugFunctions(options?: DebugOptions) {
  // Default to enabled
  if (options === undefined) options = true;

  function warning(...args: any[]) {
    if (!options) return;

    if (typeof options == 'function') {
      options('warning', ...args);
    } else if (options === true || options.warning === true) {
      console.log('Smooth Control - Warning:', ...args);
    } else if (options.warning) {
      options.warning(...args);
    }
  }

  function info(...args: any[]) {
    if (!options) return;

    if (typeof options == 'function') {
      options('info', ...args);
    } else if (options === true || options.info === true) {
      console.log('Smooth Control - info:', ...args);
    } else if (options.info) {
      options.info(...args);
    }
  }

  function debug(...args: any[]) {
    if (!options) return;

    if (typeof options == 'function') {
      options('debug', ...args);
    } else if (options === true || options.debug === true) {
      console.log('Smooth Control - debug:', ...args);
    } else if (options.debug) {
      options.debug(...args);
    }
  }

  return { info, debug, warning };
}
