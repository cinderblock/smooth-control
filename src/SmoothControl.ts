import { EventEmitter } from 'events';
import * as USB from 'usb';
import TypedEventEmitter from 'typed-emitter';

import DebugFunctions, { DebugOptions } from './utils/Debug';
import { SharedPromise } from './utils/SharedPromise';
import { validateNumber } from './utils/validateNumber';

import { motors } from './ConnectedMotorManager';
import {
  ReadData,
  Command,
  reportLength,
  parseHostDataIN,
  CommandMode,
  ServoMode,
  MultiTurn,
  isFaultState,
  isInitData,
  isNormalState,
} from './parseData';

export {
  CommandMode,
  ClearFaultCommand,
  MLXCommand,
  ThreePhaseCommand,
  CalibrationCommand,
  PushCommand,
  ServoDisabledCommand,
  ServoAmplitudeCommand,
  ServoVelocityCommand,
  ServoPositionCommand,
  isServoDisabledCommand,
  isServoAmplitudeCommand,
  isServoVelocityCommand,
  isServoPositionCommand,
  ServoCommand,
  MultiTurn,
  kPID,
  SynchronousCommand,
  BootloaderCommand,
  Command,
  isClearFaultCommand,
  isMLXCommand,
  isThreePhaseCommand,
  isCalibrationCommand,
  isPushCommand,
  isServoCommand,
  isSynchronousCommand,
  isBootloaderCommand,
  ControllerState,
  ControllerFault,
  MlxResponseState,
  FaultData,
  InitData,
  OtherFaults,
  isInitData,
  isOtherFaults,
  ManualData,
  NormalData,
  CommonData,
  ReadData,
  isFaultState,
  isManualState,
  isNormalState,
  parseHostDataIN,
} from './parseData';
export { addAttachListener, start } from './ConnectedMotorManager';

// Make melexis sub module easily accessible to others
export * as Melexis from 'mlx90363';

/**
 * Internal granularity of sin wave for each phase
 */
const StepsPerPhase = 256;

/**
 * One for each of A, B, and C.
 */
const PhasesPerCycle = 3;

/**
 * One Cycle is one full commutation (aka electrical revolution) of the motor.
 * This is almost certainly not one actual revolution of the motor shaft.
 */
export const StepsPerCycle = StepsPerPhase * PhasesPerCycle;

interface Events {
  status: (status: 'missing' | 'connected') => void;
  data: (data: ReadData) => void;
  error: (err: USB.LibUSBException) => void;
}

type Options = {
  debug?: DebugOptions;
  polling?: number | boolean;
};

/**
 * Compute MultiTurn from motor units
 * @param turns motor revolutions
 * @param CyclesPerRevolution typical values: 7, 15, and 21 (reported by motor with InitData)
 */
export function ComputeCommutationTurns(turns: number, CyclesPerRevolution: number): MultiTurn {
  let commutation = turns % 1;

  turns = ~~turns;

  // Handle negative % returning negative value
  while (commutation < 0) {
    commutation += 1;
    turns--;
  }

  // Scale to motor units
  commutation *= CyclesPerRevolution * StepsPerCycle;

  // We could use Math.floor and avoid the following fix, but this seems better
  commutation = Math.round(commutation);

  // In case the rounding bumps us to a full revolution
  while (commutation >= CyclesPerRevolution * StepsPerCycle) {
    commutation -= CyclesPerRevolution * StepsPerCycle;
    turns++;
  }

  return { commutation, turns };
}

export interface USBInterface {
  /**
   * Get notified on motor disconnect
   */
  onStatus: (handler: (status: 'connected' | 'missing') => void) => () => void;

  /**
   * Receive polling updates from motor
   */
  onData: (handler: (data: ReadData) => void) => () => void;

  /**
   * Handle errors that happen
   */
  onError: (handler: (err: USB.LibUSBException | Error) => void) => () => void;

  /**
   * Efficient manual write. Do not call before previous write has finished.
   */
  write: (command: Command) => false | Promise<unknown>;
  /**
   * Manual read. Inefficient.
   */
  read: () => false | Promise<ReadData>;

  /**
   * Close the current connection and stop looking for this serial
   */
  close: () => void;
}

interface Transfer {
  new (
    device: USB.Device,
    address: number,
    transferType: number,
    timeout: number,
    callback: (error: any, buf: Buffer, actual: number) => void
  ): Transfer;

  submit(buffer: Buffer): void;
}

/**
 * Manages a single motor connection (and reconnection). Won't do anything until `start` is called.
 * @param serial Serial number of motor to find
 * @param options
 */
export default function USBInterface(serial: string, options?: Options): USBInterface {
  if (!serial) throw new Error('Invalid ID');

  let CyclesPerRevolution: number;

  options = options || {};

  let polling = (options.polling === undefined || options.polling === true ? 3 : options.polling) || 0;

  const { info, debug, warning } = DebugFunctions(options.debug);

  let device: USB.Device | undefined;

  // Use non public API because the public one is inefficient
  let endpoint: USB.InEndpoint & {
    makeTransfer: (timeout: number, callback: (error: any, buf: Buffer, actual: number) => void) => Transfer;
  };

  const events = new EventEmitter() as TypedEventEmitter<Events>;

  /**
   * Object that we reuse for efficient transfers to devices
   */
  let outTransfer: Transfer;
  let outTransferPromise: SharedPromise<{ buffer: Buffer; actual: number }> | undefined;

  let status: 'missing' | 'connected';

  // Allocate a write buffer once and keep reusing it
  // const writeBuffer = Buffer.alloc(reportLength);

  const sendBuffer = Buffer.alloc(reportLength + USB.LIBUSB_CONTROL_SETUP_SIZE);
  const writeBuffer = sendBuffer.slice(USB.LIBUSB_CONTROL_SETUP_SIZE);

  sendBuffer.writeUInt8(USB.LIBUSB_RECIPIENT_INTERFACE | USB.LIBUSB_REQUEST_TYPE_CLASS | USB.LIBUSB_ENDPOINT_OUT, 0);
  sendBuffer.writeUInt8(0x09, 1);
  sendBuffer.writeUInt16LE(0x0809, 2);
  sendBuffer.writeUInt16LE(0, 4);
  sendBuffer.writeUInt16LE(writeBuffer.length, 6);

  const found = motors.find((d) => serial == d.serial);
  if (found) {
    if (found.consumer) {
      throw new Error("Can't have two consumers of the same serial number: " + serial);
    } else {
      found.consumer = { onAttach, onDetach };
      if (found.device) onAttach(found.device);
    }
  } else {
    motors.push({ serial, consumer: { onAttach, onDetach } });
  }

  async function onAttach(dev: USB.Device) {
    info('Attaching', serial);

    dev.open();

    device = dev;

    // Use non public API because the public one is inefficient
    const usbHiddenAPI = USB as typeof USB & {
      Transfer: Transfer;
    };

    outTransfer = new usbHiddenAPI.Transfer(
      device,
      0,
      USB.LIBUSB_TRANSFER_TYPE_CONTROL,
      1000,
      (error: any, buffer: Buffer, actual: number) => {
        if (error) outTransferPromise?.reject?.(error);
        else outTransferPromise?.resolve?.({ buffer, actual });

        outTransferPromise = undefined;
      }
    );

    // Motor HID interface is always interface 0
    const hidInterface = device.interface(0);

    if (process.platform != 'win32' && hidInterface.isKernelDriverActive()) hidInterface.detachKernelDriver();

    hidInterface.claim();

    // Store interface number as first number in write buffer
    writeBuffer[0] = hidInterface.interfaceNumber;

    // Motor HID IN endpoint is always endpoint 0
    endpoint = hidInterface.endpoints[0] as typeof endpoint;

    const inBuffer = Buffer.allocUnsafe(reportLength);

    const inDataObject = {} as ReadData;

    const inTransfer = endpoint.makeTransfer(1000, (error: USB.LibUSBException, buf: Buffer, actual: number) => {
      if (error) {
        if (error.errno != USB.LIBUSB_TRANSFER_STALL) {
          events.emit('error', error);

          return;
        } else {
          // LIBUSB_TRANSFER_STALL
        }
      } else {
        try {
          parseHostDataIN(buf.slice(0, actual), inDataObject);
          if (CyclesPerRevolution !== undefined && isNormalState(inDataObject)) {
            inDataObject.position =
              inDataObject.multi.turns * CyclesPerRevolution * StepsPerCycle + inDataObject.multi.commutation;
          }
          events.emit('data', parseHostDataIN(buf.slice(0, actual), inDataObject));
        } catch (e) {
          events.emit('error', e);
        }
      }

      if (polling) startInTransfer();
    });

    // TODO: Use this function for non-polling reading of data
    function startInTransfer() {
      inTransfer.submit(inBuffer);
    }

    if (polling) {
      startInTransfer();
    }

    endpoint.on('error', (err) => {
      if (err.errno == USB.LIBUSB_TRANSFER_STALL) return;

      events.emit('error', err);

      onDetach();
    });

    events.emit('status', (status = 'connected'));

    info('Attached', serial);
  }

  function close() {
    if (!device) return;

    const dev = device;

    if (!polling) dev.close();
    else {
      events.on('data', () => {
        dev.close();
      });
      polling = 0;
    }

    const found = motors.find((d) => serial == d.serial);
    if (found) {
      found.consumer = undefined;
      found.device = undefined;
    } else {
      throw new Error('How is the device not found?');
    }
  }

  function onDetach() {
    events.emit('status', (status = 'missing'));

    info('Detach', serial);

    device = undefined;
  }

  // Manual read. Not efficient.
  function read() {
    if (!device) {
      warning('Trying to read with no motor attached.', serial);
      return false;
    }

    return new Promise<ReadData>((resolve, reject) => {
      endpoint.transfer(reportLength, (err, data) => {
        if (
          err ||
          // && err.errno != USB.LIBUSB_TRANSFER_STALL
          !data
        ) {
          warning('Rejected trying to receive.', data);
          reject(err);
        } else {
          const ret = parseHostDataIN(data);
          if (CyclesPerRevolution !== undefined && isNormalState(ret)) {
            ret.position = ret.multi.turns * CyclesPerRevolution * StepsPerCycle + ret.multi.commutation;
          }
          resolve(ret);
        }
      });
    });
  }

  /**
   *
   * @param command Command to send
   * @param cb
   */
  function write(command: Command) {
    if (!device) {
      warning('Trying to write with no motor attached.', serial, command);
      return false;
    }

    if (outTransferPromise) {
      throw new Error('Previous write not complete');
    }

    let pos = 1;
    function writeNumberToBuffer(num: number, len = 1, signed = false) {
      pos = writeBuffer[signed ? 'writeIntLE' : 'writeUIntLE'](Math.round(num), pos, len);
    }

    try {
      writeNumberToBuffer(command.mode);

      switch (command.mode) {
        case CommandMode.MLXDebug:
          if (command.data === undefined) throw new Error('Argument `data` missing');
          if (!(command.data.length == 7 || command.data.length == 8))
            throw new Error('Argument `data` has incorrect length');

          command.data.copy(writeBuffer, pos);
          pos += 8;
          const generateCRC = command.crc || command.data.length == 7;
          writeNumberToBuffer(generateCRC ? 1 : 0);
          break;

        case CommandMode.ThreePhase:
          {
            const max = 1 << 11;
            validateNumber('A', command.A, max);
            validateNumber('B', command.B, max);
            validateNumber('C', command.C, max);

            writeNumberToBuffer(command.A, 2);
            writeNumberToBuffer(command.B, 2);
            writeNumberToBuffer(command.C, 2);
          }
          break;

        case CommandMode.Calibration:
          validateNumber('angle', command.angle, StepsPerCycle);
          validateNumber('amplitude', command.amplitude, 256);

          writeNumberToBuffer(command.angle, 2);
          writeNumberToBuffer(command.amplitude, 1);
          break;

        case CommandMode.Push:
          validateNumber('command', command.command, -255, 256);

          writeNumberToBuffer(command.command, 2, true);
          break;

        case CommandMode.Servo:
          validateNumber('servoMode', command.servoMode, Object.keys(ServoMode).length);

          writeNumberToBuffer(command.servoMode);

          switch (command.servoMode) {
            default:
              throw new Error('Invalid servo mode');

            case ServoMode.Disabled:
              break;

            case ServoMode.Amplitude:
              validateNumber('command', command.command, -255, 256);
              break;

            case ServoMode.Velocity:
              break;

            case ServoMode.Position:
              validateNumber('commutation', command.commutation, 1 << 16);
              validateNumber('turns', command.turns, 1 << 31, true);
              validateNumber('kP', command.kP, 1 << 16);
              validateNumber('kI', command.kI, 1 << 16);
              validateNumber('kD', command.kD, 1 << 16);

              writeNumberToBuffer(command.commutation, 2);
              writeNumberToBuffer(command.turns, 4, true);
              writeNumberToBuffer(command.kP, 2);
              writeNumberToBuffer(command.kI, 2);
              writeNumberToBuffer(command.kD, 2);
              break;
          }
          break;

        case CommandMode.SynchronousDrive:
          validateNumber('amplitude', command.amplitude, 256);

          // TODO: smaller range?
          validateNumber('velocity', command.velocity, 1 << 31, true);

          writeNumberToBuffer(command.amplitude);
          writeNumberToBuffer(command.velocity, 4, true);
          break;
      }
    } catch (e) {
      e = new TypeError('Failure parsing command' + e);
      warning(e);
      throw e;
    }

    outTransferPromise = SharedPromise();

    outTransfer.submit(sendBuffer);

    return outTransferPromise.promise;
  }

  function onStatus(handler: (status: 'missing' | 'connected') => void) {
    events.on('status', handler);
    setImmediate(() => handler(status));
    return () => {
      events.removeListener('status', handler);
    };
  }

  function onData(handler: (data: ReadData) => void) {
    events.on('data', handler);
    return () => {
      events.removeListener('data', handler);
    };
  }

  function onError(handler: (err: USB.LibUSBException | Error) => void) {
    events.on('error', handler);
    return () => {
      events.removeListener('error', handler);
    };
  }

  const initCyclesPerRevolutionOnce = onData((data) => {
    if (!isFaultState(data)) return;
    if (!isInitData(data)) return;
    CyclesPerRevolution = data.cyclesPerRevolution;
    initCyclesPerRevolutionOnce();
  });

  return { onStatus, onData, onError, write, read, close };
}
