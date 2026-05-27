# @cinderblock/smooth-control

Node.js API for controlling Smooth Control motors (Quantum Drive / Hover
Drive) over USB HID. Companion to the firmware at
[`cinderblock/3-Phase-Controller`](https://github.com/cinderblock/3-Phase-Controller).

## Status

ESM, TypeScript 5+, Node 22+. Builds + parses-side tests run in CI on Node 22
and 24. USB transport behavior requires a physical motor and is not exercised
in CI.

## Install

```bash
npm install @cinderblock/smooth-control
```

On Linux you'll also need `libudev-dev` for the `usb` native dependency to
build.

## Usage

```ts
import USBInterface, {
  addAttachListener,
  start,
  CommandMode,
} from '@cinderblock/smooth-control';

start();

addAttachListener((serial, _device, duplicate) => {
  if (duplicate) return;
  console.log('Motor attached:', serial);

  const motor = USBInterface(serial);
  motor.onData((data) => {
    console.log('state:', data.state, 'position:', data.position);
  });

  // Send a velocity command
  motor.write({ mode: CommandMode.Servo, command: 1000, pwmMode: 'velocity' });
});
```

## What's exported

- `USBInterface(serial, options?)` — default export. Returns the per-motor
  control object (`{ onStatus, onData, onError, write, read, start, close }`).
- `start(options?)`, `addAttachListener(listener)` — global setup hooks.
- `parseHostDataIN(buffer)` — pure parser for the 37-byte IN report; useful
  for log replay / testing.
- `CommandMode`, `ControllerState`, `ControllerFault`, `MlxResponseState` — enums.
- All the command types (`MLXCommand`, `ThreePhaseCommand`, `CalibrationCommand`,
  `PushCommand`, `ServoCommand`, `BootloaderCommand`, `ClearFaultCommand`,
  `Command`).
- `Melexis` — namespace re-export of `@cinderblock/mlx90363` for convenience.
- `ReadData`, `WriteError` — result/error shapes.

## Development

```bash
npm ci
npm run build      # tsc -> dist/
npm test           # node --test, covers parseHostDataIN + clipRange
npm run format     # prettier
```

CI runs the build + test matrix on Node 22 and Node 24. Releases are tagged
(`vX.Y.Z`) and published to npm via OIDC trusted publishing.
