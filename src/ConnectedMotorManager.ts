import { isDeviceMotorDriver } from './isDeviceMotorDriver';
import * as usb from 'usb';
import DebugFunctions, { DebugOptions } from './utils/Debug';

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

interface Consumer {
  onAttach: (device: usb.Device) => void;
  onDetach: () => void;
}

/**
 * List of motors connected to host
 */
export const motors: {
  serial: string;
  device?: usb.Device;
  consumer?: Consumer;
}[] = [];

type Listener = (serial: string, device: usb.Device, duplicate: boolean, consumer?: Consumer) => void;
const listeners: Listener[] = [];

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
