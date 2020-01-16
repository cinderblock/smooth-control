import EventEmitter = require('events');
import * as usb from 'usb';
import * as MLX from 'mlx90363';
import TypedEventEmitter from 'typed-emitter';
import clipRange from './utils/clipRange';
import DebugFunctions, { DebugOptions } from './utils/Debug';
import { SharedPromise } from './utils/SharedPromise';

const deviceVid = 0xdead;
const devicePid = 0xbeef;

function isDeviceMotorDriver(device: usb.Device) {
  const dec = device.deviceDescriptor;
  const ven = dec.idVendor;
  const prod = dec.idProduct;
  return ven == deviceVid && prod == devicePid;
}

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

// Make melexis sub module easily accessible to others
export const Melexis = MLX;

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
  pwmMode: 'pwm' | 'position' | 'velocity' | 'spare' | 'command' | 'kP' | 'kI' | 'kD';
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

// Must match REPORT_SIZE
const reportLength = 33;

export type FaultData = {
  state: ControllerState.Fault;

  fault: ControllerFault;
};

type GoodMlxResponse = {
  mlxDataValid: true;

  mlxResponse: Buffer;
  mlxResponseState: MlxResponseState;
  mlxParsedResponse: ReturnType<typeof parseMLX>;
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

interface Events {
  status: (status: 'missing' | 'connected') => void;
  data: (data: ReadData) => void;
  error: (err: usb.LibUSBException) => void;
}

/**
 * If this device is not a SmoothControl motor, do not even open it and return false.
 *
 * Otherwise read the serial number from the device and return a closed device.
 * @param dev USB Device to check
 */
async function getMotorSerial(dev: usb.Device) {
  if (!isDeviceMotorDriver(dev)) return false;

  // console.log('New Motor Device!');

  dev.open();

  try {
    const data = await new Promise<Buffer | undefined>((resolve, reject) =>
      dev.getStringDescriptor(dev.deviceDescriptor.iSerialNumber, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      })
    );

    if (!data) {
      console.log('No Serial Number detected?');
      dev.close();
      return false;
    }
    const dataStr = data
      .toString()
      .replace(/\0/g, '')
      .trim();

    // console.log('Found Motor device:', dataStr);

    dev.close();
    return dataStr;
  } catch (e) {
    console.log('ERROR reading serial number', e);
  }
  dev.close();
  return false;
}

type Options = {
  debug?: DebugOptions;
  polling?: number | boolean;
};

function parseMLX(mlxResponse: Buffer): ReturnType<typeof MLX.parseData> | string {
  try {
    return MLX.parseData(mlxResponse);
  } catch (e) {
    return e.toString();
  }
}

/**
 * Parse block of bytes from motor into logical object
 *
 * @param data Raw block of bytes from a motor packet
 */
export function parseHostDataIN(data: Buffer, ret = {} as ReadData): ReadData {
  if (data.length != reportLength) throw new Error('Invalid data. Refusing to parse');

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

interface Consumer {
  onAttach: (device: usb.Device) => void;
  onDetach: () => void;
}

/**
 * List of motors connected to host
 */
const motors: {
  serial: string;
  device?: usb.Device;
  consumer?: Consumer;
}[] = [];

type Listener = (serial: string, device: usb.Device, duplicate: boolean, consumer?: Consumer) => void;
const listeners: Listener[] = [];

export type WriteError = {
  /**
   * LibUSB Error
   */
  error: usb.LibUSBException;
  /** Device serial number */
  serial: string;
  /**
   * Command that was being sent
   */
  command: Command;
  /**
   * Nanoseconds it took to reject
   */
  time: number;
};

/**
 * Get notified whenever a motor is connected to the host
 * @param listener Function to call every time any motor device is connected
 * @returns A cleanup function to stop listening.
 */
export function addAttachListener(listener: Listener) {
  // Add to list of listeners
  listeners.push(listener);

  // Scan list if connected devices and notify of already connected devices
  motors.filter(m => m.device).forEach(m => listener(m.serial, m.device!, false, m.consumer));

  // Cleanup
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryGetMotorSerial(device: usb.Device): Promise<string> {
  while (true) {
    try {
      const ret = await getMotorSerial(device);
      if (ret) return ret;
      console.log('Empty ret!?');
    } catch (e) {
      console.log('Error reading serial');
    }
    await delay(1000);
  }
}

/**
 * Check a USB device
 * @param device USB device instance to check if it is one of us
 */
async function onDeviceAttach(device: usb.Device) {
  const serial = await getMotorSerial(device);

  if (!serial) return;

  const found = motors.find(d => serial == d.serial);
  let consumer: Consumer;
  let duplicate = false;

  if (!found) {
    // First time attach of a motor / no one looking for it
    motors.push({ serial, device });
  } else if (!found.device) {
    // No device holding this spot
    found.device = device;

    // Let our consumer know
    if (found.consumer) {
      consumer = found.consumer;
      found.consumer.onAttach(device);
    }
  } else {
    duplicate = true;
    // Don't do anything
  }

  listeners.forEach(l => l(serial, device, duplicate, consumer));
}

let started = false;
/**
 * Start actually looking for and attaching to devices
 */
export function start(options: { log?: DebugOptions } = {}) {
  const { info, warning } = DebugFunctions(options.log);
  info('Started watching for USB devices');
  // Ensure we only start searching for devices once
  if (started) {
    warning('Started again. Ignoring');
    return;
  }
  started = true;

  // When we start, find all devices
  usb.getDeviceList().forEach(onDeviceAttach);
  // And listen for any new devices connected
  usb.on('attach', onDeviceAttach);

  usb.on('detach', dev => {
    const found = motors.find(({ device }) => device == dev);

    if (found) {
      found.device = undefined;
      if (found.consumer) {
        found.consumer.onDetach();
      }
    }
  });
}

interface USBInterface {
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
  onError: (handler: (err: usb.LibUSBException) => void) => () => void;

  /**
   * Efficient manual write. Do not call before previous write has finished.
   */
  write: (command: Command) => false | Promise<unknown>;
  /**
   * Manual read. Inefficient.
   */
  read: () => false | Promise<ReadData>;

  /**
   * Close this connection
   */
  close: () => void;
}

interface Transfer {
  new (
    device: usb.Device,
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

  options = options || {};

  const polling = (options.polling === undefined || options.polling === true ? 3 : options.polling) || 0;

  const { info, debug, warning } = DebugFunctions(options.debug);

  let device: usb.Device | undefined;

  // Use non public API because the public one is inefficient
  let endpoint: usb.InEndpoint & {
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

  const sendBuffer = Buffer.alloc(reportLength + usb.LIBUSB_CONTROL_SETUP_SIZE);
  const writeBuffer = sendBuffer.slice(usb.LIBUSB_CONTROL_SETUP_SIZE);

  sendBuffer.writeUInt8(usb.LIBUSB_RECIPIENT_INTERFACE | usb.LIBUSB_REQUEST_TYPE_CLASS | usb.LIBUSB_ENDPOINT_OUT, 0);
  sendBuffer.writeUInt8(0x09, 1);
  sendBuffer.writeUInt16LE(0x0809, 2);
  sendBuffer.writeUInt16LE(0, 4);
  sendBuffer.writeUInt16LE(writeBuffer.length, 6);

  const found = motors.find(d => serial == d.serial);
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

  async function onAttach(dev: usb.Device) {
    info('Attaching', serial);

    dev.open();

    device = dev;

    // Use non public API because the public one is inefficient
    const usbHiddenAPI = usb as typeof usb & {
      Transfer: Transfer;
    };

    outTransfer = new usbHiddenAPI.Transfer(
      device,
      0,
      usb.LIBUSB_TRANSFER_TYPE_CONTROL,
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

    const inTransfer = endpoint.makeTransfer(1000, (error: Error & { errno: number }, buf: Buffer, actual: number) => {
      if (error && error.errno != 4) {
        events.emit('error', error);

        return;
      }

      try {
        events.emit('data', parseHostDataIN(buf.slice(0, actual), inDataObject));
      } catch (e) {
        events.emit('error', e);
      }

      if (polling) doInTransfer();
    });

    // TODO: Use this function for non-polling reading of data
    function doInTransfer() {
      inTransfer.submit(inBuffer);
    }

    if (polling) {
      doInTransfer();
    }

    endpoint.on('error', err => {
      if (err.errno == 4) return;

      events.emit('error', err);
    });

    events.emit('status', (status = 'connected'));

    info('Attached', serial);

    // Sample set configuration (not needed for our simple device)
    // hidDevice.controlTransfer(
    //   // bmRequestType
    //   usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_REQUEST_TYPE_STANDARD | usb.LIBUSB_ENDPOINT_OUT,
    //   // bmRequest
    //   usb.LIBUSB_REQUEST_SET_CONFIGURATION,
    //   // wValue (Configuration value)
    //   0,
    //   // wIndex
    //   0,
    //   // message to be sent
    //   Buffer.alloc(0),
    //   (err, data) => {
    //     if (err) {
    //       process.nextTick(() => events.emit('error', err));
    //       return;
    //     }
    //   }
    // );
  }

  function close() {
    if (!device) return;

    const dev = device;

    if (!polling) dev.close();
    else endpoint.stopPoll(dev.close);
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
          // && err.errno != 4
          !data
        ) {
          warning('Rejected trying to receive.', data);
          reject(err);
        } else resolve(parseHostDataIN(data));
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
          if (command.A === undefined) throw new Error('Argument `A` missing');
          if (command.B === undefined) throw new Error('Argument `B` missing');
          if (command.C === undefined) throw new Error('Argument `C` missing');

          writeNumberToBuffer(command.A, 2);
          writeNumberToBuffer(command.B, 2);
          writeNumberToBuffer(command.C, 2);
          break;

        case CommandMode.Calibration:
          if (command.angle === undefined) throw new Error('Argument `angle` missing');
          if (command.amplitude === undefined) throw new Error('Argument `amplitude` missing');

          writeNumberToBuffer(command.angle, 2);
          writeNumberToBuffer(command.amplitude, 1);
          break;

        case CommandMode.Push:
          if (command.command === undefined) throw new Error('Argument `command` missing');
          writeNumberToBuffer(command.command, 2, true);
          break;

        case CommandMode.Servo:
          if (command.command === undefined) throw new Error('Argument `command` missing');
          if (command.pwmMode === undefined) throw new Error('Argument `pwmMode` missing');

          // CommandMode::Servo
          const PWMMode = {
            pwm: 1, // Set pwm Mode
            position: 2, // setPosition
            velocity: 3, // setVelocity
            spare: 4, // Spare Mode
            command: 1, // setAmplitude  // this is redundant to pwmMode
            // Here we set the control parameters.
            // Note that these are all u1 numbers
            kP: 11, // in USBInterface.cpp, send a Proportional Gain constant
            kI: 12,
            kD: 13,

            synchronousAmplitude: 98,
            synchronousVelocity: 99,
          };

          writeNumberToBuffer(PWMMode[command.pwmMode]);
          switch (command.pwmMode) {
            case 'kP': // case 11: in USBInterface.cpp, send a Proportional Gain constant
            case 'kI': // case 12:
            case 'kD': // case 13:
              command.command &= 0xffff;
              break;
            case 'pwm': // case 1: Set pwm Mode
            case 'command': // case 1: setAmplitude  // this is redundant to pwmMode
              command.command = clipRange(-255, 255)(command.command);
              break;
            case 'position': // case 2: setPosition
            case 'velocity': // case 3: setVelocity
            case 'spare': // case 4: Set Spare Mode
              break;

            // Just in case
            default:
              command.command = 0;
              break;
          }
          writeNumberToBuffer(command.command, 4, true);
          break;

        case CommandMode.SynchronousDrive:
          writeNumberToBuffer(command.amplitude, 1, true);
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
  function onError(handler: (err: usb.LibUSBException) => void) {
    events.on('error', handler);
    return () => {
      events.removeListener('error', handler);
    };
  }

  return { onStatus, onData, onError, write, read, start, close };
}
