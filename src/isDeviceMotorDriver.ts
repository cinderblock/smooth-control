import { Device } from 'usb';
import { validateNumber } from './utils/validateNumber';

const deviceVid = 0xdead;
const devicePid = 0xbeef;

function versionBCD(major: number, minor: number, patch: number) {
  validateNumber('major', major, 1 << 8);
  validateNumber('minor', minor, 1 << 4);
  validateNumber('patch', patch, 1 << 4);

  return (major << 8) | (minor << 4) | patch;
}

const expectedVersion = versionBCD(0, 1, 0);

export function isDeviceMotorDriver(device: Device) {
  const dec = device.deviceDescriptor;
  const ven = dec.idVendor;
  const prod = dec.idProduct;

  if (ven != deviceVid) return false;
  if (prod != devicePid) return false;

  if (dec.bcdDevice != expectedVersion) {
    console.log(
      `Found ${dec.iSerialNumber} but has incorrect version: '${dec.bcdDevice}'. Expected: '${expectedVersion}'.`
    );
    return false;
  }

  return true;
}
