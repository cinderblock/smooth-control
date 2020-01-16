import { Device } from 'usb';

const deviceVid = 0xdead;
const devicePid = 0xbeef;

export function isDeviceMotorDriver(device: Device) {
  const dec = device.deviceDescriptor;
  const ven = dec.idVendor;
  const prod = dec.idProduct;
  return ven == deviceVid && prod == devicePid;
}
