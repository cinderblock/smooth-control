const debug = false;

const log = debug ? console.log : () => {};

export default function clipRange(max: number, min = 0) {
  if (max < min) {
    const temp = max;
    max = min;
    min = temp;
  }

  return function clip(value: number) {
    if (value > max) {
      log('Value out of range.', value, '>', max);
      return max;
    }
    if (value < min) {
      log('Value out of range.', value, '<', min);
      return min;
    }
    return value;
  };
}
