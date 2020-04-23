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

export enum ServoMode {
  Disabled = 0,
  Amplitude = 1,
  Velocity = 2,
  Position = 3,
}

type ServoCommandBase<mode extends ServoMode> = {
  mode: CommandMode.Servo;
  servoMode: mode;
};

export type ServoDisabledCommand = ServoCommandBase<ServoMode.Disabled>;

export type ServoAmplitudeCommand = ServoCommandBase<ServoMode.Amplitude> & {
  /**
   * @range [-255, 255]
   */
  command: number;
};

export type kPID = {
  /**
   * Always negative (transmitted as positive integer)
   * @range u2
   */
  kP: number;

  /**
   * Always negative (transmitted as positive integer)
   * @range u2
   */
  kI: number;

  /**
   * Always negative (transmitted as positive integer)
   * @range u2
   */
  kD: number;
};

export type ServoVelocityCommand = ServoCommandBase<ServoMode.Velocity> & {
  // TODO: Implement
};

export type MultiTurn = {
  /**
   * @range [0, StepsPerRevolution)
   */
  commutation: number;

  /**
   * @range s4
   */
  turns: number;
};

export type ServoPositionCommand = ServoCommandBase<ServoMode.Position> & MultiTurn & kPID;

export type ServoCommand = ServoDisabledCommand | ServoAmplitudeCommand | ServoVelocityCommand | ServoPositionCommand;

export function isServoDisabledCommand(cmd: ServoCommand): cmd is ServoDisabledCommand {
  return cmd.servoMode == ServoMode.Disabled;
}
export function isServoAmplitudeCommand(cmd: ServoCommand): cmd is ServoAmplitudeCommand {
  return cmd.servoMode == ServoMode.Amplitude;
}
export function isServoVelocityCommand(cmd: ServoCommand): cmd is ServoVelocityCommand {
  return cmd.servoMode == ServoMode.Velocity;
}
export function isServoPositionCommand(cmd: ServoCommand): cmd is ServoPositionCommand {
  return cmd.servoMode == ServoMode.Position;
}

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

export function isClearFaultCommand(command: Command): command is ClearFaultCommand {
  return command.mode == CommandMode.ClearFault;
}
export function isMLXCommand(command: Command): command is MLXCommand {
  return command.mode == CommandMode.MLXDebug;
}
export function isThreePhaseCommand(command: Command): command is ThreePhaseCommand {
  return command.mode == CommandMode.ThreePhase;
}
export function isCalibrationCommand(command: Command): command is CalibrationCommand {
  return command.mode == CommandMode.Calibration;
}
export function isPushCommand(command: Command): command is PushCommand {
  return command.mode == CommandMode.Push;
}
export function isServoCommand(command: Command): command is ServoCommand {
  return command.mode == CommandMode.Servo;
}
export function isSynchronousCommand(command: Command): command is SynchronousCommand {
  return command.mode == CommandMode.SynchronousDrive;
}
export function isBootloaderCommand(command: Command): command is BootloaderCommand {
  return command.mode == CommandMode.Bootloader;
}

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

export type ManualData = {
  state: ControllerState.Manual;

  /**
   * Motor position, as driven
   * @units motor counts
   */
  drivePosition: number;

  /**
   * Motor position
   * @units motor counts
   */
  realPosition: number;

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

  mlxResponse: Buffer;
  mlxResponseState: MlxResponseState;
  mlxParsedResponse?: Messages | string;
};

export type NormalData = {
  state: ControllerState.Normal;

  /**
   * Motor position
   * @units motor counts
   */
  position: number;

  multi: MultiTurn;

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

  controlLoops: number;
  mlxCRCFailures: number;

  /**
   * The last few, currently unused, bytes in the packet.
   * Sometimes used in development.
   */
  extra: Buffer;
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
      manualData.drivePosition = read(2);
      manualData.realPosition = read(2);
      manualData.velocity = read(4, true);

      manualData.amplitude = read(1);

      manualData.mlxResponseState = read(1);

      manualData.mlxResponse = readBuffer(8);

      if (manualData.mlxResponseState > MlxResponseState.Received) {
        manualData.mlxParsedResponse = parseMLX(manualData.mlxResponse);
      }

      break;

    case ControllerState.Normal:
      const normalData: NormalData = ret;
      normalData.multi = {} as MultiTurn;
      normalData.multi.commutation = read(2);
      normalData.multi.turns = read(4, true);
      normalData.velocity = read(2, true);
      normalData.amplitude = (!!read(1) ? 1 : -1) * read(1);

      normalData.controlLoops = read(2);
      normalData.mlxCRCFailures = read(2);

      normalData.extra = readBuffer(4);
      break;
  }

  readPosition = 1 + Math.max(1, 18, 14);

  ret.cpuTemp = read(2);
  ret.current = read(2, true);
  ret.VDD = read(2);
  ret.vBatt = read(2);
  ret.AS = read(2);
  ret.BS = read(2);
  ret.CS = read(2);

  return ret;
}
