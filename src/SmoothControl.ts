import EventEmitter from 'events';
import usb, { InEndpoint } from 'usb';
import * as MLX from 'mlx90363';
import TypedEventEmitter from 'typed-emitter';
import clipRange from './utils/clipRange';
import DebugFunctions, { DebugOptions } from './utils/Debug';

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
const reportLength = 37;

export type ReadData = {
  state: ControllerState;
  fault: ControllerFault;
  position: number;
  velocity: number;
  amplitude: number;
  /**
   * Raw bits of a "status word". Other values have parsed version of this.
   */
  statusBitsRaw: number;
  calibrated: boolean;
  cpuTemp: number;
  current: number;
  vBatt: number;
  VDD: number;
  AS: number;
  BS: number;
  CS: number;
  mlxResponse?: Buffer;
  mlxResponseState?: MlxResponseState;
  mlxParsedResponse?: ReturnType<typeof parseMLX>;
  mlxCRCFailures: number;
  controlLoops: number;
};

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
      dev.getStringDescriptor(
        dev.deviceDescriptor.iSerialNumber,
        (err, result) => (err && reject(err)) || resolve(result)
      )
    );

    if (!data) {
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

function parseMLX(
  mlxResponse: Buffer
): ReturnType<typeof MLX.parseData> | string {
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
export function parseHostDataIN(data: Buffer): ReadData {
  if (data.length != reportLength)
    throw new Error('Invalid data. Refusing to parse');

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
  const statusBitsRaw = read(2);
  const cpuTemp = read(2);
  const current = read(2, true);
  const VDD = read(2);
  const vBatt = read(2);
  const forward = !!read(1);
  const amplitude = (forward ? 1 : -1) * read(1);
  const AS = read(2);
  const BS = read(2);
  const CS = read(2);

  const mlxResponse = readBuffer(8);
  const mlxResponseState = read(1);
  const controlLoops = read(2);
  const mlxCRCFailures = read(2);

  // Top bit specifies if controller thinks it is calibrated
  const calibrated = !!(statusBitsRaw & (1 << 15));
  const mlxDataValid = !!(statusBitsRaw & (1 << 14));

  const ret: ReadData = {
    state,
    fault,
    position,
    velocity,
    amplitude,
    statusBitsRaw,
    calibrated,
    cpuTemp,
    current,
    vBatt,
    VDD,
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

interface Consumer {
  attach: (device: usb.Device) => void;
  detach: () => void;
}

/**
 * List of motors connected to host
 */
const motors: {
  serial: string;
  device?: usb.Device;
  consumer?: Consumer;
}[] = [];

type Listener = (
  serial: string,
  device: usb.Device,
  duplicate: boolean,
  consumer?: Consumer
) => void;
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
 * Call a function whenever a motor is connected to the computer
 * @param listener Function to call every time any motor device is connected
 * @returns A cleanup function to stop listening.
 */
export async function addAttachListener(listener: Listener) {
  listeners.push(listener);
  motors
    .filter(m => m.device)
    .forEach(m => listener(m.serial, m.device!, false, m.consumer));

  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
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
      found.consumer.attach(device);
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
        found.consumer.detach();
      }
    }
  });
}

/**
 * Manages a single motor connection (and reconnection). Won't do anything until `start` is called.
 * @param serial Serial number of motor to find
 * @param options
 */
export default function USBInterface(serial: string, options?: Options) {
  if (!serial) throw new Error('Invalid ID');

  options = options || {};

  const polling =
    (options.polling === undefined || options.polling === true
      ? 3
      : options.polling) || 0;

  const { info, debug, warning } = DebugFunctions(options.debug);

  let device: usb.Device | undefined;
  let endpoint: usb.InEndpoint;
  const events = new EventEmitter() as TypedEventEmitter<Events>;

  let status: 'missing' | 'connected';

  // Allocate a write buffer once and keep reusing it
  const writeBuffer = Buffer.alloc(reportLength);

  const found = motors.find(d => serial == d.serial);
  if (found) {
    if (found.consumer) {
      throw new Error(
        "Can't have two consumers of the same serial number: " + serial
      );
    } else {
      found.consumer = { attach, detach };
      if (found.device) attach(found.device);
    }
  } else {
    motors.push({ serial, consumer: { attach, detach } });
  }

  async function attach(dev: usb.Device) {
    info('Attaching', serial);

    dev.open();

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
      endpoint.startPoll(polling, reportLength);

      endpoint.on('data', d => events.emit('data', parseHostDataIN(d)));
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

  function detach() {
    events.emit('status', (status = 'missing'));

    info('Detach', serial);

    device = undefined;
  }

  async function read() {
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

  /*
   * Writes data that is read by Interface.cpp CALLBACK_HID_Device_ProcessHIDReport
   */
  async function write(command: Command, cb?: (err?: WriteError) => void) {
    if (!device) {
      warning('Trying to write with no motor attached.', serial, command);
      return false;
    }

    const dev = device;

    let pos = 1;
    function writeNumberToBuffer(num: number, len = 1, signed = false) {
      pos = writeBuffer[signed ? 'writeIntLE' : 'writeUIntLE'](
        Math.round(num),
        pos,
        len
      );
    }

    try {
      writeNumberToBuffer(command.mode);

      switch (command.mode) {
        case CommandMode.MLXDebug:
          if (command.data === undefined)
            throw new Error('Argument `data` missing');
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
          if (command.angle === undefined)
            throw new Error('Argument `angle` missing');
          if (command.amplitude === undefined)
            throw new Error('Argument `amplitude` missing');

          writeNumberToBuffer(command.angle, 2);
          writeNumberToBuffer(command.amplitude, 1);
          break;

        case CommandMode.Push:
          if (command.command === undefined)
            throw new Error('Argument `command` missing');
          writeNumberToBuffer(command.command, 2, true);
          break;

        case CommandMode.Servo:
          if (command.command === undefined)
            throw new Error('Argument `command` missing');
          if (command.pwmMode === undefined)
            throw new Error('Argument `pwmMode` missing');

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

          writeNumberToBuffer(PWMMode[command.pwmMode]);
          let skip = false;
          switch (command.pwmMode) {
            case 'kP': // case 11: in USBInterface.cpp, send a Proportional Gain constant
            case 'kI': // case 12:
            case 'kD': // case 13:
              command.command = clipRange(0, 0xffff)(command.command);
              skip = true;
            case 'pwm': // case 1: Set pwm Mode
            case 'command': // case 1: setAmplitude  // this is redundant to pwmMode
              if (!skip)
                command.command = clipRange(-255, 255)(command.command);
            case 'position': // case 2: setPosition
            case 'velocity': // case 3: setVelocity
            case 'spare': // case 4: Set Spare Mode
              writeNumberToBuffer(command.command, 4, true);
              break;
          }
      }
    } catch (e) {
      e = new TypeError('Failure parsing command' + e);
      warning(e);
      throw e;
    }

    const start = process.hrtime();
    // Send a Set Report control request
    return new Promise((resolve, reject) =>
      dev.controlTransfer(
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
        error => {
          if (error && error.errno != 4) {
            const fullError = {
              error,
              command,
              serial,
              time: process
                .hrtime(start)
                .reduce((sec, nano) => sec * 1e9 + nano),
            };
            cb && cb(fullError);
            reject(fullError);
          } else {
            cb && cb();
            resolve();
          }
        }
      )
    );
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
