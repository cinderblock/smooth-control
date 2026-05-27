// CI smoke tests for the pure parsing helpers. The USB transport itself
// can't be tested without a physical motor, so we cover the data-decode
// path (parseHostDataIN) plus the clipRange helper.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHostDataIN,
  ControllerState,
  ControllerFault,
  MlxResponseState,
} from './SmoothControl.js';
import clipRange from './utils/clipRange.js';

// Builds a 37-byte report mirroring the firmware's USBDataINShape.
function buildReport({
  state = ControllerState.Normal,
  fault = ControllerFault.Init,
  position = 0,
  velocity = 0,
  statusBitsRaw = 0,
  cpuTemp = 0,
  current = 0,
  VDD = 0,
  vBatt = 0,
  forward = 1,
  amplitudeMag = 0,
  AS = 0,
  BS = 0,
  CS = 0,
  mlxResponse = Buffer.alloc(8),
  mlxResponseState = MlxResponseState.Init,
  controlLoops = 0,
  mlxCRCFailures = 0,
}: {
  state?: number;
  fault?: number;
  position?: number;
  velocity?: number;
  statusBitsRaw?: number;
  cpuTemp?: number;
  current?: number;
  VDD?: number;
  vBatt?: number;
  forward?: 0 | 1;
  amplitudeMag?: number;
  AS?: number;
  BS?: number;
  CS?: number;
  mlxResponse?: Buffer;
  mlxResponseState?: number;
  controlLoops?: number;
  mlxCRCFailures?: number;
}): Buffer {
  const b = Buffer.alloc(37);
  let i = 0;
  b.writeUInt8(state, i);
  i += 1;
  b.writeUInt8(fault, i);
  i += 1;
  b.writeUInt16LE(position, i);
  i += 2;
  b.writeInt16LE(velocity, i);
  i += 2;
  b.writeUInt16LE(statusBitsRaw, i);
  i += 2;
  b.writeUInt16LE(cpuTemp, i);
  i += 2;
  b.writeInt16LE(current, i);
  i += 2;
  b.writeUInt16LE(VDD, i);
  i += 2;
  b.writeUInt16LE(vBatt, i);
  i += 2;
  b.writeUInt8(forward, i);
  i += 1;
  b.writeUInt8(amplitudeMag, i);
  i += 1;
  b.writeUInt16LE(AS, i);
  i += 2;
  b.writeUInt16LE(BS, i);
  i += 2;
  b.writeUInt16LE(CS, i);
  i += 2;
  mlxResponse.copy(b, i);
  i += 8;
  b.writeUInt8(mlxResponseState, i);
  i += 1;
  b.writeUInt16LE(controlLoops, i);
  i += 2;
  b.writeUInt16LE(mlxCRCFailures, i);
  i += 2;
  assert.equal(i, 37, `internal: builder wrote ${i} bytes, expected 37`);
  return b;
}

describe('parseHostDataIN', () => {
  it('rejects a buffer of the wrong length', () => {
    assert.throws(() => parseHostDataIN(Buffer.alloc(36)), /Invalid data/);
    assert.throws(() => parseHostDataIN(Buffer.alloc(38)), /Invalid data/);
  });

  it('parses a minimal all-zero report', () => {
    const r = parseHostDataIN(buildReport({}));
    assert.equal(r.state, ControllerState.Normal);
    assert.equal(r.fault, ControllerFault.Init);
    assert.equal(r.position, 0);
    assert.equal(r.velocity, 0);
    assert.equal(r.amplitude, 0);
    assert.equal(r.calibrated, false);
    assert.equal(r.controlLoops, 0);
    assert.equal(r.mlxCRCFailures, 0);
    // mlxDataValid bit is off (statusBitsRaw=0), so no mlxResponse/parsed
    assert.equal(r.mlxResponse, undefined);
    assert.equal(r.mlxResponseState, undefined);
  });

  it('sign-extends velocity through readInt16LE', () => {
    const r = parseHostDataIN(buildReport({ velocity: -1234 }));
    assert.equal(r.velocity, -1234);
  });

  it('applies forward=0 as a negative amplitude sign', () => {
    const r = parseHostDataIN(buildReport({ forward: 0, amplitudeMag: 17 }));
    assert.equal(r.amplitude, -17);
  });

  it('applies forward=1 as a positive amplitude sign', () => {
    const r = parseHostDataIN(buildReport({ forward: 1, amplitudeMag: 17 }));
    assert.equal(r.amplitude, 17);
  });

  it('reads the calibrated bit (bit 15 of statusBitsRaw)', () => {
    const r = parseHostDataIN(buildReport({ statusBitsRaw: 1 << 15 }));
    assert.equal(r.calibrated, true);
  });

  it('exposes mlx fields when the mlxDataValid bit (bit 14) is set', () => {
    const mlxResponse = Buffer.alloc(8);
    mlxResponse[7] = 0x42; // arbitrary
    const r = parseHostDataIN(
      buildReport({
        statusBitsRaw: 1 << 14,
        mlxResponse,
        mlxResponseState: MlxResponseState.failedCRC,
      })
    );
    assert.ok(r.mlxResponse);
    assert.equal(r.mlxResponseState, MlxResponseState.failedCRC);
    assert.ok('mlxParsedResponse' in r);
  });

  it('round-trips controlLoops and mlxCRCFailures', () => {
    const r = parseHostDataIN(
      buildReport({ controlLoops: 12345, mlxCRCFailures: 7 })
    );
    assert.equal(r.controlLoops, 12345);
    assert.equal(r.mlxCRCFailures, 7);
  });
});

describe('clipRange', () => {
  it('clamps above max', () => {
    assert.equal(clipRange(10)(15), 10);
  });

  it('clamps below min', () => {
    assert.equal(clipRange(10)(-5), 0);
  });

  it('passes values within range through', () => {
    assert.equal(clipRange(10)(5), 5);
    assert.equal(clipRange(10)(0), 0);
    assert.equal(clipRange(10)(10), 10);
  });

  it('uses default min=0', () => {
    assert.equal(clipRange(100)(-1), 0);
  });

  it('honors an explicit min', () => {
    assert.equal(clipRange(10, -10)(-15), -10);
    assert.equal(clipRange(10, -10)(0), 0);
  });

  it('swaps args if max < min', () => {
    // (max=-5, min=5) -> clip(value, 5..-5) ends up sorted to (-5..5)
    assert.equal(clipRange(-5, 5)(0), 0);
    assert.equal(clipRange(-5, 5)(-10), -5);
    assert.equal(clipRange(-5, 5)(10), 5);
  });
});
