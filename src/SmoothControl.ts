import { EventEmitter } from 'events';
import * as USB from 'usb';
import TypedEventEmitter from 'typed-emitter';
import clipRange from './utils/clipRange';
import DebugFunctions, { DebugOptions } from './utils/Debug';
import { SharedPromise } from './utils/SharedPromise';
import { motors } from './ConnectedMotorManager';
import { ReadData, Command, reportLength, parseHostDataIN, CommandMode } from './parseData';

export {
  CommandMode,
  ClearFaultCommand,
  MLXCommand,
  ThreePhaseCommand,
  CalibrationCommand,
  PushCommand,
  ServoCommand,
  SynchronousCommand,
  BootloaderCommand,
  Command,
  ControllerState,
  ControllerFault,
  MlxResponseState,
  FaultData,
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
import * as MLX from 'mlx90363';
export const Melexis = MLX;

interface Events {
  status: (status: 'missing' | 'connected') => void;
  data: (data: ReadData) => void;
  error: (err: USB.LibUSBException) => void;
}

type Options = {
  debug?: DebugOptions;
  polling?: number | boolean;
};

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

    endpoint.on('error', err => {
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

    const found = motors.find(d => serial == d.serial);
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

            amplitudeLimit: 199,
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

  function onError(handler: (err: USB.LibUSBException | Error) => void) {
    events.on('error', handler);
    return () => {
      events.removeListener('error', handler);
    };
  }

  return { onStatus, onData, onError, write, read, close };
}
