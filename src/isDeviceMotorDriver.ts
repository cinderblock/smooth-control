import { Device } from 'usb';

const deviceVid = 0xdead;
const devicePid = 0xbeef;
const expectedVersion = 10;

export function isDeviceMotorDriver(device: Device) {
  const dec = device.deviceDescriptor;
  const ven = dec.idVendor;
  const prod = dec.idProduct;

  if (ven != deviceVid) return false;
  if (prod != devicePid) return false;

  if (dec.bcdUSB != expectedVersion) {
    console.log(
      `Found ${dec.iSerialNumber} but has incorrect version: '${dec.bcdUSB}'. Expected: '${expectedVersion}'.`
    );
    return false;
  }

  return true;
}
