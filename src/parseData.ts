import { parseData, Messages } from 'mlx90363';

function parseMLX(mlxResponse: Buffer): Messages | string {
  try {
    return parseData(mlxResponse);
  } catch (e) {
    return e.toString();
  }
}

// Must match REPORT_SIZE
export const reportLength = 33;

// Matches PacketFormats.h
export enum CommandMode {
  MLXDebug = 0,
  ThreePhase = 1,
  Calibration = 2,
  Push = 3,
  Servo = 4,
  ClearFault = 5,
  SynchronousDrive = 6,
  Bootloader = 0xfe,
}

export type ClearFaultCommand = {
  mode: CommandMode.ClearFault;
};

export type MLXCommand = {
  mode: CommandMode.MLXDebug;
  data: Buffer;
  crc?: boolean;
};

export type ThreePhaseCommand = {
  mode: CommandMode.ThreePhase;
  A: number;
  B: number;
  C: number;
};

export type CalibrationCommand = {
  mode: CommandMode.Calibration;
  angle: number;
  amplitude: number;
};

export type PushCommand = {
  mode: CommandMode.Push;
  command: number;
};

export type ServoCommand = {
  mode: CommandMode.Servo;
  command: number;
  pwmMode: 'pwm' | 'position' | 'velocity' | 'spare' | 'command' | 'kP' | 'kI' | 'kD' | 'amplitudeLimit';
};

export type SynchronousCommand = {
  mode: CommandMode.SynchronousDrive;
  amplitude: number;
  /**
   * Velocity command motor should maintain on its own
   *
   * Match motor hardware / firmware
   * const motorCountsPerRevolution = 3 * 256 * 21;
   * const OverPrecisionBits = 32;
   * const MicroTicksPerSecond = 16e6;
   * const velocityUnitMultiplier = (motorCountsPerRevolution << OverPrecisionBits) / MicroTicksPerSecond;
   *
   * velocity = revolutionsPerSecond * (motorCountsPerRevolution << OverPrecisionBits) / MicroTicksPerSecond;
   *
   * @units Extra precision motor counts per MicroTick period
   */
  velocity: number;
};

export type BootloaderCommand = {
  mode: CommandMode.Bootloader;
};

export type Command =
  | ClearFaultCommand
  | MLXCommand
  | ThreePhaseCommand
  | CalibrationCommand
  | PushCommand
  | ServoCommand
  | SynchronousCommand
  | BootloaderCommand;

// Matches main.hpp State
export enum ControllerState {
  Fault,
  Manual,
  Normal,
}

// Matches main.hpp Fault
export enum ControllerFault {
  Init,
  UnderVoltageLockout,
  OverCurrent,
  OverTemperature,
  WatchdogReset,
  BrownOutReset,
  InvalidCommand,
}

export enum MlxResponseState {
  Init,
  Ready,
  Receiving,
  Received,
  failedCRC,
  TypeA,
  TypeAB,
  TypeXYZ,
  Other,
}

export type FaultData = {
  state: ControllerState.Fault;

  fault: ControllerFault;
};

type GoodMlxResponse = {
  mlxDataValid: true;

  mlxResponse: Buffer;
  mlxResponseState: MlxResponseState;
  mlxParsedResponse: Messages | string;
};

type BadMlxResponse = {
  mlxDataValid: false;
};

export type ManualData = {
  state: ControllerState.Manual;

  /**
   * Motor position
   * @units motor counts
   */
  position: number;
  /**
   * Not yet implemented
   */
  velocity: number;

  /**
   * How hard are we trying to "push"
   * @units pwm %
   * @range [0, 255]
   */
  amplitude: number;
} & (GoodMlxResponse | BadMlxResponse);

export type NormalData = {
  state: ControllerState.Normal;

  /**
   * Motor position
   * @units motor counts
   */
  position: number;
  /**
   * Velocity estimate
   *
   * Match motor hardware / firmware
   * const motorCountsPerRevolution = 3 * 256 * 21;
   * const timerCounts =
   * const velocityUnitMultiplier = motorCountsPerRevolution / timerCounts;
   *
   * velocity = revolutionsPerSecond * motorCountsPerRevolution / timerCounts;
   *
   * @units Motor counts per TODO: check units
   */
  velocity: number;

  /**
   * How hard are we trying to "push"
   * @units pwm %
   * @range [-255, 255]
   */
  amplitude: number;

  calibrated: boolean; // lookupValid;

  controlLoops: number;
  mlxCRCFailures: number;

  extra4: number;
  extra2: number;
  extra1: number;
};

export type CommonData = {
  cpuTemp: number;
  current: number;
  vBatt: number;
  VDD: number;
  AS: number;
  BS: number;
  CS: number;
};

export type ReadData = (FaultData | ManualData | NormalData) & CommonData;

export function isFaultState(data: ReadData): data is FaultData & CommonData {
  return data.state === ControllerState.Fault;
}

export function isManualState(data: ReadData): data is ManualData & CommonData {
  return data.state === ControllerState.Manual;
}

export function isNormalState(data: ReadData): data is NormalData & CommonData {
  return data.state === ControllerState.Normal;
}

/**
 * Parse block of bytes from motor into logical object
 *
 * @param data Raw block of bytes from a motor packet
 */
export function parseHostDataIN(data: Buffer, ret = {} as ReadData): ReadData {
  if (data.length != reportLength) {
    const e = new Error('Invalid data. Refusing to parse') as Error & { data: Buffer };
    e.data = data;
    throw e;
  }

  let readPosition = 0;
  function read(length: number, signed: boolean = false) {
    const pos = readPosition;
    readPosition += length;
    if (signed) return data.readIntLE(pos, length);
    return data.readUIntLE(pos, length);
  }
  function readBuffer(length: number) {
    const ret = Buffer.allocUnsafe(length);
    readPosition += data.copy(ret, 0, readPosition);
    return ret;
  }

  // Matches USB/PacketFormats.h USBDataINShape
  ret.state = read(1);

  switch (ret.state) {
    case ControllerState.Fault:
      const faultData: FaultData = ret;
      faultData.fault = read(1);
      break;

    case ControllerState.Manual:
      const manualData: ManualData = ret;
      manualData.position = read(2);
      manualData.velocity = read(4, true);
      // Skip sign bit that we know is always 0 in ManualData
      readPosition++;
      manualData.amplitude = read(1);

      manualData.mlxDataValid = !!read(1);

      if (manualData.mlxDataValid) {
        const res = readBuffer(8);
        manualData.mlxResponseState = read(1);

        if (manualData.mlxResponseState > MlxResponseState.Ready) {
          manualData.mlxResponse = res;
          manualData.mlxParsedResponse = parseMLX(res);
        }
      }

      break;

    case ControllerState.Normal:
      const normalData: NormalData = ret;
      normalData.position = read(2);
      normalData.velocity = read(2, true);
      normalData.amplitude = (!!read(1) ? 1 : -1) * read(1);

      normalData.calibrated = !!read(1);

      normalData.controlLoops = read(2);
      normalData.mlxCRCFailures = read(2);

      normalData.extra4 = read(4, true);
      normalData.extra2 = read(2, true);
      normalData.extra1 = read(1, true);
      break;
  }

  readPosition = 1 + Math.max(1, 18, 11);

  ret.cpuTemp = read(2);
  ret.current = read(2, true);
  ret.VDD = read(2);
  ret.vBatt = read(2);
  ret.AS = read(2);
  ret.BS = read(2);
  ret.CS = read(2);

  return ret;
}
