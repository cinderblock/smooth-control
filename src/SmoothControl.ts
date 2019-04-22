import EventEmitter from 'events';
import { promisify } from 'util';
import usb, { InEndpoint } from 'usb';
// import StrictEventEmitter from './strict-event-emitter-types';

import clipRange from './utils/clipRange';
import * as MLX from 'mlx90363';

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
  Bootloader = 0xfe,
}

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
  pwmMode:
    | 'pwm'
    | 'position'
    | 'velocity'
    | 'spare'
    | 'command'
    | 'kP'
    | 'kI'
    | 'kD';
};

export type Command =
  | ClearFaultCommand
  | MLXCommand
  | ThreePhaseCommand
  | CalibrationCommand
  | PushCommand
  | ServoCommand;

// Matches main.hpp State
export enum ControllerState {
  Fault,
  Manual,
  Normal,
}

// Matches main.hpp Fault
export enum ControllerFault {
  Init,
  UndervoltageLockout,
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

export type ReadData = {
  state: ControllerState;
  fault: ControllerFault;
  position: number;
  velocity: number;
  // Store full word. Get the low 14 bits as actual raw angle
  statusBitsWord: number;
  // Top bit specifies if controller thinks it is calibrated
  calibrated: boolean;
  cpuTemp: number;
  current: number;
  ain0: number;
  AS: number;
  BS: number;
  CS: number;
  mlxResponse?: Buffer;
  mlxResponseState?: MlxResponseState;
  mlxParsedResponse?: ReturnType<typeof parseMLX>;
  mlxCRCFailures: number;
  controlLoops: number;
};

// interface Events {
//   data(arg: ReadData): void;
//   error(): Error;
//   status(): 'ok'|'missing';
// }

async function openAndGetMotorSerial(dev: usb.Device) {
  if (!isDeviceMotorDriver(dev)) return false;

  // console.log('New Motor Device!');

  dev.open();

  const p = promisify(dev.getStringDescriptor.bind(dev)) as (
    i: number
  ) => Promise<Buffer | undefined>;

  try {
    let data = await p(dev.deviceDescriptor.iSerialNumber);

    if (!data) {
      dev.close();
      return false;
    }
    const dataStr = data
      .toString()
      .replace(/\0/g, '')
      .trim();

    // console.log('Found Motor device:', dataStr);

    return dataStr;
  } catch (e) {
    console.log('ERROR reading serial number', e);
  }
  return false;
}

type DebugFunction = boolean | ((...args: any[]) => void);

type Options = {
  debug?:
    | DebugFunction
    | { warning?: DebugFunction; info?: DebugFunction; debug?: DebugFunction };
};

function parseMLX(
  mlxResponse: Buffer
): ReturnType<typeof MLX.parseData> | string {
  try {
    return MLX.parseData(mlxResponse);
  } catch (e) {
    return e.toString();
  }
}

export function parseINBuffer(data: Buffer): ReadData {
  if (data.length != reportLength) {
    throw 'Invalid data';
  }

  let i = 0;
  function read(length: number, signed: boolean = false) {
    const pos = i;
    i += length;
    if (signed) return data.readIntLE(pos, length);
    return data.readUIntLE(pos, length);
  }
  function readBuffer(length: number) {
    const ret = Buffer.allocUnsafe(length);
    i += data.copy(ret, 0, i);
    return ret;
  }

  // Matches USB/PacketFormats.h USBDataINShape
  const state = read(1);
  const fault = read(1);
  const position = read(2);
  const velocity = read(2, true);
  // Store full word. Get the low 14 bits as actual raw angle
  const statusBitsWord = read(2);
  const cpuTemp = read(2);
  const current = read(2, true);
  const ain0 = read(2);
  const AS = read(2);
  const BS = read(2);
  const CS = read(2);

  const mlxResponse = readBuffer(8);
  const mlxResponseState = read(1);
  const controlLoops = read(2);
  const mlxCRCFailures = read(2);

  // Top bit specifies if controller thinks it is calibrated
  const calibrated = !!(statusBitsWord & (1 << 15));
  const mlxDataValid = !!(statusBitsWord & (1 << 14));

  const ret: ReadData = {
    state,
    fault,
    position,
    velocity,
    statusBitsWord,
    calibrated,
    cpuTemp,
    current,
    ain0,
    AS,
    BS,
    CS,
    controlLoops,
    mlxCRCFailures,
  };

  if (mlxDataValid) {
    ret.mlxResponse = mlxResponse;
    ret.mlxResponseState = mlxResponseState;
    ret.mlxParsedResponse = parseMLX(mlxResponse);
  }

  return ret;
}

export async function addAttachListener(
  listener: (id: string, device: usb.Device) => void
) {
  async function checker(dev: usb.Device) {
    const serial = await openAndGetMotorSerial(dev);
    dev.close();
    if (serial === false) return;
    listener(serial, dev);
  }

  const checkExisting = Promise.all(usb.getDeviceList().map(checker));

  usb.on('attach', checker);

  await checkExisting;

  return () => {
    usb.removeListener('attach', checker);
  };
}

export default function USBInterface(id: string, options?: Options) {
  if (!id) throw new Error('Invalid ID');

  options = options || {};

  // Default to enabled
  if (options.debug === undefined) options.debug = true;

  function warning(...args: any[]) {
    if (!options || !options.debug) return;

    if (typeof options.debug == 'function') {
      options.debug('warning', ...args);
    } else if (options.debug === true || options.debug.warning === true) {
      console.log('Smooth Control - Warning:', ...args);
    } else if (options.debug.warning) {
      options.debug.warning(...args);
    }
  }

  function info(...args: any[]) {
    if (!options || !options.debug) return;

    if (typeof options.debug == 'function') {
      options.debug('info', ...args);
    } else if (options.debug === true || options.debug.info === true) {
      console.log('Smooth Control - info:', ...args);
    } else if (options.debug.info) {
      options.debug.info(...args);
    }
  }

  function debug(...args: any[]) {
    if (!options || !options.debug) return;

    if (typeof options.debug == 'function') {
      options.debug('debug', ...args);
    } else if (options.debug === true || options.debug.debug === true) {
      console.log('Smooth Control - debug:', ...args);
    } else if (options.debug.debug) {
      options.debug.debug(...args);
    }
  }

  let device: usb.Device;
  let endpoint: usb.InEndpoint;
  const events = new EventEmitter(); // as StrictEventEmitter<EventEmitter, Events>;
  let enabled = false;

  let polling = true;

  function start(p = true) {
    polling = p;
    // When we start, find all devices
    usb.getDeviceList().forEach(checkDevice);
    // And listen for any new devices connected
    usb.on('attach', checkDevice);
  }

  async function checkDevice(dev: usb.Device) {
    const serial = await openAndGetMotorSerial(dev);
    if (serial != id) {
      dev.close();
      return;
    }
    info('Attaching', id);

    usb.removeListener('attach', checkDevice);

    device = dev;

    // Motor HID interface is always interface 0
    const intf = device.interface(0);

    if (process.platform != 'win32' && intf.isKernelDriverActive())
      intf.detachKernelDriver();

    intf.claim();

    // Store interface number as first number in write buffer
    writeBuffer[0] = intf.interfaceNumber;

    // Motor HID IN endpoint is always endpoint 0
    endpoint = intf.endpoints[0] as InEndpoint;

    if (polling) {
      // Start polling. 3 pending requests at all times
      endpoint.startPoll(3, reportLength);

      endpoint.on('data', d => events.emit('data', parseINBuffer(d)));
    }

    endpoint.on('error', err => {
      if (err.errno == 4) return;

      events.emit('error', err);
    });

    usb.on('detach', detach);

    enabled = true;

    events.emit('status', 'ok');

    info('Attached', id);

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

  // Allocate a write buffer once and keep reusing it
  const writeBuffer = Buffer.alloc(reportLength);

  function close() {
    if (!device) return;

    function cl() {
      device.close();
    }

    if (polling) endpoint.stopPoll(cl);
    else cl();
  }

  function detach(dev: usb.Device) {
    if (dev != device) return;

    events.emit('status', 'missing');

    info('Detach', id);

    usb.removeListener('detach', detach);
    usb.on('attach', checkDevice);

    enabled = false;
  }

  async function read() {
    if (!enabled || !device) {
      warning('USBInterface not enabled when trying to read', id);
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
        } else resolve(parseINBuffer(data));
      });
    });
  }

  /*
   * Writes data that is read by Interface.cpp CALLBACK_HID_Device_ProcessHIDReport
   */
  function write(command: Command, cb?: () => any) {
    if (!enabled || !device) {
      warning('USBInterface not enabled when trying to write', command, id);
      return false;
    }

    let pos = 1;
    function writeNumBuffer(num: number, len = 1, signed = false) {
      if (signed) pos = writeBuffer.writeIntLE(num, pos, len);
      else pos = writeBuffer.writeUIntLE(num, pos, len);
    }

    writeNumBuffer(command.mode);

    try {
      switch (command.mode) {
        case CommandMode.MLXDebug:
          if (command.data === undefined) throw 'Argument `data` missing';
          if (!(command.data.length == 7 || command.data.length == 8))
            throw 'Argument `data` has incorrect length';

          command.data.copy(writeBuffer, pos);
          pos += 8;
          const generateCRC = command.crc || command.data.length == 7;
          writeNumBuffer(generateCRC ? 1 : 0);
          break;

        case CommandMode.ThreePhase:
          if (command.A === undefined) throw 'Argument `A` missing';
          if (command.B === undefined) throw 'Argument `B` missing';
          if (command.C === undefined) throw 'Argument `C` missing';

          writeNumBuffer(command.A, 2);
          writeNumBuffer(command.B, 2);
          writeNumBuffer(command.C, 2);
          break;

        case CommandMode.Calibration:
          if (command.angle === undefined) throw 'Argument `angle` missing';
          if (command.amplitude === undefined)
            throw 'Argument `amplitude` missing';

          writeNumBuffer(command.angle, 2);
          writeNumBuffer(command.amplitude, 1);
          break;

        case CommandMode.Push:
          if (command.command === undefined) throw 'Argument `command` missing';
          writeNumBuffer(command.command, 2, true);
          break;

        case CommandMode.Servo:
          if (command.command === undefined) throw 'Argument `command` missing';
          if (command.pwmMode === undefined) throw 'Argument `pwmMode` missing';

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
          };

          writeNumBuffer(PWMMode[command.pwmMode]);

          switch (command.pwmMode) {
            case 'kP': // case 11: in USBInterface.cpp, send a Proportional Gain constant
            case 'kI': // case 12:
            case 'kD': // case 13:
              command.command = clipRange(0, 255)(command.command);
            case 'pwm': // case 1: Set pwm Mode
            case 'command': // case 1: setAmplitude  // this is redundant to pwmMode
              command.command = clipRange(-255, 255)(command.command);
            case 'position': // case 2: setPosition
            case 'velocity': // case 3: setVelocity
            case 'spare': // case 4: Set Spare Mode
              writeNumBuffer(command.command, 4, true);
              break;
          }
      }

      // Send a Set Report control request
      device.controlTransfer(
        // bmRequestType (constant for this control request)
        usb.LIBUSB_RECIPIENT_INTERFACE |
          usb.LIBUSB_REQUEST_TYPE_CLASS |
          usb.LIBUSB_ENDPOINT_OUT,
        // bmRequest (constant for this control request)
        0x09,
        // wValue (MSB is report type, LSB is report number)
        0x0809,
        // wIndex (interface number)
        0,
        // message to be sent
        writeBuffer,
        err => {
          if (err && err.errno != 4) events.emit('error', err);
          cb && cb();
        }
      );
    } catch (e) {
      warning('Failure trying to send data', command, id, e);
      cb && cb();
    }
  }
  return { events, write, read, start, close };
}
